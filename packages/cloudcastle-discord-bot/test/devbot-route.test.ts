import { describe, expect, test } from "bun:test";
import path from "node:path";
import { CHANNELS, GUILD_ID } from "../src/channels";
import { type RouteInput, routeMessage, splitWorkspacePrefix, threadName } from "../src/devbot";
import { loadDevbotConfig } from "../src/devbot-config";

const OPERATOR = "111122223333444455";
const STRANGER = "999988887777666655";
const OTHER_CHANNEL = "1542631105608556575";
const SESSION_THREAD = "1542700000000000001";

const ABSOLUTE_ROOT = process.platform === "win32" ? "C:\\repo" : "/repo";

const CONFIG = loadDevbotConfig({
	CC_DEVBOT_OPERATORS: OPERATOR,
	CC_DEVBOT_WORKSPACES: `chudcode=${path.join(ABSOLUTE_ROOT, "chudcode")}`,
});

/** An allowlisted operator posting in `#sessions`, with overrides spread on top. */
function input(overrides: Partial<RouteInput> = {}): RouteInput {
	return {
		authorId: OPERATOR,
		isBot: false,
		isWebhook: false,
		guildId: GUILD_ID,
		channelId: CHANNELS.sessions.id,
		isThread: false,
		parentId: null,
		content: "fix the build",
		...overrides,
	};
}

/** The same operator, but inside a thread of `#sessions`. */
function inThread(overrides: Partial<RouteInput> = {}): RouteInput {
	return input({ channelId: SESSION_THREAD, isThread: true, parentId: CHANNELS.sessions.id, ...overrides });
}

describe("routeMessage in #sessions", () => {
	test("a plain message from an operator starts a session", () => {
		expect(routeMessage(input(), CONFIG)).toEqual({ kind: "root-prompt", text: "fix the build" });
	});

	test("a bang-prefixed message is a control command", () => {
		expect(routeMessage(input({ content: "!sessions" }), CONFIG)).toEqual({
			kind: "root-control",
			text: "!sessions",
		});
	});

	test("content is trimmed before it becomes a prompt", () => {
		expect(routeMessage(input({ content: "  fix the build  " }), CONFIG)).toEqual({
			kind: "root-prompt",
			text: "fix the build",
		});
	});
});

describe("routeMessage in a session thread", () => {
	test("a plain message is the next prompt for that session", () => {
		expect(routeMessage(inThread({ content: "now run the tests" }), CONFIG)).toEqual({
			kind: "thread-prompt",
			text: "now run the tests",
		});
	});

	test("a bang-prefixed message is a control command", () => {
		expect(routeMessage(inThread({ content: "!abort" }), CONFIG)).toEqual({ kind: "thread-control", text: "!abort" });
	});
});

describe("routeMessage ignores", () => {
	test("a bot author, so the bot's own reports cannot become prompts", () => {
		expect(routeMessage(input({ isBot: true }), CONFIG).kind).toBe("ignore");
	});

	test("a webhook author, so the session reports cannot become prompts", () => {
		expect(routeMessage(input({ isWebhook: true }), CONFIG).kind).toBe("ignore");
	});

	test("another guild", () => {
		expect(routeMessage(input({ guildId: "1542474553320542279" }), CONFIG).kind).toBe("ignore");
	});

	test("a direct message, which has no guild at all", () => {
		expect(routeMessage(input({ guildId: null }), CONFIG).kind).toBe("ignore");
	});

	test("an author who is not on the allowlist", () => {
		expect(routeMessage(input({ authorId: STRANGER }), CONFIG).kind).toBe("ignore");
	});

	test("a channel that is neither #sessions nor one of its threads", () => {
		expect(routeMessage(input({ channelId: OTHER_CHANNEL }), CONFIG).kind).toBe("ignore");
	});

	test("a thread hanging off some other channel", () => {
		expect(routeMessage(inThread({ parentId: OTHER_CHANNEL }), CONFIG).kind).toBe("ignore");
	});

	test("empty content", () => {
		expect(routeMessage(input({ content: "" }), CONFIG).kind).toBe("ignore");
	});

	test("whitespace-only content", () => {
		expect(routeMessage(input({ content: "   \n\t  " }), CONFIG).kind).toBe("ignore");
	});

	test("a thread is never the channel itself, even when the ids line up", () => {
		expect(routeMessage(input({ isThread: true, parentId: null }), CONFIG).kind).toBe("ignore");
	});

	test("a stranger's control command in a real session thread", () => {
		// The allowlist is checked before the command surface exists, so `!abort`
		// from a non-operator cannot stop someone else's session.
		expect(routeMessage(inThread({ authorId: STRANGER, content: "!abort" }), CONFIG).kind).toBe("ignore");
	});
});

describe("routeMessage refuses slash commands", () => {
	test("a slash prefix is answered instead of silently queued", () => {
		const route = routeMessage(input({ content: "/model opus" }), CONFIG);
		expect(route.kind).toBe("refuse");
		expect(route.kind === "refuse" && route.message).toContain("!help");
	});
});

describe("splitWorkspacePrefix", () => {
	test("no prefix leaves the text alone", () => {
		expect(splitWorkspacePrefix("why is x slow")).toEqual({ workspaceName: undefined, prompt: "why is x slow" });
	});

	test("a leading name selects a workspace", () => {
		expect(splitWorkspacePrefix("chudcode: why is x")).toEqual({ workspaceName: "chudcode", prompt: "why is x" });
	});

	test("the name is lowercased", () => {
		expect(splitWorkspacePrefix("CloudCastle: go")).toEqual({ workspaceName: "cloudcastle", prompt: "go" });
	});

	test("a colon later in the sentence is not a prefix", () => {
		expect(splitWorkspacePrefix("fix this: the build breaks")).toEqual({
			workspaceName: undefined,
			prompt: "fix this: the build breaks",
		});
	});

	test("a prefix with nothing after it yields an empty prompt", () => {
		expect(splitWorkspacePrefix("chudcode:")).toEqual({ workspaceName: "chudcode", prompt: "" });
	});

	test("dots, underscores, and dashes are legal in a name", () => {
		expect(splitWorkspacePrefix("my_repo.v2-a: go")).toEqual({ workspaceName: "my_repo.v2-a", prompt: "go" });
	});
});

describe("threadName", () => {
	test("a short prompt passes through", () => {
		expect(threadName("fix the build")).toBe("fix the build");
	});

	test("a long prompt is truncated within Discord's title budget", () => {
		const name = threadName("a".repeat(200));
		expect(name.length).toBeLessThanOrEqual(90);
		expect(name.endsWith("…")).toBe(true);
	});

	test("newlines and runs of whitespace collapse", () => {
		expect(threadName("fix\n\n  the   build\t")).toBe("fix the build");
	});

	test("a fenced code block is stripped", () => {
		expect(threadName("why does this fail ```const x = 1;``` on windows")).toBe("why does this fail on windows");
	});

	test("a prompt that is only a fenced block falls back to a fixed title", () => {
		expect(threadName("```\nconst x = 1;\n```")).toBe("session");
	});
});
