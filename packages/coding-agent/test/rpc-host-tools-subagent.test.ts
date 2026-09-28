import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { Context, ToolResultMessage } from "@chudware/ai";
import { createMockModel, registerMockApi } from "@chudware/ai/providers/mock";
import { ModelRegistry } from "@chudware/coding-agent/config/model-registry";
import { Settings } from "@chudware/coding-agent/config/settings";
import { RpcHostToolBridge } from "@chudware/coding-agent/modes/rpc/host-tools";
import type {
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
} from "@chudware/coding-agent/modes/rpc/rpc-types";
import { AgentRegistry } from "@chudware/coding-agent/registry/agent-registry";
import { type CreateAgentSessionOptions, createAgentSession } from "@chudware/coding-agent/sdk";
import type { AgentSession } from "@chudware/coding-agent/session/agent-session";
import { AuthStorage } from "@chudware/coding-agent/session/auth-storage";
import { SessionManager } from "@chudware/coding-agent/session/session-manager";
import { TempDir } from "@chudware/utils";

registerMockApi();

type HostFrame = RpcHostToolCallRequest | RpcHostToolCancelRequest;

const objectSchema = { type: "object", properties: { size: { type: "number" } }, additionalProperties: false };
const MAKE_BOX: RpcHostToolDefinition = {
	name: "make_box",
	description: "Create a box part in the host CAD document",
	parameters: objectSchema,
};
const MEASURE: RpcHostToolDefinition = {
	name: "measure",
	description: "Measure a part in the host CAD document",
	parameters: objectSchema,
};

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	AgentRegistry.resetGlobalForTests();
});

/** A host bridge whose outgoing frames are recorded, as rpc-mode wires it to stdout. */
function createHost(tools: RpcHostToolDefinition[]) {
	const frames: HostFrame[] = [];
	const waiters: Array<() => void> = [];
	const bridge = new RpcHostToolBridge(frame => {
		frames.push(frame);
		for (const wake of waiters.splice(0)) wake();
	});
	bridge.setTools(tools);
	const calls = () => frames.filter((frame): frame is RpcHostToolCallRequest => frame.type === "host_tool_call");
	const waitForCalls = async (count: number): Promise<RpcHostToolCallRequest[]> => {
		while (calls().length < count) {
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.push(resolve);
			await promise;
		}
		return calls();
	};
	return { bridge, frames, calls, waitForCalls };
}

/** Mock model that writes `args` to `xd://<tool>` once, then answers with its tool result text. */
function deviceCallingModel(id: string, tool: string, args: Record<string, unknown>) {
	return createMockModel({
		id,
		handler: (context: Context) => {
			const last = context.messages.at(-1);
			if (last?.role === "toolResult") {
				const text = last.content.map(part => (part.type === "text" ? part.text : "")).join("");
				return { content: [`result:${text}`] };
			}
			return {
				content: [
					{
						type: "toolCall",
						id: `call-${id}`,
						name: "write",
						arguments: { path: `xd://${tool}`, content: JSON.stringify(args) },
					},
				],
			};
		},
	});
}

async function createSubagentSession(
	agentId: string,
	source: RpcHostToolBridge,
	overrides: Partial<CreateAgentSessionOptions> = {},
): Promise<AgentSession> {
	const dir = TempDir.createSync("@rpc-host-subagent-");
	const auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
	auth.setRuntimeApiKey("mock", "test-key");
	const { session } = await createAgentSession({
		cwd: dir.path(),
		agentDir: dir.path(),
		authStorage: auth,
		modelRegistry: new ModelRegistry(auth, path.join(dir.path(), "models.yml")),
		model: createMockModel({ id: `${agentId}-idle`, handler: () => ({ content: ["idle"] }) }),
		settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false, "retry.enabled": false }),
		sessionManager: SessionManager.inMemory(dir.path()),
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		skills: [],
		rules: [],
		contextFiles: [],
		taskDepth: 1,
		agentId,
		parentTaskPrefix: agentId,
		parentAgentId: "Main",
		inheritedHostTools: source,
		...overrides,
	});
	cleanups.push(async () => {
		await session.dispose();
		dir.removeSync();
	});
	return session;
}

function toolResultText(session: AgentSession, toolCallId: string): string {
	const result = session.messages.find(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolCallId === toolCallId,
	);
	return JSON.stringify(result?.content ?? null);
}

describe("task sub-agents inherit RPC host tools", () => {
	it("mounts the host's tools, narrows them to an explicit allowlist, and follows host replacements", async () => {
		const host = createHost([MAKE_BOX, MEASURE]);
		const open = await createSubagentSession("OpenWorker", host.bridge);
		const allowlisted = await createSubagentSession("MeasureOnly", host.bridge, { toolNames: ["read", "measure"] });
		const restricted = await createSubagentSession("Restricted", host.bridge, {
			toolNames: ["read"],
			restrictToolNames: true,
		});

		const devices = (session: AgentSession) => session.getXdevToolEntries().map(entry => entry.name);
		expect(devices(open)).toEqual(expect.arrayContaining(["make_box", "measure"]));
		// Explicitly named tools are pinned top-level rather than mounted under xd://.
		expect(allowlisted.getActiveToolNames()).toContain("measure");
		expect(allowlisted.getAllToolNames()).not.toContain("make_box");
		expect(restricted.getAllToolNames()).not.toContain("make_box");
		expect(restricted.getAllToolNames()).not.toContain("measure");
		// Grandchildren inherit through the child's own task tool.
		expect(open.getHostToolSource()).toBe(host.bridge);
		expect(restricted.getHostToolSource()).toBeUndefined();

		// The host's `enable_tools` refresh (set_host_tools) reaches live sub-agents.
		host.bridge.setTools([MAKE_BOX, MEASURE, { ...MEASURE, name: "mate_parts" }]);
		await open.runToolRegistryMutation(async () => {});
		expect(devices(open)).toContain("mate_parts");
	});

	it("clamps built-ins to the parent's --tools ceiling without dropping host tools", async () => {
		const host = createHost([MAKE_BOX, MEASURE]);
		const toolAllowlist = ["read", "bash", "task"];
		const inheriting = await createSubagentSession("CeilingWorker", host.bridge, { toolAllowlist });
		const narrowed = await createSubagentSession("NarrowWorker", host.bridge, {
			toolAllowlist,
			toolNames: ["read", "edit", "measure"],
		});

		const inheritingTools = inheriting.getAllToolNames();
		const inheritingDevices = inheriting.getXdevToolEntries().map(entry => entry.name);
		// The default built-in set collapses to the ceiling: no edit/debug/github devices ride along.
		expect(inheritingTools).toEqual(expect.arrayContaining(["read", "bash"]));
		for (const dropped of ["edit", "grep", "debug", "github", "ast_edit", "eval"]) {
			expect(inheritingTools).not.toContain(dropped);
			expect(inheritingDevices).not.toContain(dropped);
		}
		expect(inheritingDevices).toEqual(expect.arrayContaining(["make_box", "measure"]));
		// An agent allowlist narrows further; host tools stay governed by it alone.
		expect(narrowed.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "measure"]));
		expect(narrowed.getAllToolNames()).not.toContain("edit");
		expect(narrowed.getAllToolNames()).not.toContain("bash");
		expect(narrowed.getAllToolNames()).not.toContain("make_box");
	});

	it("routes parallel sub-agent calls to the host attributed to each sub-agent", async () => {
		const host = createHost([MAKE_BOX]);
		const cube = await createSubagentSession("CubeBuilder", host.bridge);
		const cylinder = await createSubagentSession("CylinderBuilder", host.bridge);
		await cube.setModel(deviceCallingModel("cube", "make_box", { size: 10 }));
		await cylinder.setModel(deviceCallingModel("cylinder", "make_box", { size: 5 }));

		const runs = [cube.prompt("build a 10mm cube"), cylinder.prompt("build a 5mm cylinder")];
		// Both calls are in flight on the same host at once: neither waits on the other.
		const calls = await host.waitForCalls(2);
		const byAgent = new Map(calls.map(call => [call.agentId, call]));
		expect(byAgent.get("CubeBuilder")).toMatchObject({
			toolName: "make_box",
			toolCallId: "call-cube",
			arguments: { size: 10 },
			parentAgentId: "Main",
		});
		expect(byAgent.get("CylinderBuilder")).toMatchObject({
			toolName: "make_box",
			toolCallId: "call-cylinder",
			arguments: { size: 5 },
			parentAgentId: "Main",
		});

		// Answer out of order; each result lands with the sub-agent that asked.
		for (const agentId of ["CylinderBuilder", "CubeBuilder"]) {
			const call = byAgent.get(agentId)!;
			host.bridge.handleResult({
				type: "host_tool_result",
				id: call.id,
				result: { content: [{ type: "text", text: `built-for-${agentId}` }] },
			});
		}
		await Promise.all(runs);
		expect(toolResultText(cube, "call-cube")).toContain("built-for-CubeBuilder");
		expect(toolResultText(cylinder, "call-cylinder")).toContain("built-for-CylinderBuilder");
	});

	it("cancels a sub-agent's in-flight host call when the sub-agent is aborted", async () => {
		const host = createHost([MAKE_BOX]);
		const worker = await createSubagentSession("SlowBuilder", host.bridge);
		await worker.setModel(deviceCallingModel("slow", "make_box", { size: 1 }));

		const run = worker.prompt("build");
		const [call] = await host.waitForCalls(1);
		expect(call?.agentId).toBe("SlowBuilder");
		await worker.abort();
		await run;

		expect(host.frames).toContainEqual(expect.objectContaining({ type: "host_tool_cancel", targetId: call!.id }));
	});
});
