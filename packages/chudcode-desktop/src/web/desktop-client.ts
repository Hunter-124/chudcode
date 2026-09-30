import type { SessionClient, SessionSnapshot, TranscriptResult } from "@oh-my-pi/collab-web/session-client";
import type { CollabUiResponseValue, ImageContent } from "@oh-my-pi/pi-wire";
import {
	DESKTOP_PROTOCOL_VERSION,
	type DesktopFrame,
	type DesktopMethod,
	type DesktopRequest,
	type DesktopRequestMap,
	type DesktopResponse,
} from "../protocol";
import { DesktopStore, type DesktopStoreSnapshot } from "./desktop-store";

const OPEN = 1;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000] as const;
const DEFAULT_DRAFT_DEBOUNCE_MS = 250;

export type DesktopWebSocket = Pick<
	WebSocket,
	"readyState" | "send" | "close" | "onopen" | "onmessage" | "onerror" | "onclose"
>;

export interface DesktopLocation {
	protocol: string;
	host: string;
	search: string;
}

export interface DesktopRequestOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface DesktopClientOptions {
	/** Test/embed location seam; production uses the current browser location. */
	location?: DesktopLocation;
	webSocketFactory?: (url: string) => DesktopWebSocket;
	requestTimeoutMs?: number;
	reconnectDelaysMs?: readonly number[];
	maxReconnectAttempts?: number;
	draftDebounceMs?: number;
}

interface PendingRequest {
	method: DesktopMethod;
	params: DesktopRequestMap[DesktopMethod]["params"];
	resolve: (value: DesktopRequestMap[DesktopMethod]["result"]) => void;
	reject: (error: Error) => void;
	dispose: () => void;
}

export class DesktopClientError extends Error {
	constructor(message: string) {
		super(message);
		this.name = new.target.name;
	}
}

export class DesktopRequestError extends DesktopClientError {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

export class DesktopDisconnectedError extends DesktopClientError {}
export class DesktopClientClosedError extends DesktopClientError {}
export class DesktopRequestTimeoutError extends DesktopClientError {}
export class DesktopRequestCancelledError extends DesktopClientError {}
export class DesktopProtocolError extends DesktopClientError {}

/** Build the authenticated same-origin endpoint. HttpOnly cookie auth is automatic; a bootstrap token is preserved if present. */
export function desktopWebSocketUrl(locationValue?: DesktopLocation): string {
	const source = locationValue ?? window.location;
	if (!source) throw new Error("DesktopClient requires a browser location");
	if (!source.host) throw new Error("DesktopClient location has no host");
	const scheme = source.protocol === "https:" ? "wss:" : source.protocol === "http:" ? "ws:" : null;
	if (!scheme) throw new Error(`DesktopClient cannot connect from ${source.protocol}`);
	const url = new URL(`${scheme}//${source.host}/ws`);
	const token = new URLSearchParams(source.search).get("token");
	if (token) url.searchParams.set("token", token);
	return url.toString();
}

/** Direct loopback client: desktop RPC correlation plus a collab-compatible session replica. */
export class DesktopClient implements SessionClient {
	readonly #store = new DesktopStore();
	readonly #wsUrl: string;
	readonly #webSocketFactory: (url: string) => DesktopWebSocket;
	readonly #requestTimeoutMs: number;
	readonly #reconnectDelaysMs: readonly number[];
	readonly #maxReconnectAttempts: number;
	readonly #pending = new Map<number, PendingRequest>();
	readonly #draftUpdates = new Map<string, boolean>();
	#socket: DesktopWebSocket | null = null;
	#socketGeneration = 0;
	#requestSequence = 0;
	#reconnectAttempts = 0;
	#reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	#draftTimer: ReturnType<typeof setTimeout> | null = null;
	#closed = true;
	#everOpened = false;
	readonly #draftDebounceMs: number;
	readonly #beforeUnload = () => {
		void this.flushSessionDrafts();
	};
	constructor(options: DesktopClientOptions = {}) {
		this.#wsUrl = desktopWebSocketUrl(options.location);
		this.#webSocketFactory = options.webSocketFactory ?? (url => new WebSocket(url));
		this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.#reconnectDelaysMs = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
		this.#maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_RECONNECT_DELAYS_MS.length;
		this.#draftDebounceMs = options.draftDebounceMs ?? DEFAULT_DRAFT_DEBOUNCE_MS;
		if (!Number.isFinite(this.#requestTimeoutMs) || this.#requestTimeoutMs <= 0) {
			throw new Error("requestTimeoutMs must be positive");
		}
		if (!Number.isInteger(this.#maxReconnectAttempts) || this.#maxReconnectAttempts < 0) {
			throw new Error("maxReconnectAttempts must be a non-negative integer");
		}
		if (this.#reconnectDelaysMs.some(delay => !Number.isFinite(delay) || delay < 0)) {
			throw new Error("reconnectDelaysMs must contain only non-negative delays");
		}
		if (!Number.isFinite(this.#draftDebounceMs) || this.#draftDebounceMs < 0) {
			throw new Error("draftDebounceMs must be non-negative");
		}
		if (typeof window !== "undefined") window.addEventListener("beforeunload", this.#beforeUnload);
	}

	connect(): void {
		if (!this.#closed && (this.#socket || this.#reconnectTimer)) return;
		this.#closed = false;
		if (typeof window !== "undefined") window.addEventListener("beforeunload", this.#beforeUnload);
		this.#reconnectAttempts = 0;
		this.#clearReconnectTimer();
		this.#store.setConnectionPhase("connecting");
		this.#openSocket(false);
	}

	close(): void {
		if (this.#closed && !this.#socket && !this.#reconnectTimer) return;
		void this.flushSessionDrafts();
		this.#closed = true;
		this.#clearReconnectTimer();
		this.#clearDraftTimer();
		if (typeof window !== "undefined") window.removeEventListener("beforeunload", this.#beforeUnload);
		this.#socketGeneration += 1;
		const socket = this.#socket;
		this.#socket = null;
		this.#rejectAll(new DesktopClientClosedError("Desktop client closed"));
		this.#store.setConnectionPhase("ended", "client closed");
		if (socket) socket.close(1000, "client closed");
	}

	subscribe = (listener: () => void): (() => void) => this.#store.subscribe(listener);

	getSnapshot = (): SessionSnapshot => this.#store.getSnapshot().session;

	getDesktopSnapshot = (): DesktopStoreSnapshot => this.#store.getSnapshot();

	request<M extends DesktopMethod>(
		method: M,
		params: DesktopRequestMap[M]["params"],
		options: DesktopRequestOptions = {},
	): Promise<DesktopRequestMap[M]["result"]> {
		if (this.#closed) return Promise.reject(new DesktopClientClosedError("Desktop client is closed"));
		const socket = this.#socket;
		if (!socket || socket.readyState !== OPEN) {
			return Promise.reject(new DesktopDisconnectedError("Desktop WebSocket is not connected"));
		}
		if (options.signal?.aborted) {
			return Promise.reject(new DesktopRequestCancelledError("Desktop request was cancelled"));
		}

		const id = ++this.#requestSequence;
		const timeoutMs = options.timeoutMs ?? this.#requestTimeoutMs;
		const { promise, resolve, reject } = Promise.withResolvers<DesktopRequestMap[M]["result"]>();
		let timer: ReturnType<typeof setTimeout> | null = null;
		let abortListener: (() => void) | null = null;
		const dispose = () => {
			if (timer !== null) clearTimeout(timer);
			if (abortListener && options.signal) options.signal.removeEventListener("abort", abortListener);
			timer = null;
			abortListener = null;
		};
		const resolvePending: PendingRequest["resolve"] = value => {
			// The pending map erases M; method equality is checked again before this callback is used.
			resolve(value as DesktopRequestMap[M]["result"]);
		};
		const pending: PendingRequest = {
			method,
			params: params as DesktopRequestMap[DesktopMethod]["params"],
			resolve: resolvePending,
			reject,
			dispose,
		};
		this.#pending.set(id, pending);
		timer = setTimeout(() => {
			if (!this.#pending.delete(id)) return;
			dispose();
			reject(new DesktopRequestTimeoutError(`Desktop request ${method} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		if (options.signal) {
			abortListener = () => {
				if (!this.#pending.delete(id)) return;
				dispose();
				reject(new DesktopRequestCancelledError(`Desktop request ${method} was cancelled`));
			};
			options.signal.addEventListener("abort", abortListener, { once: true });
		}

		const frame: DesktopRequest<M> = { t: "request", id, method, params } as DesktopRequest<M>;
		try {
			socket.send(JSON.stringify(frame));
		} catch (error) {
			this.#pending.delete(id);
			dispose();
			reject(
				new DesktopDisconnectedError(
					`Failed to send desktop request ${method}: ${error instanceof Error ? error.message : String(error)}`,
				),
			);
		}
		return promise;
	}

	sendPrompt(text: string, images?: ImageContent[]): void {
		const sessionPath = this.#requireActiveSession("prompt");
		if (!sessionPath) return;
		const params = images && images.length > 0 ? { sessionPath, text, images } : { sessionPath, text };
		this.#reportCommandFailure("prompt", this.request("prompt.send", params), sessionPath);
	}

	sendAbort(): void {
		const sessionPath = this.#requireActiveSession("abort");
		if (!sessionPath) return;
		this.#reportCommandFailure("abort", this.request("run.abort", { sessionPath }), sessionPath);
	}

	sendUiResponse(reqId: number, value?: CollabUiResponseValue): void {
		const sessionPath = this.#requireActiveSession("UI response");
		if (!sessionPath) return;
		this.#store.acknowledgeUiRequest(sessionPath, reqId);
		this.#reportCommandFailure("UI response", this.request("ui.respond", { sessionPath, reqId, value }), sessionPath);
	}

	sendAgentCmd(cmd: "chat" | "kill" | "revive", agentId: string, text?: string): void {
		const sessionPath = this.#requireActiveSession("agent command");
		if (!sessionPath) return;
		const command = this.request("agent.command", { sessionPath, cmd, agentId, text }).then(result => {
			if (!result.accepted) {
				this.#store.pushNotice("warning", result.message ?? `Agent command ${cmd} was rejected`, sessionPath);
			}
		});
		this.#reportCommandFailure("agent command", command, sessionPath);
	}

	async fetchTranscript(agentId: string, fromByte: number): Promise<TranscriptResult | null> {
		const sessionPath = this.#requireActiveSession("agent transcript");
		if (!sessionPath) return { kind: "error", message: "No active session" };
		try {
			const result = await this.request("agent.transcript", { sessionPath, agentId, fromByte });
			return result.error !== undefined
				? { kind: "error", message: result.error }
				: { kind: "rows", text: result.text, newSize: result.newSize };
		} catch (error) {
			if (
				error instanceof DesktopDisconnectedError ||
				error instanceof DesktopClientClosedError ||
				error instanceof DesktopRequestTimeoutError ||
				error instanceof DesktopRequestCancelledError
			) {
				return null;
			}
			return { kind: "error", message: error instanceof Error ? error.message : String(error) };
		}
	}

	activateSession(path: string): Promise<DesktopRequestMap["session.activate"]["result"]> {
		return this.request("session.activate", { path });
	}

	openSession(path: string): Promise<DesktopRequestMap["session.activate"]["result"]> {
		return this.request("session.activate", { path });
	}

	async closeSession(path: string, force = false): Promise<DesktopRequestMap["session.tab.close"]["result"]> {
		if (this.#draftUpdates.has(path)) await this.#flushSessionDraft(path);
		return this.request("session.tab.close", force ? { path, force: true } : { path });
	}

	setSessionDraft(path: string, dirty: boolean): void {
		this.#draftUpdates.set(path, dirty);
		this.#store.setSessionDraftDirty(path, dirty);
		this.#clearDraftTimer();
		this.#draftTimer = setTimeout(() => {
			this.#draftTimer = null;
			void this.flushSessionDrafts();
		}, this.#draftDebounceMs);
	}

	async flushSessionDrafts(): Promise<void> {
		this.#clearDraftTimer();
		const paths = [...this.#draftUpdates.keys()];
		const results = await Promise.allSettled(paths.map(path => this.#flushSessionDraft(path)));
		for (let index = 0; index < results.length; index += 1) {
			const result = results[index];
			const path = paths[index];
			if (result?.status === "rejected" && path) {
				this.#store.pushNotice(
					"error",
					`draft state failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
					path,
				);
			}
		}
	}

	#openSocket(reconnecting: boolean): void {
		if (this.#closed) return;
		let socket: DesktopWebSocket;
		try {
			socket = this.#webSocketFactory(this.#wsUrl);
		} catch (error) {
			this.#scheduleReconnect(
				`WebSocket creation failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		this.#socket = socket;
		const generation = ++this.#socketGeneration;
		socket.onopen = () => {
			if (!this.#isCurrent(socket, generation)) return;
			const wasOpened = this.#everOpened || reconnecting;
			this.#everOpened = true;
			this.#store.setConnectionPhase(wasOpened ? "reconnecting" : "waiting");
			this.request("runtime.hello", { protocol: DESKTOP_PROTOCOL_VERSION })
				.then(hello => {
					if (!this.#isCurrent(socket, generation)) return;
					if (hello.protocol !== DESKTOP_PROTOCOL_VERSION) {
						this.#fatal(
							`Desktop protocol mismatch: client v${DESKTOP_PROTOCOL_VERSION}, runtime v${hello.protocol}`,
						);
						return;
					}
					this.#reconnectAttempts = 0;
					void this.request("session.tabs", {})
						.then(() => this.flushSessionDrafts())
						.catch(error => {
							if (!this.#isCurrent(socket, generation)) return;
							this.#store.pushNotice(
								"error",
								`session tabs failed: ${error instanceof Error ? error.message : String(error)}`,
							);
						});
				})
				.catch(error => {
					if (!this.#isCurrent(socket, generation)) return;
					if (error instanceof DesktopRequestError && error.code === "PROTOCOL_MISMATCH") {
						this.#fatal(error.message);
						return;
					}
					try {
						socket.close(1011, "runtime hello failed");
					} catch {
						this.#handleClose(socket, generation, error instanceof Error ? error.message : String(error));
					}
				});
		};
		socket.onmessage = event => {
			if (!this.#isCurrent(socket, generation)) return;
			this.#handleMessage(event.data);
		};
		socket.onerror = () => {
			// Browsers intentionally hide socket error detail. The close event owns recovery.
		};
		socket.onclose = event => {
			this.#handleClose(socket, generation, event.reason || `WebSocket closed (${event.code})`);
		};
	}

	#handleMessage(data: unknown): void {
		if (typeof data !== "string") {
			this.#store.pushNotice("error", "Desktop runtime sent a non-text frame");
			return;
		}
		let frame: DesktopFrame;
		try {
			const value: unknown = JSON.parse(data);
			if (!isDesktopFrame(value)) throw new Error("unknown desktop frame");
			frame = value;
		} catch (error) {
			this.#store.pushNotice(
				"error",
				`Failed to decode desktop frame: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		if (frame.t === "response") {
			this.#handleResponse(frame);
			return;
		}
		if (frame.t === "request") {
			this.#store.pushNotice("error", "Desktop runtime sent an unexpected request frame");
			return;
		}
		if (frame.t === "welcome" && frame.protocol !== DESKTOP_PROTOCOL_VERSION) {
			this.#fatal(`Desktop protocol mismatch: client v${DESKTOP_PROTOCOL_VERSION}, runtime v${frame.protocol}`);
			return;
		}
		try {
			this.#store.applyEvent(frame);
		} catch (error) {
			this.#store.pushNotice(
				"error",
				`Failed to apply ${frame.t} frame: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	#handleResponse(frame: DesktopResponse): void {
		const pending = this.#pending.get(frame.id);
		if (!pending) return;
		this.#pending.delete(frame.id);
		pending.dispose();
		if (pending.method !== frame.method) {
			const error = new DesktopProtocolError(
				`Desktop response ${frame.id} expected ${pending.method}, received ${frame.method}`,
			);
			pending.reject(error);
			this.#fatal(error.message);
			return;
		}
		if (frame.error) {
			pending.reject(new DesktopRequestError(frame.error.code, frame.error.message));
			return;
		}
		if (frame.result === undefined) {
			pending.reject(new DesktopProtocolError(`Desktop response ${frame.id} has no result`));
			return;
		}
		this.#store.applyResponse(pending.method, pending.params, frame.result);
		pending.resolve(frame.result);
	}

	#handleClose(socket: DesktopWebSocket, generation: number, reason: string): void {
		if (!this.#isCurrent(socket, generation)) return;
		this.#socket = null;
		this.#rejectAll(new DesktopDisconnectedError(reason));
		if (this.#closed) return;
		this.#scheduleReconnect(reason);
	}

	#scheduleReconnect(reason: string): void {
		if (this.#closed || this.#reconnectTimer) return;
		if (this.#reconnectAttempts >= this.#maxReconnectAttempts) {
			this.#closed = true;
			this.#store.setConnectionPhase("ended", reason);
			return;
		}
		this.#store.setConnectionPhase("reconnecting");
		const delay =
			this.#reconnectDelaysMs.length === 0
				? 0
				: (this.#reconnectDelaysMs[Math.min(this.#reconnectAttempts, this.#reconnectDelaysMs.length - 1)] ?? 0);
		this.#reconnectAttempts += 1;
		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = null;
			this.#openSocket(true);
		}, delay);
	}

	#fatal(reason: string): void {
		this.#closed = true;
		this.#clearReconnectTimer();
		const socket = this.#socket;
		this.#socket = null;
		this.#socketGeneration += 1;
		this.#rejectAll(new DesktopProtocolError(reason));
		this.#store.setConnectionPhase("ended", reason);
		if (socket) socket.close(1002, reason.slice(0, 123));
	}

	#rejectAll(error: Error): void {
		for (const pending of this.#pending.values()) {
			pending.dispose();
			pending.reject(error);
		}
		this.#pending.clear();
	}

	#requireActiveSession(label: string): string | null {
		const sessionPath = this.#store.getSnapshot().activeSessionPath;
		if (sessionPath) return sessionPath;
		this.#store.pushNotice("error", `${label} failed: No active session`);
		return null;
	}

	async #flushSessionDraft(sessionPath: string): Promise<void> {
		const dirty = this.#draftUpdates.get(sessionPath);
		if (dirty === undefined) return;
		await this.request("session.tab.draft", { path: sessionPath, dirty });
		if (this.#draftUpdates.get(sessionPath) === dirty) this.#draftUpdates.delete(sessionPath);
	}

	#reportCommandFailure(label: string, promise: Promise<unknown>, sessionPath: string): void {
		void promise.catch(error => {
			this.#store.pushNotice(
				"error",
				`${label} failed: ${error instanceof Error ? error.message : String(error)}`,
				sessionPath,
			);
		});
	}

	#isCurrent(socket: DesktopWebSocket, generation: number): boolean {
		return !this.#closed && this.#socket === socket && this.#socketGeneration === generation;
	}

	#clearDraftTimer(): void {
		const timer = this.#draftTimer;
		if (timer === null) return;
		this.#draftTimer = null;
		clearTimeout(timer);
	}

	#clearReconnectTimer(): void {
		if (this.#reconnectTimer === null) return;
		clearTimeout(this.#reconnectTimer);
		this.#reconnectTimer = null;
	}
}

function isDesktopFrame(value: unknown): value is DesktopFrame {
	if (!value || typeof value !== "object" || !("t" in value)) return false;
	const type = value.t;
	return (
		type === "request" ||
		type === "response" ||
		type === "welcome" ||
		type === "snapshot-chunk" ||
		type === "entry" ||
		type === "agent-event" ||
		type === "state" ||
		type === "bus" ||
		type === "agents" ||
		type === "ui-request" ||
		type === "ui-request-end" ||
		type === "sessions" ||
		type === "session-tabs" ||
		type === "workspace-change" ||
		type === "document" ||
		type === "git" ||
		type === "terminal-data" ||
		type === "terminal-exit" ||
		type === "diagnostics" ||
		type === "graph" ||
		type === "error"
	);
}
