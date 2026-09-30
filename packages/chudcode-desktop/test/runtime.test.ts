import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionEntry, SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import type { DesktopFrame } from "../src/protocol";
import {
	type DesktopAgentControl,
	type DesktopAgentRegistry,
	type DesktopFrameSink,
	DesktopRuntime,
	type DesktopSessionFactoryRequest,
	type DesktopSessionResources,
} from "../src/runtime";
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

function multiSessionHarness(ids = ["one", "two"]) {
	const sessions = ids.map(id => info(id));
	const pins = new Set<string>();
	const live: FakeSession[] = [];
	let sequence = ids.length;
	const catalog: SessionCatalog = {
		list: async cwd => sessions.filter(item => !cwd || item.cwd === cwd),
		openForRename: async stored => ({
			setSessionName: async title => {
				stored.title = title;
				return true;
			},
			close: async () => {},
		}),
		delete: async sessionPath => {
			const index = sessions.findIndex(item => path.resolve(item.path) === path.resolve(sessionPath));
			if (index >= 0) sessions.splice(index, 1);
		},
		loadPins: async () => new Set(pins),
		togglePin: async id => {
			if (!pins.delete(id)) pins.add(id);
			return pins.has(id);
		},
	};
	const track = (session: FakeSession) => {
		live.push(session);
		session.onPathChanged = (id, file, cwd) => {
			const existing = sessions.find(item => item.id === id);
			if (existing) {
				existing.path = file;
				existing.cwd = cwd;
			} else {
				sessions.push(info(id, file, cwd));
			}
		};
		return session;
	};
	const resources = (session: FakeSession): DesktopSessionResources => ({
		session,
		sessionService: new SessionService(session, { catalog }),
		registry: fakeRegistry(),
	});
	const initial = new FakeSession();
	initial.setActive(ids[0] ?? "one", "/work");
	track(initial);
	const factory = async (request: DesktopSessionFactoryRequest): Promise<DesktopSessionResources> => {
		const session = track(new FakeSession());
		if (request.sessionPath) await session.switchSession(request.sessionPath);
		else session.setActive(`new-${++sequence}`, request.cwd);
		return resources(session);
	};
	const runtime = new DesktopRuntime({ ...resources(initial), sessionFactory: factory });
	return {
		runtime,
		sessions,
		live,
		sessionFor(sessionPath: string) {
			const session = live.find(
				candidate => path.resolve(candidate.sessionManager.file) === path.resolve(sessionPath),
			);
			if (!session) throw new Error(`No live fake session for ${sessionPath}`);
			return session;
		},
	};
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
	it("runs two retained sessions concurrently with interleaved tagged events, targeted abort, and unread state", async () => {
		const harness = multiSessionHarness();
		const { runtime } = harness;
		await runtime.handleRequest({
			t: "request",
			id: 1,
			method: "session.activate",
			params: { path: "/sessions/two.jsonl" },
		});
		const one = harness.sessionFor("/sessions/one.jsonl");
		const two = harness.sessionFor("/sessions/two.jsonl");
		one.isStreaming = true;
		two.isStreaming = true;
		const sink = new RecordingSink();
		runtime.attach(sink);

		await runtime.handleRequest({
			t: "request",
			id: 2,
			method: "prompt.send",
			params: { sessionPath: "/sessions/one.jsonl", text: "one" },
		});
		await runtime.handleRequest({
			t: "request",
			id: 3,
			method: "prompt.send",
			params: { sessionPath: "/sessions/two.jsonl", text: "two" },
		});
		one.sessionManager.append(entry("one-live"));
		two.sessionManager.append(entry("two-live"));
		one.emit({ type: "agent_start" });
		two.emit({ type: "agent_start" });
		expect(one.promptCalls.map(call => call.text)).toEqual(["one"]);
		expect(two.promptCalls.map(call => call.text)).toEqual(["two"]);
		expect(sink.frames.find(frame => frame.t === "entry" && frame.entry.id === "one-live")).toMatchObject({
			sessionPath: "/sessions/one.jsonl",
		});
		expect(sink.frames.find(frame => frame.t === "entry" && frame.entry.id === "two-live")).toMatchObject({
			sessionPath: "/sessions/two.jsonl",
		});

		await runtime.handleRequest({
			t: "request",
			id: 4,
			method: "session.activate",
			params: { path: "/sessions/one.jsonl" },
		});
		two.sessionManager.append(entry("inactive"));
		const tabsFrame = sink.frames.findLast(frame => frame.t === "session-tabs");
		if (tabsFrame?.t !== "session-tabs") throw new Error("session tabs missing");
		expect(tabsFrame.tabs.find(tab => tab.path === "/sessions/two.jsonl")?.unread).toBeGreaterThan(0);
		expect(two.abortCalls).toBe(0);

		await runtime.handleRequest({
			t: "request",
			id: 5,
			method: "run.abort",
			params: { sessionPath: "/sessions/one.jsonl" },
		});
		expect(one.abortCalls).toBe(1);
		expect(two.abortCalls).toBe(0);
		await runtime.dispose();
	});

	it("rehydrates every open snapshot while activation preserves the active-view snapshot semantics", async () => {
		const harness = multiSessionHarness();
		await harness.runtime.handleRequest({
			t: "request",
			id: 6,
			method: "session.activate",
			params: { path: "/sessions/two.jsonl" },
		});
		harness.sessionFor("/sessions/one.jsonl").sessionManager.entries = [entry("one-entry")];
		harness.sessionFor("/sessions/two.jsonl").sessionManager.entries = [entry("two-entry")];
		const reconnect = new RecordingSink();
		harness.runtime.attach(reconnect);
		expect(reconnect.frames.filter(frame => frame.t === "welcome").map(frame => frame.sessionPath)).toEqual([
			"/sessions/one.jsonl",
			"/sessions/two.jsonl",
		]);
		expect(
			reconnect.frames
				.filter(frame => frame.t === "snapshot-chunk")
				.map(frame => ({ path: frame.sessionPath, ids: frame.entries.map(item => item.id) })),
		).toEqual([
			{ path: "/sessions/one.jsonl", ids: ["one-entry"] },
			{ path: "/sessions/two.jsonl", ids: ["two-entry"] },
		]);
		const before = reconnect.frames.length;
		await harness.runtime.handleRequest({
			t: "request",
			id: 7,
			method: "session.activate",
			params: { path: "/sessions/one.jsonl" },
		});
		const activated = reconnect.frames.slice(before).filter(frame => frame.t === "welcome");
		expect(activated).toHaveLength(1);
		expect(activated[0]).toMatchObject({ sessionPath: "/sessions/one.jsonl" });
		await harness.runtime.dispose();
	});

	it("routes agent control, transcript, and UI responses through the addressed live session", async () => {
		const first = new FakeSession();
		const second = new FakeSession();
		second.setActive("two", "/work");
		const sessions = [info("one"), info("two")];
		const catalog: SessionCatalog = {
			list: async () => sessions,
			openForRename: async () => ({ setSessionName: async () => true, close: async () => {} }),
			delete: async () => {},
			loadPins: async () => new Set(),
			togglePin: async () => false,
		};
		const calls: string[] = [];
		const control = (label: string): DesktopAgentControl => ({
			command: (cmd, agentId) => {
				calls.push(`${label}:${cmd}:${agentId}`);
				return { accepted: true };
			},
			transcript: async (agentId, fromByte) => {
				calls.push(`${label}:transcript:${agentId}:${fromByte}`);
				return { text: label, newSize: fromByte + 1 };
			},
		});
		const runtime = new DesktopRuntime({
			session: first,
			sessionService: new SessionService(first, { catalog }),
			registry: fakeRegistry(),
			agentControl: control("one"),
			sessionFactory: async () => ({
				session: second,
				sessionService: new SessionService(second, { catalog }),
				registry: fakeRegistry(),
				agentControl: control("two"),
			}),
		});
		await runtime.handleRequest({
			t: "request",
			id: 8,
			method: "session.activate",
			params: { path: "/sessions/two.jsonl" },
		});
		await runtime.handleRequest({
			t: "request",
			id: 9,
			method: "agent.command",
			params: { sessionPath: "/sessions/one.jsonl", cmd: "chat", agentId: "Worker", text: "status" },
		});
		const transcript = await runtime.handleRequest({
			t: "request",
			id: 10,
			method: "agent.transcript",
			params: { sessionPath: "/sessions/two.jsonl", agentId: "Worker", fromByte: 4 },
		});
		expect(calls).toEqual(["one:chat:Worker", "two:transcript:Worker:4"]);
		expect(transcript).toMatchObject({ result: { text: "two", newSize: 5 } });

		const sink = new RecordingSink();
		runtime.attach(sink);
		const answer = runtime.createUiContext("/sessions/two.jsonl").select("Pick", ["A", "B"]);
		const request = sink.frames.findLast(frame => frame.t === "ui-request");
		if (request?.t !== "ui-request") throw new Error("ui request missing");
		expect(request.sessionPath).toBe("/sessions/two.jsonl");
		await runtime.handleRequest({
			t: "request",
			id: 11,
			method: "ui.respond",
			params: { sessionPath: "/sessions/two.jsonl", reqId: request.request.reqId, value: "B" },
		});
		expect(await answer).toBe("B");
		await runtime.dispose();
	});

	it("guards running and dirty tabs, and force-close explicitly aborts, flushes, and disposes", async () => {
		const harness = multiSessionHarness();
		await harness.runtime.handleRequest({
			t: "request",
			id: 12,
			method: "session.activate",
			params: { path: "/sessions/two.jsonl" },
		});
		const two = harness.sessionFor("/sessions/two.jsonl");
		two.isStreaming = true;
		const blockedRunning = await harness.runtime.handleRequest({
			t: "request",
			id: 13,
			method: "session.tab.close",
			params: { path: "/sessions/two.jsonl" },
		});
		expect(blockedRunning).toMatchObject({ result: { closed: false, blockedReason: "running" } });
		two.isStreaming = false;
		await harness.runtime.handleRequest({
			t: "request",
			id: 14,
			method: "session.tab.draft",
			params: { path: "/sessions/two.jsonl", dirty: true },
		});
		const blockedDirty = await harness.runtime.handleRequest({
			t: "request",
			id: 15,
			method: "session.tab.close",
			params: { path: "/sessions/two.jsonl" },
		});
		expect(blockedDirty).toMatchObject({ result: { closed: false, blockedReason: "dirty-draft" } });
		two.isStreaming = true;
		const forced = await harness.runtime.handleRequest({
			t: "request",
			id: 16,
			method: "session.tab.close",
			params: { path: "/sessions/two.jsonl", force: true },
		});
		expect(forced).toMatchObject({ result: { closed: true } });
		expect(two.abortCalls).toBe(1);
		expect(two.sessionManager.flushed).toBeGreaterThan(0);
		expect(two.disposed).toBe(1);
		await harness.runtime.dispose();
	});

	it("guards deletion before closing the runtime and deletes only after a clean close", async () => {
		const harness = multiSessionHarness();
		const one = harness.sessionFor("/sessions/one.jsonl");
		await harness.runtime.handleRequest({
			t: "request",
			id: 17,
			method: "session.tab.draft",
			params: { path: "/sessions/one.jsonl", dirty: true },
		});
		const blocked = await harness.runtime.handleRequest({
			t: "request",
			id: 18,
			method: "session.delete",
			params: { path: "/sessions/one.jsonl" },
		});
		expect(blocked).toMatchObject({ result: { deleted: false } });
		expect(one.disposed).toBe(0);
		expect(harness.sessions.some(item => item.id === "one")).toBeTrue();
		await harness.runtime.handleRequest({
			t: "request",
			id: 19,
			method: "session.tab.draft",
			params: { path: "/sessions/one.jsonl", dirty: false },
		});
		const deleted = await harness.runtime.handleRequest({
			t: "request",
			id: 20,
			method: "session.delete",
			params: { path: "/sessions/one.jsonl" },
		});
		expect(deleted).toMatchObject({ result: { deleted: true } });
		expect(one.disposed).toBe(1);
		expect(one.sessionManager.flushed).toBeGreaterThan(0);
		expect(harness.sessions.some(item => item.id === "one")).toBeFalse();
		await harness.runtime.dispose();
	});

	it("opens at most twelve live sessions and never evicts an existing tab", async () => {
		const ids = Array.from({ length: 13 }, (_, index) => `s${index + 1}`);
		const harness = multiSessionHarness(ids);
		for (const id of ids.slice(1, 12)) {
			const response = await harness.runtime.handleRequest({
				t: "request",
				id: 30 + Number(id.slice(1)),
				method: "session.activate",
				params: { path: `/sessions/${id}.jsonl` },
			});
			expect(response.error).toBeUndefined();
		}
		const capped = await harness.runtime.handleRequest({
			t: "request",
			id: 50,
			method: "session.activate",
			params: { path: "/sessions/s13.jsonl" },
		});
		expect(capped).toMatchObject({
			error: {
				code: "MAX_OPEN_SESSIONS",
				message: expect.stringContaining("close a finished tab"),
			},
		});
		const tabs = await harness.runtime.handleRequest({
			t: "request",
			id: 51,
			method: "session.tabs",
			params: {},
		});
		if (tabs.method !== "session.tabs" || !tabs.result) throw new Error("tabs missing");
		expect(tabs.result.tabs).toHaveLength(12);
		expect(harness.live.every(session => session.disposed === 0)).toBeTrue();
		await harness.runtime.dispose();
	});

	it("creates and forks independent live sessions, renames tab titles, and retains the source", async () => {
		const harness = multiSessionHarness();
		const created = await harness.runtime.handleRequest({
			t: "request",
			id: 52,
			method: "session.new",
			params: { cwd: "/other" },
		});
		if (created.method !== "session.new" || !created.result) throw new Error("new session failed");
		const createdPath = created.result.session.path;
		expect(created.result.session.cwd).toBe("/other");
		const forked = await harness.runtime.handleRequest({
			t: "request",
			id: 53,
			method: "session.fork",
			params: { path: "/sessions/one.jsonl" },
		});
		if (forked.method !== "session.fork" || !forked.result) throw new Error("fork failed");
		expect(forked.result.session.path).not.toBe("/sessions/one.jsonl");
		expect(harness.sessionFor("/sessions/one.jsonl").disposed).toBe(0);
		await harness.runtime.handleRequest({
			t: "request",
			id: 54,
			method: "session.rename",
			params: { path: createdPath, title: "Named tab" },
		});
		const tabs = await harness.runtime.handleRequest({
			t: "request",
			id: 55,
			method: "session.tabs",
			params: {},
		});
		if (tabs.method !== "session.tabs" || !tabs.result) throw new Error("tabs missing");
		expect(tabs.result.tabs.find(tab => tab.path === createdPath)?.title).toBe("Named tab");
		await harness.runtime.dispose();
	});

	it("flushes and disposes every managed session during shutdown", async () => {
		const harness = multiSessionHarness(["one", "two", "three"]);
		for (const id of ["two", "three"]) {
			await harness.runtime.handleRequest({
				t: "request",
				id: id === "two" ? 56 : 57,
				method: "session.activate",
				params: { path: `/sessions/${id}.jsonl` },
			});
		}
		const sink = new RecordingSink();
		harness.runtime.attach(sink);
		await harness.runtime.dispose();
		expect(harness.live).toHaveLength(3);
		expect(harness.live.every(session => session.sessionManager.flushed > 0)).toBeTrue();
		expect(harness.live.every(session => session.disposed === 1)).toBeTrue();
		expect(sink.closed?.code).toBe(1001);
	});

	it("keeps authoritative SessionService catalog operations available", async () => {
		const fake = new FakeSession();
		const { catalog, sessions, pins } = catalogFor(fake);
		sessions.push(info("two"));
		const service = new SessionService(fake, { catalog });
		expect((await service.list()).map(item => item.id)).toEqual(["one", "two"]);
		const selected = await service.select("/sessions/two.jsonl");
		expect(selected.header.id).toBe("two");
		const created = await service.newSession("/other");
		expect(created.cwd).toBe("/other");
		const forked = await service.fork(created.path);
		expect(forked.session.id).toStartWith("fork-");
		const renamed = await service.rename("/sessions/one.jsonl", "Renamed");
		expect(renamed.title).toBe("Renamed");
		const pinned = await service.pin("/sessions/one.jsonl", true);
		expect(pinned.pinned).toBeTrue();
		expect(pins.has("one")).toBeTrue();
		expect(await service.deleteStored("/sessions/one.jsonl")).toBeTrue();
		expect(sessions.some(item => item.id === "one")).toBeFalse();
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
