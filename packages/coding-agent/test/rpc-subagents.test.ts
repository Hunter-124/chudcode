import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import {
	handleRpcSessionChange,
	type RpcSessionChangeCommand,
	type RpcSessionChangeResult,
	type RpcSessionChangeSession,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { RpcSubagentRegistry, readRpcSubagentTranscript } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import type { RpcSubagentFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { type AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import {
	type SubagentEventPayload,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const tempPaths: string[] = [];

afterEach(() => {
	for (const tempPath of tempPaths.splice(0)) {
		removeSyncWithRetries(tempPath);
	}
});

function createProgress(overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 0,
		id: "SubagentA",
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "Do work",
		assignment: "Implement work",
		description: "Worker",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

function createRegistryWithSnapshot(): RpcSubagentRegistry {
	const eventBus = new EventBus();
	const registry = new RpcSubagentRegistry(eventBus, () => {});
	eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
		id: "SubagentA",
		index: 0,
		agent: "task",
		agentSource: "bundled",
		status: "started",
		sessionFile: "/tmp/subagent.jsonl",
	} satisfies SubagentLifecyclePayload);
	expect(registry.getSubagents()).toHaveLength(1);
	return registry;
}

type SessionChangeStubOptions = {
	newSession?: boolean;
	switchSession?: boolean;
	branch?: { selectedText: string; selectedImages: ImageContent[]; cancelled: boolean };
};

function createSessionChangeSession(options: SessionChangeStubOptions): RpcSessionChangeSession {
	return {
		newSession: async (_options?: unknown) => options.newSession ?? true,
		switchSession: async (_sessionPath: string) => options.switchSession ?? true,
		branch: async (_entryId: string) =>
			options.branch ?? { selectedText: "branched text", selectedImages: [], cancelled: false },
	};
}

describe("RPC subagent registry", () => {
	test("defaults subagent frame emission to off while tracking snapshots", () => {
		const frames: RpcSubagentFrame[] = [];
		const eventBus = new EventBus();
		const registry = new RpcSubagentRegistry(eventBus, frame => frames.push(frame));
		const lifecycle: SubagentLifecyclePayload = {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			description: "Worker",
			status: "started",
			sessionFile: "/tmp/subagent.jsonl",
			parentToolCallId: "toolu_parent",
		};
		const progressPayload: SubagentProgressPayload = {
			index: 0,
			agent: "task",
			agentSource: "bundled",
			task: "Do work",
			assignment: "Implement work",
			parentToolCallId: "toolu_parent",
			sessionFile: "/tmp/subagent.jsonl",
			progress: createProgress(),
		};
		const eventPayload: SubagentEventPayload = {
			id: "SubagentA",
			event: { type: "agent_start" },
		};

		expect(registry.getSubscriptionLevel()).toBe("off");
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle);
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progressPayload);
		eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, eventPayload);

		expect(frames).toHaveLength(0);
		expect(registry.getSubagents()).toMatchObject([
			{
				id: "SubagentA",
				status: "running",
				sessionFile: "/tmp/subagent.jsonl",
			},
		]);
		registry.dispose();
	});

	test("emits progress frames after explicit progress subscription and snapshots tracked subagents", () => {
		const frames: RpcSubagentFrame[] = [];
		const eventBus = new EventBus();
		const registry = new RpcSubagentRegistry(eventBus, frame => frames.push(frame));
		registry.setSubscriptionLevel("progress");
		const lifecycle: SubagentLifecyclePayload = {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			description: "Worker",
			status: "started",
			sessionFile: "/tmp/subagent.jsonl",
			parentToolCallId: "toolu_parent",
		};
		const progressPayload: SubagentProgressPayload = {
			index: 0,
			agent: "task",
			agentSource: "bundled",
			task: "Do work",
			assignment: "Implement work",
			parentToolCallId: "toolu_parent",
			sessionFile: "/tmp/subagent.jsonl",
			progress: createProgress(),
		};

		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle);
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progressPayload);

		expect(frames.map(frame => frame.type)).toEqual(["subagent_lifecycle", "subagent_progress"]);
		expect(registry.getSubagents()).toMatchObject([
			{
				id: "SubagentA",
				status: "running",
				task: "Do work",
				assignment: "Implement work",
				sessionFile: "/tmp/subagent.jsonl",
				parentToolCallId: "toolu_parent",
			},
		]);

		registry.dispose();
	});

	test("clears stale snapshots after successful RPC session changes", async () => {
		const cases: Array<{
			command: RpcSessionChangeCommand;
			session: RpcSessionChangeSession;
			expected: RpcSessionChangeResult;
		}> = [
			{
				command: { type: "new_session", parentSession: "/tmp/parent.jsonl" },
				session: createSessionChangeSession({ newSession: true }),
				expected: { type: "new_session", data: { cancelled: false } },
			},
			{
				command: { type: "switch_session", sessionPath: "/tmp/next.jsonl" },
				session: createSessionChangeSession({ switchSession: true }),
				expected: { type: "switch_session", data: { cancelled: false } },
			},
			{
				command: { type: "branch", entryId: "entry-1" },
				session: createSessionChangeSession({
					branch: { selectedText: "Branch text", selectedImages: [], cancelled: false },
				}),
				expected: { type: "branch", data: { text: "Branch text", cancelled: false } },
			},
		];

		for (const testCase of cases) {
			const registry = createRegistryWithSnapshot();
			try {
				const result = await handleRpcSessionChange(testCase.session, testCase.command, registry);

				expect(result).toEqual(testCase.expected);
				expect(registry.getSubagents()).toHaveLength(0);
				await expect(registry.resolveSessionFile({ subagentId: "SubagentA" })).rejects.toThrow(
					/Unknown subagent or session file unavailable/,
				);
			} finally {
				registry.dispose();
			}
		}
	});

	test("keeps stale snapshots when RPC session changes are cancelled", async () => {
		const cases: Array<{
			command: RpcSessionChangeCommand;
			session: RpcSessionChangeSession;
			expected: RpcSessionChangeResult;
		}> = [
			{
				command: { type: "new_session", parentSession: "/tmp/parent.jsonl" },
				session: createSessionChangeSession({ newSession: false }),
				expected: { type: "new_session", data: { cancelled: true } },
			},
			{
				command: { type: "switch_session", sessionPath: "/tmp/next.jsonl" },
				session: createSessionChangeSession({ switchSession: false }),
				expected: { type: "switch_session", data: { cancelled: true } },
			},
			{
				command: { type: "branch", entryId: "entry-1" },
				session: createSessionChangeSession({ branch: { selectedText: "", selectedImages: [], cancelled: true } }),
				expected: { type: "branch", data: { text: "", cancelled: true } },
			},
		];

		for (const testCase of cases) {
			const registry = createRegistryWithSnapshot();
			try {
				const result = await handleRpcSessionChange(testCase.session, testCase.command, registry);

				expect(result).toEqual(testCase.expected);
				expect(registry.getSubagents()).toMatchObject([{ id: "SubagentA" }]);
				expect(await registry.resolveSessionFile({ subagentId: "SubagentA" })).toBe("/tmp/subagent.jsonl");
			} finally {
				registry.dispose();
			}
		}
	});

	test("prunes terminal lifecycle snapshots while retaining transcript selectors", async () => {
		const eventBus = new EventBus();
		const registry = new RpcSubagentRegistry(eventBus, () => {});
		const sessionFile = "/tmp/subagent.jsonl";
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "started",
			sessionFile,
		} satisfies SubagentLifecyclePayload);

		expect(registry.getSubagents()).toHaveLength(1);
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "completed",
			sessionFile,
		} satisfies SubagentLifecyclePayload);

		expect(registry.getSubagents()).toHaveLength(0);
		expect(await registry.resolveSessionFile({ subagentId: "SubagentA" })).toBe(sessionFile);
		expect(await registry.resolveSessionFile({ sessionFile })).toBe(sessionFile);
		registry.dispose();
	});

	test("resolves persisted child and grandchild files after restart only within the current session tree", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-subagent-resume-"));
		tempPaths.push(dir);
		const root = path.join(dir, "root.jsonl");
		const child = path.join(dir, "root", "Child.jsonl");
		const grandchild = path.join(dir, "root", "Child", "Child.Grandchild.jsonl");
		const otherRoot = path.join(dir, "other.jsonl");
		const outside = path.join(dir, "outside.jsonl");
		const wrongParent = path.join(dir, "root", "WrongParent.jsonl");
		const linked = path.join(dir, "root", "Linked.jsonl");
		const forgedPrefix = path.join(dir, "root-forged", "Child.jsonl");
		const linkedParent = path.join(dir, "root", "LinkedParent.jsonl");
		const grandchildViaLinkedParent = path.join(dir, "root", "LinkedParent", "Grandchild.jsonl");
		const linkedDirectory = path.join(dir, "root", "LinkedDirectory");
		const grandchildViaLinkedDirectory = path.join(linkedDirectory, path.basename(grandchild));
		fs.mkdirSync(path.dirname(grandchild), { recursive: true });
		fs.mkdirSync(path.dirname(forgedPrefix), { recursive: true });
		fs.mkdirSync(path.dirname(grandchildViaLinkedParent), { recursive: true });
		const header = (id: string, parentSession?: string) =>
			`${JSON.stringify({ type: "session", version: 3, id, cwd: dir, parentSession })}\n`;
		fs.writeFileSync(root, header("root"));
		fs.writeFileSync(otherRoot, header("other"));
		fs.writeFileSync(child, header("child", root));
		fs.writeFileSync(grandchild, header("grandchild", child));
		fs.writeFileSync(outside, header("outside", root));
		fs.writeFileSync(wrongParent, header("wrong-parent", otherRoot));
		fs.writeFileSync(forgedPrefix, header("forged-prefix", root));
		fs.writeFileSync(grandchildViaLinkedParent, header("linked-parent-grandchild", linkedParent));
		fs.symlinkSync(outside, linked);
		fs.symlinkSync(child, linkedParent);
		fs.symlinkSync(path.dirname(grandchild), linkedDirectory, process.platform === "win32" ? "junction" : "dir");
		const traversalOutside = path.join(dir, "traversal-outside");
		fs.mkdirSync(path.join(traversalOutside, "nested"), { recursive: true });
		const markerMessage = {
			type: "message",
			id: "inside-marker",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: { role: "user", content: [{ type: "text", text: "INSIDE-CURRENT-SESSION" }], timestamp: 0 },
		};
		fs.appendFileSync(child, `${JSON.stringify(markerMessage)}\n`);
		markerMessage.id = "outside-marker";
		markerMessage.message.content[0]!.text = "OUTSIDE-CURRENT-SESSION";
		fs.writeFileSync(
			path.join(traversalOutside, path.basename(child)),
			header("outside-child", root) + `${JSON.stringify(markerMessage)}\n`,
		);
		const traversalLink = path.join(dir, "root", "TraversalLink");
		fs.symlinkSync(
			path.join(traversalOutside, "nested"),
			traversalLink,
			process.platform === "win32" ? "junction" : "dir",
		);
		const registry = new RpcSubagentRegistry(new EventBus(), () => {});
		try {
			expect(await registry.resolveSessionFile({ sessionFile: child }, root)).toBe(child);
			expect(await registry.resolveSessionFile({ sessionFile: grandchild }, root)).toBe(grandchild);
			const relativeAlias = `${path.dirname(child)}${path.sep}.${path.sep}${path.basename(child)}`;
			expect(await registry.resolveSessionFile({ sessionFile: relativeAlias }, root)).toBe(
				path.resolve(relativeAlias),
			);
			const caseAlias = child.toUpperCase();
			if (fs.existsSync(caseAlias)) {
				const selected = await registry.resolveSessionFile({ sessionFile: caseAlias }, root.toUpperCase());
				expect(JSON.stringify((await readRpcSubagentTranscript(selected)).messages)).toContain(
					"INSIDE-CURRENT-SESSION",
				);
			}
			const traversalRequest = `${traversalLink}${path.sep}..${path.sep}${path.basename(child)}`;
			const selected = await registry.resolveSessionFile({ sessionFile: traversalRequest }, root);
			const selectedContent = JSON.stringify((await readRpcSubagentTranscript(selected)).messages);
			expect(selectedContent).toContain("INSIDE-CURRENT-SESSION");
			expect(selectedContent).not.toContain("OUTSIDE-CURRENT-SESSION");
			expect(registry.getSubagents()).toEqual([]);
			for (const sessionFile of [
				root,
				outside,
				wrongParent,
				linked,
				forgedPrefix,
				grandchildViaLinkedParent,
				grandchildViaLinkedDirectory,
				path.join(dir, "root", "missing.jsonl"),
			]) {
				await expect(registry.resolveSessionFile({ sessionFile }, root)).rejects.toThrow(
					"Unknown subagent session file",
				);
			}
			await expect(registry.resolveSessionFile({ sessionFile: child }, otherRoot)).rejects.toThrow(
				"Unknown subagent session file",
			);
			await expect(registry.resolveSessionFile({ sessionFile: child })).rejects.toThrow(
				"Unknown subagent session file",
			);
		} finally {
			registry.dispose();
		}
	});

	test("gates raw subagent events behind the events subscription level", () => {
		const frames: RpcSubagentFrame[] = [];
		const eventBus = new EventBus();
		const registry = new RpcSubagentRegistry(eventBus, frame => frames.push(frame));
		const eventPayload: SubagentEventPayload = {
			id: "SubagentA",
			event: { type: "agent_start" },
		};

		eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, eventPayload);
		expect(frames).toHaveLength(0);

		registry.setSubscriptionLevel("events");
		eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, eventPayload);

		expect(frames).toHaveLength(1);
		expect(frames[0]).toEqual({ type: "subagent_event", payload: eventPayload });
		registry.dispose();
	});
});

describe("readRpcSubagentTranscript", () => {
	test("returns complete JSONL entries and byte cursor", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-subagent-transcript-"));
		tempPaths.push(dir);
		const sessionFile = path.join(dir, "session.jsonl");
		const headerLine = `${JSON.stringify({ type: "session", id: "s1", timestamp: "2026-06-09T00:00:00.000Z", cwd: dir })}\n`;
		const messageLine = `${JSON.stringify({
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-06-09T00:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: "hello" }] },
		})}\n`;
		await Bun.write(sessionFile, `${headerLine}${messageLine}{"type":"message"`);

		const result = await readRpcSubagentTranscript(sessionFile);

		expect(result.entries).toHaveLength(2);
		expect(result.messages).toHaveLength(1);
		expect(result.nextByte).toBe(Buffer.byteLength(`${headerLine}${messageLine}`, "utf8"));
		expect(result.reset).toBe(false);
	});

	test("returns empty cursor result for missing transcript files", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-subagent-transcript-missing-"));
		tempPaths.push(dir);
		const sessionFile = path.join(dir, "missing.jsonl");

		const result = await readRpcSubagentTranscript(sessionFile, 42);

		expect(result).toEqual({
			sessionFile,
			fromByte: 42,
			nextByte: 42,
			reset: false,
			entries: [],
			messages: [],
		});
	});
});

describe("RpcClient subagent frames", () => {
	test("dispatches subagent frames and session-specific events", async () => {
		const scriptPath = path.join(os.tmpdir(), `omp-rpc-subagent-client-${Date.now()}.js`);
		tempPaths.push(scriptPath);
		await Bun.write(
			scriptPath,
			`
let buffer = "";
function write(frame) {
	process.stdout.write(JSON.stringify(frame) + "\\n");
}
const progress = {
	index: 0,
	id: "SubagentA",
	agent: "task",
	agentSource: "bundled",
	status: "running",
	task: "Do work",
	assignment: "Implement work",
	recentTools: [],
	recentOutput: [],
	toolCount: 0,
	tokens: 0,
	cost: 0,
	durationMs: 0
};
write({ type: "ready" });
process.stdin.on("data", chunk => {
	buffer += chunk.toString("utf8");
	let index = buffer.indexOf("\\n");
	while (index !== -1) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line) handle(JSON.parse(line));
		index = buffer.indexOf("\\n");
	}
});
function handle(frame) {
	if (frame.type === "set_subagent_subscription") {
		write({ id: frame.id, type: "response", command: "set_subagent_subscription", success: true, data: { level: frame.level } });
		return;
	}
	if (frame.type === "get_subagents") {
		write({ id: frame.id, type: "response", command: "get_subagents", success: true, data: { subagents: [{ id: "SubagentA", index: 0, agent: "task", agentSource: "bundled", status: "running", lastUpdate: 1 }] } });
		return;
	}
	if (frame.type === "get_subagent_messages") {
		write({ id: frame.id, type: "response", command: "get_subagent_messages", success: true, data: { sessionFile: frame.sessionFile || "/tmp/subagent.jsonl", fromByte: frame.fromByte || 0, nextByte: 0, reset: false, entries: [], messages: [] } });
		return;
	}
	if (frame.type === "prompt") {
		write({ id: frame.id, type: "response", command: "prompt", success: true });
		write({ type: "notice", level: "info", message: "subagent test" });
		write({ type: "subagent_lifecycle", payload: { id: "SubagentA", index: 0, agent: "task", agentSource: "bundled", status: "started", sessionFile: "/tmp/subagent.jsonl" } });
		write({ type: "subagent_progress", payload: { index: 0, agent: "task", agentSource: "bundled", task: "Do work", assignment: "Implement work", sessionFile: "/tmp/subagent.jsonl", progress } });
		write({ type: "subagent_event", payload: { id: "SubagentA", event: { type: "agent_start" } } });
		write({ type: "agent_end", messages: [] });
		write({ type: "prompt_result", id: frame.id, agentInvoked: true, status: "completed" });
	}
}
`,
		);

		using client = new RpcClient({ cliPath: scriptPath });
		const lifecycleIds: string[] = [];
		const progressTasks: string[] = [];
		const rawEventTypes: string[] = [];
		const sessionEventTypes: string[] = [];
		client.onSubagentLifecycle(payload => lifecycleIds.push(payload.id));
		client.onSubagentProgress(payload => progressTasks.push(payload.task));
		client.onSubagentEvent(payload => rawEventTypes.push(payload.event.type));
		client.onSessionEvent(event => sessionEventTypes.push(event.type));

		await client.start();
		await expect(client.setSubagentSubscription("events")).resolves.toBe("events");
		await client.promptAndWait("Trigger subagent frames");
		expect(await client.getSubagents()).toHaveLength(1);
		expect(await client.getSubagentMessages({ sessionFile: "/tmp/subagent.jsonl" })).toMatchObject({
			sessionFile: "/tmp/subagent.jsonl",
		});

		expect(lifecycleIds).toEqual(["SubagentA"]);
		expect(progressTasks).toEqual(["Do work"]);
		expect(rawEventTypes).toEqual(["agent_start"]);
		expect(sessionEventTypes).toContain("notice");
	});

	test("forwards nested subagent frames published on the shared observability bus", () => {
		const frames: RpcSubagentFrame[] = [];
		const eventBus = new EventBus();
		const registry = new RpcSubagentRegistry(eventBus, frame => frames.push(frame));
		registry.setSubscriptionLevel("events");
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "Kid",
			agent: "task",
			agentSource: "bundled",
			status: "started",
			parentToolCallId: "call-1",
			index: 1,
		} satisfies SubagentLifecyclePayload);
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "Kid.Grandkid",
			agent: "task",
			agentSource: "bundled",
			status: "started",
			parentToolCallId: "call-2",
			index: 2,
		} satisfies SubagentLifecyclePayload);
		eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, {
			id: "Kid.Grandkid",
			event: { type: "agent_start" } as SubagentEventPayload["event"],
		} satisfies SubagentEventPayload);
		expect(frames.map(frame => frame.type)).toEqual(["subagent_lifecycle", "subagent_lifecycle", "subagent_event"]);
		expect((frames[1] as { payload: SubagentLifecyclePayload }).payload.id).toBe("Kid.Grandkid");
		expect((frames[2] as { payload: SubagentEventPayload }).payload.id).toBe("Kid.Grandkid");
		registry.dispose();
	});

	test("scopes observability to each root session — another tree's bus stays invisible", () => {
		const busA = new EventBus();
		const busB = new EventBus();
		const framesA: RpcSubagentFrame[] = [];
		const framesB: RpcSubagentFrame[] = [];
		const registryA = new RpcSubagentRegistry(busA, frame => framesA.push(frame));
		const registryB = new RpcSubagentRegistry(busB, frame => framesB.push(frame));
		registryA.setSubscriptionLevel("events");
		registryB.setSubscriptionLevel("events");
		busB.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "Kid",
			agent: "task",
			agentSource: "bundled",
			status: "started",
			index: 1,
		} satisfies SubagentLifecyclePayload);
		expect(framesA).toEqual([]);
		expect(framesB).toHaveLength(1);
		registryA.dispose();
		registryB.dispose();
	});
});
