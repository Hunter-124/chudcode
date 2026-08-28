import { spawnSync as nodeSpawnSync } from "node:child_process";

/**
 * Host-agnostic process helpers, replacing the `Bun.spawn*` builtins.
 *
 * Deliberately free of side effects and of `@oh-my-pi/pi-natives`: process
 * spawning sits on the CLI's cold-start path, and importing this module must not
 * grow the startup graph or load the native addon.
 *
 * The shapes mirror the Bun builtins rather than `node:child_process`, so call
 * sites keep reading `.exitCode` / `.success` / `.stdout` and keep the
 * throw-on-missing-executable behaviour they were written against.
 */

export type StdioTarget = "pipe" | "ignore" | "inherit";

export interface SpawnSyncOptions {
	/** Argv, when passing a single options object instead of `(cmd, options)`. */
	readonly cmd?: readonly string[];
	readonly cwd?: string;
	readonly env?: Record<string, string | undefined>;
	readonly stdin?: StdioTarget;
	readonly stdout?: StdioTarget;
	readonly stderr?: StdioTarget;
	readonly maxBuffer?: number;
	readonly timeout?: number;
	readonly killSignal?: NodeJS.Signals | number;
	readonly windowsHide?: boolean;
}

export interface SpawnSyncResult {
	/** Captured stdout, empty when the target was not piped. */
	readonly stdout: Buffer;
	/** Captured stderr, empty when the target was not piped. */
	readonly stderr: Buffer;
	readonly exitCode: number | null;
	readonly signalCode: NodeJS.Signals | null;
	/** True when the command was killed because `timeout` elapsed. */
	readonly exitedDueToTimeout: boolean;
	readonly success: boolean;
}

const EMPTY = Buffer.alloc(0);

/**
 * Run a command to completion.
 *
 * Both `Bun.spawnSync` call shapes are accepted: `spawnSync(argv, options)` and
 * `spawnSync({ cmd, … })`. Unlike `node:child_process`, a missing executable
 * throws instead of returning an `error` field — the git and MCP probes depend
 * on catching `ENOENT`, and silently returning a failed result would turn a
 * missing binary into an ordinary non-zero exit.
 */
export function spawnSync(
	command: readonly string[] | SpawnSyncOptions,
	options: SpawnSyncOptions = {},
): SpawnSyncResult {
	const merged = Array.isArray(command) ? options : (command as SpawnSyncOptions);
	const argv = Array.isArray(command) ? command : (merged.cmd ?? []);
	if (argv.length === 0) throw new TypeError("spawnSync requires a non-empty command");

	const result = nodeSpawnSync(argv[0], argv.slice(1), {
		cwd: merged.cwd,
		env: merged.env as NodeJS.ProcessEnv | undefined,
		stdio: [merged.stdin ?? "ignore", merged.stdout ?? "pipe", merged.stderr ?? "pipe"],
		maxBuffer: merged.maxBuffer,
		timeout: merged.timeout,
		killSignal: merged.killSignal,
		windowsHide: merged.windowsHide,
	});
	// A timeout is a result, not a failure to launch: callers render the partial
	// output and treat the marker as authoritative. Every other spawn error
	// (ENOENT, EACCES) throws, matching `Bun.spawnSync`.
	const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
	if (result.error && !timedOut) throw result.error;

	return {
		stdout: result.stdout ?? EMPTY,
		stderr: result.stderr ?? EMPTY,
		exitCode: result.status,
		signalCode: result.signal,
		exitedDueToTimeout: timedOut,
		success: result.status === 0,
	};
}
