#!/usr/bin/env bun
/**
 * Hard wall-clock deadline for one CI command and every process it starts.
 *
 * Usage:
 *   bun scripts/ci-deadline.ts <seconds> -- <command> [args...]
 *
 * The command runs as the leader of its own session and process group. When
 * the deadline passes, or this supervisor receives SIGINT/SIGTERM/SIGHUP (a
 * cancelled GitHub Actions step), the whole group gets SIGTERM, then SIGKILL
 * after a 15 s grace period. Group members still alive after the command
 * itself exits are cleaned up the same way, so nothing outlives the step.
 *
 * Exit status: 124 when the deadline expired; 128+N when this supervisor was
 * stopped by signal N; otherwise the command's own status (128+N if the
 * command died from signal N). It never retries and never extends a budget.
 *
 * macOS ships no GNU `timeout`; Bun is already on every runner that uses
 * this, so the ARM lanes share one supervisor on Linux and macOS.
 */
import * as os from "node:os";

export const DEADLINE_EXIT_CODE = 124;
const GRACE_MS = 15_000;
const POLL_MS = 100;

export interface DeadlineOptions {
	/** Hard budget for the command and all of its descendants. */
	seconds: number;
	cwd?: string;
	env?: Record<string, string | undefined>;
	/** "pipe" captures stdout into the result; stderr is always inherited. */
	stdout?: "inherit" | "pipe";
}

export interface DeadlineResult {
	code: number;
	timedOut: boolean;
	stdout: string;
}

function groupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw err;
	}
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pgid, signal);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
	}
}

async function groupGoneWithin(pgid: number, ms: number): Promise<boolean> {
	const until = Date.now() + ms;
	while (groupAlive(pgid)) {
		if (Date.now() >= until) return false;
		await Bun.sleep(POLL_MS);
	}
	return true;
}

/** SIGTERM the whole group, SIGKILL whatever is left after the grace period. */
async function terminateGroup(pgid: number, reason: string): Promise<void> {
	if (!groupAlive(pgid)) return;
	console.error(`[deadline] ${reason}: SIGTERM to process group ${pgid}, SIGKILL after ${GRACE_MS / 1000}s`);
	signalGroup(pgid, "SIGTERM");
	if (await groupGoneWithin(pgid, GRACE_MS)) return;
	console.error(`[deadline] process group ${pgid} outlived the grace period: SIGKILL`);
	signalGroup(pgid, "SIGKILL");
	if (!(await groupGoneWithin(pgid, 5_000))) throw new Error(`process group ${pgid} survived SIGKILL`);
}

export async function runWithDeadline(argv: string[], options: DeadlineOptions): Promise<DeadlineResult> {
	if (!(Number.isFinite(options.seconds) && options.seconds > 0)) {
		throw new Error(`deadline must be a positive number of seconds, got ${options.seconds}`);
	}
	const child = Bun.spawn(argv, {
		cwd: options.cwd ?? process.cwd(),
		env: { ...(options.env ?? process.env), CHUDCODE_CI_DEADLINE_SECONDS: String(options.seconds) },
		stdin: "ignore",
		stdout: options.stdout ?? "inherit",
		stderr: "inherit",
		// setsid(): the child leads a new session and process group.
		detached: true,
	});
	const pgid = child.pid;
	const stdout = options.stdout === "pipe" ? new Response(child.stdout as ReadableStream).text() : Promise.resolve("");

	let timedOut = false;
	let stoppedBy: NodeJS.Signals | undefined;
	let stopping: Promise<void> | undefined;
	const stop = (reason: string) => {
		stopping ??= terminateGroup(pgid, reason);
		return stopping;
	};
	const timer = setTimeout(() => {
		timedOut = true;
		void stop(`${argv.join(" ")} exceeded its ${options.seconds}s deadline`);
	}, options.seconds * 1000);
	const forwarded: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
	const onSignal = (signal: NodeJS.Signals) => {
		stoppedBy ??= signal;
		void stop(`supervisor received ${signal}`);
	};
	for (const signal of forwarded) process.on(signal, onSignal);

	try {
		const exitCode = await child.exited;
		clearTimeout(timer);
		// The leader is gone; reap anything it left behind in its group.
		await stop(`${argv[0]} exited with ${exitCode} but left processes in its group`);
		const captured = await stdout;
		if (timedOut) return { code: DEADLINE_EXIT_CODE, timedOut, stdout: captured };
		if (stoppedBy) return { code: 128 + os.constants.signals[stoppedBy], timedOut, stdout: captured };
		return { code: exitCode, timedOut, stdout: captured };
	} finally {
		clearTimeout(timer);
		for (const signal of forwarded) process.off(signal, onSignal);
	}
}

async function main(): Promise<number> {
	const args = process.argv.slice(2);
	const separator = args.indexOf("--");
	const seconds = Number(args[0]);
	if (separator !== 1 || args.length < 3 || !(Number.isFinite(seconds) && seconds > 0)) {
		console.error("usage: ci-deadline.ts <seconds> -- <command> [args...]");
		return 2;
	}
	const result = await runWithDeadline(args.slice(2), { seconds });
	if (result.timedOut)
		console.error(`[deadline] exit ${DEADLINE_EXIT_CODE}: ${args.slice(2).join(" ")} exceeded ${seconds}s`);
	return result.code;
}

if (import.meta.main) {
	process.exitCode = await main();
}
