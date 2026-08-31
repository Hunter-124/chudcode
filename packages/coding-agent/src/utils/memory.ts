import { readFile } from "node:fs/promises";
import { freemem } from "node:os";

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
