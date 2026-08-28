import { Copy, File, FilePlus2, Folder, FolderOpen, FolderPlus, Pencil, RefreshCw, Search, Trash2 } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
import type { DocumentUri, FileChange, WorkspaceDescriptor, WorkspaceEntry } from "../../protocol";
import type { DesktopClient } from "../desktop-client";

interface FileTreeProps {
	client: DesktopClient;
	workspace: WorkspaceDescriptor;
	activeUri?: DocumentUri;
	changes?: readonly FileChange[];
	onOpen(uri: DocumentUri): void;
	onQuickOpen?(): void;
	onError?(message: string): void;
}

type PendingAction = "create-file" | "create-directory" | "rename" | "copy";

export type FileAction =
	| { kind: "create"; uri: DocumentUri; directory: boolean }
	| { kind: "rename"; from: DocumentUri; to: DocumentUri }
	| { kind: "copy"; from: DocumentUri; to: DocumentUri; recursive: boolean }
	| { kind: "remove"; uri: DocumentUri }
	| { kind: "reveal"; uri: DocumentUri };

export async function executeFileAction(client: DesktopClient, workspaceId: string, action: FileAction): Promise<void> {
	switch (action.kind) {
		case "create":
			await client.request("workspace.create", { workspaceId, uri: action.uri, directory: action.directory });
			return;
		case "rename":
			await client.request("workspace.rename", { workspaceId, from: action.from, to: action.to });
			return;
		case "copy":
			await client.request("workspace.copy", {
				workspaceId,
				from: action.from,
				to: action.to,
				recursive: action.recursive,
			});
			return;
		case "remove":
			await client.request("workspace.remove", { workspaceId, uri: action.uri, mode: "trash" });
			return;
		case "reveal":
			await client.request("workspace.reveal", { workspaceId, uri: action.uri });
	}
}

function fileUri(path: string): DocumentUri {
	const normalized = path.replaceAll("\\", "/");
	return `file://${normalized
		.split("/")
		.map((part, index) => (index === 0 ? part : encodeURIComponent(part)))
		.join("/")}`;
}

function uriParent(uri: DocumentUri): DocumentUri {
	const slash = uri.lastIndexOf("/");
	return slash > "file://".length ? uri.slice(0, slash) : uri;
}

function appendUri(parent: DocumentUri, name: string): DocumentUri {
	return `${parent.replace(/\/$/, "")}/${encodeURIComponent(name)}`;
}

function entrySort(a: WorkspaceEntry, b: WorkspaceEntry): number {
	if (a.directory !== b.directory) return a.directory ? -1 : 1;
	return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

export function agentFileMotionClass(change: FileChange | undefined): string {
	if (change?.origin !== "agent") return "";
	switch (change.kind) {
		case "created":
			return "motion-file-created motion-file-recent";
		case "deleted":
			return "motion-file-deleted";
		case "renamed":
			return "motion-file-moved motion-file-recent";
		case "modified":
			return "motion-file-modified motion-file-recent";
		default:
			return "";
	}
}

export function FileTree({ client, workspace, activeUri, changes = [], onOpen, onQuickOpen, onError }: FileTreeProps) {
	const [entries, setEntries] = useState<Map<DocumentUri | "", readonly WorkspaceEntry[]>>(new Map());
	const [expanded, setExpanded] = useState<Set<DocumentUri>>(new Set());
	const [loading, setLoading] = useState<Set<DocumentUri | "">>(new Set());
	const [selected, setSelected] = useState<WorkspaceEntry>();
	const [pending, setPending] = useState<PendingAction>();
	const [pendingValue, setPendingValue] = useState("");
	const rootUri = useMemo(() => fileUri(workspace.rootPath), [workspace.rootPath]);
	const recentChanges = useMemo(() => {
		const byUri = new Map<DocumentUri, FileChange>();
		for (const change of changes) byUri.set(change.uri, change);
		return byUri;
	}, [changes]);
	const report = useCallback(
		(cause: unknown) => onError?.(cause instanceof Error ? cause.message : String(cause)),
		[onError],
	);

	const load = useCallback(
		async (uri?: DocumentUri) => {
			const key = uri ?? "";
			setLoading(current => new Set(current).add(key));
			try {
				const result = await client.request("workspace.list", {
					workspaceId: workspace.id,
					...(uri ? { uri } : {}),
				});
				setEntries(current => new Map(current).set(key, [...result.entries].sort(entrySort)));
			} catch (cause) {
				report(cause);
			} finally {
				setLoading(current => {
					const next = new Set(current);
					next.delete(key);
					return next;
				});
			}
		},
		[client, report, workspace.id],
	);

	useEffect(() => {
		setEntries(new Map());
		setExpanded(new Set());
		setSelected(undefined);
		void load();
	}, [load]);

	useEffect(() => {
		if (changes.length === 0) return;
		void load();
		for (const uri of expanded) void load(uri);
	}, [changes, expanded, load]);

	const toggle = useCallback(
		(entry: WorkspaceEntry) => {
			if (!entry.directory) {
				onOpen(entry.uri);
				return;
			}
			setExpanded(current => {
				const next = new Set(current);
				next.has(entry.uri) ? next.delete(entry.uri) : next.add(entry.uri);
				return next;
			});
			if (!entries.has(entry.uri)) void load(entry.uri);
		},
		[entries, load, onOpen],
	);

	const begin = (action: PendingAction) => {
		setPending(action);
		setPendingValue(action === "rename" && selected ? selected.name : "");
	};

	const runPending = async () => {
		if (!pending || !pendingValue.trim()) return;
		const name = pendingValue.trim();
		try {
			if (pending === "create-file" || pending === "create-directory") {
				const parent = selected?.directory ? selected.uri : selected ? uriParent(selected.uri) : rootUri;
				await executeFileAction(client, workspace.id, {
					kind: "create",
					uri: appendUri(parent, name),
					directory: pending === "create-directory",
				});
				await load(parent === rootUri ? undefined : parent);
			} else if (selected) {
				const destination = appendUri(uriParent(selected.uri), name);
				if (pending === "rename")
					await executeFileAction(client, workspace.id, { kind: "rename", from: selected.uri, to: destination });
				else
					await executeFileAction(client, workspace.id, {
						kind: "copy",
						from: selected.uri,
						to: destination,
						recursive: selected.directory,
					});
				await load(uriParent(selected.uri) === rootUri ? undefined : uriParent(selected.uri));
			}
			setPending(undefined);
			setPendingValue("");
		} catch (cause) {
			report(cause);
		}
	};

	const remove = async () => {
		if (!selected) return;
		try {
			await executeFileAction(client, workspace.id, { kind: "remove", uri: selected.uri });
			setSelected(undefined);
			await load(uriParent(selected.uri) === rootUri ? undefined : uriParent(selected.uri));
		} catch (cause) {
			report(cause);
		}
	};

	const reveal = async () => {
		if (!selected) return;
		try {
			await executeFileAction(client, workspace.id, { kind: "reveal", uri: selected.uri });
		} catch (cause) {
			report(cause);
		}
	};

	const renderEntries = (parent: DocumentUri | "", depth: number) =>
		(entries.get(parent) ?? []).map(entry => {
			const open = expanded.has(entry.uri);
			const EntryIcon = entry.directory ? (open ? FolderOpen : Folder) : File;
			return (
				<div key={entry.uri} role="none">
					<button
						type="button"
						role="treeitem"
						aria-expanded={entry.directory ? open : undefined}
						aria-selected={selected?.uri === entry.uri}
						className={`file-tree__row ${activeUri === entry.uri ? "is-active" : ""} ${agentFileMotionClass(recentChanges.get(entry.uri))}`}
						style={{ "--tree-depth": depth } as CSSProperties}
						onClick={() => setSelected(entry)}
						onDoubleClick={() => toggle(entry)}
					>
						<EntryIcon aria-hidden="true" size={15} />
						<span className="file-tree__name">{entry.name}</span>
						{entry.ignored ? <span className="file-tree__ignored">ignored</span> : null}
					</button>
					{entry.directory && open ? renderEntries(entry.uri, depth + 1) : null}
				</div>
			);
		});

	return (
		<section className="file-tree" aria-label={`${workspace.displayName} files`}>
			<header className="file-tree__header">
				<strong title={workspace.rootPath}>{workspace.displayName}</strong>
				<div className="file-tree__actions" role="toolbar" aria-label="File actions">
					<button type="button" title="Quick Open" aria-label="Quick Open" onClick={onQuickOpen}>
						<Search size={15} />
					</button>
					<button type="button" title="New File" aria-label="New File" onClick={() => begin("create-file")}>
						<FilePlus2 size={15} />
					</button>
					<button
						type="button"
						title="New Folder"
						aria-label="New Folder"
						onClick={() => begin("create-directory")}
					>
						<FolderPlus size={15} />
					</button>
					<button type="button" title="Refresh" aria-label="Refresh" onClick={() => void load()}>
						<RefreshCw size={15} />
					</button>
				</div>
			</header>
			<div className="file-tree__secondary-actions" role="toolbar" aria-label="Selected file actions">
				<button type="button" disabled={!selected} onClick={() => begin("rename")}>
					<Pencil size={13} /> Rename
				</button>
				<button type="button" disabled={!selected} onClick={() => begin("copy")}>
					<Copy size={13} /> Copy
				</button>
				<button type="button" disabled={!selected} onClick={() => void remove()}>
					<Trash2 size={13} /> Trash
				</button>
				<button type="button" disabled={!selected} onClick={() => void reveal()}>
					Reveal
				</button>
			</div>
			{pending ? (
				<form
					className="file-tree__inline-form"
					onSubmit={event => {
						event.preventDefault();
						void runPending();
					}}
				>
					<label htmlFor="file-action-name">
						{pending === "rename" ? "New name" : pending === "copy" ? "Copy name" : "Name"}
					</label>
					<input
						id="file-action-name"
						autoFocus
						value={pendingValue}
						onChange={event => setPendingValue(event.currentTarget.value)}
					/>
					<button type="submit">Apply</button>
					<button type="button" onClick={() => setPending(undefined)}>
						Cancel
					</button>
				</form>
			) : null}
			<div className="file-tree__scroll" role="tree" aria-busy={loading.size > 0}>
				{renderEntries("", 0)}
				{loading.has("") && !entries.has("") ? <p className="file-tree__empty">Loading files…</p> : null}
				{entries.get("")?.length === 0 ? <p className="file-tree__empty">No files</p> : null}
			</div>
		</section>
	);
}
