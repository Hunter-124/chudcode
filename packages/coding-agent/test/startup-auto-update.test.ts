import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
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

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

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
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		expect(await checkForNewVersion("1.0.0", { mode: "off" })).toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("startup version check throttle", () => {
	it("reuses the persisted latest version without a second request inside six hours", async () => {
		const dir = await makeTempDir();
		const cachePath = path.join(dir, "version-check-cache.json");
		const fetchStub = Object.assign(async () => Response.json({ version: "2.0.0" }), {
			preconnect: globalThis.fetch.preconnect,
		});
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		const first = await checkForNewVersion("1.0.0", {
			mode: "notify",
			cachePath,
			now: 1_000,
		});
		const second = await checkForNewVersion("1.0.0", {
			mode: "notify",
			cachePath,
			now: 1_000 + VERSION_CHECK_INTERVAL_MS - 1,
		});

		expect(first).toBe("2.0.0");
		expect(second).toBe("2.0.0");
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(await Bun.file(cachePath).json()).toEqual({ checkedAt: 1_000, latestVersion: "2.0.0" });
	});
});
