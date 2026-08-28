import { afterEach, describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getEnumValues, getUi } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner, emitSessionShutdownEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import {
	getRegisteredMemoryBackend,
	type MemoryBackend,
	registerMemoryBackend,
	resolveMemoryBackend,
	unregisterMemoryBackendsForSource,
} from "@oh-my-pi/pi-coding-agent/memory-backend";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const TEST_SOURCES = ["registry-test-a", "registry-test-b", "registry-extension", "registry-broken"] as const;

function createBackend(id: string, marker = id): MemoryBackend & { marker: string } {
	return {
		id,
		marker,
		start: () => {},
		buildDeveloperInstructions: async () => undefined,
		clear: async () => {},
		enqueue: async () => {},
	};
}

function initializeRunner(runner: ExtensionRunner): void {
	runner.initialize(
		{
			sendMessage: () => {},
			sendUserMessage: () => {},
			appendEntry: () => {},
			setLabel: () => {},
			getActiveTools: () => [],
			getAllTools: () => [],
			setActiveTools: async () => {},
			getCommands: () => [],
			setModel: async () => false,
			getThinkingLevel: () => undefined,
			setThinkingLevel: () => {},
			getSessionName: () => undefined,
			setSessionName: async () => {},
		},
		{
			getModel: () => undefined,
			isIdle: () => true,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () => undefined,
			compact: async () => {},
			getSystemPrompt: () => [],
		},
	);
}

afterEach(() => {
	for (const source of TEST_SOURCES) unregisterMemoryBackendsForSource(source);
});

describe("memory backend registry", () => {
	test("same-source registrations use the latest backend while other sources are rejected", async () => {
		const first = createBackend("registry-duplicate", "first");
		const second = createBackend("registry-duplicate", "second");
		const disposeFirst = registerMemoryBackend(first, "registry-test-a");
		const disposeSecond = registerMemoryBackend(second, "registry-test-a");

		expect(await resolveMemoryBackend(Settings.isolated({ "memory.backend": first.id }))).toBe(second);
		expect(() => registerMemoryBackend(createBackend(first.id), "registry-test-b")).toThrow(
			/already registered by "registry-test-a"/,
		);

		disposeSecond();
		expect(await resolveMemoryBackend(Settings.isolated({ "memory.backend": first.id }))).toBe(first);
		disposeFirst();
	});

	test("registered backends resolve before built-ins and built-ins remain unchanged after disposal", async () => {
		const override = createBackend("local", "extension-local");
		const dispose = registerMemoryBackend(override, "registry-test-a");
		expect(await resolveMemoryBackend(Settings.isolated({ "memory.backend": "local" }))).toBe(override);
		dispose();

		for (const id of ["off", "local", "hindsight", "mnemopi"] as const) {
			expect((await resolveMemoryBackend(Settings.isolated({ "memory.backend": id }))).id).toBe(id);
		}
	});

	test("unknown ids remain invalid", async () => {
		expect(getEnumValues("memory.backend")).not.toContain("missing-backend");
		await expect(resolveMemoryBackend(Settings.isolated({ "memory.backend": "missing-backend" }))).rejects.toThrow(
			'Unknown memory backend "missing-backend"',
		);
	});

	test("failed extension loading rolls back its registration", async () => {
		const backend = createBackend("registry-broken-backend");
		const runtime = new ExtensionRuntime();
		await expect(
			loadExtensionFromFactory(
				pi => {
					pi.registerMemoryBackend(backend);
					throw new Error("intentional load failure");
				},
				process.cwd(),
				new EventBus(),
				runtime,
				"registry-broken",
			),
		).rejects.toThrow("intentional load failure");
		expect(getRegisteredMemoryBackend(backend.id)).toBeUndefined();
	});

	test("extension registration is selectable, explicitly removable, and cleaned up on unload", async () => {
		const backend = createBackend("registry-extension-backend");
		const survivor = createBackend("registry-survivor");
		const disposeSurvivor = registerMemoryBackend(survivor, "registry-test-a");
		const runtime = new ExtensionRuntime();
		let registerAgain: (() => void) | undefined;
		let unregister: (() => void) | undefined;
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.registerMemoryBackend(backend);
				registerAgain = () => pi.registerMemoryBackend(backend);
				unregister = () => pi.unregisterMemoryBackend(backend.id);
			},
			process.cwd(),
			new EventBus(),
			runtime,
			"registry-extension",
		);
		const runner = new ExtensionRunner([extension], runtime, process.cwd(), SessionManager.inMemory(), {} as never);
		initializeRunner(runner);

		expect(getRegisteredMemoryBackend(backend.id)?.sourceId).toBe("registry-extension");
		expect(getEnumValues("memory.backend")).toContain(backend.id);
		expect(getUi("memory.backend")?.options).toContainEqual({
			value: backend.id,
			label: backend.id,
			description: "Extension-provided memory backend",
		});
		expect(await resolveMemoryBackend(Settings.isolated({ "memory.backend": backend.id }))).toBe(backend);

		expect(unregister).toBeDefined();
		unregister?.();
		expect(getRegisteredMemoryBackend(backend.id)).toBeUndefined();
		await expect(resolveMemoryBackend(Settings.isolated({ "memory.backend": backend.id }))).rejects.toThrow(
			`Unknown memory backend "${backend.id}"`,
		);

		expect(registerAgain).toBeDefined();
		registerAgain?.();
		expect(await resolveMemoryBackend(Settings.isolated({ "memory.backend": backend.id }))).toBe(backend);

		await emitSessionShutdownEvent(runner);
		expect(getRegisteredMemoryBackend(backend.id)).toBeUndefined();
		expect(getRegisteredMemoryBackend(survivor.id)?.backend).toBe(survivor);
		disposeSurvivor();
		expect(getEnumValues("memory.backend")).not.toContain(backend.id);
		await expect(resolveMemoryBackend(Settings.isolated({ "memory.backend": backend.id }))).rejects.toThrow(
			`Unknown memory backend "${backend.id}"`,
		);
	});
});
