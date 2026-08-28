import { describe, expect, it } from "bun:test";
import type { MemoryBackend } from "@chudware/coding-agent/memory-backend/types";
import { MnemopiEmbedClient, type MnemopiEmbedWorkerHandle } from "@chudware/coding-agent/mnemo/embed-client";
import type {
	MnemopiEmbedWorkerInbound,
	MnemopiEmbedWorkerOutbound,
} from "@chudware/coding-agent/mnemo/embed-protocol";
import type { AgentSession } from "@chudware/coding-agent/session/agent-session";
import { awaitMemoryPromptInjection } from "@chudware/coding-agent/session/session-tools";
import {
	parseMemAvailableMB,
	readAvailableMemoryMB,
	waitForAvailableMemory,
} from "@chudware/coding-agent/utils/memory";

describe("context hardening", () => {
	it("uses Linux MemAvailable and falls back when procfs is unavailable", async () => {
		expect(parseMemAvailableMB("MemTotal: 8192 kB\nMemAvailable: 3072 kB\n")).toBe(3);
		expect(
			await readAvailableMemoryMB({
				platform: "linux",
				readMeminfo: async () => {
					throw new Error("procfs unavailable");
				},
				freeMemoryBytes: () => 5 * 1024 * 1024,
			}),
		).toBe(5);
	});

	it("defers low-memory admission until the floor recovers", async () => {
		const readings = [256, 512, 2048];
		const sleeps: number[] = [];
		let now = 0;
		const admitted = await waitForAvailableMemory({
			minimumMB: 1024,
			readMemoryMB: async () => readings.shift() ?? 2048,
			now: () => now,
			sleep: async ms => {
				sleeps.push(ms);
				now += ms;
			},
		});

		expect(sleeps).toEqual([500, 500]);
		expect(admitted).toEqual({ availableMB: 2048, waitedMs: 1000, timedOut: false, aborted: false });
	});

	it("disables memory admission reads when the configured floor is zero", async () => {
		let reads = 0;
		const admitted = await waitForAvailableMemory({
			minimumMB: 0,
			readMemoryMB: async () => {
				reads += 1;
				return 0;
			},
		});
		expect(reads).toBe(0);
		expect(admitted.timedOut).toBe(false);
	});

	it("admits with a warning callback after the bounded low-memory wait", async () => {
		let now = 0;
		let warning: { availableMB: number | undefined; waitedMs: number } | undefined;
		const admitted = await waitForAvailableMemory({
			minimumMB: 1024,
			readMemoryMB: async () => 128,
			now: () => now,
			sleep: async ms => {
				now += ms;
			},
			onTimeout: result => {
				warning = { availableMB: result.availableMB, waitedMs: result.waitedMs };
			},
		});

		expect(admitted).toEqual({ availableMB: 128, waitedMs: 30_000, timedOut: true, aborted: false });
		expect(warning).toEqual({ availableMB: 128, waitedMs: 30_000 });
	});

	it("times out a hung first-turn memory injection without waiting for the backend", async () => {
		let fireTimeout: (() => void) | undefined;
		let cancelled = false;
		let scheduledDelay: number | undefined;
		const neverCompletes = Promise.withResolvers<string | undefined>().promise;
		const backend = {
			id: "hung-test-backend",
			beforeAgentStartPrompt: async () => await neverCompletes,
		} as unknown as MemoryBackend;
		const session = {} as AgentSession;
		const pending = awaitMemoryPromptInjection(backend, session, "hello", {
			scheduleTimeout: (callback, delayMs) => {
				scheduledDelay = delayMs;
				fireTimeout = callback;
				return () => {
					cancelled = true;
				};
			},
		});
		expect(scheduledDelay).toBe(5000);
		fireTimeout?.();

		expect(await pending).toEqual({ timedOut: true, injected: undefined });
		expect(cancelled).toBe(true);
	});

	it("never tears down an in-flight embed and transparently respawns after idle expiry", async () => {
		const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
		let spawns = 0;
		let terminations = 0;
		let holdEmbeds = true;
		let releaseEmbed: (() => void) | undefined;
		const spawn = (): MnemopiEmbedWorkerHandle => {
			spawns += 1;
			let messageHandler: ((message: MnemopiEmbedWorkerOutbound) => void) | undefined;
			return {
				send(message: MnemopiEmbedWorkerInbound) {
					if (message.type === "init") {
						queueMicrotask(() => messageHandler?.({ type: "ready", id: message.id }));
					} else if (message.type === "embed") {
						const reply = () => messageHandler?.({ type: "vectors", id: message.id, vectors: [[1, 2, 3]] });
						if (holdEmbeds) releaseEmbed = reply;
						else queueMicrotask(reply);
					}
				},
				onMessage(handler) {
					messageHandler = handler;
					return () => {
						if (messageHandler === handler) messageHandler = undefined;
					};
				},
				onError() {
					return () => {};
				},
				async terminate() {
					terminations += 1;
					messageHandler = undefined;
				},
			};
		};
		const client = new MnemopiEmbedClient(spawn, 10_000, {
			idleTimeoutMs: 1,
			scheduleIdleTimer: callback => {
				const timer = { callback, cancelled: false };
				timers.push(timer);
				return {
					cancel() {
						timer.cancelled = true;
					},
				};
			},
		});

		const model = await client.initialize("fast-bge-base-en-v1.5", "/tmp/cache");
		expect(model).not.toBeNull();
		const iterator = model!.embed(["first"])[Symbol.asyncIterator]();
		const inFlight = iterator.next();
		await Promise.resolve();
		// Deliberately invoke the cancelled stale timer to prove the pending-set
		// guard, not merely timer cancellation, protects active requests.
		timers[0]?.callback();
		expect(terminations).toBe(0);

		releaseEmbed?.();
		await inFlight;
		const idleTimer = timers.findLast(timer => !timer.cancelled);
		expect(idleTimer).toBeDefined();
		idleTimer?.callback();
		await Promise.resolve();
		expect(terminations).toBe(1);

		holdEmbeds = false;
		for await (const vectors of model!.embed(["second"])) {
			expect(vectors).toEqual([[1, 2, 3]]);
		}
		expect(spawns).toBe(2);
		client.setIdleTimeoutMinutes(0);
		for (const timer of timers) timer.callback();
		await Promise.resolve();
		expect(terminations).toBe(1);
		await client.terminate();
	});
});
