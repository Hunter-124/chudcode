/**
 * Platform-independent contract for sleep/idle inhibition.
 *
 * `power.sleepPrevention` is a cumulative enum: each level adds what every
 * lower level asks for. Backends translate a level into whatever their OS
 * exposes (macOS power assertions, systemd-logind inhibitor locks, Win32
 * execution state), so the level semantics live here rather than in the
 * session.
 */

/** Mirrors the `power.sleepPrevention` setting values. */
export type SleepPreventionMode = "off" | "idle" | "display" | "system";

/** A level that actually asks for inhibition. */
export type ActiveSleepPreventionMode = Exclude<SleepPreventionMode, "off">;

/** What a level asks of the platform, expanded from the cumulative enum. */
export interface PowerInhibitPlan {
	/** Keep the machine from sleeping because the user looks idle. */
	readonly idle: boolean;
	/** Also keep the display from blanking/dimming. */
	readonly display: boolean;
	/** Also refuse system sleep outright, not just idle-triggered sleep. */
	readonly system: boolean;
}

/**
 * Expand a cumulative level. Named because all three backends must agree on
 * what `display` and `system` imply — a backend deriving this itself is how
 * platforms drift apart.
 */
export function powerInhibitPlan(mode: ActiveSleepPreventionMode): PowerInhibitPlan {
	return {
		idle: true,
		display: mode === "display" || mode === "system",
		system: mode === "system",
	};
}

/** Identifying strings a backend surfaces to the OS's inhibitor registry. */
export interface PowerInhibitorRequest {
	readonly mode: ActiveSleepPreventionMode;
	/** Short application identity, e.g. `omp`. */
	readonly who: string;
	/** Human-readable reason, e.g. `agent turn in progress`. */
	readonly why: string;
}

/** A held inhibition. `release()` must be idempotent. */
export interface PowerInhibitorHandle {
	release(): void;
}

/** A platform implementation. `acquire` never throws and never blocks a turn. */
export interface PowerInhibitorBackend {
	/** Stable id for debug logs, e.g. `logind`, `win32-execution-state`. */
	readonly id: string;
	/** Returns undefined when this platform cannot inhibit right now. */
	acquire(request: PowerInhibitorRequest): PowerInhibitorHandle | undefined;
}
