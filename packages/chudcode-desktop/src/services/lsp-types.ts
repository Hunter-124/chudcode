import type {
	CodeAction,
	CodeActionContext,
	Diagnostic,
	Location,
	LocationLink,
	Position,
	PublishDiagnosticsParams,
	Range,
	TextEdit,
	WorkspaceEdit,
} from "@oh-my-pi/pi-coding-agent/lsp/types";
import type { LspDiagnostic as DesktopLspDiagnostic, DesktopRequestMap } from "../protocol";

export type {
	CodeAction,
	CodeActionContext,
	DesktopLspDiagnostic,
	Diagnostic,
	Location,
	LocationLink,
	Position,
	PublishDiagnosticsParams,
	Range,
	TextEdit,
	WorkspaceEdit,
};
export type DesktopLspRequestParams = DesktopRequestMap["lsp.request"]["params"];

export interface LspLanguageSelector {
	/** LSP language id sent in textDocument/didOpen. */
	languageId: string;
	/** Lower-case extensions, with or without the leading dot. */
	extensions: string[];
}

export interface LspRestartPolicy {
	/** Number of replacement processes allowed after the initial process. */
	maxRestarts: number;
	/** Sliding window used to forget old crashes. */
	windowMs: number;
	/** Base delay before a replacement process is started. */
	backoffMs: number;
	/** Maximum delay even after repeated crashes. */
	maxBackoffMs?: number;
}

/**
 * A language-server command loaded from trusted, host-local settings.
 *
 * This object is never accepted from the desktop wire protocol. The broker is
 * constructed with a trusted loader and always spawns `command` plus `args` as
 * an argv array; no shell parses either value.
 */
export interface TrustedLspServerSpec {
	id: string;
	command: string;
	args?: string[];
	languages: LspLanguageSelector[];
	initializationOptions?: unknown;
	settings?: unknown;
	env?: Record<string, string>;
	requestTimeoutMs?: number;
	initializeTimeoutMs?: number;
	restart?: Partial<LspRestartPolicy>;
}

export interface LspWorkspaceSpec {
	id: string;
	rootPath: string;
}

export interface LspDocument {
	uri: string;
	languageId: string;
	text: string;
}

export interface TextDocumentContentChangeEvent {
	range?: Range;
	rangeLength?: number;
	text: string;
}

export interface LspRequestOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

export type LspDefinitionResult = Location | Location[] | LocationLink[] | null;
export type LspReferencesResult = Location[] | null;

export type LspBrokerRequest =
	| { method: "completion"; uri: string; position: Position; context?: unknown }
	| { method: "hover"; uri: string; position: Position }
	| { method: "definition"; uri: string; position: Position }
	| { method: "references"; uri: string; position: Position; includeDeclaration?: boolean }
	| { method: "documentSymbols"; uri: string }
	| { method: "workspaceSymbols"; query: string }
	| { method: "codeActions"; uri: string; range: Range; context: CodeActionContext }
	| { method: "rename"; uri: string; position: Position; newName: string };

export interface LspBrokerDiagnosticsEvent {
	workspaceId: string;
	serverId: string;
	params: PublishDiagnosticsParams;
}

export interface LspServerExitEvent {
	code: number | null;
	expected: boolean;
	stderr: string;
}

export interface LspClientNotification {
	method: string;
	params?: unknown;
}

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number | string;
	method: string;
	params?: unknown;
}

export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: number | string;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;
