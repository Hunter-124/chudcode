import { afterEach, describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner, emitSessionShutdownEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { getRegisteredMemoryBackend, registerMemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/registry";
import { resolveMemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/resolve";
import type { MemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const disposers: Array<() => void> = [];
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
});

function backend(id: string): MemoryBackend {
	return {
		id,
		start() {},
		async buildDeveloperInstructions() {
			return undefined;
		},
		async clear() {},
		async enqueue() {},
	};
}

describe("extension memory backend selection", () => {
	test("two sessions of one source do not unbind each other; an unrelated extension cannot steal the id", async () => {
		const first = backend("registry-test-custom");
		const second = backend(first.id);
		const unbindFirst = registerMemoryBackend(first, "extension-a");
		const unbindSecond = registerMemoryBackend(second, "extension-a");
		disposers.push(unbindFirst, unbindSecond);
		const settings = Settings.isolated({ "memory.backend": first.id });
		expect(await resolveMemoryBackend(settings)).toBe(second);
		expect(() => registerMemoryBackend(backend(first.id), "extension-b")).toThrow(/already registered/);
		unbindSecond();
		expect(await resolveMemoryBackend(settings)).toBe(first);
		unbindFirst();
		expect(getRegisteredMemoryBackend(first.id)).toBeUndefined();
		await expect(resolveMemoryBackend(settings)).rejects.toThrow(`Unknown memory backend "${first.id}"`);
	});

	test("session shutdown releases only that extension's backend without disabling other sessions", async () => {
		const surviving = backend("registry-test-survivor");
		const disposeSurvivor = registerMemoryBackend(surviving, "another-session");
		disposers.push(disposeSurvivor);
		const installed = backend("registry-test-owned");
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			api => {
				api.registerMemoryBackend(installed);
			},
			process.cwd(),
			new EventBus(),
			runtime,
			"owned-extension",
		);
		const runner = new ExtensionRunner([extension], runtime, process.cwd(), SessionManager.inMemory(), {} as never);
		try {
			expect(await resolveMemoryBackend(Settings.isolated({ "memory.backend": installed.id }))).toBe(installed);
		} finally {
			await emitSessionShutdownEvent(runner);
		}
		expect(getRegisteredMemoryBackend(installed.id)).toBeUndefined();
		expect(await resolveMemoryBackend(Settings.isolated({ "memory.backend": surviving.id }))).toBe(surviving);
	});

	test("failed extension initialization rolls back backend selection", async () => {
		const registered = backend("registry-test-broken");
		const runtime = new ExtensionRuntime();
		await expect(
			loadExtensionFromFactory(
				api => {
					api.registerMemoryBackend(registered);
					throw new Error("extension failed to initialize");
				},
				process.cwd(),
				new EventBus(),
				runtime,
				"broken-extension",
			),
		).rejects.toThrow("extension failed to initialize");
		expect(getRegisteredMemoryBackend(registered.id)).toBeUndefined();
	});
});
