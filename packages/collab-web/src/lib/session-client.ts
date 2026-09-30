import type { CollabUiResponseValue, ImageContent } from "@oh-my-pi/pi-wire";
import type { GuestSnapshot, TranscriptResult } from "./client";

export type { ActiveTool, ConnectionPhase, Notice, TranscriptResult } from "./client";

/** Shared presentation shape: the relay alone supplies snapshot-download progress. */
export type SessionSnapshot = Omit<GuestSnapshot, "loading">;

export interface SessionClient {
	subscribe(listener: () => void): () => void;
	getSnapshot(): SessionSnapshot;
	sendPrompt(text: string, images?: ImageContent[]): void;
	sendAbort(): void;
	sendUiResponse(reqId: number, value?: CollabUiResponseValue): void;
	sendAgentCmd(cmd: "chat" | "kill" | "revive", agentId: string, text?: string): void;
	fetchTranscript(agentId: string, fromByte: number): Promise<TranscriptResult | null>;
}
