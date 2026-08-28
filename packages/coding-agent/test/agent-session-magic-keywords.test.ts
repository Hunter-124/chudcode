import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@chudware/chudtype";
import { Agent, type AgentTool } from "@chudware/agent-core";
import { Effort } from "@chudware/ai";
import { getBundledModel } from "@chudware/catalog/models";
import * as autoThinkingClassifier from "@chudware/coding-agent/auto-thinking/classifier";
import { ModelRegistry } from "@chudware/coding-agent/config/model-registry";
import { Settings } from "@chudware/coding-agent/config/settings";
import { AgentSession } from "@chudware/coding-agent/session/agent-session";
import { AuthStorage } from "@chudware/coding-agent/session/auth-storage";
import { SessionManager } from "@chudware/coding-agent/session/session-manager";
import { AUTO_THINKING } from "@chudware/coding-agent/thinking";
import { removeWithRetries } from "@chudware/utils";

const mockTaskTool: AgentTool = {
	name: "task",
	label: "Task",
	description: "Mock task tool",
	parameters: type({}),
	execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
};

const mockEvalTool: AgentTool = {
	name: "eval",
	label: "Eval",
	description: "Mock eval tool",
	parameters: type({}),
	execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
};

const mockAskTool: AgentTool = {
	name: "ask",
	label: "Ask",
	description: "Mock ask tool",
	parameters: type({}),
	execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
};

async function createMagicKeywordSession(
	modelRegistry: ModelRegistry,
	tools: AgentTool[] = [mockTaskTool, mockEvalTool],
): Promise<{
	session: AgentSession;
	settings: Settings;
}> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled Claude Sonnet model");
	const agent = new Agent({
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools,
			messages: [],
			thinkingLevel: Effort.High,
		},
	});
	const settings = Settings.isolated();
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry,
	});
	return { session, settings };
}

describe("AgentSession magic keyword settings", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage;
	let authRoot: string;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		authRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chudcode-magic-keywords-auth-"));
		authStorage = await AuthStorage.create(path.join(authRoot, "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(authRoot, "models.yml"));
	});

	afterAll(async () => {
		authStorage.close();
		await removeWithRetries(authRoot);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) await session.dispose();
		session = undefined;
	});

	it("does not append magic keyword notices when disabled", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;
		created.settings.set("magicKeywords.enabled", false);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please workflowz this and ultrathink through it");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([]);
	});

	it("honors non-ultrathink per-keyword notice toggles", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;
		created.settings.set("magicKeywords.orchestrate", false);
		created.settings.set("magicKeywords.workflow", false);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please orchestrate and workflowz this");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([]);
	});

	it("still appends enabled non-ultrathink notices", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please orchestrate and workflowz this");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([
			"orchestrate-notice",
			"workflow-notice",
		]);
	});

	it("renders the eval-specific workflowz notice", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;
		created.settings.set("task.batch", false);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please workflowz this");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{
			content?: string;
			customType?: string;
		}>;
		const notice = promptMessages.find(message => message.customType === "workflow-notice");
		expect(notice?.customType).toBe("workflow-notice");
		expect(notice?.content).toContain("`eval`");
		expect(notice?.content).toContain("`parallel(thunks)`");
		expect(notice?.content).toContain("**Python (`eval`, Python backend):**");
		expect(notice?.content).toContain("**JavaScript (`eval`, JavaScript backend):**");
	});

	it("updates the workflowz notice when scout is disabled during the session", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;
		created.settings.set("task.disabledAgents", ["scout"]);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please workflowz this");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ content?: string; customType?: string }>;
		const notice = promptMessages.find(message => message.customType === "workflow-notice")?.content ?? "";
		expect(notice.toLowerCase()).not.toContain("scout");
		expect(notice).toContain("Explore inline FIRST");
	});

	it("skips workflowz notice when the task tool is inactive", async () => {
		const created = await createMagicKeywordSession(modelRegistry, []);
		session = created.session;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please workflowz this");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([]);
	});

	it("skips orchestrate notice when the task tool is inactive", async () => {
		const created = await createMagicKeywordSession(modelRegistry, []);
		session = created.session;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please orchestrate this");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([]);
	});

	it("skips workflowz notice when the eval tool is inactive", async () => {
		const created = await createMagicKeywordSession(modelRegistry, [mockTaskTool]);
		session = created.session;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please workflowz this");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([]);
	});

	it("does not use a disabled ultrathink keyword to force auto thinking", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;
		created.settings.set("magicKeywords.ultrathink", false);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const classifierSpy = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);
		session.setThinkingLevel(AUTO_THINKING);

		await session.prompt("ultrathink through the unsafe refactor");

		expect(classifierSpy).toHaveBeenCalledTimes(1);
		expect(session.thinkingLevel).toBe(Effort.Low);
		expect(session.autoResolvedThinkingLevel()).toBe(Effort.Low);
	});

	it("injects the ultragoon notice when either of its mechanisms is live, and skips it otherwise", async () => {
		const withAskOnly = await createMagicKeywordSession(modelRegistry, [mockAskTool]);
		session = withAskOnly.session;
		let promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please ultragoon this rewrite");

		let promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ content?: string; customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual(["ultragoon-notice"]);
		// `ask` present, `task` absent: the decision round stays, the research
		// fan-out degrades to self-directed exploration.
		const askOnlyNotice = promptMessages.find(message => message.customType === "ultragoon-notice")?.content ?? "";
		expect(askOnlyNotice).toContain("`glob`/`grep`/`read`");
		expect(askOnlyNotice).not.toContain("No `ask` tool");
		await session.dispose();

		const withoutTools = await createMagicKeywordSession(modelRegistry, []);
		session = withoutTools.session;
		promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please ultragoon this rewrite");

		promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([]);
	});

	it("pairs tokenmaxxing with the orchestration contract exactly once when task is active", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		// Both keywords ask for the dispatch contract; it must not be injected twice.
		await session.prompt("tokenmaxxing and orchestrate this audit");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([
			"orchestrate-notice",
			"tokenmaxxing-notice",
		]);
	});

	it("keeps the tokenmaxxing routing notice without the dispatch contract when task is inactive", async () => {
		const created = await createMagicKeywordSession(modelRegistry, []);
		session = created.session;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("tokenmaxxing this audit");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual(["tokenmaxxing-notice"]);
	});

	it("leaves auto thinking to the classifier for keywords other than ultrathink", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const classifierSpy = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);
		session.setThinkingLevel(AUTO_THINKING);

		await session.prompt("tokenmaxxing autobot ultragoon this rewrite");

		expect(classifierSpy).toHaveBeenCalledTimes(1);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("injects the autobot notice with no tool prerequisites", async () => {
		const created = await createMagicKeywordSession(modelRegistry, []);
		session = created.session;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("autobot the release prep");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual(["autobot-notice"]);
	});

	it("honors the per-keyword toggles for the new keywords", async () => {
		const created = await createMagicKeywordSession(modelRegistry, [mockTaskTool, mockEvalTool, mockAskTool]);
		session = created.session;
		created.settings.set("magicKeywords.ultragoon", false);
		created.settings.set("magicKeywords.tokenmaxxing", false);
		created.settings.set("magicKeywords.autobot", false);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("ultragoon tokenmaxxing autobot this rewrite");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([]);
	});

	it("queues the magic-keyword notice before the user message", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("ultrathink do the thing");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ role?: string; customType?: string }>;
		const noticeIdx = promptMessages.findIndex(m => m.customType === "ultrathink-notice");
		const userIdx = promptMessages.findIndex(m => m.role === "user");
		expect(noticeIdx).toBeGreaterThanOrEqual(0);
		expect(userIdx).toBeGreaterThanOrEqual(0);
		expect(noticeIdx).toBeLessThan(userIdx);
	});
});
