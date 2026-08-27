import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentHubOverlayComponent } from "@oh-my-pi/pi-coding-agent/modes/components/agent-hub";
import { SessionObserverRegistry } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { sanitizeTaskLabel } from "@oh-my-pi/pi-coding-agent/task/label";
import { generateSessionTitle } from "@oh-my-pi/pi-coding-agent/utils/title-generator";

function getModel(): Model<Api> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled title model");
	return model;
}

function createSettings(model: Model<Api>) {
	return {
		get(path: string) {
			if (path === "providers.tinyModel") return "online";
			return undefined;
		},
		getModelRole(role: string) {
			return role === "smol" ? `${model.provider}/${model.id}` : undefined;
		},
		getStorage() {
			return undefined;
		},
	} as never;
}

function createRegistry(model: Model<Api>) {
	return {
		getAvailable: () => [model],
		getApiKey: async () => "test-key",
		getApiKeyForProvider: async () => "test-key",
		authStorage: { rotateSessionCredential: async () => false },
		resolver: () => async () => "test-key",
	} as never;
}

function renderLabel(label: string): string {
	const agents = new AgentRegistry();
	agents.register({ id: "Worker", displayName: "Worker", kind: "sub", session: {} as AgentSession });
	const observers = new SessionObserverRegistry();
	vi.spyOn(observers, "getSessions").mockReturnValue([
		{
			id: "Worker",
			kind: "subagent",
			label: "Subagent",
			status: "active",
			description: label,
			lastUpdate: Date.now(),
		},
	]);
	const hub = new AgentHubOverlayComponent({
		observers,
		hubKeys: [],
		onDone: () => {},
		requestRender: () => {},
		registry: agents,
		irc: new IrcBus(agents),
		focusAgent: async () => {},
	});
	try {
		return hub.render(120).map(Bun.stripANSI).join("\n");
	} finally {
		hub.dispose();
	}
}

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
	AgentRegistry.resetGlobalForTests();
});

describe("task label markup sanitization", () => {
	it.each([
		["Map TUI editor for undo/redo feature</title>", "Map TUI editor for undo/redo feature"],
		[
			'< TITLE data-origin="model" >Map TUI editor for undo/redo feature< / TITLE \n>',
			"Map TUI editor for undo/redo feature",
		],
		['Map TUI editor for undo/redo feature</TiTlE data-origin="model" \n>', "Map TUI editor for undo/redo feature"],
		["Map TUI editor for undo/redo feature</TiTlE", "Map TUI editor for undo/redo feature"],
	] as const)("cleans title wrapper variants in generated output: %s", async (responseText, expected) => {
		const model = getModel();
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: responseText }],
		} as never);

		const title = await generateSessionTitle(
			"Implement undo and redo history for the TUI editor",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBe(expected);
	});

	it.each([
		"Map<K,V>",
		"migrate A -> B",
	])("preserves legitimate angle-bracket label text byte-identical: %s", label => {
		expect(sanitizeTaskLabel(label)).toBe(label);
	});

	it("strips residual tag-shaped markup at the hub render boundary", () => {
		const rendered = renderLabel(
			'Map TUI editor for undo/redo feature</TiTlE> <strong data-origin="model">now</strong>',
		);

		expect(rendered).toContain("Map TUI editor for undo/redo feature now");
		expect(rendered).not.toContain("</TiTlE>");
		expect(rendered).not.toContain("<strong");
		expect(rendered).not.toContain("</strong>");
	});

	it.each(["Map<K,V>", "migrate A -> B"])("renders legitimate angle-bracket label text unchanged: %s", label => {
		expect(renderLabel(label)).toContain(label);
	});
});
