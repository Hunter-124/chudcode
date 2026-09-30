import { describe, expect, it, vi } from "bun:test";
import type { SessionClient } from "@oh-my-pi/collab-web/session-client";
import type { AgentSnapshot, ImageContent, SessionEntry, SessionHeader, SessionState } from "@oh-my-pi/pi-wire";
import type {
	DesktopFrame,
	DesktopRequest,
	DesktopResponse,
	DesktopSessionTab,
	GitSnapshot,
	GraphSnapshot,
} from "../src/protocol";
import {
	DesktopClient,
	DesktopClientClosedError,
	DesktopDisconnectedError,
	DesktopRequestCancelledError,
	DesktopRequestError,
	DesktopRequestTimeoutError,
	type DesktopWebSocket,
	desktopWebSocketUrl,
} from "../src/web/desktop-client";
import {
	DesktopStore,
	MAX_TERMINAL_OUTPUT_BYTES,
	MAX_TERMINAL_OUTPUT_CHUNKS,
	TerminalDataDecodeError,
} from "../src/web/desktop-store";

const SESSION_A = "/sessions/a.jsonl";
const SESSION_B = "/sessions/b.jsonl";
const HEADER: SessionHeader = {
	type: "session",
	id: "session-1",
	timestamp: "2026-08-27T00:00:00.000Z",
	cwd: "/work",
};
const STATE: SessionState = {
	isStreaming: false,
	queuedMessageCount: 0,
	cwd: "/work",
	participants: [{ name: "desktop", role: "host" }],
};
const AGENTS: AgentSnapshot[] = [
	{
		id: "main",
		displayName: "Main",
		kind: "main",
		status: "running",
		hasSessionFile: true,
		createdAt: 1,
		lastActivity: 2,
	},
];
const GIT: GitSnapshot = {
	root: "/work",
	branch: "main",
	ahead: 0,
	behind: 0,
	files: [],
	commits: [],
};
const GRAPH: GraphSnapshot = { revision: 1, nodes: [], edges: [] };

function entry(id: string): SessionEntry {
	return {
		type: "custom_message",
		id,
		parentId: null,
		timestamp: "2026-08-27T00:00:00.000Z",
		customType: "test",
		content: id,
		display: true,
	};
}

function terminalData(terminalId: string, data: Uint8Array): Extract<DesktopFrame, { t: "terminal-data" }> {
	return {
		t: "terminal-data",
		terminalId,
		dataBase64: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64"),
	};
}

class FakeWebSocket {
	readyState = 0;
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent<string>) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	readonly sent: string[] = [];

	send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
		if (this.readyState !== 1) throw new Error("socket is not open");
		if (typeof data !== "string") throw new Error("fake accepts text only");
		this.sent.push(data);
	}

	close(code = 1000, reason = "closed"): void {
		if (this.readyState === 3) return;
		this.readyState = 3;
		const event = { code, reason, wasClean: code === 1000 } as CloseEvent;
		this.onclose?.(event);
	}

	open(): void {
		this.readyState = 1;
		this.onopen?.(new Event("open"));
	}

	receive(frame: DesktopFrame): void {
		const event = { data: JSON.stringify(frame) } as MessageEvent<string>;
		this.onmessage?.(event);
	}

	disconnect(code = 1006, reason = "connection lost"): void {
		this.close(code, reason);
	}

	frames(): DesktopRequest[] {
		return this.sent.map(json => JSON.parse(json) as DesktopRequest);
	}
}

function harness(
	options: { reconnectDelaysMs?: readonly number[]; maxReconnectAttempts?: number; requestTimeoutMs?: number } = {},
) {
	const sockets: FakeWebSocket[] = [];
	const urls: string[] = [];
	const client = new DesktopClient({
		location: { protocol: "http:", host: "127.0.0.1:4321", search: "?token=secret" },
		webSocketFactory: url => {
			urls.push(url);
			const socket = new FakeWebSocket();
			sockets.push(socket);
			return socket as DesktopWebSocket;
		},
		reconnectDelaysMs: options.reconnectDelaysMs ?? [100],
		maxReconnectAttempts: options.maxReconnectAttempts ?? 1,
		requestTimeoutMs: options.requestTimeoutMs ?? 1_000,
	});
	client.connect();
	return { client, sockets, urls };
}

function completeHello(socket: FakeWebSocket): DesktopRequest<"runtime.hello"> {
	socket.open();
	const hello = socket.frames()[0] as DesktopRequest<"runtime.hello">;
	socket.receive({
		t: "response",
		id: hello.id,
		method: "runtime.hello",
		result: { protocol: 1, product: "Chudcode" },
	});
	return hello;
}

function welcome(sessionPath = SESSION_A, entryCount = 0, header = HEADER): DesktopFrame {
	return { t: "welcome", sessionPath, protocol: 1, header, state: STATE, agents: AGENTS, entryCount };
}

function tabs(
	activePath = SESSION_A,
	overrides: Partial<Record<string, Partial<DesktopSessionTab>>> = {},
): DesktopSessionTab[] {
	return [SESSION_A, SESSION_B].map(path => ({
		path,
		title: path === SESSION_A ? "Alpha" : "Beta",
		cwd: "/work",
		active: path === activePath,
		running: false,
		unread: 0,
		draftDirty: false,
		...overrides[path],
	}));
}

describe("DesktopClient bootstrap and replica", () => {
	it("derives the authenticated same-origin WebSocket URL and checks runtime.hello", () => {
		expect(desktopWebSocketUrl({ protocol: "https:", host: "localhost:8443", search: "?token=a%2Fb&x=1" })).toBe(
			"wss://localhost:8443/ws?token=a%2Fb",
		);
		const { client, sockets, urls } = harness();
		const socket = sockets[0];
		expect(socket).toBeDefined();
		completeHello(socket!);
		expect(urls).toEqual(["ws://127.0.0.1:4321/ws?token=secret"]);
		expect(socket!.frames()[0]).toEqual({ t: "request", id: 1, method: "runtime.hello", params: { protocol: 1 } });
		client.close();
	});

	it("ends the connection when runtime.hello reports a different protocol", async () => {
		const { client, sockets } = harness();
		const socket = sockets[0]!;
		socket.open();
		const hello = socket.frames()[0] as DesktopRequest<"runtime.hello">;
		socket.receive({
			t: "response",
			id: hello.id,
			method: "runtime.hello",
			result: { protocol: 2, product: "Chudcode" },
		});
		await Promise.resolve();
		expect(client.getSnapshot().phase).toBe("ended");
		expect(client.getSnapshot().endedReason).toContain("protocol mismatch");
	});

	it("applies welcome, chunks, entries, agent events, state, bus, agents, and UI requests in arrival order", () => {
		const { client, sockets } = harness();
		const socket = sockets[0]!;
		completeHello(socket);
		const revisions: number[] = [];
		const unsubscribe = client.subscribe(() => revisions.push(client.getDesktopSnapshot().revision));
		socket.receive(welcome(SESSION_A, 2));
		socket.receive({ t: "snapshot-chunk", sessionPath: SESSION_A, entries: [entry("one")], final: false });
		socket.receive({ t: "agent-event", sessionPath: SESSION_A, event: { type: "agent_start" } });
		socket.receive({ t: "snapshot-chunk", sessionPath: SESSION_A, entries: [entry("two")], final: true });
		socket.receive({ t: "entry", sessionPath: SESSION_A, entry: entry("three") });
		socket.receive({
			t: "state",
			sessionPath: SESSION_A,
			state: { ...STATE, isStreaming: false, queuedMessageCount: 1 },
		});
		socket.receive({
			t: "bus",
			sessionPath: SESSION_A,
			channel: "task:subagent:lifecycle",
			data: { id: "sub-1", agent: "task", status: "started", index: 0 },
		});
		socket.receive({
			t: "agents",
			sessionPath: SESSION_A,
			agents: [{ ...AGENTS[0]!, status: "idle" }],
		});
		socket.receive({
			t: "ui-request",
			sessionPath: SESSION_A,
			request: { reqId: 9, kind: "select", title: "Choose", options: ["one"] },
		});

		const snapshot = client.getSnapshot();
		expect(snapshot.phase).toBe("live");
		expect(snapshot.entries.map(item => item.id)).toEqual(["one", "two", "three"]);
		expect(snapshot.working).toBe(false);
		expect(snapshot.state?.queuedMessageCount).toBe(1);
		expect(snapshot.lifecycle.get("sub-1")?.status).toBe("started");
		expect(snapshot.agents[0]?.status).toBe("idle");
		expect(snapshot.uiRequest?.reqId).toBe(9);
		expect(revisions.every((revision, index) => index === 0 || revision > revisions[index - 1]!)).toBe(true);
		unsubscribe();
		client.close();
	});

	it("stores IDE events and successful response slices immutably", async () => {
		const { client, sockets } = harness();
		const socket = sockets[0]!;
		completeHello(socket);
		socket.receive(welcome());
		const before = client.getDesktopSnapshot();
		const opened = client.request("workspace.open", { rootPath: "/work" });
		const openRequest = socket.frames().at(-1)!;
		socket.receive({
			t: "response",
			id: openRequest.id,
			method: "workspace.open",
			result: { workspace: { id: "workspace-1", rootPath: "/work", displayName: "work" } },
		});
		await opened;
		socket.receive({ t: "git", workspaceId: "workspace-1", snapshot: GIT });
		socket.receive(terminalData("terminal-1", new TextEncoder().encode("hello")));
		socket.receive({ t: "terminal-exit", terminalId: "terminal-1", exitCode: 0 });
		socket.receive({ t: "diagnostics", workspaceId: "workspace-1", diagnostics: [] });
		socket.receive({ t: "graph", workspaceId: "workspace-1", kind: "code", graph: GRAPH });
		socket.receive({
			t: "workspace-change",
			workspaceId: "workspace-1",
			changes: [{ kind: "modified", uri: "file:///work/a.ts", origin: "agent" }],
		});
		const after = client.getDesktopSnapshot();
		expect(after).not.toBe(before);
		expect(after.workspaces).not.toBe(before.workspaces);
		expect(after.workspaces.get("workspace-1")?.displayName).toBe("work");
		expect(after.git.get("workspace-1")).toEqual(GIT);
		expect(after.terminals.get("terminal-1")).toMatchObject({
			byteLength: 5,
			nextSequence: 1,
			closed: true,
			exitCode: 0,
		});
		expect([...after.terminals.get("terminal-1")!.chunks[0]!.data]).toEqual([104, 101, 108, 108, 111]);
		expect(after.diagnostics.get("workspace-1")).toEqual([]);
		expect(after.graphs.get("workspace-1:code")).toEqual(GRAPH);
		expect(after.workspaceChanges.get("workspace-1")?.[0]?.origin).toBe("agent");
		client.close();
	});

	it("preserves binary, split UTF-8, and ANSI bytes as ordered immutable chunks", () => {
		const { client, sockets } = harness();
		const socket = sockets[0]!;
		completeHello(socket);
		socket.receive(welcome());
		const chunks = [
			Uint8Array.from([0x00, 0xff, 0x7f]),
			Uint8Array.from([0xe2]),
			Uint8Array.from([0x82, 0xac]),
			Uint8Array.from([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x1b, 0x5b, 0x30, 0x6d]),
		];
		for (const chunk of chunks.slice(0, 2)) socket.receive(terminalData("terminal-binary", chunk));
		const earlier = client.getDesktopSnapshot().terminals.get("terminal-binary")!;
		for (const chunk of chunks.slice(2)) socket.receive(terminalData("terminal-binary", chunk));

		const terminal = client.getDesktopSnapshot().terminals.get("terminal-binary")!;
		expect(terminal.byteLength).toBe(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
		expect(terminal.nextSequence).toBe(chunks.length);
		expect(terminal.chunks.map(chunk => chunk.sequence)).toEqual([0, 1, 2, 3]);
		expect(terminal.chunks.map(chunk => [...chunk.data])).toEqual(chunks.map(chunk => [...chunk]));
		expect(terminal.chunks).not.toBe(earlier.chunks);
		expect(earlier.chunks.map(chunk => [...chunk.data])).toEqual(chunks.slice(0, 2).map(chunk => [...chunk]));
		client.close();
	});

	it("bounds retained terminal bytes and chunk metadata to the newest exact suffix", () => {
		const store = new DesktopStore();
		const bytes = Uint8Array.from({ length: MAX_TERMINAL_OUTPUT_BYTES + 7 }, (_, index) => index % 251);
		store.applyEvent(terminalData("terminal-bounded", bytes));

		const terminal = store.getSnapshot().terminals.get("terminal-bounded")!;
		expect(terminal.byteLength).toBe(MAX_TERMINAL_OUTPUT_BYTES);
		expect(terminal.chunks).toHaveLength(1);
		expect(terminal.chunks[0]!.data.slice(0, 4)).toEqual(bytes.slice(7, 11));
		expect(terminal.chunks[0]!.data.slice(-4)).toEqual(bytes.slice(-4));

		const chunkBoundStore = new DesktopStore();
		for (let sequence = 0; sequence <= MAX_TERMINAL_OUTPUT_CHUNKS; sequence += 1) {
			chunkBoundStore.applyEvent(terminalData("terminal-chunk-bounded", Uint8Array.of(sequence & 0xff)));
		}
		const chunkBounded = chunkBoundStore.getSnapshot().terminals.get("terminal-chunk-bounded")!;
		expect(chunkBounded.chunks).toHaveLength(MAX_TERMINAL_OUTPUT_CHUNKS);
		expect(chunkBounded.chunks[0]?.sequence).toBe(1);
		expect(chunkBounded.nextSequence).toBe(MAX_TERMINAL_OUTPUT_CHUNKS + 1);
	});

	it("rejects invalid terminal base64 with a typed error and leaves output untouched", () => {
		const store = new DesktopStore();
		store.applyEvent(terminalData("terminal-invalid", Uint8Array.from([0x00, 0xff])));
		const before = store.getSnapshot();
		let thrown: unknown;
		try {
			store.applyEvent({ t: "terminal-data", terminalId: "terminal-invalid", dataBase64: "not/base64!" });
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(TerminalDataDecodeError);
		expect(thrown).toMatchObject({
			code: "INVALID_TERMINAL_DATA_BASE64",
			terminalId: "terminal-invalid",
		});
		expect(store.getSnapshot()).toBe(before);
		expect(
			store
				.getSnapshot()
				.terminals.get("terminal-invalid")
				?.chunks.map(chunk => [...chunk.data]),
		).toEqual([[0x00, 0xff]]);
	});
});

describe("DesktopClient request lifecycle", () => {
	it("correlates out-of-order responses and rejects typed runtime errors", async () => {
		const { client, sockets } = harness();
		const socket = sockets[0]!;
		completeHello(socket);
		const workspace = client.request("workspace.open", { rootPath: "/work" });
		const git = client.request("git.snapshot", { workspaceId: "workspace-1" });
		const search = client.request("workspace.search", {
			workspaceId: "workspace-1",
			query: { text: "needle", kind: "content" },
		});
		const [workspaceRequest, gitRequest, searchRequest] = socket.frames().slice(-3);
		socket.receive({ t: "response", id: gitRequest!.id, method: "git.snapshot", result: { snapshot: GIT } });
		socket.receive({
			t: "response",
			id: searchRequest!.id,
			method: "workspace.search",
			error: { code: "SEARCH_FAILED", message: "index unavailable" },
		});
		socket.receive({
			t: "response",
			id: workspaceRequest!.id,
			method: "workspace.open",
			result: { workspace: { id: "workspace-1", rootPath: "/work", displayName: "work" } },
		});
		expect(await git).toEqual({ snapshot: GIT });
		expect(await workspace).toEqual({
			workspace: { id: "workspace-1", rootPath: "/work", displayName: "work" },
		});
		try {
			await search;
			throw new Error("search should reject");
		} catch (error) {
			expect(error).toBeInstanceOf(DesktopRequestError);
			expect((error as DesktopRequestError).code).toBe("SEARCH_FAILED");
		}
		client.close();
	});

	it("rejects pending requests on disconnect and close", async () => {
		const disconnectedHarness = harness();
		const disconnectedSocket = disconnectedHarness.sockets[0]!;
		completeHello(disconnectedSocket);
		const disconnected = disconnectedHarness.client.request("terminal.create", {
			workspaceId: "workspace-1",
			cols: 80,
			rows: 24,
		});
		disconnectedSocket.disconnect();
		await expect(disconnected).rejects.toBeInstanceOf(DesktopDisconnectedError);
		disconnectedHarness.client.close();

		const closedHarness = harness();
		const closedSocket = closedHarness.sockets[0]!;
		completeHello(closedSocket);
		const closed = closedHarness.client.request("terminal.create", {
			workspaceId: "workspace-1",
			cols: 80,
			rows: 24,
		});
		closedHarness.client.close();
		await expect(closed).rejects.toBeInstanceOf(DesktopClientClosedError);
	});

	it("rejects request cancellation and timeout without poisoning later correlation", async () => {
		vi.useFakeTimers();
		try {
			const { client, sockets } = harness({ requestTimeoutMs: 1_000 });
			const socket = sockets[0]!;
			completeHello(socket);
			const controller = new AbortController();
			const cancelled = client.request(
				"git.snapshot",
				{ workspaceId: "workspace-1" },
				{ signal: controller.signal },
			);
			controller.abort();
			await expect(cancelled).rejects.toBeInstanceOf(DesktopRequestCancelledError);
			const timedOut = client.request("git.snapshot", { workspaceId: "workspace-1" }, { timeoutMs: 1 });
			vi.advanceTimersByTime(1);
			await expect(timedOut).rejects.toBeInstanceOf(DesktopRequestTimeoutError);
			client.close();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("DesktopClient reconnect and SessionClient seam", () => {
	it("reconnects with the same process URL and performs a fresh hello without replaying pending work", () => {
		vi.useFakeTimers();
		try {
			const { client, sockets, urls } = harness({ reconnectDelaysMs: [0], maxReconnectAttempts: 2 });
			const first = sockets[0]!;
			completeHello(first);
			first.receive({ t: "session-tabs", tabs: tabs() });
			first.receive(welcome());
			client.sendPrompt("only once");
			expect(first.frames().filter(frame => frame.method === "prompt.send")).toHaveLength(1);
			first.disconnect();
			vi.advanceTimersByTime(0);
			const second = sockets[1];
			expect(second).toBeDefined();
			completeHello(second!);
			second!.receive({ t: "session-tabs", tabs: tabs() });
			second!.receive(welcome());
			expect(urls).toEqual(["ws://127.0.0.1:4321/ws?token=secret", "ws://127.0.0.1:4321/ws?token=secret"]);
			expect(second!.frames().map(frame => frame.method)).toEqual(["runtime.hello"]);
			expect(client.getSnapshot().phase).toBe("live");
			client.close();
		} finally {
			vi.useRealTimers();
		}
	});

	it("sends a single prompt request with its image frame intact", () => {
		const { client, sockets } = harness();
		const socket = sockets[0]!;
		completeHello(socket);
		socket.receive({ t: "session-tabs", tabs: tabs() });
		const images: ImageContent[] = [{ type: "image", data: "cGl4ZWxz", mimeType: "image/png" }];
		client.sendPrompt("inspect", images);
		const prompt = socket.frames().at(-1);
		expect(prompt).toMatchObject({
			method: "prompt.send",
			params: { sessionPath: SESSION_A, text: "inspect", images },
		});
		client.close();
	});

	it("is structurally compatible with the native collab SessionClient and routes agent operations", async () => {
		const { client, sockets } = harness();
		const socket = sockets[0]!;
		completeHello(socket);
		socket.receive({ t: "session-tabs", tabs: tabs() });
		const nativeClient: SessionClient = client;
		const unsubscribe = nativeClient.subscribe(() => undefined);
		nativeClient.sendAgentCmd("kill", "sub-1");
		const command = socket.frames().at(-1)!;
		expect(command).toMatchObject({
			method: "agent.command",
			params: { sessionPath: SESSION_A, cmd: "kill", agentId: "sub-1" },
		});
		socket.receive({
			t: "response",
			id: command.id,
			method: "agent.command",
			result: { accepted: true },
		});
		const transcript = nativeClient.fetchTranscript("sub-1", 4);
		const transcriptRequest = socket.frames().at(-1)!;
		expect(transcriptRequest).toMatchObject({
			method: "agent.transcript",
			params: { sessionPath: SESSION_A, agentId: "sub-1", fromByte: 4 },
		});
		socket.receive({
			t: "response",
			id: transcriptRequest.id,
			method: "agent.transcript",
			result: { text: "rows", newSize: 8 },
		});
		expect(await transcript).toEqual({ kind: "rows", text: "rows", newSize: 8 });
		unsubscribe();
		client.close();
	});
});

describe("DesktopClient multi-session projection", () => {
	it("keeps interleaved tagged entries, streams, tools, and unread tab state independent", () => {
		const { client, sockets } = harness();
		const socket = sockets[0]!;
		completeHello(socket);
		socket.receive({
			t: "session-tabs",
			tabs: tabs(SESSION_A, { [SESSION_B]: { running: true, unread: 3 } }),
		});
		socket.receive(welcome(SESSION_A, 1));
		socket.receive(welcome(SESSION_B, 1, { ...HEADER, id: "session-2" }));
		socket.receive({ t: "snapshot-chunk", sessionPath: SESSION_B, entries: [entry("b-history")], final: true });
		socket.receive({ t: "snapshot-chunk", sessionPath: SESSION_A, entries: [entry("a-history")], final: true });
		socket.receive({
			t: "agent-event",
			sessionPath: SESSION_A,
			event: { type: "tool_execution_start", toolCallId: "tool-a", toolName: "read", args: { path: "a" } },
		});
		socket.receive({
			t: "agent-event",
			sessionPath: SESSION_B,
			event: { type: "tool_execution_start", toolCallId: "tool-b", toolName: "bash", args: { command: "b" } },
		});
		socket.receive({ t: "entry", sessionPath: SESSION_B, entry: entry("b-live") });

		const beforeSwitch = client.getDesktopSnapshot();
		const sessionA = beforeSwitch.sessionSnapshots.get(SESSION_A);
		expect(sessionA).toBeDefined();
		if (!sessionA) throw new Error("Missing session A snapshot");
		expect(client.getSnapshot()).toBe(sessionA);
		expect(client.getSnapshot().entries.map(item => item.id)).toEqual(["a-history"]);
		expect(sessionA.activeTools.has("tool-a")).toBe(true);
		expect(beforeSwitch.sessionSnapshots.get(SESSION_B)?.activeTools.has("tool-b")).toBe(true);
		expect(beforeSwitch.sessionSnapshots.get(SESSION_B)?.entries.map(item => item.id)).toEqual([
			"b-history",
			"b-live",
		]);
		expect(beforeSwitch.sessionTabs.find(tab => tab.path === SESSION_B)).toMatchObject({
			active: false,
			running: true,
			unread: 3,
		});

		let notifications = 0;
		const unsubscribe = client.subscribe(() => {
			notifications += 1;
		});
		socket.receive({ t: "session-tabs", tabs: tabs(SESSION_B) });
		expect(notifications).toBe(1);
		expect(client.getDesktopSnapshot().activeSessionPath).toBe(SESSION_B);
		expect(client.getSnapshot().entries.map(item => item.id)).toEqual(["b-history", "b-live"]);
		expect(client.getSnapshot().activeTools.has("tool-b")).toBe(true);
		expect(client.getDesktopSnapshot().sessionSnapshots.get(SESSION_A)?.activeTools.has("tool-a")).toBe(true);
		unsubscribe();
		client.close();
	});

	it("targets every SessionClient command at the active session and rejects cleanly without one", async () => {
		const { client, sockets } = harness();
		const socket = sockets[0]!;
		completeHello(socket);
		expect(client.getDesktopSnapshot().activeSessionPath).toBeNull();
		expect(client.getSnapshot()).toMatchObject({
			phase: "waiting",
			header: null,
			entries: [],
			state: null,
			working: false,
		});
		client.sendPrompt("not sent");
		expect(socket.frames().filter(frame => frame.method === "prompt.send")).toHaveLength(0);
		expect(client.getSnapshot().notices.at(-1)?.message).toContain("No active session");

		socket.receive({ t: "session-tabs", tabs: tabs(SESSION_B) });
		client.sendPrompt("hello");
		client.sendAbort();
		client.sendUiResponse(7, "yes");
		client.sendAgentCmd("chat", "sub-1", "status?");
		const transcript = client.fetchTranscript("sub-1", 10);
		const targeted = socket
			.frames()
			.filter(frame =>
				["prompt.send", "run.abort", "ui.respond", "agent.command", "agent.transcript"].includes(frame.method),
			);
		expect(targeted).toHaveLength(5);
		expect(targeted.every(frame => "sessionPath" in frame.params && frame.params.sessionPath === SESSION_B)).toBe(
			true,
		);

		for (const request of targeted) {
			const result =
				request.method === "prompt.send"
					? { accepted: true }
					: request.method === "agent.transcript"
						? { text: "targeted", newSize: 18 }
						: { accepted: true };
			socket.receive({
				t: "response",
				id: request.id,
				method: request.method,
				result,
			} as DesktopResponse);
		}
		expect(await transcript).toEqual({ kind: "rows", text: "targeted", newSize: 18 });
		client.close();
	});

	it("uses typed tab helpers, preserves server close guards, and surfaces close errors", async () => {
		const { client, sockets } = harness();
		const socket = sockets[0]!;
		completeHello(socket);
		socket.receive({ t: "session-tabs", tabs: tabs() });

		const activating = client.activateSession(SESSION_B);
		const activateRequest = socket.frames().at(-1)!;
		expect(activateRequest).toMatchObject({ method: "session.activate", params: { path: SESSION_B } });
		socket.receive({
			t: "response",
			id: activateRequest.id,
			method: "session.activate",
			result: { tabs: tabs(SESSION_B) },
		});
		await activating;
		expect(client.getDesktopSnapshot().activeSessionPath).toBe(SESSION_B);

		const blocked = client.closeSession(SESSION_B);
		const blockedRequest = socket.frames().at(-1)!;
		socket.receive({
			t: "response",
			id: blockedRequest.id,
			method: "session.tab.close",
			result: { closed: false, blockedReason: "running", tabs: tabs(SESSION_B, { [SESSION_B]: { running: true } }) },
		});
		expect(await blocked).toMatchObject({ closed: false, blockedReason: "running" });
		expect(client.getDesktopSnapshot().sessionSnapshots.has(SESSION_B)).toBe(true);

		const errored = client.closeSession(SESSION_B, true);
		const errorRequest = socket.frames().at(-1)!;
		socket.receive({
			t: "response",
			id: errorRequest.id,
			method: "session.tab.close",
			error: { code: "SESSION_CLOSE_FAILED", message: "close failed" },
		});
		await expect(errored).rejects.toMatchObject({ code: "SESSION_CLOSE_FAILED" });
		client.close();
	});

	it("debounces draft state, flushes it before close, and applies returned tab state", async () => {
		vi.useFakeTimers();
		try {
			const { client, sockets } = harness();
			const socket = sockets[0]!;
			completeHello(socket);
			await Promise.resolve();
			socket.receive({ t: "session-tabs", tabs: tabs() });
			client.setSessionDraft(SESSION_A, true);
			client.setSessionDraft(SESSION_A, false);
			client.setSessionDraft(SESSION_A, true);
			expect(socket.frames().filter(frame => frame.method === "session.tab.draft")).toHaveLength(0);
			expect(client.getDesktopSnapshot().sessionTabs[0]?.draftDirty).toBe(true);
			vi.advanceTimersByTime(250);
			await Promise.resolve();
			const draftRequest = socket.frames().at(-1)!;
			expect(draftRequest).toMatchObject({
				method: "session.tab.draft",
				params: { path: SESSION_A, dirty: true },
			});
			socket.receive({
				t: "response",
				id: draftRequest.id,
				method: "session.tab.draft",
				result: { tabs: tabs(SESSION_A, { [SESSION_A]: { draftDirty: true } }) },
			});
			await Promise.resolve();

			client.setSessionDraft(SESSION_A, false);
			const closing = client.closeSession(SESSION_A);
			const flushed = socket.frames().at(-1)!;
			expect(flushed).toMatchObject({
				method: "session.tab.draft",
				params: { path: SESSION_A, dirty: false },
			});
			socket.receive({
				t: "response",
				id: flushed.id,
				method: "session.tab.draft",
				result: { tabs: tabs() },
			});
			await Promise.resolve();
			await Promise.resolve();
			const closeRequest = socket.frames().at(-1)!;
			expect(closeRequest.method).toBe("session.tab.close");
			socket.receive({
				t: "response",
				id: closeRequest.id,
				method: "session.tab.close",
				result: { closed: true, tabs: [tabs(SESSION_B)[1]!] },
			});
			await closing;
			expect(client.getDesktopSnapshot().sessionSnapshots.has(SESSION_A)).toBe(false);
			client.close();
		} finally {
			vi.useRealTimers();
		}
	});

	it("rehydrates every open tab on reconnect without replaying a prompt or retaining stale entries", async () => {
		vi.useFakeTimers();
		try {
			const { client, sockets } = harness({ reconnectDelaysMs: [0], maxReconnectAttempts: 2 });
			const first = sockets[0]!;
			completeHello(first);
			first.receive({ t: "session-tabs", tabs: tabs() });
			first.receive(welcome(SESSION_A, 1));
			first.receive({ t: "snapshot-chunk", sessionPath: SESSION_A, entries: [entry("a-old")], final: true });
			first.receive(welcome(SESSION_B, 1, { ...HEADER, id: "session-2" }));
			first.receive({ t: "snapshot-chunk", sessionPath: SESSION_B, entries: [entry("b-old")], final: true });
			client.sendPrompt("once");
			expect(first.frames().filter(frame => frame.method === "prompt.send")).toHaveLength(1);

			first.disconnect();
			vi.advanceTimersByTime(0);
			const second = sockets[1]!;
			completeHello(second);
			second.receive(welcome(SESSION_A, 1));
			second.receive({ t: "snapshot-chunk", sessionPath: SESSION_A, entries: [entry("a-new")], final: true });
			second.receive(welcome(SESSION_B, 1, { ...HEADER, id: "session-2" }));
			second.receive({ t: "snapshot-chunk", sessionPath: SESSION_B, entries: [entry("b-new")], final: true });
			second.receive({ t: "session-tabs", tabs: tabs(SESSION_B) });
			await Promise.resolve();
			const tabsRequest = second.frames().find(frame => frame.method === "session.tabs");
			expect(tabsRequest).toBeDefined();
			second.receive({
				t: "response",
				id: tabsRequest!.id,
				method: "session.tabs",
				result: { tabs: tabs(SESSION_B) },
			});
			await Promise.resolve();

			const snapshot = client.getDesktopSnapshot();
			expect(snapshot.activeSessionPath).toBe(SESSION_B);
			expect(snapshot.sessionSnapshots.get(SESSION_A)?.entries.map(item => item.id)).toEqual(["a-new"]);
			expect(snapshot.sessionSnapshots.get(SESSION_B)?.entries.map(item => item.id)).toEqual(["b-new"]);
			expect(second.frames().filter(frame => frame.method === "prompt.send")).toHaveLength(0);
			client.close();
		} finally {
			vi.useRealTimers();
		}
	});
});
