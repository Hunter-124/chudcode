import { MacOSPowerAssertion } from "@chudware/natives";
import { isBunTestRuntime } from "@chudware/utils/env";
import * as logger from "@chudware/utils/logger";
import { $which } from "@chudware/utils/which";

/**
 * How hard a live session fights the machine's power management. Levels are
 * cumulative: each one keeps the guarantees of the level below it.
 */
export type SleepPreventionMode = "off" | "idle" | "display" | "system";

/** Which platform mechanism is holding a live inhibitor. */
export type SleepInhibitorBackend = "iokit" | "logind";

/** A held sleep inhibitor. {@link SleepInhibitor.stop} is idempotent. */
export interface SleepInhibitor {
	readonly backend: SleepInhibitorBackend;
	stop(): void;
}

/** macOS `IOPMAssertion` handles, taken through the native `caffeinate` bridge. */
class IokitInhibitor implements SleepInhibitor {
	readonly backend = "iokit" as const;
	#assertion: MacOSPowerAssertion | undefined;

	constructor(assertion: MacOSPowerAssertion) {
		this.#assertion = assertion;
	}

	stop(): void {
		const assertion = this.#assertion;
		this.#assertion = undefined;
		if (!assertion) return;
		try {
			assertion.stop();
		} catch (error) {
			logger.warn("Failed to release macOS power assertion", { error: String(error) });
		}
	}
}

/**
 * logind exposes exactly one idle lever, so `idle` and `display` both map to
 * `--what=idle`. That is not a downgrade: blocking idle is what stops a
 * logind-aware session manager (KDE's PowerDevil, GNOME's mutter) from dimming,
 * blanking, locking, and auto-suspending. `system` additionally blocks explicit
 * suspend and hibernate requests, matching `caffeinate -s`.
 */
const LOGIND_WHAT: Record<Exclude<SleepPreventionMode, "off">, string> = {
	idle: "idle",
	display: "idle",
	system: "idle:sleep",
};

/**
 * A logind inhibitor is a file descriptor, and logind drops the inhibitor the
 * moment that descriptor closes. `systemd-inhibit` holds it and needs a command
 * to supervise; `cat` reading a pipe we own is the only choice that cannot leak.
 *
 * Closing our write end gives `cat` EOF, so the whole chain unwinds on release —
 * and because the kernel closes that end for us when this process dies, even a
 * `SIGKILL` releases the inhibitor. Supervising `sleep infinity` instead would
 * strand an orphan (`systemd-inhibit` does not forward signals to its child)
 * and pin the machine awake until the next reboot.
 */
class LogindInhibitor implements SleepInhibitor {
	readonly backend = "logind" as const;
	#child: Bun.Subprocess<"pipe", "ignore", "ignore"> | undefined;
	#stopping = false;

	constructor(binary: string, what: string, why: string) {
		const child = Bun.spawn([binary, `--what=${what}`, "--who=Chudcode", `--why=${why}`, "--mode=block", "cat"], {
			stdin: "pipe",
			stdout: "ignore",
			stderr: "ignore",
		});
		this.#child = child;
		// The inhibitor must never keep the CLI alive past its own work.
		child.unref();
		void child.exited.then(exitCode => {
			if (this.#stopping) return;
			this.#child = undefined;
			logger.warn("logind sleep inhibitor exited early", { what, exitCode });
		});
	}

	stop(): void {
		const child = this.#child;
		this.#child = undefined;
		if (!child) return;
		this.#stopping = true;
		try {
			// EOF unwinds `cat`; the kill makes the release immediate rather than
			// waiting on process scheduling, and closing the held fd is the release.
			child.stdin.end();
			child.kill();
		} catch (error) {
			logger.warn("Failed to release logind sleep inhibitor", { error: String(error) });
		}
	}
}

function startIokitInhibitor(mode: SleepPreventionMode, reason: string): SleepInhibitor | undefined {
	try {
		return new IokitInhibitor(
			MacOSPowerAssertion.start({
				reason,
				idle: true,
				display: mode === "display" || mode === "system",
				system: mode === "system",
				user: mode === "system",
			}),
		);
	} catch (error) {
		logger.warn("Failed to acquire macOS power assertion", { error: String(error) });
		return undefined;
	}
}

function startLogindInhibitor(mode: Exclude<SleepPreventionMode, "off">, reason: string): SleepInhibitor | undefined {
	const binary = $which("systemd-inhibit");
	if (binary === null) {
		logger.debug("Sleep prevention skipped: systemd-inhibit is not on PATH");
		return undefined;
	}
	const what = LOGIND_WHAT[mode];
	try {
		// logind reads `--why` as a single line, so control characters must go.
		const why = reason.replace(/\s+/gu, " ").trim();
		return new LogindInhibitor(binary, what, why.length > 0 ? why : "Chudcode session");
	} catch (error) {
		logger.warn("Failed to acquire logind sleep inhibitor", { what, error: String(error) });
		return undefined;
	}
}

/**
 * Keep the machine awake for as long as the returned handle is held.
 *
 * Returns `undefined` when the mode is `off`, the host has no supported
 * mechanism, or acquisition failed — sleep prevention is best-effort and never
 * blocks the work it was protecting.
 */
export function startSleepInhibitor(mode: SleepPreventionMode, reason: string): SleepInhibitor | undefined {
	if (mode === "off") return undefined;
	if (isBunTestRuntime()) return undefined;
	if (process.platform === "darwin") return startIokitInhibitor(mode, reason);
	if (process.platform === "linux") return startLogindInhibitor(mode, reason);
	return undefined;
}
