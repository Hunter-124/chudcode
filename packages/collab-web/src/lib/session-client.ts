import type {
	AgentSnapshot,
	AssistantMessage,
	CollabUiRequest,
	CollabUiResponseValue,
	ImageContent,
	SessionEntry,
	SessionHeader,
	SessionState,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "@oh-my-pi/pi-wire";

export type ConnectionPhase = "connecting" | "waiting" | "live" | "reconnecting" | "ended";

export interface ActiveTool {
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
	partialResult?: unknown;
	startedAt: number;
}

export interface Notice {
	id: number;
	level: "info" | "warning" | "error";
	message: string;
	at: number;
}

/** Immutable presentation state shared by relay and direct session clients. */
export interface SessionSnapshot {
	phase: ConnectionPhase;
	endedReason: string | null;
	header: SessionHeader | null;
	entries: readonly SessionEntry[];
	state: SessionState | null;
	agents: readonly AgentSnapshot[];
	/** Keyed by `payload.progress.id`. */
	progress: ReadonlyMap<string, SubagentProgressPayload>;
	/** Keyed by `payload.id`. */
	lifecycle: ReadonlyMap<string, SubagentLifecyclePayload>;
	/** Streaming assistant ghost; held until the matching entry lands. */
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	/** agent_start..agent_end, reconciled by state.isStreaming. */
	working: boolean;
	/** True when presentation commands are unavailable. */
	readOnly: boolean;
	/** Pending session UI request (`ask` select/editor) this client can answer. */
	uiRequest: CollabUiRequest | null;
	/** Capped at 50 by the relay client, newest last. */
	notices: readonly Notice[];
}

/**
 * One incremental subagent-transcript read.
 * Transient failures resolve `null`; terminal failures return `error`.
 */
export type TranscriptResult = { kind: "rows"; text: string; newSize: number } | { kind: "error"; message: string };

/** Structural presentation seam implemented by relay and direct session clients. */
export interface SessionClient {
	subscribe(listener: () => void): () => void;
	getSnapshot(): SessionSnapshot;
	sendPrompt(text: string, images?: ImageContent[]): void;
	sendAbort(): void;
	sendUiResponse(reqId: number, value?: CollabUiResponseValue): void;
	sendAgentCmd(cmd: "chat" | "kill" | "revive", agentId: string, text?: string): void;
	fetchTranscript(agentId: string, fromByte: number): Promise<TranscriptResult | null>;
}
