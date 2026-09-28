import { afterEach, describe, expect, it } from "bun:test";
import { parseArgs } from "@chudware/coding-agent/cli/args";
import { ModelRegistry } from "@chudware/coding-agent/config/model-registry";
import { Settings } from "@chudware/coding-agent/config/settings";
import { buildSessionOptions } from "@chudware/coding-agent/main";
import { MCPManager } from "@chudware/coding-agent/mcp/manager";
import { createAgentSession } from "@chudware/coding-agent/sdk";
import { AuthStorage } from "@chudware/coding-agent/session/auth-storage";
import { SessionManager } from "@chudware/coding-agent/session/session-manager";
import { TempDir } from "@chudware/utils";

afterEach(() => {
	MCPManager.resetForTests();
});

/** Build a real session from CLI argv, offering it an MCP manager so no on-disk discovery runs. */
async function createSessionFromArgs(argv: string[]) {
	using tempDir = TempDir.createSync("@chudcode-no-mcp-");
	const authStorage = await AuthStorage.create(":memory:");
	const settings = Settings.isolated();
	const sessionManager = SessionManager.inMemory(tempDir.path());
	const modelRegistry = new ModelRegistry(authStorage);
	const offeredManager = new MCPManager(tempDir.path(), null);
	try {
		const options = await buildSessionOptions(parseArgs(argv), [], sessionManager, modelRegistry, settings);
		const result = await createAgentSession({
			...options,
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry,
			settings,
			sessionManager,
			mcpManager: offeredManager,
			disableExtensionDiscovery: true,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
		});
		const toolNames = result.session.getAllToolNames();
		await result.session.dispose();
		return { options, mcpManager: result.mcpManager, offeredManager, toolNames };
	} finally {
		authStorage.close();
	}
}

describe("--no-mcp", () => {
	it("keeps MCP disabled for the session and records the --tools ceiling for sub-agents", async () => {
		const withMcp = await createSessionFromArgs(["--tools", "read,bash,task"]);
		const withoutMcp = await createSessionFromArgs(["--no-mcp", "--tools", "read,bash,task"]);

		expect(withMcp.mcpManager).toBe(withMcp.offeredManager);
		expect(withoutMcp.options.enableMCP).toBe(false);
		expect(withoutMcp.mcpManager).toBeUndefined();
		expect(withoutMcp.options.toolAllowlist).toEqual(["read", "bash", "task"]);
		expect(withoutMcp.toolNames).toEqual(expect.arrayContaining(["read", "bash", "task"]));
		expect(withoutMcp.toolNames).not.toContain("edit");
	});

	it("leaves sessions without --tools unbounded", async () => {
		const { options } = await createSessionFromArgs(["--no-mcp"]);
		expect(options.toolAllowlist).toBeUndefined();
	});
});
