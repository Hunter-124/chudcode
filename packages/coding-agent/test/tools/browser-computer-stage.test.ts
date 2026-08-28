/**
 * A headed browser requested with a private computer stage must never reach the
 * real desktop, and two sessions must never land on each other's stage.
 *
 * `browserKey` collapses every headed browser to `headless:0`, so without the
 * per-owner suffix two owners share one Chromium — and therefore one display.
 * The stage hold is ref-counted, so a handle that forgets to release it leaks
 * the Xvfb daemon for the rest of the project's life.
 */

import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as launch from "@chudware/coding-agent/tools/browser/launch";
import {
	acquireBrowser,
	type BrowserHandle,
	type BrowserKind,
	releaseBrowser,
} from "@chudware/coding-agent/tools/browser/registry";
import * as stage from "@chudware/coding-agent/tools/computer/stage";

const HEADED: BrowserKind = { kind: "headless", headless: false } as BrowserKind;

function stageLease(id: string, releases: string[]) {
	return {
		descriptor: {
			id,
			daemonName: `chudcode-stage-${id}`,
			projectDir: "/tmp/project",
			displayServer: "x11",
			env: { DISPLAY: `:${id}`, XAUTHORITY: `/tmp/${id}.auth` },
			unsetEnv: ["WAYLAND_DISPLAY"],
		},
		release: async () => {
			releases.push(id);
		},
	} as unknown as stage.ComputerStageLease;
}

function fakeBrowser() {
	return {
		browser: {
			connected: true,
			process: () => ({ pid: 1234 }),
			close: () => Promise.resolve(),
			disconnect: () => {},
		},
		userDataDir: undefined,
	} as unknown as launch.LaunchHeadlessResult;
}

describe("headed browser pinned to a private computer stage", () => {
	beforeEach(() => {
		spyOn(stage, "acquireComputerStage").mockRestore();
		spyOn(launch, "launchHeadlessBrowser").mockRestore();
	});

	it("launches in-process against the stage's environment instead of the real display", async () => {
		const releases: string[] = [];
		spyOn(stage, "acquireComputerStage").mockResolvedValue(stageLease("101", releases));
		const launchSpy = spyOn(launch, "launchHeadlessBrowser").mockResolvedValue(fakeBrowser());

		const handle = await acquireBrowser(HEADED, {
			cwd: "/tmp/project",
			stage: { ownerId: "session-a", width: 1280, height: 800 },
		});
		handle.refCount = 1;

		expect(launchSpy).toHaveBeenCalledTimes(1);
		const passed = launchSpy.mock.calls[0][0];
		expect(passed.env).toEqual({ DISPLAY: ":101", XAUTHORITY: "/tmp/101.auth" });
		// The inherited Wayland session must be dropped, or Chromium prefers it
		// over the stage's DISPLAY and opens on the user's real desktop.
		expect(passed.unsetEnv).toEqual(["WAYLAND_DISPLAY"]);

		await releaseBrowser(handle, { kill: false });
		expect(releases).toEqual(["101"]);
	});

	it("keys the browser per stage owner so two sessions never share one display", async () => {
		const releases: string[] = [];
		let next = 0;
		spyOn(stage, "acquireComputerStage").mockImplementation(async () => stageLease(`s${++next}`, releases));
		spyOn(launch, "launchHeadlessBrowser").mockImplementation(async () => fakeBrowser());

		const a = await acquireBrowser(HEADED, {
			cwd: "/tmp/project",
			stage: { ownerId: "session-a", width: 1280, height: 800 },
		});
		a.refCount = 1;
		const b = await acquireBrowser(HEADED, {
			cwd: "/tmp/project",
			stage: { ownerId: "session-b", width: 1280, height: 800 },
		});
		b.refCount = 1;

		expect(a).not.toBe(b);
		expect(a.key).not.toBe(b.key);
		expect(a.key).toContain("session-a");
		expect(b.key).toContain("session-b");

		await releaseBrowser(a, { kill: false });
		await releaseBrowser(b, { kill: false });
		expect(releases.sort()).toEqual(["s1", "s2"]);
	});

	it("reuses one Chromium for the same owner asking twice", async () => {
		const releases: string[] = [];
		spyOn(stage, "acquireComputerStage").mockResolvedValue(stageLease("shared", releases));
		const launchSpy = spyOn(launch, "launchHeadlessBrowser").mockResolvedValue(fakeBrowser());

		const first = await acquireBrowser(HEADED, {
			cwd: "/tmp/project",
			stage: { ownerId: "session-a", width: 1280, height: 800 },
		});
		const second = await acquireBrowser(HEADED, {
			cwd: "/tmp/project",
			stage: { ownerId: "session-a", width: 1280, height: 800 },
		});

		expect(second).toBe(first);
		expect(launchSpy).toHaveBeenCalledTimes(1);

		first.refCount = 1;
		await releaseBrowser(first, { kill: false });
	});

	it("releases the stage hold when the launch fails, since no handle reaches the registry", async () => {
		const releases: string[] = [];
		spyOn(stage, "acquireComputerStage").mockResolvedValue(stageLease("doomed", releases));
		spyOn(launch, "launchHeadlessBrowser").mockRejectedValue(new Error("chromium missing"));

		await expect(
			acquireBrowser(HEADED, {
				cwd: "/tmp/project",
				stage: { ownerId: "session-c", width: 1280, height: 800 },
			}),
		).rejects.toThrow("chromium missing");

		expect(releases).toEqual(["doomed"]);
	});

	it("fails closed when no stage can be acquired rather than opening on the real desktop", async () => {
		spyOn(stage, "acquireComputerStage").mockRejectedValue(new Error("Unable to start a ready Xvfb computer stage"));
		const launchSpy = spyOn(launch, "launchHeadlessBrowser").mockResolvedValue(fakeBrowser());

		await expect(
			acquireBrowser(HEADED, {
				cwd: "/tmp/project",
				stage: { ownerId: "session-d", width: 1280, height: 800 },
			}),
		).rejects.toThrow(/Xvfb computer stage/);

		expect(launchSpy).not.toHaveBeenCalled();
	});

	it("leaves an unstaged headed browser on the shared key with no stage hold", async () => {
		const stageSpy = spyOn(stage, "acquireComputerStage");
		spyOn(launch, "launchHeadlessBrowser").mockResolvedValue(fakeBrowser());

		const handle = (await acquireBrowser(HEADED, { cwd: "/tmp/project" })) as BrowserHandle & {
			stageLease?: unknown;
		};
		handle.refCount = 1;

		expect(stageSpy).not.toHaveBeenCalled();
		expect(handle.key).toBe("headless:0");
		expect(handle.stageLease).toBeUndefined();

		await releaseBrowser(handle, { kill: false });
	});
});
