import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import * as url from "node:url";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { createSessionTeardown } from "@oh-my-pi/pi-coding-agent/modes/session-teardown";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage, type WriteTextAtomicOptions } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import { ModelRegistry } from "../../src/config/model-registry";

const AUTOSAVE_INTERVAL_MS = 40;

class RecordingStorage extends MemorySessionStorage {
	readonly atomicPaths: string[] = [];

	override async writeTextAtomic(file: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		this.atomicPaths.push(file);
		await super.writeTextAtomic(file, content, options);
	}
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error(`Condition was not met within ${timeoutMs}ms`);
		await Bun.sleep(10);
	}
}

function makeTool(): AgentTool {
	return {
		name: "read",
		label: "read",
		description: "Fake read",
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
}

interface InteractiveHarness {
	mode: InteractiveMode;
	session: AgentSession;
	authStorage: AuthStorage;
}

async function createInteractiveHarness(tempDir: TempDir, manager: SessionManager): Promise<InteractiveHarness> {
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), `auth-${Bun.nanoseconds()}.db`));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), `models-${Bun.nanoseconds()}.yml`));
	const model: Model<Api> | undefined = registry.find("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected test model");
	const readTool = makeTool();
	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [readTool],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
		}),
		sessionManager: manager,
		settings: Settings.instance,
		modelRegistry: registry,
		toolRegistry: new Map([[readTool.name, readTool]]),
		builtInToolNames: [readTool.name],
	});
	return { mode: new InteractiveMode(session, "test"), session, authStorage };
}

async function createResumedManager(tempDir: TempDir, draft: string): Promise<SessionManager> {
	const sessionDir = path.join(tempDir.path(), "sessions");
	const firstRun = SessionManager.create(tempDir.path(), sessionDir);
	firstRun.appendMessage({ role: "user", content: "existing turn", timestamp: 1 });
	await firstRun.saveDraft(draft);
	const sessionFile = firstRun.getSessionFile();
	if (!sessionFile) throw new Error("Expected persisted session file");
	await firstRun.close();

	const resumed = SessionManager.create(tempDir.path(), sessionDir);
	await resumed.setSessionFile(sessionFile);
	return resumed;
}

beforeAll(() => {
	initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	Settings.instance.set("startup.quiet", true);
	Settings.instance.set("draft.autosaveIntervalMs", 0);
});

afterEach(() => {
	vi.useRealTimers();
	resetSettingsForTest();
});

describe("draft crash preservation", () => {
	it("coalesces rapid typing into one periodic autosave", async () => {
		vi.useFakeTimers();
		let text = "";
		const saved: string[] = [];
		let disposed = false;
		const teardown = createSessionTeardown({
			getDraftText: () => text,
			beginDispose: () => {},
			saveDraft: async draft => {
				saved.push(draft);
			},
			disposeSession: async () => {
				disposed = true;
			},
			autosaveIntervalMs: AUTOSAVE_INTERVAL_MS,
		});

		text = "a";
		text = "ab";
		text = "abc";
		vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS);
		await Promise.resolve();
		await Promise.resolve();
		expect(saved).toEqual(["abc"]);

		await teardown();
		expect(disposed).toBe(true);
	});

	it("restores an autosaved draft after the writer is killed with SIGKILL", async () => {
		// This is intentionally a real-clock integration test: a separate Bun
		// process must receive an actual kernel SIGKILL after its timer writes.
		using tempDir = TempDir.createSync("@pi-draft-sigkill-");
		const readyPath = path.join(tempDir.path(), "ready.json");
		const managerUrl = url.pathToFileURL(path.join(import.meta.dir, "../../src/session/session-manager.ts")).href;
		const teardownUrl = url.pathToFileURL(path.join(import.meta.dir, "../../src/modes/session-teardown.ts")).href;
		const childScript = `
			import { SessionManager } from ${JSON.stringify(managerUrl)};
			import { createSessionTeardown } from ${JSON.stringify(teardownUrl)};
			const dir = process.env.DRAFT_TEST_DIR;
			const readyPath = process.env.DRAFT_READY_PATH;
			if (!dir || !readyPath) throw new Error("missing test paths");
			const session = SessionManager.create(dir, dir);
			session.appendMessage({ role: "user", content: "existing turn", timestamp: 1 });
			let draft = "";
			createSessionTeardown({
				getDraftText: () => draft,
				beginDispose: () => {},
				saveDraft: text => session.saveDraft(text),
				disposeSession: () => session.close(),
				autosaveIntervalMs: ${AUTOSAVE_INTERVAL_MS},
			});
			draft = "survives sigkill";
			await Bun.write(readyPath, JSON.stringify({ sessionFile: session.getSessionFile(), changedAt: Date.now() }));
			setInterval(() => {}, 60_000);
		`;
		const child = Bun.spawn([process.execPath, "-e", childScript], {
			env: {
				DRAFT_TEST_DIR: tempDir.path(),
				DRAFT_READY_PATH: readyPath,
			},
			stdout: "pipe",
			stderr: "pipe",
		});

		await waitUntil(() => Bun.file(readyPath).exists());
		const ready = (await Bun.file(readyPath).json()) as { sessionFile: string; changedAt: number };
		const draftPath = path.join(ready.sessionFile.slice(0, -".jsonl".length), "draft.txt");
		await waitUntil(
			async () => (await Bun.file(draftPath).exists()) && (await Bun.file(draftPath).text()) === "survives sigkill",
		);
		expect(Date.now() - ready.changedAt).toBeLessThan(1_000);

		child.kill(9);
		await child.exited;

		const resumed = SessionManager.create(tempDir.path(), tempDir.path());
		await resumed.setSessionFile(ready.sessionFile);
		expect(await resumed.consumeDraft()).toBe("survives sigkill");
		await resumed.close();
	});

	it("restores a consumed draft into an empty editor", async () => {
		using tempDir = TempDir.createSync("@pi-draft-empty-editor-");
		const manager = await createResumedManager(tempDir, "restore me");
		const harness = await createInteractiveHarness(tempDir, manager);
		try {
			await harness.mode.init({ suppressWelcomeIntro: true });
			expect(harness.mode.editor.getText()).toBe("restore me");
		} finally {
			harness.mode.stop();
			await harness.session.dispose();
			harness.authStorage.close();
		}
	});

	it("does not clobber editor text typed before draft restore", async () => {
		using tempDir = TempDir.createSync("@pi-draft-nonempty-editor-");
		const manager = await createResumedManager(tempDir, "stale draft");
		const harness = await createInteractiveHarness(tempDir, manager);
		harness.mode.editor.setText("already typed");
		try {
			await harness.mode.init({ suppressWelcomeIntro: true });
			expect(harness.mode.editor.getText()).toBe("already typed");
		} finally {
			harness.mode.stop();
			await harness.session.dispose();
			harness.authStorage.close();
		}
	});

	it("strips image and paste markers whose in-memory bytes cannot be restored", async () => {
		using tempDir = TempDir.createSync("@pi-draft-markers-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendMessage({ role: "user", content: "existing turn", timestamp: 1 });

		await session.saveDraft("before [Image #1, 800x600] middle [Paste #2, +30 lines] after");
		const draftPath = path.join(session.getArtifactsDir()!, "draft.txt");
		expect(await Bun.file(draftPath).text()).toBe("before  middle  after");
		await Bun.write(draftPath, "legacy [Image #3] and [Paste #4, 2000 chars]");

		expect(await session.consumeDraft()).toBe("legacy  and ");
		await session.close();
	});

	it("publishes the draft through the storage atomic-write API", async () => {
		const storage = new RecordingStorage();
		const session = SessionManager.create("/workspace", "/sessions", storage);
		session.appendMessage({ role: "user", content: "existing turn", timestamp: 1 });

		await session.saveDraft("atomic draft");

		expect(storage.atomicPaths.some(file => file.endsWith("/draft.txt"))).toBe(true);
		await session.close();
	});
});
