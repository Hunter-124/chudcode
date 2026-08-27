/**
 * `SleepInhibitor` — the session-facing handle for keeping the machine awake
 * while the agent is working.
 *
 * Contract, in priority order:
 *  1. **Never fail the run.** Every acquire path swallows its failure and logs
 *     at debug level. An unsupported platform, missing logind, absent D-Bus, or
 *     a denied Win32 request is a no-op, not an error.
 *  2. **Never leak.** `release()` is idempotent and is additionally driven from
 *     a process `exit` hook, so a `process.exit()` on any path still drops the
 *     lock. Each backend also self-releases if omp is killed outright (see the
 *     pipe-EOF holder in `linux.ts` and the per-process execution state in
 *     `windows.ts`).
 */

import { logger } from "@oh-my-pi/pi-utils";
import { MacOSPowerInhibitorBackend } from "./darwin";
import { LogindPowerInhibitorBackend } from "./linux";
import type { PowerInhibitorBackend, PowerInhibitorHandle, SleepPreventionMode } from "./types";
import { Win32PowerInhibitorBackend } from "./windows";

/** Handles that must be dropped if the process exits without a clean teardown. */
const liveHandles = new Set<PowerInhibitorHandle>();
let exitHookInstalled = false;

/**
 * Registers the `exit` safety net once. Deliberately only `exit`: adding
 * SIGINT/SIGTERM listeners would suppress their default terminating behaviour
 * and change how omp shuts down.
 */
function ensureExitHook(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.on("exit", () => {
		for (const handle of [...liveHandles]) {
			try {
				handle.release();
			} catch {
				/* teardown is best effort */
			}
		}
		liveHandles.clear();
	});
}

/** Resolve the backend for a platform, or undefined where none exists. */
export function selectPowerInhibitorBackend(
	platform: NodeJS.Platform = process.platform,
): PowerInhibitorBackend | undefined {
	switch (platform) {
		case "darwin":
			return new MacOSPowerInhibitorBackend();
		case "linux":
			return new LogindPowerInhibitorBackend();
		case "win32":
			return new Win32PowerInhibitorBackend();
		default:
			return undefined;
	}
}

export interface SleepInhibitorOptions {
	/** Short application identity shown in the OS inhibitor registry. */
	who: string;
	/** Human-readable reason shown alongside it. */
	why: string;
	/** Test/DI seam; defaults to {@link selectPowerInhibitorBackend}. */
	backend?: PowerInhibitorBackend | undefined;
}

/**
 * Holds at most one inhibition. `acquire` is a no-op while one is already held
 * or when the mode is `off`, so callers can drive it from a refcount without
 * tracking state themselves.
 */
export class SleepInhibitor {
	readonly #who: string;
	readonly #why: string;
	readonly #backend: PowerInhibitorBackend | undefined;
	#handle: PowerInhibitorHandle | undefined;

	constructor(options: SleepInhibitorOptions) {
		this.#who = options.who;
		this.#why = options.why;
		this.#backend = options.backend ?? selectPowerInhibitorBackend();
	}

	/** True while an inhibition is held. */
	get active(): boolean {
		return this.#handle !== undefined;
	}

	/** Backend id for debug output, or undefined on an unsupported platform. */
	get backendId(): string | undefined {
		return this.#backend?.id;
	}

	acquire(mode: SleepPreventionMode): void {
		if (mode === "off") return;
		if (this.#handle) return;
		const backend = this.#backend;
		if (!backend) return;
		let handle: PowerInhibitorHandle | undefined;
		try {
			handle = backend.acquire({ mode, who: this.#who, why: this.#why });
		} catch (error) {
			// Backends are supposed to swallow their own failures; this is the
			// belt-and-braces guarantee that sleep prevention cannot break a turn.
			logger.debug("Sleep inhibition failed", { backend: backend.id, error: String(error) });
			return;
		}
		if (!handle) return;
		ensureExitHook();
		liveHandles.add(handle);
		this.#handle = handle;
		logger.debug("Sleep inhibition acquired", { backend: backend.id, mode });
	}

	/** Idempotent: safe to call when nothing is held and safe to call twice. */
	release(): void {
		const handle = this.#handle;
		this.#handle = undefined;
		if (!handle) return;
		liveHandles.delete(handle);
		try {
			handle.release();
		} catch (error) {
			logger.debug("Sleep inhibition release failed", { error: String(error) });
		}
	}
}
