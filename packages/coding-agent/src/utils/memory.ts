import { readFile } from "node:fs/promises";
import { freemem } from "node:os";
import { sleep } from "@chudware/utils/async";

const BYTES_PER_MIB = 1024 * 1024;
const KIB_PER_MIB = 1024;

export interface AvailableMemoryReaderOptions {
	platform?: NodeJS.Platform;
	readMeminfo?: () => Promise<string>;
	freeMemoryBytes?: () => number;
}

/** Parse Linux's cache-aware MemAvailable value, returning MiB. */
export function parseMemAvailableMB(meminfo: string): number | undefined {
	const match = /^MemAvailable:\s+(\d+)\s+kB\s*$/m.exec(meminfo);
	if (!match) return undefined;
	const kib = Number(match[1]);
	return Number.isFinite(kib) ? kib / KIB_PER_MIB : undefined;
}

/**
 * Read memory available for new work. Linux uses /proc/meminfo's MemAvailable,
 * which includes reclaimable caches; other platforms and unreadable procfs
 * fall back to os.freemem().
 */
export async function readAvailableMemoryMB(options: AvailableMemoryReaderOptions = {}): Promise<number> {
	const platform = options.platform ?? process.platform;
	if (platform === "linux") {
		try {
			const meminfo = await (options.readMeminfo?.() ?? readFile("/proc/meminfo", "utf8"));
			const available = parseMemAvailableMB(meminfo);
			if (available !== undefined) return available;
		} catch {
			// Containers can hide procfs; use the portable fallback below.
		}
	}
	return (options.freeMemoryBytes ?? freemem)() / BYTES_PER_MIB;
}

export interface MemoryAdmissionResult {
	availableMB: number | undefined;
	waitedMs: number;
	timedOut: boolean;
	aborted: boolean;
}

export interface MemoryAdmissionOptions {
	minimumMB: number;
	maxWaitMs?: number;
	pollIntervalMs?: number;
	signal?: AbortSignal;
	readMemoryMB?: () => Promise<number>;
	now?: () => number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	onTimeout?: (result: Readonly<MemoryAdmissionResult>) => void;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
	if (!signal) return sleep(ms);
	if (signal.aborted) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	const finish = () => {
		clearTimeout(timer);
		signal.removeEventListener("abort", finish);
		resolve();
	};
	const timer = setTimeout(finish, ms);
	timer.unref();
	signal.addEventListener("abort", finish, { once: true });
	return promise;
}

/**
 * Defer admission while memory is below the configured floor. The wait is
 * bounded and observational only: unreadable memory or an expired deadline
 * always admits rather than failing a task.
 */
export async function waitForAvailableMemory(options: MemoryAdmissionOptions): Promise<MemoryAdmissionResult> {
	const minimumMB = Number.isFinite(options.minimumMB) ? Math.max(0, options.minimumMB) : 0;
	const maxWaitMs = Math.max(0, options.maxWaitMs ?? 30_000);
	const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 500);
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? sleepWithAbort;
	const readMemory = options.readMemoryMB ?? readAvailableMemoryMB;
	const startedAt = now();

	const result = (availableMB: number | undefined, timedOut: boolean, aborted: boolean): MemoryAdmissionResult => ({
		availableMB,
		waitedMs: Math.max(0, now() - startedAt),
		timedOut,
		aborted,
	});

	if (minimumMB === 0) return result(undefined, false, false);

	let availableMB: number | undefined;
	while (true) {
		if (options.signal?.aborted) return result(availableMB, false, true);
		try {
			availableMB = await readMemory();
		} catch {
			return result(undefined, false, false);
		}
		if (!Number.isFinite(availableMB) || availableMB >= minimumMB) {
			return result(availableMB, false, false);
		}

		const elapsed = Math.max(0, now() - startedAt);
		if (elapsed >= maxWaitMs) {
			const timedOut = result(availableMB, true, false);
			try {
				options.onTimeout?.(timedOut);
			} catch {
				// Admission is advisory even if a warning sink fails.
			}
			return timedOut;
		}
		try {
			await sleep(Math.min(pollIntervalMs, maxWaitMs - elapsed), options.signal);
		} catch {
			return result(availableMB, false, options.signal?.aborted === true);
		}
	}
}
