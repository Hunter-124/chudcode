import { type BigIntStats, type FSWatcher, watch } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import type { DocumentUri, FileChange, FileStamp } from "../protocol";
import type { WorkspaceMutation, WorkspaceService } from "./workspace-service";

interface SnapshotEntry {
	path: string;
	uri: DocumentUri;
	directory: boolean;
	symlink: boolean;
	dev: bigint;
	ino: bigint;
	size: number;
	mtimeNs: bigint;
}

interface PendingOwnWrite {
	sha256: string;
}

export interface FileWatcherOptions {
	coalesceMs?: number;
}

export class FileWatcher {
	readonly workspaceId: string;
	readonly rootUri: DocumentUri;
	recursiveMode: "native" | "directory-fallback" | "stopped" = "stopped";

	private readonly coalesceMs: number;
	private readonly nativeWatchers = new Map<string, FSWatcher>();
	private readonly queuedChanges = new Map<string, FileChange>();
	private readonly ownWrites = new Map<DocumentUri, Map<number, PendingOwnWrite>>();
	private snapshot = new Map<string, SnapshotEntry>();
	private flushTimer?: ReturnType<typeof setTimeout>;
	private reconcileTimer?: ReturnType<typeof setTimeout>;
	private reconcileChain: Promise<void> = Promise.resolve();
	private closed = false;
	private readonly unsubscribeMutation: () => void;

	constructor(
		private readonly workspace: WorkspaceService,
		private readonly onChanges: (changes: FileChange[]) => void,
		options: FileWatcherOptions = {},
	) {
		this.workspaceId = workspace.id;
		this.rootUri = workspace.rootUri();
		this.coalesceMs = Math.max(0, options.coalesceMs ?? 35);
		this.unsubscribeMutation = workspace.onMutation(mutation => this.recordMutation(mutation));
	}

	async start(): Promise<void> {
		if (this.closed) throw new Error("File watcher is closed");
		if (this.recursiveMode !== "stopped") return;
		await this.captureBaseline();
		try {
			const watcher = watch(this.workspace.rootPath, { recursive: true }, (_eventType, filename) => {
				if (filename === null) this.notifyOverflow();
				else this.scheduleReconcile();
			});
			this.attachWatcher(this.workspace.rootPath, watcher);
			this.recursiveMode = "native";
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM" && code !== "ERR_INVALID_ARG_VALUE" && code !== "ENOSYS")
				throw error;
			this.recursiveMode = "directory-fallback";
			await this.syncDirectoryWatchers();
		}
	}

	async captureBaseline(): Promise<void> {
		this.snapshot = await this.scanTree();
	}

	/** Testable overflow seam, also used for null filenames and OS watcher errors. */
	notifyOverflow(): void {
		this.queueChange({ kind: "rescan-required", uri: this.rootUri, origin: "external" });
		this.scheduleReconcile();
	}

	/** Register an already-published write so only the matching filesystem generation is suppressed. */
	recordOwnWrite(uri: DocumentUri, stamp: FileStamp, origin: "agent" | "user", publish = false): void {
		let generations = this.ownWrites.get(uri);
		if (!generations) {
			generations = new Map();
			this.ownWrites.set(uri, generations);
		}
		generations.set(stamp.generation, { sha256: stamp.sha256 });
		if (publish) this.queueChange({ kind: "modified", uri, stamp, origin });
	}

	async reconcileNow(): Promise<void> {
		const operation = this.reconcileChain.then(() => this.reconcile());
		this.reconcileChain = operation.catch(() => undefined);
		await operation;
	}

	flushNow(): void {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		if (this.queuedChanges.size === 0) return;
		const changes = [...this.queuedChanges.values()];
		this.queuedChanges.clear();
		this.onChanges(changes);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.recursiveMode = "stopped";
		clearTimeout(this.flushTimer);
		clearTimeout(this.reconcileTimer);
		this.flushTimer = undefined;
		this.reconcileTimer = undefined;
		for (const watcher of this.nativeWatchers.values()) watcher.close();
		this.nativeWatchers.clear();
		this.unsubscribeMutation();
		this.flushNow();
	}

	private recordMutation(mutation: WorkspaceMutation): void {
		if (mutation.stamp) {
			let generations = this.ownWrites.get(mutation.uri);
			if (!generations) {
				generations = new Map();
				this.ownWrites.set(mutation.uri, generations);
			}
			generations.set(mutation.stamp.generation, { sha256: mutation.stamp.sha256 });
		}
		this.queueChange(mutation);
	}

	private attachWatcher(directory: string, watcher: FSWatcher): void {
		watcher.on("error", () => this.notifyOverflow());
		this.nativeWatchers.set(directory, watcher);
	}

	private scheduleReconcile(): void {
		if (this.closed || this.reconcileTimer) return;
		this.reconcileTimer = setTimeout(() => {
			this.reconcileTimer = undefined;
			void this.reconcileNow().catch(() => this.notifyOverflow());
		}, this.coalesceMs);
	}

	private queueChange(change: FileChange): void {
		if (this.closed) return;
		const generation = change.stamp?.generation ?? change.kind;
		const key = `${change.uri}\0${generation}`;
		this.queuedChanges.set(key, change);
		if (this.flushTimer) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			this.flushNow();
		}, this.coalesceMs);
	}

	private async reconcile(): Promise<void> {
		if (this.closed) return;
		const previous = this.snapshot;
		const current = await this.scanTree();
		const deleted = new Map<string, SnapshotEntry>();
		const created = new Map<string, SnapshotEntry>();

		for (const [entryPath, oldEntry] of previous) {
			if (!current.has(entryPath)) deleted.set(entryPath, oldEntry);
		}
		for (const [entryPath, newEntry] of current) {
			if (!previous.has(entryPath)) created.set(entryPath, newEntry);
		}

		const deletedByIdentity = new Map<string, SnapshotEntry>();
		for (const entry of deleted.values()) deletedByIdentity.set(identity(entry), entry);
		for (const [entryPath, entry] of created) {
			const oldEntry = deletedByIdentity.get(identity(entry));
			if (!oldEntry) continue;
			deleted.delete(oldEntry.path);
			created.delete(entryPath);
			const stamp = entry.directory || entry.symlink ? undefined : await this.safeStamp(entry.path);
			if (!stamp || !this.consumeOwnWrite(entry.uri, stamp)) {
				this.queueChange({ kind: "renamed", uri: entry.uri, oldUri: oldEntry.uri, stamp, origin: "external" });
			}
		}

		for (const entry of deleted.values()) {
			this.queueChange({ kind: "deleted", uri: entry.uri, origin: "external" });
		}
		for (const entry of created.values()) {
			const stamp = entry.directory || entry.symlink ? undefined : await this.safeStamp(entry.path);
			if (!stamp || !this.consumeOwnWrite(entry.uri, stamp)) {
				this.queueChange({ kind: "created", uri: entry.uri, stamp, origin: "external" });
			}
		}
		for (const [entryPath, entry] of current) {
			const oldEntry = previous.get(entryPath);
			if (!oldEntry || entry.directory || entry.symlink) continue;
			if (entry.size === oldEntry.size && entry.mtimeNs === oldEntry.mtimeNs) continue;
			const stamp = await this.safeStamp(entry.path);
			if (!stamp || !this.consumeOwnWrite(entry.uri, stamp)) {
				this.queueChange({ kind: "modified", uri: entry.uri, stamp, origin: "external" });
			}
		}
		this.snapshot = current;
		if (this.recursiveMode === "directory-fallback") await this.syncDirectoryWatchers();
	}

	private consumeOwnWrite(uri: DocumentUri, stamp: FileStamp): boolean {
		const generations = this.ownWrites.get(uri);
		const expected = generations?.get(stamp.generation);
		if (!expected || expected.sha256 !== stamp.sha256) return false;
		generations?.delete(stamp.generation);
		if (generations?.size === 0) this.ownWrites.delete(uri);
		return true;
	}

	private async safeStamp(filePath: string): Promise<FileStamp | undefined> {
		try {
			return await this.workspace.getStamp(filePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	private async scanTree(): Promise<Map<string, SnapshotEntry>> {
		const result = new Map<string, SnapshotEntry>();
		const visit = async (directory: string): Promise<void> => {
			for (const entry of await readdir(directory, { withFileTypes: true })) {
				if (entry.name === ".git") continue;
				const entryPath = path.join(directory, entry.name);
				let entryStat: BigIntStats;
				try {
					entryStat = await lstat(entryPath, { bigint: true });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
					throw error;
				}
				const snapshotEntry: SnapshotEntry = {
					path: entryPath,
					uri: this.workspace.uriForPath(entryPath),
					directory: entryStat.isDirectory(),
					symlink: entryStat.isSymbolicLink(),
					dev: entryStat.dev,
					ino: entryStat.ino,
					size: Number(entryStat.size),
					mtimeNs: entryStat.mtimeNs,
				};
				result.set(entryPath, snapshotEntry);
				if (snapshotEntry.directory && !snapshotEntry.symlink) await visit(entryPath);
			}
		};
		await visit(this.workspace.rootPath);
		return result;
	}

	private async syncDirectoryWatchers(): Promise<void> {
		const directories = new Set<string>([this.workspace.rootPath]);
		for (const entry of this.snapshot.values()) {
			if (entry.directory && !entry.symlink) directories.add(entry.path);
		}
		for (const [directory, watcher] of this.nativeWatchers) {
			if (directories.has(directory)) continue;
			watcher.close();
			this.nativeWatchers.delete(directory);
		}
		for (const directory of directories) {
			if (this.nativeWatchers.has(directory)) continue;
			try {
				const watcher = watch(directory, (_eventType, filename) => {
					if (filename === null) this.notifyOverflow();
					else this.scheduleReconcile();
				});
				this.attachWatcher(directory, watcher);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.notifyOverflow();
			}
		}
	}
}

function identity(entry: SnapshotEntry): string {
	return `${entry.dev}:${entry.ino}:${entry.directory ? "d" : "f"}`;
}
