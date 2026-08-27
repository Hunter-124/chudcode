import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionEntry, SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import type { DesktopFrame } from "../src/protocol";
import { type DesktopAgentRegistry, type DesktopFrameSink, DesktopRuntime } from "../src/runtime";
import { OrderedSocketQueue, rejectUntrustedRequest, requestHasToken, startDesktopServer } from "../src/server";
import {
	type DesktopAgentSession,
	type DesktopSessionManager,
	type SessionCatalog,
	SessionService,
} from "../src/session-service";

const BASE_TIME = new Date("2026-01-01T00:00:00.000Z");

function entry(id: string, content = id): SessionEntry {
	return {
		type: "custom_message",
		id,
		parentId: null,
		timestamp: BASE_TIME.toISOString(),
		customType: "test",
		content,
		display: true,
	};
}

function info(id: string, sessionPath = `/sessions/${id}.jsonl`, cwd = "/work"): SessionInfo {
	return {
		id,
		path: sessionPath,
		cwd,
		title: id,
		created: BASE_TIME,
		modified: BASE_TIME,
		messageCount: 1,
		size: 128,
		firstMessage: id,
		allMessagesText: id,
		status: "complete",
	};
}

class FakeManager implements DesktopSessionManager {
	onEntryAppended?: (value: SessionEntry) => void;
	header: SessionHeader = {
		type: "session",
		version: 3,
		id: "one",
		timestamp: BASE_TIME.toISOString(),
		cwd: "/work",
	};
	entries: SessionEntry[] = [];
	file = "/sessions/one.jsonl";
	materialized = 0;
	flushed = 0;

	snapshotForReplication() {
		return { header: structuredClone(this.header), entries: structuredClone(this.entries) };
	}

	getSessionFile() {
		return this.file;
	}

	getSessionId() {
		return this.header.id;
	}

	getSessionName() {
		return this.header.title;
	}

	getCwd() {
		return this.header.cwd;
	}

	async ensureOnDisk() {
		this.materialized += 1;
	}

	async flush() {
		this.flushed += 1;
	}

	append(value: SessionEntry) {
		this.entries.push(value);
		this.onEntryAppended?.(value);
	}
}

class FakeSession implements DesktopAgentSession {
	readonly sessionManager = new FakeManager();
	readonly listeners = new Set<(event: AgentSessionEvent) => void | Promise<void>>();
	isStreaming = false;
	isAborting = false;
	queuedMessageCount = 0;
	model = undefined;
	thinkingLevel = undefined;
	promptCalls: Array<{ text: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }> = [];
	abortCalls = 0;
	disposed = 0;
	sequence = 1;
	onPathChanged?: (id: string, file: string, cwd: string) => void;
	readonly sdkCalls: string[] = [];

	get sessionName() {
		return this.sessionManager.header.title;
	}

	async prompt(text: string, options?: { images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }) {
		this.promptCalls.push({ text, ...options });
		return true;
	}

	async abort() {
		this.abortCalls += 1;
		this.isStreaming = false;
	}

	subscribe(listener: (event: AgentSessionEvent) => void | Promise<void>) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: AgentSessionEvent) {
		for (const listener of this.listeners) void listener(event);
	}

	async switchSession(sessionPath: string) {
		const id = path.basename(sessionPath, ".jsonl");
		this.sessionManager.file = sessionPath;
		this.sessionManager.header.id = id;
		this.sessionManager.header.title = id;
		return true;
	}

	async newSession() {
		this.sdkCalls.push("newSession");
		this.sequence += 1;
		this.setActive(`new-${this.sequence}`, this.sessionManager.header.cwd);
		return true;
	}

	async moveSession(cwd: string) {
		this.sdkCalls.push(`moveSession:${cwd}`);
		this.setActive(this.sessionManager.header.id, cwd);
	}

	async fork() {
		this.sequence += 1;
		this.setActive(`fork-${this.sequence}`, this.sessionManager.header.cwd);
		return true;
	}

	async branch() {
		this.sequence += 1;
		this.setActive(`branch-${this.sequence}`, this.sessionManager.header.cwd);
		return { selectedText: "editable prompt", selectedImages: [], cancelled: false };
	}

	async setSessionName(name: string) {
		this.sessionManager.header.title = name;
		return true;
	}

	getContextBreakdown() {
		return { usedTokens: 10, contextWindow: 100 };
	}

	async dispose() {
		this.disposed += 1;
	}

	setActive(id: string, cwd: string) {
		const file = `/sessions/${id}.jsonl`;
		this.sessionManager.file = file;
		this.sessionManager.header = {
			type: "session",
			version: 3,
			id,
			title: id,
			timestamp: BASE_TIME.toISOString(),
			cwd,
		};
		this.sessionManager.entries = [];
		this.onPathChanged?.(id, file, cwd);
	}
}

class RecordingSink implements DesktopFrameSink {
	frames: DesktopFrame[] = [];
	closed?: { code?: number; reason?: string };

	send(frame: DesktopFrame) {
		this.frames.push(frame);
		return true;
	}

	close(code?: number, reason?: string) {
		this.closed = { code, reason };
	}
}

function fakeRegistry(): DesktopAgentRegistry {
	return {
		list: () => [
			{
				id: "Main",
				displayName: "Main",
				kind: "main",
				status: "idle",
				sessionFile: "/sessions/one.jsonl",
				createdAt: 1,
				lastActivity: 2,
			},
		],
		onChange: () => () => {},
	};
}

function catalogFor(session: FakeSession) {
	const sessions = [info("one")];
	const pins = new Set<string>();
	session.onPathChanged = (id, file, cwd) => {
		const existing = sessions.find(item => item.id === id);
		if (existing) {
			existing.path = file;
			existing.cwd = cwd;
		} else {
			sessions.push(info(id, file, cwd));
		}
	};
	const catalog: SessionCatalog = {
		list: async cwd => {
			session.sdkCalls.push(`list:${cwd ?? "*"}`);
			return sessions.filter(item => !cwd || item.cwd === cwd);
		},
		openForRename: async stored => ({
			setSessionName: async title => {
				stored.title = title;
				return true;
			},
			close: async () => {},
		}),
		delete: async sessionPath => {
			const index = sessions.findIndex(item => item.path === sessionPath);
			if (index >= 0) sessions.splice(index, 1);
		},
		loadPins: async () => new Set(pins),
		togglePin: async id => {
			if (!pins.delete(id)) pins.add(id);
			return pins.has(id);
		},
	};
	return { catalog, sessions, pins };
}

describe("desktop loopback authorization", () => {
	it("rejects missing tokens, non-loopback Host, and foreign Origin", () => {
		const token = "t".repeat(43);
		const port = 43123;
		const base = `http://127.0.0.1:${port}/`;
		expect(
			requestHasToken(new Request(base, { headers: { Host: `127.0.0.1:${port}` } }), new URL(base), token),
		).toBeFalse();
		expect(
			rejectUntrustedRequest(new Request(base, { headers: { Host: `attacker.test:${port}` } }), port)?.status,
		).toBe(421);
		expect(
			rejectUntrustedRequest(
				new Request(base, {
					headers: { Host: `127.0.0.1:${port}`, Origin: "https://attacker.test" },
				}),
				port,
			)?.status,
		).toBe(403);
		const authorized = new Request(base, {
			headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${token}` },
		});
		expect(rejectUntrustedRequest(authorized, port)).toBeUndefined();
		expect(requestHasToken(authorized, new URL(base), token)).toBeTrue();
	});

	it("protects the HTML bootstrap and releases server/runtime resources", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "chudcode-desktop-"));
		const webDist = path.join(root, "web");
		await mkdir(webDist);
		await writeFile(path.join(webDist, "index.html"), "<!doctype html><title>desktop</title>");
		await writeFile(path.join(root, "secret.ts"), "do-not-serve");
		const fake = new FakeSession();
		const { catalog } = catalogFor(fake);
		const runtime = new DesktopRuntime({
			session: fake,
			sessionService: new SessionService(fake, { catalog }),
			registry: fakeRegistry(),
		});
		const server = await startDesktopServer({ runtime, webDist, singleInstance: false });
		try {
			const unauthenticated = await fetch(server.url, { redirect: "manual" });
			expect(unauthenticated.status).toBe(401);
			const bootstrap = await fetch(server.bootstrapUrl, { redirect: "manual" });
			expect(bootstrap.status).toBe(302);
			expect(bootstrap.headers.get("set-cookie")).toContain("HttpOnly");
			const traversal = await fetch(`${server.url}/%2e%2e%2fsecret.ts?token=${encodeURIComponent(server.token)}`);
			expect(traversal.status).toBe(404);
			expect(await traversal.text()).not.toContain("do-not-serve");
			const sourceFallback = await fetch(`${server.url}/src/server.ts?token=${encodeURIComponent(server.token)}`);
			expect(sourceFallback.status).toBe(404);
		} finally {
			await server.stop();
			await rm(root, { recursive: true, force: true });
		}
		expect(fake.disposed).toBe(1);
	});
});

describe("desktop runtime", () => {
	it("routes prompts with images and aborts through AgentSession", async () => {
		const fake = new FakeSession();
		fake.isStreaming = true;
		const { catalog } = catalogFor(fake);
		const runtime = new DesktopRuntime({
			session: fake,
			sessionService: new SessionService(fake, { catalog }),
			registry: fakeRegistry(),
		});
		const images: ImageContent[] = [{ type: "image", data: "AA==", mimeType: "image/png" }];
		const prompt = await runtime.handleRequest({
			t: "request",
			id: 1,
			method: "prompt.send",
			params: { text: "hello", images },
		});
		const abort = await runtime.handleRequest({ t: "request", id: 2, method: "run.abort", params: {} });
		expect(prompt).toMatchObject({ result: { accepted: true } });
		expect(abort).toMatchObject({ result: { accepted: true } });
		expect(fake.promptCalls).toEqual([{ text: "hello", images, streamingBehavior: "steer" }]);
		expect(fake.abortCalls).toBe(1);
		await runtime.dispose();
	});

	it("delivers snapshot chunks and live entry/event frames in arrival order", async () => {
		const fake = new FakeSession();
		fake.sessionManager.entries = [
			entry("a", "x".repeat(70)),
			entry("b", "y".repeat(70)),
			entry("c", "z".repeat(70)),
			{
				type: "service_tier_change",
				id: "desktop-hidden",
				parentId: null,
				timestamp: BASE_TIME.toISOString(),
				serviceTier: null,
			},
		];
		const { catalog } = catalogFor(fake);
		const runtime = new DesktopRuntime({
			session: fake,
			sessionService: new SessionService(fake, { catalog }),
			registry: fakeRegistry(),
			snapshotChunkBytes: 120,
		});
		const sink = new RecordingSink();
		runtime.attach(sink);
		const chunks = sink.frames.filter(frame => frame.t === "snapshot-chunk");
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.at(-1)).toMatchObject({ final: true });
		const welcome = sink.frames.find(frame => frame.t === "welcome");
		expect(welcome).toMatchObject({ entryCount: 3 });
		expect(chunks.flatMap(chunk => chunk.entries).map(item => item.id)).toEqual(["a", "b", "c"]);
		expect(
			sink.frames.some(
				frame =>
					frame.t === "agent-event" &&
					frame.event.type === "notice" &&
					frame.event.message.includes('session entry type "service_tier_change"'),
			),
		).toBeTrue();

		fake.sessionManager.append(entry("live"));
		fake.emit({ type: "model_changed" });
		fake.emit({ type: "agent_start" });
		const entryIndex = sink.frames.findIndex(frame => frame.t === "entry" && frame.entry.id === "live");
		const eventIndex = sink.frames.findIndex(
			frame => frame.t === "agent-event" && frame.event.type === "agent_start",
		);
		expect(entryIndex).toBeGreaterThan(-1);
		expect(eventIndex).toBeGreaterThan(entryIndex);
		expect(
			sink.frames.some(
				frame =>
					frame.t === "agent-event" &&
					frame.event.type === "notice" &&
					frame.event.message.includes('agent event type "model_changed"'),
			),
		).toBeTrue();
		await runtime.dispose();
	});

	it("routes every session verb through authoritative session/catalog seams", async () => {
		const fake = new FakeSession();
		const { catalog, sessions, pins } = catalogFor(fake);
		sessions.push(info("two"));
		const service = new SessionService(fake, { catalog });
		expect((await service.list()).map(item => item.id)).toEqual(["one", "two"]);

		const selected = await service.select("/sessions/two.jsonl");
		expect(selected.header.id).toBe("two");
		fake.sdkCalls.length = 0;
		const created = await service.newSession("/work/../other");
		expect(created.cwd).toBe("/other");
		expect(fake.sdkCalls).toEqual(["newSession", "moveSession:/other", "list:/other"]);
		expect(fake.sessionManager.getCwd()).toBe("/other");
		expect(fake.sessionManager.materialized).toBeGreaterThan(0);
		const forked = await service.fork(created.path);
		expect(forked.session.id).toStartWith("fork-");
		expect(forked.selectedText).toBeUndefined();
		expect(forked.selectedImages).toBeUndefined();
		expect(forked.cancelled).toBeUndefined();
		const branched = await service.fork(forked.session.path, "entry-1");
		expect(branched.session.id).toStartWith("branch-");
		expect(branched.selectedText).toBe("editable prompt");
		expect(branched.selectedImages).toEqual([]);
		expect(branched.cancelled).toBeFalse();
		const renamed = await service.rename("/sessions/two.jsonl", "Renamed");
		expect(renamed.title).toBe("Renamed");
		const pinned = await service.pin("/sessions/two.jsonl", true);
		expect(pinned.pinned).toBeTrue();
		expect(pins.has("two")).toBeTrue();
		const removed = await service.delete("/sessions/two.jsonl");
		expect(removed).toEqual({ deleted: true, activeChanged: false });
		expect(sessions.some(item => item.id === "two")).toBeFalse();
	});

	it("round-trips UI requests through ui.respond and closes cleanly", async () => {
		const fake = new FakeSession();
		const { catalog } = catalogFor(fake);
		let closeableClosed = 0;
		const runtime = new DesktopRuntime({
			session: fake,
			sessionService: new SessionService(fake, { catalog }),
			registry: fakeRegistry(),
			closeables: [
				{
					close: async () => {
						closeableClosed += 1;
					},
				},
			],
		});
		const sink = new RecordingSink();
		runtime.attach(sink);
		const answerPromise = runtime.createUiContext().select("Pick", ["A", "B"]);
		const request = sink.frames.find(frame => frame.t === "ui-request");
		if (request?.t !== "ui-request") throw new Error("ui request missing");
		const response = await runtime.handleRequest({
			t: "request",
			id: 7,
			method: "ui.respond",
			params: { reqId: request.request.reqId, value: "B" },
		});
		expect(response).toMatchObject({ result: { accepted: true } });
		expect(await answerPromise).toBe("B");
		expect(
			sink.frames.some(frame => frame.t === "ui-request-end" && frame.reqId === request.request.reqId),
		).toBeTrue();
		await runtime.dispose();
		expect(closeableClosed).toBe(1);
		expect(fake.disposed).toBe(1);
		expect(sink.closed?.code).toBe(1001);
	});
});

describe("ordered outbound queue", () => {
	it("preserves FIFO order across backpressure drain", () => {
		const sent: string[] = [];
		let blocked = true;
		const socket = {
			bufferedAmount: 0,
			send(data: string) {
				if (blocked) return -1;
				sent.push(data);
				return Buffer.byteLength(data);
			},
			close() {},
		};
		const queue = new OrderedSocketQueue(socket, { maxBytes: 4096, maxFrames: 8 });
		queue.send({ t: "error", code: "one", message: "1" });
		queue.send({ t: "error", code: "two", message: "2" });
		expect(sent).toEqual([]);
		blocked = false;
		queue.drain();
		expect(sent.map(value => JSON.parse(value).code)).toEqual(["one", "two"]);
	});

	it("emits an explicit slow-client error and closes at the bound", () => {
		const sent: string[] = [];
		let closed: { code?: number; reason?: string } | undefined;
		const socket = {
			bufferedAmount: 0,
			send(data: string) {
				sent.push(data);
				return -1;
			},
			close(code?: number, reason?: string) {
				closed = { code, reason };
			},
		};
		const queue = new OrderedSocketQueue(socket, { maxBytes: 128, maxFrames: 1 });
		queue.send({ t: "error", code: "first", message: "queued" });
		expect(queue.send({ t: "error", code: "second", message: "overflow" })).toBeFalse();
		expect(sent.some(value => value.includes("SLOW_CLIENT"))).toBeTrue();
		expect(closed?.code).toBe(1013);
		expect(closed?.reason).toContain("SLOW_CLIENT");
	});
});
