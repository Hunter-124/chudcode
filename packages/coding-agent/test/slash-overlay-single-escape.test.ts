import { beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentDashboard } from "@oh-my-pi/pi-coding-agent/modes/components/agent-dashboard";
import { ModelHubComponent } from "@oh-my-pi/pi-coding-agent/modes/components/model-hub";
import { ModelPickerComponent } from "@oh-my-pi/pi-coding-agent/modes/components/model-picker";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
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

	it("keeps Escape assigned to an in-progress /agents create flow before closing the overlay", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-overlay-dismiss-"));
		try {
			const dashboard = await AgentDashboard.create(
				cwd,
				Settings.isolated({ "tui.escapeClosesOverlay": true }),
				24,
				{},
			);
			const onClose = vi.fn();
			dashboard.onClose = onClose;

			dashboard.handleInput("n");
			dashboard.handleInput("\x1b");
			expect(onClose).not.toHaveBeenCalled();

			dashboard.handleInput("\x1b");
			expect(onClose).toHaveBeenCalledTimes(1);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});
