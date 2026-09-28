import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@chudware/ai";
import type { ModelRegistry } from "@chudware/coding-agent/config/model-registry";
import { Settings } from "@chudware/coding-agent/config/settings";
import type { LoadExtensionsResult } from "@chudware/coding-agent/extensibility/extensions/types";
import type { PlanModeState } from "@chudware/coding-agent/plan-mode/state";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@chudware/coding-agent/sdk";
import * as sdkModule from "@chudware/coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@chudware/coding-agent/session/agent-session";
import { TaskTool } from "@chudware/coding-agent/task";
import * as discoveryModule from "@chudware/coding-agent/task/discovery";
import type { AgentDefinition, TaskParams } from "@chudware/coding-agent/task/types";
import type { IsolationHandle, WorktreeBaseline } from "@chudware/coding-agent/task/worktree";
import * as worktreeModule from "@chudware/coding-agent/task/worktree";
import type { ToolSession } from "@chudware/coding-agent/tools";
import { applyToolAllowlist } from "@chudware/coding-agent/tools/builtin-names";
import { removeWithRetries } from "@chudware/utils";
import "@chudware/coding-agent/tools/yield";
import { EventBus } from "@chudware/coding-agent/utils/event-bus";

const TEST_TASK: TaskParams = { agent: "task", name: "CheckLsp", task: "Inspect LSP tools." };

function createAssistantStopMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createYieldingSession(): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const state = { messages: [] as AssistantMessage[] };

	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};

	return {
		state,
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: {
			appendSessionInit: () => {},
		},
		getActiveToolNames: () => ["yield"],
		getEnabledToolNames: () => ["yield"],
		setActiveToolsByName: async () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			state.messages.push(createAssistantStopMessage("done"));
			emit({
				type: "tool_execution_end",
				toolCallId: "yield-call",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => state.messages[state.messages.length - 1],
		abort: async () => {},
		dispose: async () => {},
		setIrcWakeTurnObserver: () => {},
		subscribeRunState: () => () => {},
	} as unknown as AgentSession;
}

function createSession(
	options: {
		isolationMode?: "none" | "auto";
		parentEnableLsp?: boolean;
		parentEnableMCP?: boolean;
		parentToolAllowlist?: readonly string[];
		planMode?: PlanModeState;
		sessionFile?: string | null;
		taskEnableLsp?: boolean;
	} = {},
): ToolSession {
	const modelRegistry = {
		authStorage: undefined,
		refresh: async () => {},
		getAvailable: () => [],
		getApiKey: async () => null,
	} as unknown as ModelRegistry;

	return {
		cwd: "/tmp",
		hasUI: false,
		enableLsp: options.parentEnableLsp,
		enableMCP: options.parentEnableMCP,
		toolAllowlist: options.parentToolAllowlist,
		settings: Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": options.isolationMode ?? "none",
			...(options.taskEnableLsp !== undefined ? { "task.enableLsp": options.taskEnableLsp } : {}),
		}),
		getSessionFile: () => options.sessionFile ?? null,
		getSessionSpawns: () => "*",
		modelRegistry,
		getPlanModeState: () => options.planMode,
	} as unknown as ToolSession;
}

function mockAgents(agent: AgentDefinition): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
		agents: [agent],
		projectAgentsDir: null,
	});
}

function mockCreateAgentSession(): { getOptions: () => CreateAgentSessionOptions | undefined } {
	let capturedOptions: CreateAgentSessionOptions | undefined;
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async (options = {}) => {
		capturedOptions = options;
		return {
			session: createYieldingSession(),
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} satisfies CreateAgentSessionResult;
	});
	return { getOptions: () => capturedOptions };
}

function mockIsolation(): void {
	const baseline: WorktreeBaseline = {
		root: {
			repoRoot: "/repo",
			headCommit: "HEAD",
			staged: "",
			unstaged: "",
			untracked: [],
			untrackedPatch: "",
		},
		nested: [],
	};
	const isolationHandle: IsolationHandle = {
		mergedDir: "/tmp/isolated-subagent",
		backend: worktreeModule.parseIsolationMode("rcopy")!,
		fellBack: false,
		fallbackReason: null,
	};

	vi.spyOn(worktreeModule, "getRepoRoot").mockResolvedValue("/repo");
	vi.spyOn(worktreeModule, "captureBaseline").mockResolvedValue(baseline);
	vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue(isolationHandle);
	vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({ rootPatch: "", nestedPatches: [] });
	vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();
}

describe("subagent LSP availability", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("disables LSP for subagents by default", async () => {
		mockAgents({
			name: "task",
			description: "Task agent",
			systemPrompt: "Use LSP when useful.",
			source: "bundled",
			tools: ["lsp"],
		});
		const { getOptions } = mockCreateAgentSession();

		const tool = await TaskTool.create(createSession());
		await tool.execute("tool-call", TEST_TASK);

		expect(getOptions()?.enableLsp).toBe(false);
	});

	it("enables subagent LSP when task.enableLsp is set", async () => {
		mockAgents({
			name: "task",
			description: "Task agent",
			systemPrompt: "Use normal tools.",
			source: "bundled",
			tools: ["lsp"],
		});
		const { getOptions } = mockCreateAgentSession();

		const tool = await TaskTool.create(createSession({ taskEnableLsp: true }));
		await tool.execute("tool-call", TEST_TASK);

		expect(getOptions()?.enableLsp).toBe(true);
		expect(getOptions()?.toolNames).toContain("lsp");
	});

	it("keeps subagent LSP disabled when the parent session disables LSP", async () => {
		mockAgents({
			name: "task",
			description: "Task agent",
			systemPrompt: "Use normal tools.",
			source: "bundled",
			tools: ["lsp"],
		});
		const { getOptions } = mockCreateAgentSession();

		const tool = await TaskTool.create(createSession({ parentEnableLsp: false, taskEnableLsp: true }));
		await tool.execute("tool-call", TEST_TASK);

		expect(getOptions()?.enableLsp).toBe(false);
	});

	it("disables LSP for isolated subagents by default", async () => {
		mockAgents({
			name: "task",
			description: "Task agent",
			systemPrompt: "Use LSP when useful.",
			source: "bundled",
			tools: ["lsp"],
		});
		mockIsolation();
		const { getOptions } = mockCreateAgentSession();

		const tool = await TaskTool.create(createSession({ isolationMode: "auto" }));
		await tool.execute("tool-call", { ...TEST_TASK, isolated: true });

		expect(getOptions()?.cwd).toBe("/tmp/isolated-subagent");
		expect(getOptions()?.enableLsp).toBe(false);
	});

	it("opens isolated persisted subagent sessions with the worktree cwd", async () => {
		mockAgents({
			name: "task",
			description: "Task agent",
			systemPrompt: "Use normal tools.",
			source: "bundled",
			tools: ["write"],
		});
		mockIsolation();
		const { getOptions } = mockCreateAgentSession();
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chudcode-isolated-session-cwd-"));
		try {
			const parentSessionFile = path.join(tempDir, "parent.jsonl");
			const tool = await TaskTool.create(createSession({ isolationMode: "auto", sessionFile: parentSessionFile }));
			await tool.execute("tool-call", { ...TEST_TASK, isolated: true });

			const sessionManager = getOptions()?.sessionManager as { getCwd?: () => string } | undefined;
			expect(getOptions()?.cwd).toBe("/tmp/isolated-subagent");
			expect(sessionManager?.getCwd?.()).toBe("/tmp/isolated-subagent");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("clamps plan-mode mixed-capability tools despite ordinary settings", async () => {
		mockAgents({
			name: "task",
			description: "Reviewer-like task agent",
			systemPrompt: "Review with read-only specialty tools.",
			source: "bundled",
			tools: ["bash", "ast_grep", "memory_edit", "retain", "todo"],
		});
		const { getOptions } = mockCreateAgentSession();
		const planMode = { enabled: true, planFilePath: "local://PLAN.md" };

		const tool = await TaskTool.create(createSession({ planMode, taskEnableLsp: true }));
		await tool.execute("tool-call", TEST_TASK);

		const options = getOptions();
		expect(options?.enableLsp).toBe(false);
		expect(options?.enableIrc).toBe(false);
		expect(options?.restrictToolNames).toBe(true);
		expect(options?.toolNames).toEqual(["read", "grep", "glob", "web_search", "ast_grep"]);
		expect(options?.toolNames).not.toContain("lsp");
		expect(options?.toolNames).not.toContain("hub");
		expect(options?.toolNames).not.toContain("bash");
		expect(options?.toolNames).not.toContain("memory_edit");
		expect(options?.toolNames).not.toContain("retain");
		expect(options?.toolNames).not.toContain("todo");
	});
});

describe("subagents inherit the parent process restrictions", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("spawns children under the parent's --tools ceiling with MCP and LSP off", async () => {
		mockAgents({ name: "task", description: "Task agent", systemPrompt: "Work.", source: "bundled" });
		const { getOptions } = mockCreateAgentSession();
		const parentToolAllowlist = ["read", "bash", "hub", "task"];

		const tool = await TaskTool.create(
			createSession({ parentToolAllowlist, parentEnableMCP: false, parentEnableLsp: false, taskEnableLsp: true }),
		);
		await tool.execute("tool-call", TEST_TASK);

		const options = getOptions();
		expect(options?.toolAllowlist).toEqual(parentToolAllowlist);
		expect(applyToolAllowlist(options?.toolNames, options?.toolAllowlist)).toEqual(parentToolAllowlist);
		expect(options?.enableMCP).toBe(false);
		expect(options?.mcpManager).toBeUndefined();
		expect(options?.enableLsp).toBe(false);
	});

	it("narrows an agent's own tool allowlist to the parent ceiling", async () => {
		mockAgents({
			name: "task",
			description: "Task agent",
			systemPrompt: "Work.",
			source: "bundled",
			tools: ["read", "edit", "debug"],
		});
		const { getOptions } = mockCreateAgentSession();

		const tool = await TaskTool.create(createSession({ parentToolAllowlist: ["read", "bash", "hub"] }));
		await tool.execute("tool-call", TEST_TASK);

		const options = getOptions();
		expect(applyToolAllowlist(options?.toolNames, options?.toolAllowlist)).toEqual(["read", "hub"]);
	});
});
