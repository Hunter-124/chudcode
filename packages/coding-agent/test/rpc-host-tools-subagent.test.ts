import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { RpcHostToolBridge } from "@oh-my-pi/pi-coding-agent/modes/rpc/host-tools";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

registerMockApi();

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	AgentRegistry.resetGlobalForTests();
});

async function childSession(
	id: string,
	host: RpcHostToolBridge,
	options: { toolNames?: string[]; toolAllowlist?: string[]; restrictToolNames?: boolean } = {},
): Promise<AgentSession> {
	const dir = TempDir.createSync("@rpc-host-subagent-");
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const { session } = await createAgentSession({
		cwd: dir.path(),
		agentDir: dir.path(),
		authStorage,
		modelRegistry: new ModelRegistry(authStorage, path.join(dir.path(), "models.yml")),
		model: createMockModel({ id: `${id}-idle`, handler: () => ({ content: ["idle"] }) }),
		settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false, "retry.enabled": false }),
		sessionManager: SessionManager.inMemory(dir.path()),
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		skills: [],
		rules: [],
		contextFiles: [],
		taskDepth: 1,
		agentId: id,
		parentTaskPrefix: id,
		parentAgentId: "Main",
		inheritedHostTools: host,
		...options,
	});
	cleanups.push(async () => {
		await session.dispose();
		dir.removeSync();
	});
	return session;
}

describe("RPC nested host tools", () => {
	it("gives live host tools to unrestricted children and grandchildren but never restricted children", async () => {
		const host = new RpcHostToolBridge(() => {});
		host.setTools([{ name: "make_box", description: "Create a CAD part", parameters: { type: "object" } }]);
		const worker = await childSession("Worker", host);
		const restricted = await childSession("Restricted", host, { toolNames: ["read"], restrictToolNames: true });
		expect(worker.getXdevToolEntries().map(entry => entry.name)).toContain("make_box");
		expect(worker.getHostToolSource()).toBe(host);
		expect(restricted.getAllToolNames()).not.toContain("make_box");
		expect(restricted.getHostToolSource()).toBeUndefined();
		host.setTools([{ name: "mate_parts", description: "Join two CAD parts", parameters: { type: "object" } }]);
		await worker.runToolRegistryMutation(async () => {});
		expect(worker.getXdevToolEntries().map(entry => entry.name)).toContain("mate_parts");
	});

	it("clamps child built-ins to root --tools while allowing named host tools", async () => {
		const host = new RpcHostToolBridge(() => {});
		host.setTools([{ name: "make_box", description: "Create a CAD part", parameters: { type: "object" } }]);
		const child = await childSession("Builder", host, {
			toolNames: ["read", "edit", "make_box"],
			toolAllowlist: ["read", "bash"],
		});
		expect(child.getAllToolNames()).toContain("make_box");
		expect(child.getActiveToolNames()).toContain("make_box");
		expect(child.getAllToolNames()).not.toContain("edit");
		expect(child.getAllToolNames()).not.toContain("bash");
	});
});
