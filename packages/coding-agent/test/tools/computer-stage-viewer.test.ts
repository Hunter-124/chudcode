import { describe, expect, it } from "bun:test";
import type { DaemonBrokerClient } from "@chudware/coding-agent/launch/client";
import type { DaemonSnapshot, DaemonSpec } from "@chudware/coding-agent/launch/protocol";
import type { ComputerStageDescriptor } from "@chudware/coding-agent/tools/computer/stage";
import {
	type ComputerStageViewerDaemonDescription,
	ComputerStageViewerManager,
	type ComputerStageViewerRuntime,
} from "@chudware/coding-agent/tools/computer/stage-viewer";

const PROJECT_DIR = "/canonical/project";
const STAGE: ComputerStageDescriptor = {
	id: "stage-alpha",
	daemonName: "chudcode.computer.xvfb.fixture",
	projectDir: PROJECT_DIR,
	displayServer: ":27",
	env: { DISPLAY: ":27" },
	unsetEnv: ["WAYLAND_DISPLAY"],
};

function daemon(name: string, id: string = name): DaemonSnapshot {
	return {
		name,
		id,
		state: "ready",
		pid: 1234,
		createdAt: 1,
		startedAt: 2,
		readyAt: 3,
		restartCount: 0,
		outputBytes: 0,
		owner: STAGE.id,
		persist: false,
		detached: false,
	};
}

class ViewerHarness {
	readonly client = {
		projectDir: PROJECT_DIR,
		onCompletion: () => () => undefined,
		request: async () => {
			throw new Error("Viewer tests must use the injected runtime boundary");
		},
		close: () => undefined,
	} as unknown as DaemonBrokerClient;
	readonly descriptions = new Map<string, ComputerStageViewerDaemonDescription>();
	readonly startSpecs: DaemonSpec[] = [];
	readonly startOwners: string[] = [];
	readonly stopNames: string[] = [];
	readonly firstStart = Promise.withResolvers<void>();
	readonly files = new Set<string>();
	readonly binaries: Record<string, string | undefined> = {
		x11vnc: "/usr/bin/x11vnc",
		novnc_proxy: "/usr/bin/novnc_proxy",
		websockify: "/usr/bin/websockify",
	};
	ports = [5901, 6081, 5902, 6082];
	startGate?: PromiseWithResolvers<void>;
	failProxyStarts = 0;

	runtime(): ComputerStageViewerRuntime {
		return {
			which: name => this.binaries[name],
			allocatePort: async () => {
				const port = this.ports.shift();
				if (port === undefined) throw new Error("No fixture port remains");
				return port;
			},
			isFile: async path => this.files.has(path),
			daemonClientForProject: async () => this.client,
			describe: async (_client, name) => this.descriptions.get(name),
			start: async (_client, spec, owner) => {
				this.startSpecs.push(structuredClone(spec));
				this.startOwners.push(owner);
				this.firstStart.resolve();
				if (this.startGate && this.startSpecs.length === 1) await this.startGate.promise;
				if (spec.name.includes("novnc") && this.failProxyStarts > 0) {
					this.failProxyStarts--;
					throw new Error("fixture proxy start failed");
				}
				const snapshot = daemon(spec.name, `${spec.name}-${this.startSpecs.length}`);
				this.descriptions.set(spec.name, { daemon: snapshot, spec });
				return { daemon: snapshot, readyTimedOut: false };
			},
			wait: async (_client, name) => this.descriptions.get(name)?.daemon,
			stop: async (_client, name) => {
				this.stopNames.push(name);
				this.descriptions.delete(name);
			},
		};
	}
}

function expectedNames(stageId: string): { x11vnc: string; proxy: string } {
	const suffix = Bun.hash(stageId).toString(36);
	return {
		x11vnc: `chudcode.computer.vnc.${suffix}`,
		proxy: `chudcode.computer.novnc.${suffix}`,
	};
}

function expectedSpec(name: string, application: string, args: string[], port: number): DaemonSpec {
	return {
		name,
		application,
		args,
		env: { DISPLAY: ":27", WAYLAND_DISPLAY: "" },
		cwd: PROJECT_DIR,
		pty: false,
		ready: { port, host: "127.0.0.1", timeoutMs: 30_000 },
		restart: "no",
		persist: false,
		detached: false,
	};
}

describe("ComputerStageViewerManager", () => {
	it("starts loopback x11vnc and novnc_proxy with the stage display and an autoconnect URL", async () => {
		const harness = new ViewerHarness();
		const manager = new ComputerStageViewerManager(harness.runtime());
		const lease = await manager.acquire({ stage: STAGE });
		const names = lease.descriptor.daemonNames;

		expect(lease.descriptor).toEqual({
			id: STAGE.id,
			url: "http://127.0.0.1:6081/vnc.html?autoconnect=1&resize=scale",
			daemonNames: names,
			projectDir: PROJECT_DIR,
		});
		expect(names.x11vnc.length).toBeLessThanOrEqual(48);
		expect(names.proxy.length).toBeLessThanOrEqual(48);
		expect(harness.startOwners).toEqual([STAGE.id, STAGE.id]);
		expect(harness.startSpecs).toEqual([
			expectedSpec(
				names.x11vnc,
				"/usr/bin/x11vnc",
				["-display", ":27", "-rfbport", "5901", "-listen", "127.0.0.1", "-forever", "-shared", "-nopw"],
				5901,
			),
			expectedSpec(
				names.proxy,
				"/usr/bin/novnc_proxy",
				["--listen", "127.0.0.1:6081", "--vnc", "127.0.0.1:5901"],
				6081,
			),
		]);
		expect(harness.startSpecs[0]?.args).not.toContain("-viewonly");
		await lease.release();
	});

	it("falls back to websockify only with standard packaged noVNC assets", async () => {
		const harness = new ViewerHarness();
		harness.binaries.novnc_proxy = undefined;
		harness.files.add("/usr/share/novnc/vnc.html");
		const manager = new ComputerStageViewerManager(harness.runtime());
		const lease = await manager.acquire({ stage: STAGE });

		expect(harness.startSpecs[1]?.application).toBe("/usr/bin/websockify");
		expect(harness.startSpecs[1]?.args).toEqual(["--web", "/usr/share/novnc", "127.0.0.1:6081", "127.0.0.1:5901"]);
		await lease.release();
	});

	it("cleans both daemon names after a partial start failure before retrying", async () => {
		const harness = new ViewerHarness();
		harness.failProxyStarts = 1;
		const manager = new ComputerStageViewerManager(harness.runtime());
		const lease = await manager.acquire({ stage: STAGE });
		const names = lease.descriptor.daemonNames;

		expect(harness.startSpecs.map(spec => spec.application)).toEqual([
			"/usr/bin/x11vnc",
			"/usr/bin/novnc_proxy",
			"/usr/bin/x11vnc",
			"/usr/bin/novnc_proxy",
		]);
		expect(harness.stopNames.slice(0, 2)).toEqual([names.proxy, names.x11vnc]);
		expect(lease.descriptor.url).toContain(":6082/");
		await lease.release();
	});

	it("single-flights concurrent acquisition and stops proxy then x11vnc after the final idempotent release", async () => {
		const harness = new ViewerHarness();
		const startGate = Promise.withResolvers<void>();
		harness.startGate = startGate;
		const manager = new ComputerStageViewerManager(harness.runtime());
		const first = manager.acquire({ stage: STAGE });
		const second = manager.acquire({ stage: STAGE });
		await harness.firstStart.promise;

		expect(harness.startSpecs).toHaveLength(1);
		startGate.resolve();
		const [firstLease, secondLease] = await Promise.all([first, second]);
		expect(harness.startSpecs).toHaveLength(2);
		expect(firstLease.descriptor).toEqual(secondLease.descriptor);

		await firstLease.release();
		await firstLease.release();
		expect(harness.stopNames).toEqual([]);
		await secondLease.release();
		expect(harness.stopNames).toEqual([
			secondLease.descriptor.daemonNames.proxy,
			secondLease.descriptor.daemonNames.x11vnc,
		]);
		await secondLease.release();
		expect(harness.stopNames).toHaveLength(2);
	});

	it("adopts only a live pair whose commands, ports, and display match", async () => {
		const harness = new ViewerHarness();
		const names = expectedNames(STAGE.id);
		const x11Spec = expectedSpec(
			names.x11vnc,
			"/usr/bin/x11vnc",
			["-display", ":27", "-rfbport", "5901", "-listen", "127.0.0.1", "-forever", "-shared", "-nopw"],
			5901,
		);
		const webSpec = expectedSpec(
			names.proxy,
			"/usr/bin/novnc_proxy",
			["--listen", "127.0.0.1:6081", "--vnc", "127.0.0.1:5901"],
			6081,
		);
		harness.descriptions.set(names.x11vnc, { daemon: daemon(names.x11vnc), spec: x11Spec });
		harness.descriptions.set(names.proxy, { daemon: daemon(names.proxy), spec: webSpec });
		const manager = new ComputerStageViewerManager(harness.runtime());
		const lease = await manager.acquire({ stage: STAGE });

		expect(harness.startSpecs).toEqual([]);
		expect(lease.descriptor.url).toContain(":6081/");
		await lease.release();
	});

	it("replaces a live pair when the x11vnc display does not match", async () => {
		const harness = new ViewerHarness();
		const names = expectedNames(STAGE.id);
		const wrongX11 = expectedSpec(
			names.x11vnc,
			"/usr/bin/x11vnc",
			["-display", ":99", "-rfbport", "5909", "-listen", "127.0.0.1", "-forever", "-shared", "-nopw"],
			5909,
		);
		const oldWeb = expectedSpec(
			names.proxy,
			"/usr/bin/novnc_proxy",
			["--listen", "127.0.0.1:6089", "--vnc", "127.0.0.1:5909"],
			6089,
		);
		harness.descriptions.set(names.x11vnc, { daemon: daemon(names.x11vnc), spec: wrongX11 });
		harness.descriptions.set(names.proxy, { daemon: daemon(names.proxy), spec: oldWeb });
		const manager = new ComputerStageViewerManager(harness.runtime());
		const lease = await manager.acquire({ stage: STAGE });

		expect(harness.stopNames.slice(0, 2)).toEqual([names.proxy, names.x11vnc]);
		expect(harness.startSpecs).toHaveLength(2);
		expect(harness.startSpecs[0]?.args).toContain(":27");
		await lease.release();
	});

	it("reports exact Fedora and Debian guidance for missing dependencies", async () => {
		const missingX11 = new ViewerHarness();
		missingX11.binaries.x11vnc = undefined;
		await expect(new ComputerStageViewerManager(missingX11.runtime()).acquire({ stage: STAGE })).rejects.toThrow(
			"x11vnc is required for the computer stage viewer but was not found on PATH. Install it with `sudo dnf install x11vnc` on Fedora or `sudo apt install x11vnc` on Debian/Ubuntu.",
		);

		const missingNoVnc = new ViewerHarness();
		missingNoVnc.binaries.novnc_proxy = undefined;
		missingNoVnc.binaries.websockify = undefined;
		await expect(new ComputerStageViewerManager(missingNoVnc.runtime()).acquire({ stage: STAGE })).rejects.toThrow(
			"noVNC is required for the computer stage viewer but neither novnc_proxy nor a usable websockify + noVNC asset installation was found. Install it with `sudo dnf install novnc python3-websockify` on Fedora or `sudo apt install novnc websockify` on Debian/Ubuntu.",
		);
	});
});
