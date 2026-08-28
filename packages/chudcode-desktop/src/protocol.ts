import type {
	AgentEvent,
	AgentSnapshot,
	BusChannel,
	CollabUiRequest,
	CollabUiResponseValue,
	ImageContent,
	SessionEntry,
	SessionHeader,
	SessionState,
	WireModel,
} from "@oh-my-pi/pi-wire";

export const DESKTOP_PROTOCOL_VERSION = 1 as const;

export type RequestId = number;
export type WorkspaceId = string;
export type DocumentId = string;
export type DocumentUri = string;
export type TerminalId = string;

export interface DesktopSessionInfo {
	id: string;
	path: string;
	cwd: string;
	title?: string;
	parentSessionPath?: string;
	createdMs: number;
	modifiedMs: number;
	messageCount: number;
	size: number;
	status?: "completed" | "failed" | "interrupted" | "active";
	pinned?: boolean;
}
export interface DesktopSessionTab {
	path: string;
	title: string;
	cwd: string;
	active: boolean;
	running: boolean;
	unread: number;
	draftDirty: boolean;
}

export interface WorkspaceDescriptor {
	id: WorkspaceId;
	rootPath: string;
	displayName: string;
}
export interface RecentProject {
	rootPath: string;
	displayName: string;
	lastOpenedMs: number;
}

export interface FileStamp {
	sha256: string;
	size: number;
	mtimeNs: number;
	generation: number;
}

export interface WorkspaceEntry {
	uri: DocumentUri;
	name: string;
	relativePath: string;
	directory: boolean;
	ignored: boolean;
	stamp?: FileStamp;
}

export type FileChangeKind = "created" | "modified" | "deleted" | "renamed" | "rescan-required";
export interface FileChange {
	kind: FileChangeKind;
	uri: DocumentUri;
	oldUri?: DocumentUri;
	stamp?: FileStamp;
	origin: "external" | "agent" | "user";
}
export type DeleteMode = "trash" | "permanent";

export interface DocumentSnapshot {
	id: DocumentId;
	uri: DocumentUri;
	language: string;
	text: string;
	stamp: FileStamp;
	dirty: boolean;
	conflict: boolean;
}

export interface SearchQuery {
	text: string;
	kind: "files" | "content" | "symbols";
	maxResults?: number;
	includeIgnored?: boolean;
}
export interface SearchResult {
	uri: DocumentUri;
	line?: number;
	column?: number;
	preview: string;
	score?: number;
}

export interface GitFileState {
	path: string;
	staged: string;
	unstaged: string;
	untracked: boolean;
}
export interface GitCommit {
	hash: string;
	parents: string[];
	author: string;
	timestampMs: number;
	subject: string;
	refs: string[];
}
export interface GitBranch {
	name: string;
	current: boolean;
	remote: boolean;
	upstream?: string;
	ahead?: number;
	behind?: number;
}
export interface GitRemote {
	name: string;
	fetchUrl: string;
	pushUrl: string;
}
export interface LspPosition {
	line: number;
	column: number;
}
export interface LspRange {
	start: LspPosition;
	end: LspPosition;
}
export interface GitSnapshot {
	root: string;
	branch: string;
	upstream?: string;
	ahead: number;
	behind: number;
	files: GitFileState[];
	commits: GitCommit[];
}

export interface LspDiagnostic {
	uri: DocumentUri;
	severity: 1 | 2 | 3 | 4;
	message: string;
	source?: string;
	/** LSP-native zero-based coordinates; editor adapters convert to their UI convention. */
	startLine: number;
	startColumn: number;
	endLine: number;
	endColumn: number;
}

export interface GraphNode {
	id: string;
	label: string;
	kind: string;
	group?: string;
	state?: "entering" | "stable" | "changing" | "leaving";
	meta?: Record<string, string | number | boolean | null>;
}
export interface GraphEdge {
	id: string;
	source: string;
	target: string;
	kind: string;
	state?: "entering" | "stable" | "changing" | "leaving";
}
export interface GraphSnapshot {
	revision: number;
	nodes: GraphNode[];
	edges: GraphEdge[];
}

export interface DesktopRequestMap {
	"runtime.hello": { params: { protocol: number }; result: { protocol: number; product: string } };
	"prompt.send": {
		params: { sessionPath: string; text: string; images?: ImageContent[] };
		result: { accepted: true };
	};
	"run.abort": { params: { sessionPath: string }; result: { accepted: boolean } };
	"ui.respond": {
		params: { sessionPath: string; reqId: number; value?: CollabUiResponseValue };
		result: { accepted: boolean };
	};
	"agent.command": {
		params: { sessionPath: string; cmd: "chat" | "kill" | "revive"; agentId: string; text?: string };
		result: { accepted: boolean; message?: string };
	};
	"agent.transcript": {
		params: { sessionPath: string; agentId: string; fromByte: number };
		result: { text: string; newSize: number; error?: string };
	};
	"session.list": { params: { cwd?: string }; result: { sessions: DesktopSessionInfo[] } };
	"session.select": { params: { path: string }; result: { header: SessionHeader; entries: SessionEntry[] } };
	"session.new": { params: { cwd: string }; result: { session: DesktopSessionInfo } };
	"session.fork": {
		params: { path: string; entryId?: string };
		result: {
			session: DesktopSessionInfo;
			selectedText?: string;
			selectedImages?: ImageContent[];
			cancelled?: boolean;
		};
	};
	"session.rename": { params: { path: string; title: string }; result: { session: DesktopSessionInfo } };
	"session.delete": { params: { path: string }; result: { deleted: boolean } };
	"session.pin": { params: { path: string; pinned: boolean }; result: { session: DesktopSessionInfo } };
	"session.tabs": { params: Record<string, never>; result: { tabs: DesktopSessionTab[] } };
	"session.activate": { params: { path: string }; result: { tabs: DesktopSessionTab[] } };
	"session.tab.close": {
		params: { path: string; force?: boolean };
		result: { closed: boolean; blockedReason?: "running" | "dirty-draft"; tabs: DesktopSessionTab[] };
	};
	"session.tab.draft": { params: { path: string; dirty: boolean }; result: { tabs: DesktopSessionTab[] } };
	"workspace.recent": { params: Record<string, never>; result: { projects: RecentProject[] } };
	"workspace.pick": { params: { initialPath?: string }; result: { rootPath?: string; cancelled: boolean } };
	"workspace.open": { params: { rootPath: string }; result: { workspace: WorkspaceDescriptor } };
	"workspace.list": { params: { workspaceId: WorkspaceId; uri?: DocumentUri }; result: { entries: WorkspaceEntry[] } };
	"workspace.read": { params: { workspaceId: WorkspaceId; uri: DocumentUri }; result: { document: DocumentSnapshot } };
	"workspace.write": {
		params: { workspaceId: WorkspaceId; uri: DocumentUri; text: string; expectedSha256: string };
		result: { stamp: FileStamp };
	};
	"workspace.stat": { params: { workspaceId: WorkspaceId; uri: DocumentUri }; result: { entry: WorkspaceEntry } };
	"workspace.create": {
		params: { workspaceId: WorkspaceId; uri: DocumentUri; directory?: boolean };
		result: { entry: WorkspaceEntry };
	};
	"workspace.rename": {
		params: { workspaceId: WorkspaceId; from: DocumentUri; to: DocumentUri };
		result: { entry: WorkspaceEntry };
	};
	"workspace.copy": {
		params: { workspaceId: WorkspaceId; from: DocumentUri; to: DocumentUri; recursive?: boolean };
		result: { entry: WorkspaceEntry };
	};
	"workspace.remove": {
		params: { workspaceId: WorkspaceId; uri: DocumentUri; mode: DeleteMode };
		result: { removed: boolean };
	};
	"workspace.reveal": { params: { workspaceId: WorkspaceId; uri: DocumentUri }; result: { revealed: boolean } };
	"workspace.search": {
		params: { workspaceId: WorkspaceId; query: SearchQuery };
		result: { results: SearchResult[] };
	};
	"git.init": { params: { workspaceId: WorkspaceId }; result: { snapshot: GitSnapshot } };
	"git.branches": { params: { workspaceId: WorkspaceId }; result: { branches: GitBranch[] } };
	"git.remotes": { params: { workspaceId: WorkspaceId }; result: { remotes: GitRemote[] } };
	"git.fetch": { params: { workspaceId: WorkspaceId; remote?: string }; result: { snapshot: GitSnapshot } };
	"git.pull": {
		params: { workspaceId: WorkspaceId; remote?: string; branch?: string };
		result: { snapshot: GitSnapshot };
	};
	"git.push": {
		params: { workspaceId: WorkspaceId; remote?: string; branch?: string; setUpstream?: boolean };
		result: { snapshot: GitSnapshot };
	};
	"git.branch.create": {
		params: { workspaceId: WorkspaceId; name: string; startPoint?: string; checkout?: boolean };
		result: { snapshot: GitSnapshot };
	};
	"git.hunk": {
		params: { workspaceId: WorkspaceId; path: string; hunkId: string; action: "stage" | "unstage" | "revert" };
		result: { snapshot: GitSnapshot };
	};
	"git.snapshot": { params: { workspaceId: WorkspaceId }; result: { snapshot: GitSnapshot } };
	"git.diff": { params: { workspaceId: WorkspaceId; path?: string; staged?: boolean }; result: { unified: string } };
	"git.stage": { params: { workspaceId: WorkspaceId; paths: string[] }; result: { snapshot: GitSnapshot } };
	"git.unstage": { params: { workspaceId: WorkspaceId; paths: string[] }; result: { snapshot: GitSnapshot } };
	"git.commit": {
		params: { workspaceId: WorkspaceId; message: string };
		result: { commit: GitCommit; snapshot: GitSnapshot };
	};
	"git.checkout": { params: { workspaceId: WorkspaceId; ref: string }; result: { snapshot: GitSnapshot } };
	"terminal.create": {
		params: { workspaceId: WorkspaceId; cols: number; rows: number };
		result: { terminalId: TerminalId };
	};
	"terminal.write": { params: { terminalId: TerminalId; data: string }; result: { accepted: boolean } };
	"terminal.resize": { params: { terminalId: TerminalId; cols: number; rows: number }; result: Record<string, never> };
	"terminal.close": { params: { terminalId: TerminalId }; result: Record<string, never> };
	"lsp.request": {
		params: {
			workspaceId: WorkspaceId;
			method: string;
			uri?: DocumentUri;
			position?: LspPosition;
			query?: string;
			newName?: string;
			range?: LspRange;
			context?: { diagnostics: LspDiagnostic[]; only?: string[] };
			includeDeclaration?: boolean;
		};
		result: { value: unknown };
	};
	"graph.snapshot": {
		params: { workspaceId: WorkspaceId; kind: "code" | "git" | "agent" };
		result: { graph: GraphSnapshot };
	};
}

export type DesktopMethod = keyof DesktopRequestMap;
export type DesktopRequest<M extends DesktopMethod = DesktopMethod> = M extends DesktopMethod
	? { t: "request"; id: RequestId; method: M; params: DesktopRequestMap[M]["params"] }
	: never;
export type DesktopResponse<M extends DesktopMethod = DesktopMethod> = M extends DesktopMethod
	? {
			t: "response";
			id: RequestId;
			method: M;
			result?: DesktopRequestMap[M]["result"];
			error?: { code: string; message: string };
		}
	: never;

export type DesktopEvent =
	| {
			t: "welcome";
			sessionPath: string;
			protocol: number;
			header: SessionHeader;
			state: SessionState & { model?: WireModel };
			agents: AgentSnapshot[];
			entryCount: number;
	  }
	| { t: "snapshot-chunk"; sessionPath: string; entries: SessionEntry[]; final: boolean }
	| { t: "entry"; sessionPath: string; entry: SessionEntry }
	| { t: "agent-event"; sessionPath: string; event: AgentEvent }
	| { t: "state"; sessionPath: string; state: SessionState & { model?: WireModel } }
	| { t: "bus"; sessionPath: string; channel: BusChannel; data: unknown }
	| { t: "agents"; sessionPath: string; agents: AgentSnapshot[] }
	| { t: "ui-request"; sessionPath: string; request: CollabUiRequest }
	| { t: "ui-request-end"; sessionPath: string; reqId: number }
	| { t: "sessions"; sessions: DesktopSessionInfo[] }
	| { t: "session-tabs"; tabs: DesktopSessionTab[] }
	| { t: "workspace-change"; workspaceId: WorkspaceId; changes: FileChange[] }
	| { t: "document"; document: DocumentSnapshot; origin: FileChange["origin"] }
	| { t: "git"; workspaceId: WorkspaceId; snapshot: GitSnapshot }
	| { t: "terminal-data"; terminalId: TerminalId; dataBase64: string }
	| { t: "terminal-exit"; terminalId: TerminalId; exitCode: number | null; signal?: string }
	| { t: "diagnostics"; workspaceId: WorkspaceId; diagnostics: LspDiagnostic[] }
	| { t: "graph"; workspaceId: WorkspaceId; kind: "code" | "git" | "agent"; graph: GraphSnapshot }
	| { t: "error"; sessionPath?: string; code: string; message: string };

export type DesktopFrame = DesktopRequest | DesktopResponse | DesktopEvent;
