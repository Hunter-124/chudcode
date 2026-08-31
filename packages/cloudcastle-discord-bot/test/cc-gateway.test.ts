import { describe, expect, test } from "bun:test";
import type { AgentHeartbeat, CommandResult, SessionSnapshot } from "../src/bridge-protocol";
import { BUS_PROTOCOL_VERSION } from "../src/bridge-protocol";
import {
	COMMAND_DEFINITIONS,
	HeartbeatRegistry,
	projectChoices,
	renderOutcome,
	renderTaskList,
	renderTaskStatus,
	taskChoices,
} from "../src/cc-gateway";

const NOW = new Date("2026-08-31T12:00:00.000Z");

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
	return {
		sessionId: "task-1",
		host: "hunter-pc",
		sessionFile: "/tmp/task-1.jsonl",
		cwd: "/home/hunter/Desktop/CloudCastle",
		project: "CloudCastle",
		title: "Fix email delivery",
		model: "openai/gpt-5",
		status: "running",
		startedAt: "2026-08-31T11:30:00.000Z",
		updatedAt: "2026-08-31T11:59:30.000Z",
		messageCount: 5,
		costUsd: 1,
		tokensIn: 10,
		tokensOut: 20,
		lastTool: "edit",
		lastText: "Updating the attachment queue contract.",
		originCommandId: "cmd-1",
		requestedBy: "user-1",
		channelId: "channel-1",
		...overrides,
	};
}

function heartbeat(sessions: readonly SessionSnapshot[]): AgentHeartbeat {
	return {
		kind: "agent.heartbeat",
		v: BUS_PROTOCOL_VERSION,
		id: "hb-1",
		host: "hunter-pc",
		projects: ["/home/hunter/Desktop/CloudCastle", "/home/hunter/Repositories/omp"],
		chudcodeVersion: "18.0.8",
		sentAt: "2026-08-31T11:59:45.000Z",
		sessions,
	};
}

function views(sessions: readonly SessionSnapshot[]) {
	const registry = new HeartbeatRegistry();
	registry.ingest(heartbeat(sessions));
	return { registry, views: registry.hosts(NOW) };
}

describe("task discovery", () => {
	test("finds a task from its channel and keeps local sessions out of the task list", () => {
		const local = snapshot({ sessionId: "local", channelId: null, originCommandId: null });
		const task = snapshot();
		const state = views([local, task]);

		expect(state.registry.findSessionByChannel("channel-1", NOW)?.snapshot.sessionId).toBe("task-1");
		const rendered = renderTaskList(state.views);
		expect(rendered).toContain("<#channel-1>");
		expect(rendered).toContain("Working");
		expect(rendered).not.toContain("local");
		expect(rendered).not.toContain("18.0.8");
	});

	test("renders a concise status summary", () => {
		const located = views([snapshot()]).registry.findSession("task-1", NOW);
		if (!located) throw new Error("task fixture was not registered");
		const rendered = renderTaskStatus(located);
		expect(rendered).toContain("Fix email delivery");
		expect(rendered).toContain("Updating the attachment queue contract.");
		expect(rendered).not.toContain("hunter-pc");
		expect(rendered).not.toContain("task-1");
	});

	test("autocomplete uses readable project and task labels", () => {
		const state = views([snapshot(), snapshot({ sessionId: "local", channelId: null })]);
		expect(projectChoices(state.views, "cloud", null)[0]).toEqual({
			name: "CloudCastle · hunter-pc",
			value: "/home/hunter/Desktop/CloudCastle",
		});
		expect(taskChoices(state.views, "fix")).toEqual([{ name: "Fix email delivery · Working", value: "task-1" }]);
	});
});

describe("task command copy", () => {
	const result = (outcome: CommandResult["outcome"], detail: string): CommandResult => ({
		kind: "command.result",
		v: BUS_PROTOCOL_VERSION,
		id: `result-${outcome}`,
		commandId: "cmd-1",
		host: "hunter-pc",
		outcome,
		detail,
		sessionId: "task-1",
		channelId: "channel-1",
		completedAt: NOW.toISOString(),
	});

	test("start and steer answers tell the user what to do next", () => {
		expect(renderOutcome(result("accepted", "Task channel ready."), "hunter-pc", "start")).toContain(
			"reply in that channel to steer",
		);
		expect(renderOutcome(result("accepted", "queued"), "hunter-pc", "steer")).toContain("Direction sent");
	});

	test("rejections stay plain and timeouts point to the task list", () => {
		expect(renderOutcome(result("rejected", "This task has finished."), "hunter-pc", "steer")).toBe(
			"This task has finished.",
		);
		expect(renderOutcome(null, "hunter-pc", "stop")).toContain("/task list");
	});

	test("registers one coherent task command surface", () => {
		expect(COMMAND_DEFINITIONS).toHaveLength(1);
		expect(COMMAND_DEFINITIONS[0]?.name).toBe("task");
		const options = COMMAND_DEFINITIONS[0]?.options as Array<{ name: string }>;
		expect(options.map(option => option.name)).toEqual(["start", "list", "status", "steer", "pause", "stop", "transcript"]);
	});
});
