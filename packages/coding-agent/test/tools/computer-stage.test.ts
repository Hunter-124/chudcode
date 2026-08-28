import { describe, expect, it } from "bun:test";
import type { DaemonBrokerClient } from "@chudware/coding-agent/launch/client";
import type { DaemonSnapshot, DaemonSpec } from "@chudware/coding-agent/launch/protocol";
import { ComputerStageManager, type ComputerStageRuntime } from "@chudware/coding-agent/tools/computer/stage";
import { ToolAbortError, ToolError } from "@chudware/coding-agent/tools/tool-errors";

function snapshot(id: string, readyMatch: string = "\n27\n"): DaemonSnapshot {
	return {
		name: "fixture",
		id,
		state: "ready",
		pid: 1234,
		createdAt: 1,
		startedAt: 2,
		readyAt: 3,
		restartCount: 0,
		outputBytes: readyMatch.length,
		readyMatch,
		persist: false,
		detached: false,
	};
}

function stageSpec(width: number = 800, height: number = 600): DaemonSpec {
	return {
		name: "fixture",
		application: "/usr/bin/Xvfb",
		args: [
			"-displayfd",
			"1",
			"-screen",
			"0",
			`${width}x${height}x24`,
			"-nolisten",
			"tcp",
			"-noreset",
			"-dpi",
			"96",
			"+extension",
			"GLX",
			"+extension",
			"RANDR",
			"+extension",
			"RENDER",
			"+extension",
			"XTEST",
		],
		env: {},
		cwd: "/canonical/project",
		pty: false,
		restart: "no",
		persist: false,
		detached: false,
	};
}

class StageHarness {
	readonly started = Promise.withResolvers<void>();
	readonly stopped = Promise.withResolvers<void>();
	readonly startGate?: PromiseWithResolvers<DaemonSnapshot>;
	readonly projectDir = "/canonical/project";
	whichResult: string | null = "/usr/bin/Xvfb";
	current?: DaemonSnapshot;
	startCount = 0;
	stopCount = 0;
	waitCount = 0;
	startSpec?: DaemonSpec;
	currentSpec?: DaemonSpec;
	startOwner?: string;

	constructor(options: { existing?: DaemonSnapshot; gatedStart?: boolean } = {}) {
		this.current = options.existing;
		this.currentSpec = options.existing ? stageSpec() : undefined;
		if (options.gatedStart) this.startGate = Promise.withResolvers<DaemonSnapshot>();
	}

	readonly client = {
		projectDir: this.projectDir,
		onCompletion: () => () => undefined,
		request: async operation => {
			if (operation.op === "describe") {
				if (!this.current || !this.currentSpec) throw new Error("Unknown daemon");
				return { op: "describe" as const, daemon: this.current, spec: this.currentSpec };
			}
			if (operation.op !== "start") throw new Error(`Unexpected ${operation.op} request`);
			this.startCount++;
			this.startSpec = operation.spec;
			this.currentSpec = operation.spec;
			this.startOwner = operation.owner;
			this.started.resolve();
			const daemon = this.startGate ? await this.startGate.promise : snapshot(`stage-${this.startCount}`);
			this.current = daemon;
			return { op: "start" as const, daemon, readyTimedOut: false };
		},
		close: () => undefined,
	} as DaemonBrokerClient;

	runtime(): ComputerStageRuntime {
		return {
			platform: "linux",
			which: () => this.whichResult,
			daemonClientForProject: async () => this.client,
			describeQuietly: async () => this.current,
			waitReady: async () => {
				this.waitCount++;
				return this.current;
			},
			stopQuietly: async () => {
				this.stopCount++;
				this.current = undefined;
				this.currentSpec = undefined;
				this.stopped.resolve();
			},
		};
	}
}

describe("ComputerStageManager", () => {
	it("starts bounded Xvfb and returns the isolated display environment", async () => {
		const harness = new StageHarness();
		const manager = new ComputerStageManager(harness.runtime());
		const lease = await manager.acquire({
			projectDir: "/project-via-symlink",
			ownerId: "agent:alpha",
			width: 12,
			height: 99_999,
		});

		expect(lease.descriptor).toEqual({
			id: "stage-1",
			daemonName: lease.descriptor.daemonName,
			projectDir: "/canonical/project",
			displayServer: ":27",
			env: { DISPLAY: ":27" },
			unsetEnv: ["WAYLAND_DISPLAY"],
		});
		expect(lease.descriptor.daemonName.startsWith("chudcode.computer.xvfb.")).toBe(true);
		expect(lease.descriptor.daemonName.length).toBeLessThanOrEqual(48);
		expect(harness.startOwner).toBe("agent:alpha");
		expect(harness.startSpec).toMatchObject({
			application: "/usr/bin/Xvfb",
			cwd: "/canonical/project",
			pty: false,
			env: {},
			restart: "no",
			persist: false,
			detached: false,
		});
		expect(harness.startSpec?.args).toEqual([
			"-displayfd",
			"1",
			"-screen",
			"0",
			"320x4320x24",
			"-nolisten",
			"tcp",
			"-noreset",
			"-dpi",
			"96",
			"+extension",
			"GLX",
			"+extension",
			"RANDR",
			"+extension",
			"RENDER",
			"+extension",
			"XTEST",
		]);

		await lease.release();
		await lease.release();
		expect(harness.stopCount).toBe(1);
	});

	it("single-flights concurrent acquires and stops only after the final release", async () => {
		const harness = new StageHarness({ gatedStart: true });
		const manager = new ComputerStageManager(harness.runtime());
		const options = { projectDir: "/project", ownerId: "shared-owner", width: 1280, height: 720 };
		const first = manager.acquire(options);
		const second = manager.acquire(options);
		await harness.started.promise;
		expect(harness.startCount).toBe(1);
		harness.startGate?.resolve(snapshot("shared-stage", "\n41\n"));

		const [firstLease, secondLease] = await Promise.all([first, second]);
		expect(firstLease.descriptor.id).toBe("shared-stage");
		expect(secondLease.descriptor.id).toBe("shared-stage");
		await firstLease.release();
		expect(harness.stopCount).toBe(0);
		await firstLease.release();
		expect(harness.stopCount).toBe(0);
		await secondLease.release();
		expect(harness.stopCount).toBe(1);
	});

	it("rejects incompatible geometry while an owner has live leases", async () => {
		const harness = new StageHarness();
		const manager = new ComputerStageManager(harness.runtime());
		const lease = await manager.acquire({ projectDir: "/project", ownerId: "owner", width: 800, height: 600 });

		await expect(
			manager.acquire({ projectDir: "/project", ownerId: "owner", width: 1024, height: 768 }),
		).rejects.toThrow("already has 800x600 geometry");
		expect(harness.startCount).toBe(1);
		await lease.release();
	});

	it("rejects incompatible geometry exposed by an already-live broker daemon", async () => {
		const harness = new StageHarness({ existing: snapshot("other-geometry", "\n9\n") });
		harness.currentSpec = stageSpec(1024, 768);
		const manager = new ComputerStageManager(harness.runtime());
		const acquisition = manager.acquire({
			projectDir: "/project",
			ownerId: "owner",
			width: 800,
			height: 600,
		});

		const error = await acquisition.catch(error => error);
		expect(error).toBeInstanceOf(ToolError);
		expect(error.message).toContain("already has 1024x768x24 geometry");
		expect(harness.startCount).toBe(0);
		expect(harness.stopCount).toBe(0);
	});

	it("reuses a live daemon whose displayfd match is valid", async () => {
		const harness = new StageHarness({ existing: snapshot("existing-stage", "\n9\n") });
		const manager = new ComputerStageManager(harness.runtime());
		const lease = await manager.acquire({ projectDir: "/project", ownerId: "owner", width: 800, height: 600 });

		expect(lease.descriptor.id).toBe("existing-stage");
		expect(lease.descriptor.displayServer).toBe(":9");
		expect(harness.startCount).toBe(0);
		await lease.release();
	});

	it("stops and replaces a live daemon without a valid displayfd match", async () => {
		const harness = new StageHarness({ existing: snapshot("wedged-stage", "not-a-display") });
		const manager = new ComputerStageManager(harness.runtime());
		const lease = await manager.acquire({ projectDir: "/project", ownerId: "owner", width: 800, height: 600 });

		expect(harness.stopCount).toBe(1);
		expect(harness.startCount).toBe(1);
		expect(lease.descriptor.id).toBe("stage-1");
		await lease.release();
		expect(harness.stopCount).toBe(2);
	});

	it("surfaces abort before a shared start settles and cleans up the late daemon", async () => {
		const harness = new StageHarness({ gatedStart: true });
		const manager = new ComputerStageManager(harness.runtime());
		const abort = new AbortController();
		const acquisition = manager.acquire({
			projectDir: "/project",
			ownerId: "owner",
			width: 800,
			height: 600,
			signal: abort.signal,
		});
		await harness.started.promise;
		abort.abort("test cancellation");

		await expect(acquisition).rejects.toBeInstanceOf(ToolAbortError);
		harness.startGate?.resolve(snapshot("late-stage"));
		await harness.stopped.promise;
		expect(harness.stopCount).toBe(1);
	});

	it("reports an actionable ToolError when Xvfb is unavailable", async () => {
		const harness = new StageHarness();
		harness.whichResult = null;
		const manager = new ComputerStageManager(harness.runtime());
		const acquisition = manager.acquire({
			projectDir: "/project",
			ownerId: "owner",
			width: 800,
			height: 600,
		});

		const error = await acquisition.catch(error => error);
		expect(error).toBeInstanceOf(ToolError);
		expect(error.message).toMatch(/Xvfb.*not found.*Install/s);
		expect(harness.startCount).toBe(0);
		expect(harness.stopCount).toBe(0);
	});
});
