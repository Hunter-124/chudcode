import type { DesktopWebSocket } from "../../../chudcode-desktop/src/web/desktop-client";

export type WorkbenchView = "chat" | "sessions" | "tasks" | "graphs";

export interface WebviewState {
	view?: WorkbenchView | "settings";
	drafts?: Record<string, string>;
	agentsOpen?: boolean;
}

interface VsCodeApi {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: WebviewState): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export type HostMessage =
	| { type: "open"; connectionId: string; rootPath: string }
	| { type: "message"; connectionId: string; data: string }
	| { type: "close"; connectionId: string; code: number; reason: string }
	| { type: "error"; connectionId?: string; message: string }
	| { type: "view"; view: WorkbenchView };

function isHostMessage(value: unknown): value is HostMessage {
	if (typeof value !== "object" || value === null || !("type" in value)) return false;
	if (value.type === "view") {
		return (
			"view" in value &&
			typeof value.view === "string" &&
			["chat", "sessions", "tasks", "graphs"].includes(value.view)
		);
	}
	if (value.type === "error") {
		return (
			"message" in value &&
			typeof value.message === "string" &&
			(!("connectionId" in value) || value.connectionId === undefined || typeof value.connectionId === "string")
		);
	}
	if (!("connectionId" in value) || typeof value.connectionId !== "string") return false;
	if (value.type === "open")
		return "rootPath" in value && typeof value.rootPath === "string" && value.rootPath.length > 0;
	if (value.type === "message") return "data" in value && typeof value.data === "string";
	return (
		value.type === "close" &&
		"code" in value &&
		typeof value.code === "number" &&
		"reason" in value &&
		typeof value.reason === "string"
	);
}

/** The only browser transport. No service URL or credential crosses this boundary. */
export class WorkbenchBridge {
	readonly #api = acquireVsCodeApi();
	readonly #sockets = new Map<string, BridgeSocket>();
	readonly #listeners = new Set<(message: HostMessage) => void>();
	#latestView: WorkbenchView | undefined;
	readonly #receive = (event: MessageEvent<unknown>): void => {
		if (!isHostMessage(event.data)) return;
		const message = event.data;
		if (message.type === "view") this.#latestView = message.view;
		if ("connectionId" in message && message.connectionId) {
			const socket = this.#sockets.get(message.connectionId);
			if (!socket) return;
			socket.receive(message);
			if (message.type === "close") return;
		}
		for (const listener of this.#listeners) listener(message);
	};

	constructor() {
		// Install before any connect message, including a synchronously ready host.
		window.addEventListener("message", this.#receive);
	}

	getState(): WebviewState {
		const state = this.#api.getState();
		if (typeof state !== "object" || state === null || Array.isArray(state)) return {};
		const value = state as WebviewState;
		const drafts: Record<string, string> = {};
		if (value.drafts && typeof value.drafts === "object") {
			for (const [path, draft] of Object.entries(value.drafts)) {
				if (typeof draft === "string") drafts[path] = draft;
			}
		}
		return {
			view: ["chat", "sessions", "tasks", "graphs", "settings"].includes(String(value.view)) ? value.view : "chat",
			drafts,
			agentsOpen: typeof value.agentsOpen === "boolean" ? value.agentsOpen : true,
		};
	}

	setState(state: WebviewState): void {
		this.#api.setState(state);
	}

	subscribe(listener: (message: HostMessage) => void): () => void {
		this.#listeners.add(listener);
		if (this.#latestView) listener({ type: "view", view: this.#latestView });
		// React may mount after DesktopClient has already opened its bridge.
		for (const socket of this.#sockets.values()) {
			if (socket.readyState === 1 && socket.rootPath !== null)
				listener({ type: "open", connectionId: socket.connectionId, rootPath: socket.rootPath });
		}
		return () => this.#listeners.delete(listener);
	}

	createSocket = (_url: string): DesktopWebSocket => {
		const connectionId = crypto.randomUUID();
		const socket = new BridgeSocket(
			connectionId,
			message => this.#api.postMessage(message),
			(code, reason) => {
				this.#sockets.delete(connectionId);
				for (const listener of this.#listeners) listener({ type: "close", connectionId, code, reason });
			},
		);
		this.#sockets.set(connectionId, socket);
		// DesktopClient installs its handlers after the factory returns.
		queueMicrotask(() => socket.connect());
		return socket;
	};

	openFile(path: string, line?: number, column?: number): void {
		this.#api.postMessage({ type: "openFile", path, line, column });
	}

	openFolder(): void {
		this.#api.postMessage({ type: "openFolder" });
	}

	dispose(): void {
		for (const socket of this.#sockets.values()) socket.close();
		window.removeEventListener("message", this.#receive);
		this.#listeners.clear();
	}
}

class BridgeSocket implements DesktopWebSocket {
	readyState: DesktopWebSocket["readyState"] = 0;
	rootPath: string | null = null;
	onopen: DesktopWebSocket["onopen"] = null;
	onmessage: DesktopWebSocket["onmessage"] = null;
	onerror: DesktopWebSocket["onerror"] = null;
	onclose: DesktopWebSocket["onclose"] = null;

	constructor(
		readonly connectionId: string,
		readonly post: (message: unknown) => void,
		readonly release: (code: number, reason: string) => void,
	) {}

	connect(): void {
		if (this.readyState === 0) this.post({ type: "connect", connectionId: this.connectionId });
	}

	send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
		if (this.readyState !== 1) throw new Error("Workbench connection is not open");
		if (typeof data !== "string") throw new Error("Desktop bridge requires text frames");
		if (new TextEncoder().encode(data).byteLength > 1024 * 1024) {
			throw new Error("Request exceeds the desktop protocol's 1 MiB limit. Remove an image or shorten the prompt.");
		}
		this.post({ type: "send", connectionId: this.connectionId, data });
	}

	close(code = 1000, reason = "client closed"): void {
		if (this.readyState === 3) return;
		this.readyState = 2;
		this.post({ type: "close", connectionId: this.connectionId });
		this.#finish(code, reason);
	}

	receive(message: HostMessage): void {
		if (this.readyState === 3) return;
		const receiver = this as unknown as WebSocket;
		if (message.type === "open" && this.readyState === 0) {
			this.readyState = 1;
			this.rootPath = message.rootPath;
			this.onopen?.call(receiver, new Event("open"));
		} else if (message.type === "message" && this.readyState === 1) {
			this.onmessage?.call(receiver, new MessageEvent("message", { data: message.data }));
		} else if (message.type === "close") {
			this.#finish(message.code, message.reason);
		} else if (message.type === "error") {
			this.onerror?.call(receiver, new Event("error"));
			this.post({ type: "close", connectionId: this.connectionId });
			this.#finish(1011, message.message);
		}
	}

	#finish(code: number, reason: string): void {
		this.readyState = 3;
		this.release(code, reason);
		this.onclose?.call(
			this as unknown as WebSocket,
			new CloseEvent("close", { code, reason, wasClean: code === 1000 }),
		);
	}
}
