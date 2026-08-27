import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	checkForNewVersion,
	resolveStartupUpdateMode,
	VERSION_CHECK_INTERVAL_MS,
} from "@oh-my-pi/pi-coding-agent/main";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-startup-update-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("startup application update policy", () => {
	it.each([
		[true, "off", "off"],
		[true, "notify", "notify"],
		[true, "auto", "auto"],
		[false, "auto", "off"],
	] as const)("resolves checkUpdate=%s with autoUpdate=%s to %s", (checkUpdate, autoUpdate, expected) => {
		expect(resolveStartupUpdateMode(checkUpdate, autoUpdate)).toBe(expected);
	});

	it("does not issue a registry request when the resolved policy is off", async () => {
		const fetchImpl = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ version: "2.0.0" }))));

		expect(await checkForNewVersion("1.0.0", { mode: "off", fetchImpl })).toBeUndefined();
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe("startup version check throttle", () => {
	it("reuses the persisted latest version without a second request inside six hours", async () => {
		const dir = await makeTempDir();
		const cachePath = path.join(dir, "version-check-cache.json");
		const fetchImpl = vi.fn(() =>
			Promise.resolve(
				new Response(JSON.stringify({ version: "2.0.0" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			),
		);

		const first = await checkForNewVersion("1.0.0", {
			mode: "notify",
			cachePath,
			now: 1_000,
			fetchImpl,
		});
		const second = await checkForNewVersion("1.0.0", {
			mode: "notify",
			cachePath,
			now: 1_000 + VERSION_CHECK_INTERVAL_MS - 1,
			fetchImpl,
		});

		expect(first).toBe("2.0.0");
		expect(second).toBe("2.0.0");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(await Bun.file(cachePath).json()).toEqual({ checkedAt: 1_000, latestVersion: "2.0.0" });
	});
});
