import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, copyFile, lstat, mkdir, open, readdir, realpath, rename, rm, stat, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
	DeleteMode,
	DocumentSnapshot,
	DocumentUri,
	FileChangeKind,
	FileStamp,
	WorkspaceDescriptor,
	WorkspaceEntry,
} from "../protocol";
import { checkIgnoredPaths } from "./workspace-search";

export const DEFAULT_MAX_READ_BYTES = 8 * 1024 * 1024;
export const HARD_MAX_READ_BYTES = 64 * 1024 * 1024;
/** Sentinel used as the expected hash when a caller intentionally creates a new file. */
export const ABSENT_SHA256 = "absent";

export type WorkspaceErrorCode =
	| "WORKSPACE_NOT_FOUND"
	| "INVALID_URI"
	| "PATH_OUTSIDE_WORKSPACE"
	| "FILE_NOT_FOUND"
	| "NOT_A_FILE"
	| "NOT_A_DIRECTORY"
	| "FILE_TOO_LARGE"
	| "BINARY_FILE"
	| "ALREADY_EXISTS"
	| "CONFLICT"
	| "INVALID_OPERATION";

export class WorkspaceServiceError extends Error {
	readonly code: WorkspaceErrorCode;
	readonly details?: Record<string, unknown>;

	constructor(code: WorkspaceErrorCode, message: string, details?: Record<string, unknown>) {
		super(message);
		this.name = "WorkspaceServiceError";
		this.code = code;
		this.details = details;
	}
}

export interface WorkspaceMutation {
	kind: FileChangeKind;
	uri: DocumentUri;
	oldUri?: DocumentUri;
	stamp?: FileStamp;
	origin: "agent" | "user";
}

export interface WorkspaceServiceOptions {
	maxReadBytes?: number;
}

export interface CreateOptions {
	directory?: boolean;
	text?: string;
	origin?: "agent" | "user";
}

export interface CopyOptions {
	recursive?: boolean;
	overwrite?: boolean;
	origin?: "agent" | "user";
}

interface TrackedStamp {
	sha256: string;
	size: number;
	mtimeNs: number;
	generation: number;
}

function normalizedForComparison(value: string): string {
	const normalized = path.resolve(value);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(normalizedForComparison(root), normalizedForComparison(candidate));
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function statsMtimeNs(stats: { mtimeNs?: bigint | number; mtimeMs: number }): number {
	if (stats.mtimeNs !== undefined) {
		const value = Number(stats.mtimeNs);
		return Number.isSafeInteger(value) ? value : Math.trunc(stats.mtimeMs * 1_000_000);
	}
	return Math.trunc(stats.mtimeMs * 1_000_000);
}

export async function sha256File(filePath: string): Promise<string> {
	const handle = await open(filePath, "r");
	try {
		const hash = createHash("sha256");
		const buffer = Buffer.allocUnsafe(128 * 1024);
		let position = 0;
		while (true) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
			if (bytesRead === 0) break;
			hash.update(buffer.subarray(0, bytesRead));
			position += bytesRead;
		}
		return hash.digest("hex");
	} finally {
		await handle.close();
	}
}

async function existingAncestor(candidate: string): Promise<{ ancestor: string; tail: string[] }> {
	const tail: string[] = [];
	let cursor = candidate;
	while (true) {
		try {
			await lstat(cursor);
			return { ancestor: cursor, tail };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = path.dirname(cursor);
			if (parent === cursor) throw error;
			tail.unshift(path.basename(cursor));
			cursor = parent;
		}
	}
}

async function syncDirectory(directory: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(directory, fsConstants.O_RDONLY);
		await handle.sync();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR" && code !== "EPERM" && code !== "EACCES") {
			throw error;
		}
	} finally {
		await handle?.close();
	}
}

function decodeText(bytes: Uint8Array, uri: string): string {
	if (bytes.includes(0)) throw new WorkspaceServiceError("BINARY_FILE", `Refusing to decode binary file: ${uri}`);
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new WorkspaceServiceError("BINARY_FILE", `File is not valid UTF-8 text: ${uri}`);
	}
}

async function readBoundedFile(filePath: string, limit: number): Promise<Buffer> {
	const handle = await open(filePath, "r");
	const chunks: Buffer[] = [];
	let total = 0;
	try {
		while (total <= limit) {
			const chunk = Buffer.allocUnsafe(Math.min(128 * 1024, limit + 1 - total));
			const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, total);
			if (bytesRead === 0) break;
			chunks.push(chunk.subarray(0, bytesRead));
			total += bytesRead;
		}
	} finally {
		await handle.close();
	}
	if (chunks.length === 0) return Buffer.alloc(0);
	if (chunks.length === 1) return chunks[0];
	return Buffer.concat(chunks, total);
}

export class WorkspaceService {
	readonly rootPath: string;
	readonly id: string;
	readonly descriptor: WorkspaceDescriptor;
	readonly maxReadBytes: number;

	private generation = 0;
	private readonly tracked = new Map<string, TrackedStamp>();
	private readonly mutationListeners = new Set<(mutation: WorkspaceMutation) => void>();
	private readonly writeQueues = new Map<string, Promise<void>>();

	private constructor(rootPath: string, options: WorkspaceServiceOptions) {
		this.rootPath = rootPath;
		const identityPath = process.platform === "win32" ? rootPath.toLowerCase() : rootPath;
		this.id = `workspace-${createHash("sha256").update(identityPath).digest("hex").slice(0, 24)}`;
		this.descriptor = { id: this.id, rootPath, displayName: path.basename(rootPath) || rootPath };
		const requestedLimit = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
		this.maxReadBytes = Number.isFinite(requestedLimit)
			? Math.min(HARD_MAX_READ_BYTES, Math.max(1, Math.trunc(requestedLimit)))
			: DEFAULT_MAX_READ_BYTES;
	}

	static async open(rootPath: string, options: WorkspaceServiceOptions = {}): Promise<WorkspaceService> {
		let canonical: string;
		try {
			canonical = await realpath(path.resolve(rootPath));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				throw new WorkspaceServiceError("WORKSPACE_NOT_FOUND", `Workspace root does not exist: ${rootPath}`);
			}
			throw error;
		}
		const rootStat = await stat(canonical);
		if (!rootStat.isDirectory())
			throw new WorkspaceServiceError("NOT_A_DIRECTORY", `Workspace root is not a directory: ${rootPath}`);
		return new WorkspaceService(canonical, options);
	}

	rootUri(): DocumentUri {
		return pathToFileURL(this.rootPath).href;
	}

	onMutation(listener: (mutation: WorkspaceMutation) => void): () => void {
		this.mutationListeners.add(listener);
		return () => this.mutationListeners.delete(listener);
	}

	private emitMutation(mutation: WorkspaceMutation): void {
		for (const listener of this.mutationListeners) listener(mutation);
	}

	private inputPath(uri: DocumentUri): string {
		if (uri.startsWith("file:")) {
			try {
				return fileURLToPath(uri);
			} catch {
				throw new WorkspaceServiceError("INVALID_URI", `Invalid file URI: ${uri}`);
			}
		}
		return path.isAbsolute(uri) ? uri : path.join(this.rootPath, uri);
	}

	async resolve(uri: DocumentUri, allowMissing = false): Promise<string> {
		const lexical = path.resolve(this.inputPath(uri));
		if (!isWithin(this.rootPath, lexical)) {
			throw new WorkspaceServiceError("PATH_OUTSIDE_WORKSPACE", `Path is outside the workspace: ${uri}`);
		}
		try {
			const canonical = await realpath(lexical);
			if (!isWithin(this.rootPath, canonical)) {
				throw new WorkspaceServiceError("PATH_OUTSIDE_WORKSPACE", `Symlink resolves outside the workspace: ${uri}`);
			}
			return canonical;
		} catch (error) {
			if (error instanceof WorkspaceServiceError) throw error;
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			if (!allowMissing) throw new WorkspaceServiceError("FILE_NOT_FOUND", `Path does not exist: ${uri}`);
		}
		const { ancestor, tail } = await existingAncestor(lexical);
		const canonicalAncestor = await realpath(ancestor);
		if (!isWithin(this.rootPath, canonicalAncestor)) {
			throw new WorkspaceServiceError(
				"PATH_OUTSIDE_WORKSPACE",
				`Parent symlink resolves outside the workspace: ${uri}`,
			);
		}
		const resolved = path.join(canonicalAncestor, ...tail);
		if (!isWithin(this.rootPath, resolved)) {
			throw new WorkspaceServiceError("PATH_OUTSIDE_WORKSPACE", `Path is outside the workspace: ${uri}`);
		}
		return resolved;
	}

	uriForPath(filePath: string): DocumentUri {
		if (!isWithin(this.rootPath, filePath)) {
			throw new WorkspaceServiceError("PATH_OUTSIDE_WORKSPACE", `Path is outside the workspace: ${filePath}`);
		}
		return pathToFileURL(filePath).href;
	}

	relativePath(filePath: string): string {
		if (!isWithin(this.rootPath, filePath)) {
			throw new WorkspaceServiceError("PATH_OUTSIDE_WORKSPACE", `Path is outside the workspace: ${filePath}`);
		}
		return path.relative(this.rootPath, filePath).split(path.sep).join("/");
	}

	async list(uri: DocumentUri = this.rootUri()): Promise<WorkspaceEntry[]> {
		const directory = await this.resolve(uri);
		const directoryStat = await stat(directory);
		if (!directoryStat.isDirectory()) throw new WorkspaceServiceError("NOT_A_DIRECTORY", `Not a directory: ${uri}`);
		const entries = await readdir(directory, { withFileTypes: true });
		entries.sort(
			(left, right) =>
				Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name),
		);
		const relativePaths = entries.map(entry => this.relativePath(path.join(directory, entry.name)));
		const ignored = await checkIgnoredPaths(this.rootPath, relativePaths);
		return entries.map((entry, index) => ({
			uri: this.uriForPath(path.join(directory, entry.name)),
			name: entry.name,
			relativePath: relativePaths[index],
			directory: entry.isDirectory(),
			ignored: ignored.has(relativePaths[index]),
		}));
	}

	async getStamp(uriOrPath: DocumentUri, forcedGeneration?: number): Promise<FileStamp> {
		const filePath = await this.resolve(uriOrPath);
		const fileStat = await stat(filePath);
		if (!fileStat.isFile()) throw new WorkspaceServiceError("NOT_A_FILE", `Not a regular file: ${uriOrPath}`);
		const sha256 = await sha256File(filePath);
		const size = fileStat.size;
		const modified = statsMtimeNs(fileStat);
		const tracked = this.tracked.get(filePath);
		let generation: number;
		if (forcedGeneration !== undefined) {
			generation = forcedGeneration;
			this.generation = Math.max(this.generation, forcedGeneration);
		} else if (tracked && tracked.sha256 === sha256 && tracked.size === size && tracked.mtimeNs === modified) {
			generation = tracked.generation;
		} else {
			generation = ++this.generation;
		}
		const stamp = { sha256, size, mtimeNs: modified, generation };
		this.tracked.set(filePath, stamp);
		return stamp;
	}

	async stat(uri: DocumentUri): Promise<WorkspaceEntry> {
		const filePath = await this.resolve(uri);
		const fileStat = await stat(filePath);
		const relativePath = this.relativePath(filePath);
		const ignored = (await checkIgnoredPaths(this.rootPath, [relativePath])).has(relativePath);
		return {
			uri: this.uriForPath(filePath),
			name: path.basename(filePath),
			relativePath,
			directory: fileStat.isDirectory(),
			ignored,
			stamp: fileStat.isFile() ? await this.getStamp(filePath) : undefined,
		};
	}

	async read(uri: DocumentUri): Promise<DocumentSnapshot> {
		const filePath = await this.resolve(uri);
		const fileStat = await stat(filePath);
		if (!fileStat.isFile()) throw new WorkspaceServiceError("NOT_A_FILE", `Not a regular file: ${uri}`);
		if (fileStat.size > this.maxReadBytes) {
			throw new WorkspaceServiceError(
				"FILE_TOO_LARGE",
				`File exceeds the ${this.maxReadBytes}-byte read limit: ${uri}`,
				{
					size: fileStat.size,
					limit: this.maxReadBytes,
				},
			);
		}
		const bytes = await readBoundedFile(filePath, this.maxReadBytes);
		if (bytes.byteLength > this.maxReadBytes) {
			throw new WorkspaceServiceError("FILE_TOO_LARGE", `File grew beyond the read limit: ${uri}`);
		}
		const text = decodeText(bytes, uri);
		const stamp = await this.getStamp(filePath);
		const canonicalUri = this.uriForPath(filePath);
		return {
			id: canonicalUri,
			uri: canonicalUri,
			language: languageForPath(filePath),
			text,
			stamp,
			dirty: false,
			conflict: false,
		};
	}

	async write(
		uri: DocumentUri,
		text: string,
		expectedSha256: string,
		origin: "agent" | "user" = "user",
	): Promise<FileStamp> {
		const filePath = await this.resolve(uri, expectedSha256 === ABSENT_SHA256);
		return this.withWriteLock(filePath, async () => {
			const parent = await this.resolve(this.uriForPath(path.dirname(filePath)));
			const target = path.join(parent, path.basename(filePath));
			const bytes = Buffer.from(text, "utf8");
			const tempPath = path.join(
				parent,
				`.${path.basename(target)}.chudcode-${process.pid}-${randomBytes(12).toString("hex")}.tmp`,
			);
			let tempExists = false;
			try {
				const temp = await open(tempPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
				tempExists = true;
				try {
					await temp.writeFile(bytes);
					await temp.sync();
				} finally {
					await temp.close();
				}
				const diskHash = await this.diskHashOrAbsent(target);
				if (diskHash !== expectedSha256) {
					throw new WorkspaceServiceError("CONFLICT", `File changed since it was read: ${uri}`, {
						expectedSha256,
						actualSha256: diskHash,
					});
				}
				await rename(tempPath, target);
				tempExists = false;
				await syncDirectory(parent);
				const generation = ++this.generation;
				const stamp = await this.getStamp(target, generation);
				const writtenHash = createHash("sha256").update(bytes).digest("hex");
				if (stamp.sha256 !== writtenHash) {
					throw new WorkspaceServiceError("CONFLICT", `Atomic write could not be confirmed: ${uri}`, {
						expectedSha256: writtenHash,
						actualSha256: stamp.sha256,
					});
				}
				this.emitMutation({
					kind: diskHash === ABSENT_SHA256 ? "created" : "modified",
					uri: this.uriForPath(target),
					stamp,
					origin,
				});
				return stamp;
			} finally {
				if (tempExists) await rm(tempPath, { force: true });
			}
		});
	}

	async create(uri: DocumentUri, options: CreateOptions = {}): Promise<WorkspaceEntry> {
		const target = await this.resolve(uri, true);
		await this.assertAbsent(target, uri);
		if (options.directory) {
			await mkdir(target);
			this.emitMutation({ kind: "created", uri: this.uriForPath(target), origin: options.origin ?? "user" });
			return this.stat(this.uriForPath(target));
		}
		await this.write(this.uriForPath(target), options.text ?? "", ABSENT_SHA256, options.origin ?? "user");
		return this.stat(this.uriForPath(target));
	}

	async rename(fromUri: DocumentUri, toUri: DocumentUri, origin: "agent" | "user" = "user"): Promise<WorkspaceEntry> {
		const source = await this.resolve(fromUri);
		const destination = await this.resolve(toUri, true);
		await this.assertAbsent(destination, toUri);
		await rename(source, destination);
		await syncDirectory(path.dirname(destination));
		const entry = await this.stat(this.uriForPath(destination));
		this.tracked.delete(source);
		this.emitMutation({
			kind: "renamed",
			uri: entry.uri,
			oldUri: this.uriForPath(source),
			stamp: entry.stamp,
			origin,
		});
		return entry;
	}

	async copy(fromUri: DocumentUri, toUri: DocumentUri, options: CopyOptions = {}): Promise<WorkspaceEntry> {
		const source = await this.resolve(fromUri);
		const destination = await this.resolve(toUri, true);
		if (!options.overwrite) await this.assertAbsent(destination, toUri);
		const sourceStat = await lstat(source);
		if (sourceStat.isSymbolicLink())
			throw new WorkspaceServiceError("INVALID_OPERATION", "Copying symbolic links is not supported");
		if (sourceStat.isDirectory()) {
			if (!options.recursive)
				throw new WorkspaceServiceError("INVALID_OPERATION", "Directory copy requires recursive=true");
			if (isWithin(source, destination)) {
				throw new WorkspaceServiceError("INVALID_OPERATION", "A directory cannot be copied into itself");
			}
			await this.copyDirectory(source, destination);
		} else if (sourceStat.isFile()) {
			await copyFile(source, destination, options.overwrite ? 0 : fsConstants.COPYFILE_EXCL);
		} else {
			throw new WorkspaceServiceError("NOT_A_FILE", `Unsupported file type: ${fromUri}`);
		}
		const entry = await this.stat(this.uriForPath(destination));
		this.emitMutation({ kind: "created", uri: entry.uri, stamp: entry.stamp, origin: options.origin ?? "user" });
		return entry;
	}

	async remove(uri: DocumentUri, mode: DeleteMode = "permanent", origin: "agent" | "user" = "user"): Promise<boolean> {
		const target = await this.resolve(uri);
		if (target === this.rootPath)
			throw new WorkspaceServiceError("INVALID_OPERATION", "The workspace root cannot be removed");
		const targetUri = this.uriForPath(target);
		if (mode === "trash") await this.moveToTrash(target);
		else await rm(target, { recursive: true, force: false });
		this.tracked.delete(target);
		this.emitMutation({ kind: "deleted", uri: targetUri, origin });
		return true;
	}

	async reveal(uri: DocumentUri): Promise<boolean> {
		const target = await this.resolve(uri);
		let command: string[];
		if (process.platform === "darwin") command = ["open", "-R", target];
		else if (process.platform === "win32") command = ["explorer.exe", `/select,${target}`];
		else command = ["xdg-open", (await stat(target)).isDirectory() ? target : path.dirname(target)];
		try {
			const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
			return (await child.exited) === 0;
		} catch {
			return false;
		}
	}

	private async copyDirectory(source: string, destination: string): Promise<void> {
		await mkdir(destination);
		for (const entry of await readdir(source, { withFileTypes: true })) {
			const sourceChild = path.join(source, entry.name);
			const destinationChild = path.join(destination, entry.name);
			if (entry.isSymbolicLink()) {
				const resolved = await this.resolve(this.uriForPath(sourceChild));
				if (!isWithin(this.rootPath, resolved))
					throw new WorkspaceServiceError(
						"PATH_OUTSIDE_WORKSPACE",
						`Copied symlink escapes workspace: ${sourceChild}`,
					);
				const linkTarget = await realpath(sourceChild);
				const relativeTarget = path.relative(path.dirname(destinationChild), linkTarget);
				await symlink(relativeTarget, destinationChild);
			} else if (entry.isDirectory()) {
				await this.copyDirectory(sourceChild, destinationChild);
			} else if (entry.isFile()) {
				await copyFile(sourceChild, destinationChild, fsConstants.COPYFILE_EXCL);
			}
		}
	}

	private async moveToTrash(target: string): Promise<void> {
		if (process.platform !== "linux") {
			throw new WorkspaceServiceError(
				"INVALID_OPERATION",
				"Trash is currently supported only on Linux; use permanent deletion on this platform",
			);
		}
		try {
			const child = Bun.spawn(["gio", "trash", "--", target], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
			const stderr = await new Response(child.stderr).text();
			if ((await child.exited) !== 0) {
				throw new WorkspaceServiceError("INVALID_OPERATION", `Could not move path to trash: ${stderr.trim()}`);
			}
		} catch (error) {
			if (error instanceof WorkspaceServiceError) throw error;
			throw new WorkspaceServiceError(
				"INVALID_OPERATION",
				"The gio trash service is unavailable on this Linux installation",
			);
		}
	}

	private async assertAbsent(target: string, uri: string): Promise<void> {
		try {
			await access(target, fsConstants.F_OK);
			throw new WorkspaceServiceError("ALREADY_EXISTS", `Destination already exists: ${uri}`);
		} catch (error) {
			if (error instanceof WorkspaceServiceError) throw error;
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	private async diskHashOrAbsent(filePath: string): Promise<string> {
		try {
			const fileStat = await stat(filePath);
			if (!fileStat.isFile()) throw new WorkspaceServiceError("NOT_A_FILE", `Not a regular file: ${filePath}`);
			return await sha256File(filePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return ABSENT_SHA256;
			throw error;
		}
	}

	private async withWriteLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.writeQueues.get(key) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>(resolve => {
			release = resolve;
		});
		const chain = previous.then(() => current);
		this.writeQueues.set(key, chain);
		await previous;
		try {
			return await operation();
		} finally {
			release();
			if (this.writeQueues.get(key) === chain) this.writeQueues.delete(key);
		}
	}
}

function languageForPath(filePath: string): string {
	const extension = path.extname(filePath).slice(1).toLowerCase();
	const languages: Record<string, string> = {
		c: "c",
		cc: "cpp",
		cpp: "cpp",
		css: "css",
		go: "go",
		html: "html",
		java: "java",
		js: "javascript",
		json: "json",
		jsx: "javascriptreact",
		md: "markdown",
		py: "python",
		rs: "rust",
		ts: "typescript",
		tsx: "typescriptreact",
		yaml: "yaml",
		yml: "yaml",
	};
	return (languages[extension] ?? extension) || "plaintext";
}
