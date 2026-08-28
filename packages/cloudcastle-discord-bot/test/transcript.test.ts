import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import {
	DISCORD_MESSAGE_LIMIT,
	formatDurationMs,
	formatToolLine,
	renderFooter,
	renderStatus,
	splitForDiscord,
	type TodoLine,
	TurnAccumulator,
	type TurnDigest,
} from "../src/transcript";

/**
 * Events reach the bot over RPC as plain JSON, so the tests fabricate the same
 * shape rather than constructing a real `AssistantMessage`: the point of the
 * accumulator is that it survives whatever the wire hands it.
 */
function ev(value: Record<string, unknown>): AgentSessionEvent {
	return value as unknown as AgentSessionEvent;
}

function assistant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		role: "assistant",
		content: [],
		model: "claude-opus-5",
		api: "messages",
		provider: "anthropic",
		usage: {},
		stopReason: "stop",
		...overrides,
	};
}

function textBlocks(...texts: string[]): Array<Record<string, unknown>> {
	return texts.map(text => ({ type: "text", text }));
}

function startTool(id: string, toolName: string, args: unknown): AgentSessionEvent {
	return ev({ type: "tool_execution_start", toolCallId: id, toolName, args });
}

function endTool(id: string, toolName: string, isError = false): AgentSessionEvent {
	return ev({ type: "tool_execution_end", toolCallId: id, toolName, result: {}, isError });
}

function digestOf(overrides: Partial<TurnDigest> = {}): TurnDigest {
	return {
		text: "",
		toolCalls: 0,
		toolErrors: 0,
		steps: 0,
		usd: null,
		totalTokens: null,
		errored: false,
		aborted: false,
		notes: [],
		...overrides,
	};
}

/** Every fence line in a Discord message must pair up or the rest of the thread greys out. */
function fenceLineCount(chunk: string): number {
	return chunk.split("\n").filter(line => /^\s*`{3,}/.test(line)).length;
}

describe("splitForDiscord", () => {
	test("(1) never exceeds the limit and partitions the text exactly", () => {
		const text = Array.from({ length: 400 }, (_, index) => `line ${index} ${"x".repeat(20)}`).join("\n");
		const chunks = splitForDiscord(text);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
		expect(chunks.join("")).toBe(text);
	});

	test("(1) returns nothing for empty or whitespace-only input", () => {
		expect(splitForDiscord("")).toEqual([]);
		expect(splitForDiscord("   \n\n\t  ")).toEqual([]);
	});

	test("(1) prefers a blank line, then a newline, then a space, then a hard cut", () => {
		expect(splitForDiscord(`${"a".repeat(30)}\n\n${"b".repeat(30)}`, 40)).toEqual([
			`${"a".repeat(30)}\n\n`,
			"b".repeat(30),
		]);
		expect(splitForDiscord(`${"a".repeat(20)}\n${"b".repeat(20)}`, 30)).toEqual([
			`${"a".repeat(20)}\n`,
			"b".repeat(20),
		]);
		expect(splitForDiscord(`${"a".repeat(20)} ${"b".repeat(20)}`, 30)).toEqual([
			`${"a".repeat(20)} `,
			"b".repeat(20),
		]);
		expect(splitForDiscord("a".repeat(70), 30)).toEqual(["a".repeat(30), "a".repeat(30), "a".repeat(10)]);
	});

	test("(1) a single unbreakable token longer than the limit is hard-split, not dropped", () => {
		const token = "z".repeat(4500);
		const chunks = splitForDiscord(token);
		expect(chunks.join("")).toBe(token);
		for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
	});

	test("(1) repairs a fence broken across chunks and reproduces the input once stripped", () => {
		const code = Array.from({ length: 40 }, (_, index) => `const value${index} = ${index};`).join("\n");
		const text = `here is the patch\n\n\`\`\`ts\n${code}\n\`\`\`\n\ndone`;
		const chunks = splitForDiscord(text, 200);
		expect(chunks.length).toBeGreaterThan(2);

		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(200);
			expect(fenceLineCount(chunk) % 2).toBe(0);
		}

		const reopen = "```ts\n";
		expect(chunks[1].startsWith(reopen)).toBe(true);
		expect(chunks[0].endsWith("\n```")).toBe(true);

		let rejoined = "";
		for (let index = 0; index < chunks.length; index++) {
			let body = chunks[index];
			if (index > 0 && body.startsWith(reopen)) body = body.slice(reopen.length);
			const nextIsRepaired = index + 1 < chunks.length && chunks[index + 1].startsWith(reopen);
			if (nextIsRepaired && body.endsWith("\n```")) body = body.slice(0, -4);
			rejoined += body;
		}
		expect(rejoined).toBe(text);
	});

	test("(1) closes a fence the input itself never closed", () => {
		const chunks = splitForDiscord("```ts\nconst unfinished = 1;");
		expect(chunks).toHaveLength(1);
		expect(chunks[0].endsWith("```")).toBe(true);
		expect(fenceLineCount(chunks[0])).toBe(2);
	});
});

describe("formatToolLine", () => {
	test("(2) picks the one useful argument per tool", () => {
		expect(formatToolLine("read", { path: "docs/rpc.md" })).toBe("`read` docs/rpc.md");
		expect(formatToolLine("write", { path: "src/a.ts", content: "x" })).toBe("`write` src/a.ts");
		expect(formatToolLine("edit", { path: "src/b.ts" })).toBe("`edit` src/b.ts");
		expect(formatToolLine("bash", { command: "bun test" })).toBe("`bash` bun test");
		expect(formatToolLine("grep", { pattern: "TurnAccumulator", path: "src" })).toBe("`grep` TurnAccumulator");
		expect(formatToolLine("glob", { path: "src/**/*.ts" })).toBe("`glob` src/**/*.ts");
		expect(formatToolLine("glob", { pattern: "**/*.md" })).toBe("`glob` **/*.md");
		expect(formatToolLine("task", { tasks: [{ name: "BridgeDocs", task: "read the docs" }] })).toBe(
			"`task` BridgeDocs",
		);
	});

	test("(2) falls back to the intent, and to nothing at all", () => {
		expect(formatToolLine("browser", { action: "open" }, "Opening the dashboard")).toBe(
			"`browser` Opening the dashboard",
		);
		expect(formatToolLine("browser", { action: "open" })).toBe("`browser`");
		expect(formatToolLine("read", {}, "Reading the runbook")).toBe("`read` Reading the runbook");
	});

	test("(2) truncates a long argument and collapses newlines", () => {
		const line = formatToolLine("read", { path: `deeply/${"nested/".repeat(40)}file.ts` });
		expect(line.startsWith("`read` deeply/nested/")).toBe(true);
		expect(line.endsWith("…")).toBe(true);
		expect(line.length).toBe("`read` ".length + 60);

		const multiline = formatToolLine("bash", { command: "set -e\nbun test\necho done" });
		expect(multiline).toBe("`bash` set -e bun test echo done");
		expect(multiline).not.toContain("\n");
	});

	test("(2) never throws on malformed or absent args", () => {
		expect(formatToolLine("read", undefined)).toBe("`read`");
		expect(formatToolLine("read", null)).toBe("`read`");
		expect(formatToolLine("read", "just a string")).toBe("`read`");
		expect(formatToolLine("read", ["a", "b"])).toBe("`read`");
		expect(formatToolLine("task", { tasks: [] })).toBe("`task`");
		expect(formatToolLine("task", { tasks: ["not an object"] })).toBe("`task`");
	});
});

describe("TurnAccumulator", () => {
	test("(3) walks queued → thinking → working → thinking → done", () => {
		const turn = new TurnAccumulator();
		expect(turn.status().phase).toBe("queued");
		turn.push(ev({ type: "agent_start" }));
		expect(turn.status().phase).toBe("thinking");
		turn.push(startTool("t1", "read", { path: "a.ts" }));
		expect(turn.status().phase).toBe("working");
		turn.push(endTool("t1", "read"));
		expect(turn.status().phase).toBe("thinking");
		expect(turn.finished).toBe(false);
		turn.push(ev({ type: "agent_end", messages: [] }));
		expect(turn.status().phase).toBe("done");
		expect(turn.finished).toBe(true);
	});

	test("(3) compaction and retry own the phase while they are in flight", () => {
		const turn = new TurnAccumulator();
		turn.push(ev({ type: "turn_start" }));
		turn.push(ev({ type: "auto_compaction_start", reason: "threshold", action: "context-full" }));
		expect(turn.status().phase).toBe("compacting");
		turn.push(
			ev({
				type: "auto_compaction_end",
				action: "context-full",
				result: undefined,
				aborted: false,
				willRetry: false,
			}),
		);
		expect(turn.status().phase).toBe("thinking");
		turn.push(
			ev({ type: "auto_retry_start", attempt: 2, maxAttempts: 5, delayMs: 1000, errorMessage: "overloaded" }),
		);
		expect(turn.status().phase).toBe("retrying");
		expect(turn.status().note).toBe("Retry 2/5: overloaded");
		turn.push(ev({ type: "auto_retry_end", success: true, attempt: 2 }));
		expect(turn.status().phase).toBe("thinking");
	});

	test("(3) a non-terminal agent_end does not finish the turn", () => {
		const turn = new TurnAccumulator();
		turn.push(ev({ type: "agent_start" }));
		turn.push(ev({ type: "agent_end", messages: [], isTerminal: false }));
		expect(turn.finished).toBe(false);
		expect(turn.status().phase).toBe("thinking");
		turn.push(ev({ type: "agent_end", messages: [], isTerminal: true }));
		expect(turn.finished).toBe(true);
		expect(turn.status().phase).toBe("done");
	});

	test("(3) error comes from the newest message, an error notice, or telemetry", () => {
		const fromMessage = new TurnAccumulator();
		fromMessage.push(ev({ type: "message_end", message: assistant({ errorMessage: "context overflow" }) }));
		expect(fromMessage.status().phase).toBe("error");
		// A recovered turn stops reading as failed: only the newest message counts.
		fromMessage.push(ev({ type: "message_start", message: assistant() }));
		expect(fromMessage.status().phase).toBe("thinking");

		const fromNotice = new TurnAccumulator();
		fromNotice.push(ev({ type: "agent_start" }));
		fromNotice.push(ev({ type: "notice", level: "error", message: "tool sandbox died" }));
		expect(fromNotice.status().phase).toBe("error");
		fromNotice.push(ev({ type: "agent_end", messages: [] }));
		expect(fromNotice.status().phase).toBe("error");

		const fromTelemetry = new TurnAccumulator();
		fromTelemetry.push(
			ev({
				type: "agent_end",
				messages: [],
				telemetry: {
					usage: { totalTokens: 10 },
					cost: { estimatedUsd: 1 },
					tools: { total: 1 },
					errors: { total: 3 },
				},
			}),
		);
		expect(fromTelemetry.status().phase).toBe("error");
	});

	test("(3) aborted beats error and done never overrides either", () => {
		const viaStopReason = new TurnAccumulator();
		viaStopReason.push(
			ev({ type: "message_end", message: assistant({ stopReason: "aborted", errorMessage: "cancelled" }) }),
		);
		expect(viaStopReason.status().phase).toBe("aborted");
		viaStopReason.push(ev({ type: "agent_end", messages: [] }));
		expect(viaStopReason.status().phase).toBe("aborted");
		expect(viaStopReason.digest().aborted).toBe(true);

		const viaUpdate = new TurnAccumulator();
		viaUpdate.push(ev({ type: "agent_start" }));
		viaUpdate.push(
			ev({
				type: "message_update",
				message: assistant(),
				assistantMessageEvent: { type: "error", reason: "aborted", error: assistant() },
			}),
		);
		expect(viaUpdate.status().phase).toBe("aborted");
	});

	test("(3) activity keeps the newest lines and marks the failures", () => {
		const turn = new TurnAccumulator({ activityLimit: 3 });
		for (let index = 0; index < 5; index++) {
			turn.push(startTool(`t${index}`, "read", { path: `file${index}.ts` }));
			turn.push(endTool(`t${index}`, "read", index === 4));
		}
		expect(turn.status().activity).toEqual(["`read` file2.ts", "`read` file3.ts", "`read` file4.ts ✗"]);
		expect(turn.status().toolCalls).toBe(5);
		expect(turn.status().toolErrors).toBe(1);
	});

	test("(3) digest text keeps assistant text blocks only, blank-line joined", () => {
		const turn = new TurnAccumulator();
		turn.push(
			ev({
				type: "message_end",
				message: assistant({
					content: [
						{ type: "thinking", thinking: "secret plan nobody should read" },
						...textBlocks("First paragraph."),
						{ type: "toolCall", id: "t1", name: "read", arguments: {} },
					],
				}),
			}),
		);
		turn.push(ev({ type: "message_end", message: assistant({ content: textBlocks("Second paragraph.") }) }));
		const digest = turn.digest();
		expect(digest.text).toBe("First paragraph.\n\nSecond paragraph.");
		expect(digest.text).not.toContain("secret plan");
		expect(digest.steps).toBe(2);

		const silent = new TurnAccumulator();
		silent.push(ev({ type: "message_end", message: assistant() }));
		expect(silent.digest().text).toBe("");
	});

	test("(3) revision only moves when the render would change", () => {
		const turn = new TurnAccumulator();
		turn.push(ev({ type: "agent_start" }));
		const afterStart = turn.revision;
		expect(afterStart).toBeGreaterThan(0);

		turn.push(startTool("t1", "bash", { command: "bun test" }));
		const afterTool = turn.revision;
		expect(afterTool).toBeGreaterThan(afterStart);

		// An update for a tool already on the board renders identically.
		turn.push(
			ev({ type: "tool_execution_update", toolCallId: "t1", toolName: "bash", args: {}, partialResult: "x" }),
		);
		expect(turn.revision).toBe(afterTool);
		turn.push(ev({ type: "thinking_level_changed", thinkingLevel: "high" }));
		expect(turn.revision).toBe(afterTool);
		turn.push(
			ev({
				type: "message_update",
				message: assistant(),
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi", partial: assistant() },
			}),
		);
		expect(turn.revision).toBe(afterTool);

		// Ending the tool empties the in-flight set: working → thinking is visible.
		turn.push(endTool("t1", "bash"));
		expect(turn.revision).toBeGreaterThan(afterTool);

		const afterNote = turn.revision;
		turn.push(ev({ type: "notice", level: "info", message: "same sentence" }));
		expect(turn.revision).toBeGreaterThan(afterNote);
		const afterFirstNote = turn.revision;
		turn.push(ev({ type: "notice", level: "info", message: "same sentence" }));
		expect(turn.revision).toBe(afterFirstNote);
	});

	test("(3) setTodos only bumps the revision for a different list", () => {
		const turn = new TurnAccumulator();
		const todos: TodoLine[] = [
			{ content: "wire the bridge", status: "completed" },
			{ content: "post the digest", status: "in_progress" },
		];
		turn.setTodos(todos);
		const afterFirst = turn.revision;
		expect(afterFirst).toBeGreaterThan(0);
		expect(turn.todos()).toEqual(todos);

		turn.setTodos([
			{ content: "wire the bridge", status: "completed" },
			{ content: "post the digest", status: "in_progress" },
		]);
		expect(turn.revision).toBe(afterFirst);

		turn.setTodos([
			{ content: "wire the bridge", status: "completed" },
			{ content: "post the digest", status: "completed" },
		]);
		expect(turn.revision).toBeGreaterThan(afterFirst);
	});

	test("(3) unknown and future event types are ignored without throwing", () => {
		const turn = new TurnAccumulator();
		turn.push(ev({ type: "agent_start" }));
		const before = turn.revision;
		expect(() =>
			turn.push({ type: "something_new", payload: { nested: true } } as unknown as AgentSessionEvent),
		).not.toThrow();
		expect(() => turn.push({ type: "irc_message" } as unknown as AgentSessionEvent)).not.toThrow();
		expect(turn.revision).toBe(before);
		expect(turn.status().phase).toBe("thinking");
	});

	test("(3) telemetry populates the digest and stays null when RPC omits it", () => {
		const withTelemetry = new TurnAccumulator();
		withTelemetry.push(
			ev({
				type: "agent_end",
				messages: [],
				telemetry: {
					usage: { totalTokens: 34_102 },
					cost: { estimatedUsd: 0.042_123 },
					tools: { total: 4 },
					errors: { total: 0 },
					stepCount: 3,
				},
			}),
		);
		expect(withTelemetry.digest().totalTokens).toBe(34_102);
		expect(withTelemetry.digest().usd).toBeCloseTo(0.042_123, 6);

		const without = new TurnAccumulator();
		without.push(ev({ type: "agent_end", messages: [] }));
		expect(without.digest().totalTokens).toBeNull();
		expect(without.digest().usd).toBeNull();
	});

	test("(3) notes are collected in order and deduped", () => {
		const turn = new TurnAccumulator();
		turn.push(ev({ type: "notice", level: "warning", message: "disk is filling up" }));
		turn.push(ev({ type: "retry_fallback_applied", from: "opus", to: "sonnet", role: "main" }));
		turn.push(ev({ type: "notice", level: "warning", message: "disk is filling up" }));
		expect(turn.digest().notes).toEqual(["warning: disk is filling up", "Model fallback: opus → sonnet (main)"]);
	});

	test("(3) the model comes from the newest assistant message", () => {
		const turn = new TurnAccumulator();
		expect(turn.status().model).toBeNull();
		turn.push(ev({ type: "message_start", message: assistant({ model: "claude-opus-5" }) }));
		expect(turn.status().model).toBe("claude-opus-5");
	});
});

describe("renderStatus", () => {
	test("(4) stays inside the Discord limit under 200 tool lines and 100 todos", () => {
		const activity = Array.from({ length: 200 }, (_, index) => `\`read\` ${"p".repeat(300)}/${index}.ts`);
		const todos: TodoLine[] = Array.from({ length: 100 }, (_, index) => ({
			content: `task number ${index} ${"detail ".repeat(20)}`,
			status: index < 40 ? "completed" : index === 40 ? "in_progress" : "pending",
		}));
		const rendered = renderStatus(
			{
				phase: "working",
				model: "claude-opus-5",
				steps: 12,
				toolCalls: 200,
				toolErrors: 3,
				activity,
				note: `something noisy ${"and long ".repeat(80)}`,
			},
			todos,
			195_000,
		);
		expect(rendered.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
		expect(rendered).toContain("+");
		expect(rendered).toContain("more");
	});

	test("(4) leads with an emoji phase marker carrying elapsed time and model", () => {
		const rendered = renderStatus(
			{
				phase: "working",
				model: "claude-opus-5",
				steps: 2,
				toolCalls: 3,
				toolErrors: 1,
				activity: ["`bash` bun test"],
				note: null,
			},
			[],
			67_000,
		);
		const [first, second] = rendered.split("\n");
		expect(first).toBe("🔧 **working** · 1m 07s · claude-opus-5");
		expect(second).toBe("-# 2 steps · 3 tools · 1 failed");
		expect(rendered).toContain("`bash` bun test");
	});

	test("(4) renders todo checkboxes and an honest overflow count", () => {
		const todos: TodoLine[] = [
			{ content: "done", status: "completed" },
			{ content: "in progress", status: "in_progress" },
			{ content: "pending", status: "pending" },
		];
		const rendered = renderStatus(
			{ phase: "thinking", model: null, steps: 0, toolCalls: 0, toolErrors: 0, activity: [], note: null },
			todos,
			0,
		);
		expect(rendered).toContain("- [x] done");
		expect(rendered).toContain("- [~] in progress");
		expect(rendered).toContain("- [ ] pending");
		expect(rendered).not.toContain("more");

		const many: TodoLine[] = Array.from({ length: 30 }, (_, index) => ({
			content: `todo ${index}`,
			status: "pending",
		}));
		const truncated = renderStatus(
			{ phase: "thinking", model: null, steps: 0, toolCalls: 0, toolErrors: 0, activity: [], note: null },
			many,
			0,
		);
		const shown = truncated.split("\n").filter(line => line.startsWith("- [")).length;
		expect(truncated).toContain(`+${30 - shown} more`);
	});

	test("(4) the note survives when activity and todos are trimmed away", () => {
		const rendered = renderStatus(
			{
				phase: "retrying",
				model: null,
				steps: 1,
				toolCalls: 400,
				toolErrors: 0,
				activity: Array.from({ length: 400 }, () => `\`bash\` ${"y".repeat(400)}`),
				note: "Retry 3/5: provider overloaded",
			},
			Array.from({ length: 200 }, (_, index) => ({ content: `todo ${index}`, status: "pending" })),
			5_000,
		);
		expect(rendered.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
		expect(rendered).toContain("> Retry 3/5: provider overloaded");
	});
});

describe("renderFooter", () => {
	test("(5) shows elapsed, counts, tokens and a 4-decimal cost", () => {
		const footer = renderFooter(
			digestOf({ steps: 4, toolCalls: 12, toolErrors: 1, totalTokens: 34_102, usd: 0.042_123 }),
			125_000,
		);
		expect(footer).toBe("-# ✅ done · 2m 05s · 4 steps · 12 tools · 1 failed · 34,102 tokens · $0.0421");
	});

	test("(5) never prints null, undefined or NaN when telemetry is missing", () => {
		const footer = renderFooter(digestOf({ steps: 1, toolCalls: 1 }), 12_000);
		expect(footer).toBe("-# ✅ done · 12s · 1 step · 1 tool");
		for (const forbidden of ["null", "undefined", "NaN", "$"]) expect(footer).not.toContain(forbidden);

		const broken = renderFooter(
			digestOf({ steps: 1, toolCalls: 0, totalTokens: Number.NaN, usd: Number.NaN, errored: true }),
			1_000,
		);
		expect(broken).not.toContain("NaN");
		expect(broken).toContain("❌");
	});

	test("(5) an aborted turn says so", () => {
		expect(renderFooter(digestOf({ aborted: true, errored: true }), 0)).toContain("🛑 aborted");
	});
});

describe("formatDurationMs", () => {
	test("(6) formats seconds, minutes and hours and clamps negatives", () => {
		expect(formatDurationMs(0)).toBe("0s");
		expect(formatDurationMs(12_400)).toBe("12s");
		expect(formatDurationMs(59_999)).toBe("59s");
		expect(formatDurationMs(187_000)).toBe("3m 07s");
		expect(formatDurationMs(3_840_000)).toBe("1h 04m");
		expect(formatDurationMs(-5_000)).toBe("0s");
		expect(formatDurationMs(Number.NaN)).toBe("0s");
	});
});
