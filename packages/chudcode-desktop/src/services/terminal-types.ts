import type { DesktopEvent, DesktopRequestMap, TerminalId, WorkspaceDescriptor, WorkspaceId } from "../protocol";

export const DEFAULT_TERMINAL_ENVIRONMENT_ALLOWLIST = [
	"COLORTERM",
	"COMSPEC",
	"HOME",
	"LANG",
	"LANGUAGE",
	"LC_ALL",
	"LC_CTYPE",
	"LOGNAME",
	"PATH",
	"PATHEXT",
	"SYSTEMROOT",
	"TEMP",
	"TMP",
	"TMPDIR",
	"USER",
	"USERNAME",
	"WINDIR",
	"XDG_RUNTIME_DIR",
] as const;

export type TerminalCreateParams = DesktopRequestMap["terminal.create"]["params"];
export type TerminalCreateResult = DesktopRequestMap["terminal.create"]["result"];
export type TerminalWriteParams = DesktopRequestMap["terminal.write"]["params"];
export type TerminalWriteResult = DesktopRequestMap["terminal.write"]["result"];
export type TerminalResizeParams = DesktopRequestMap["terminal.resize"]["params"];
export type TerminalResizeResult = DesktopRequestMap["terminal.resize"]["result"];
export type TerminalCloseParams = DesktopRequestMap["terminal.close"]["params"];
export type TerminalCloseResult = DesktopRequestMap["terminal.close"]["result"];

export type TerminalServiceEvent = Extract<DesktopEvent, { t: "terminal-data" | "terminal-exit" | "error" }>;
export type TerminalEventSink = (event: TerminalServiceEvent) => void | Promise<void>;

export type TerminalWorkspace = Pick<WorkspaceDescriptor, "id" | "rootPath">;
export type TerminalWorkspaceResolver = (
	workspaceId: WorkspaceId,
) => string | TerminalWorkspace | Promise<string | TerminalWorkspace>;

export interface TerminalServiceOptions {
	resolveWorkspace: TerminalWorkspaceResolver;
	emit: TerminalEventSink;
	/** Explicit shell path or executable name. No shell command string is ever evaluated. */
	shell?: string;
	/** Source consulted only for names in environmentAllowlist. Defaults to process.env. */
	inheritedEnvironment?: Readonly<Record<string, string | undefined>>;
	/** Names that may be copied from inheritedEnvironment into the shell. */
	environmentAllowlist?: readonly string[];
	/** Explicit, caller-approved values added after inherited allowlisting. */
	environment?: Readonly<Record<string, string>>;
	termName?: string;
	maxTerminals?: number;
	maxInputBytes?: number;
	maxBufferedOutputBytes?: number;
	closeGraceMs?: number;
	closeTimeoutMs?: number;
}

export interface TerminalSnapshot {
	id: TerminalId;
	workspaceId: WorkspaceId;
	cwd: string;
	pid: number;
	cols: number;
	rows: number;
	bufferedOutputBytes: number;
	closing: boolean;
}
