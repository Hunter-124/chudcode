import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentsHubComponent } from "@oh-my-pi/pi-coding-agent/modes/components/agents-hub";
import { ModelHubComponent } from "@oh-my-pi/pi-coding-agent/modes/components/model-hub";
import { ModelPickerComponent } from "@oh-my-pi/pi-coding-agent/modes/components/model-picker";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import * as discovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { TUI } from "@oh-my-pi/pi-tui";

function makeModel(): Model {
	return buildModel({
		id: "test-model",
		name: "Test Model",
		api: "ollama-chat",
		provider: "test",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 1024,
	});
}

function makeRegistry(model: Model): ModelRegistry {
	return {
		refresh: async () => {},
		refreshProvider: async () => {},
		getError: () => undefined,
		getAvailable: () => [model],
		getAll: () => [model],
		getDiscoverableProviders: () => [],
		getProviderDiscoveryState: () => undefined,
		authStorage: { hasAuth: () => false },
	} as unknown as ModelRegistry;
}

function createHub(escapeClosesOverlay: boolean) {
	const model = makeModel();
	const registry = makeRegistry(model);
	const tui = { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI;
	const onCancel = vi.fn();
	const hub = new ModelHubComponent(
		tui,
		Settings.isolated({ "tui.escapeClosesOverlay": escapeClosesOverlay }),
		registry,
		[],
		{
			onAssign: () => {},
			onUnassign: () => {},
			onCancel,
		},
	);
	return { hub, onCancel };
}

describe("slash overlay dismissal", () => {
	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("dismisses the /models hub with one raw Escape when enabled and search is active", () => {
		const { hub, onCancel } = createHub(true);
		try {
			hub.handleInput("t");
			hub.handleInput("\x1b");
			expect(onCancel).toHaveBeenCalledTimes(1);
		} finally {
			hub.dispose();
		}
	});

	it("keeps Escape assigned to an in-progress /models role assignment before closing the overlay", () => {
		const { hub, onCancel } = createHub(true);
		try {
			hub.handleInput("\x1b[A");
			hub.handleInput("\n");
			hub.handleInput("\n");
			hub.handleInput("\x1b");
			expect(onCancel).not.toHaveBeenCalled();

			hub.handleInput("\x1b");
			expect(onCancel).toHaveBeenCalledTimes(1);
		} finally {
			hub.dispose();
		}
	});

	it("dismisses the /switch picker with one raw Escape when enabled and search is active", () => {
		const model = makeModel();
		const onCancel = vi.fn();
		const picker = new ModelPickerComponent(
			{ requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI,
			Settings.isolated({ "tui.escapeClosesOverlay": true }),
			makeRegistry(model),
			[{ model }],
			{ onPick: () => {}, onCancel },
		);

		picker.handleInput("t");
		picker.handleInput("\x1b");
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("preserves query-clear-then-close behavior when single-Escape dismissal is disabled", () => {
		const { hub, onCancel } = createHub(false);
		try {
			hub.handleInput("t");
			hub.handleInput("\x1b");
			expect(onCancel).not.toHaveBeenCalled();

			hub.handleInput("\x1b");
			expect(onCancel).toHaveBeenCalledTimes(1);
		} finally {
			hub.dispose();
		}
	});

	it("dismisses the /agents hub with one raw Escape when enabled and search is active", async () => {
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			projectAgentsDir: null,
			agents: [{ name: "dev", description: "Development agent", systemPrompt: "", source: "project" }],
		});
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-overlay-dismiss-"));
		try {
			const onCancel = vi.fn();
			const hub = await AgentsHubComponent.create(
				{ requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI,
				cwd,
				Settings.isolated({ "tui.escapeClosesOverlay": true }),
				{ modelRegistry: makeRegistry(makeModel()) },
				{ onCancel },
			);
			hub.handleInput("d");
			hub.handleInput("\x1b");
			expect(onCancel).toHaveBeenCalledTimes(1);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("keeps Escape assigned to an in-progress /agents model assignment before closing the overlay", async () => {
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			projectAgentsDir: null,
			agents: [{ name: "dev", description: "Development agent", systemPrompt: "", source: "project" }],
		});
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-overlay-dismiss-"));
		try {
			const onCancel = vi.fn();
			const hub = await AgentsHubComponent.create(
				{ requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI,
				cwd,
				Settings.isolated({ "tui.escapeClosesOverlay": true }),
				{ modelRegistry: makeRegistry(makeModel()) },
				{ onCancel },
			);
			hub.handleInput("\r"); // agent strip (model chip preselected)
			hub.handleInput("\r"); // model value strip → [pick model…] first
			hub.handleInput("\r"); // assign mode: model browser
			hub.handleInput("\x1b");
			expect(onCancel).not.toHaveBeenCalled();

			hub.handleInput("\x1b");
			expect(onCancel).toHaveBeenCalledTimes(1);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});
