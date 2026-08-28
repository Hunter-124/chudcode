import * as fs from "node:fs/promises";
import { $which } from "@chudware/utils";
import { type DaemonBrokerClient, daemonClientForProject } from "../../launch/client";
import { stopQuietly, waitReady } from "../../launch/ensure";
import type { DaemonSnapshot, DaemonSpec } from "../../launch/protocol";
import { findFreeCdpPort } from "../browser/attach";
import { ToolAbortError, ToolError, throwIfAborted } from "../tool-errors";
import type { ComputerStageDescriptor } from "./stage";

const VIEWER_LABEL = "Computer stage viewer";
const LOOPBACK = "127.0.0.1";
const READY_TIMEOUT_MS = 30_000;
const ENSURE_ATTEMPTS = 3;
const PORT_ATTEMPTS = 3;
const NOVNC_ASSET_DIRS = ["/usr/share/novnc", "/usr/share/noVNC"] as const;
const X11VNC_INSTALL_GUIDANCE =
	"x11vnc is required for the computer stage viewer but was not found on PATH. Install it with `sudo dnf install x11vnc` on Fedora or `sudo apt install x11vnc` on Debian/Ubuntu.";
const NOVNC_INSTALL_GUIDANCE =
	"noVNC is required for the computer stage viewer but neither novnc_proxy nor a usable websockify + noVNC asset installation was found. Install it with `sudo dnf install novnc python3-websockify` on Fedora or `sudo apt install novnc websockify` on Debian/Ubuntu.";

export interface ComputerStageViewerDaemonNames {
	readonly x11vnc: string;
	readonly proxy: string;
}

/** Browser endpoint and broker identities for one shared stage viewer. */
export interface ComputerStageViewerDescriptor {
	readonly id: string;
	readonly url: string;
	readonly daemonNames: ComputerStageViewerDaemonNames;
	readonly projectDir: string;
}

/** Ref-counted hold on a browser-native stage viewer. Release is idempotent. */
export interface ComputerStageViewerLease {
	readonly descriptor: ComputerStageViewerDescriptor;
	release(): Promise<void>;
}

export interface AcquireComputerStageViewerOptions {
	stage: ComputerStageDescriptor;
	signal?: AbortSignal;
}

export interface ComputerStageViewerDaemonDescription {
	readonly daemon: DaemonSnapshot;
	readonly spec: DaemonSpec;
}

export interface ComputerStageViewerStartResult {
	readonly daemon: DaemonSnapshot;
	readonly readyTimedOut: boolean;
}

/** Injectable filesystem, port, and broker boundary used by focused lifecycle tests. */
export interface ComputerStageViewerRuntime {
	which(name: string): string | null | undefined;
	allocatePort(): Promise<number>;
	isFile(path: string): Promise<boolean>;
	daemonClientForProject(projectDir: string): Promise<DaemonBrokerClient>;
	describe(
		client: DaemonBrokerClient,
		name: string,
		signal?: AbortSignal,
	): Promise<ComputerStageViewerDaemonDescription | undefined>;
	start(
		client: DaemonBrokerClient,
		spec: DaemonSpec,
		owner: string,
		signal?: AbortSignal,
	): Promise<ComputerStageViewerStartResult>;
	wait(client: DaemonBrokerClient, name: string, signal?: AbortSignal): Promise<DaemonSnapshot | undefined>;
	stop(client: DaemonBrokerClient, name: string, signal?: AbortSignal): Promise<void>;
}

const DEFAULT_RUNTIME: ComputerStageViewerRuntime = {
	which: $which,
	allocatePort: findFreeCdpPort,
	isFile: async path => {
		try {
			return (await fs.stat(path)).isFile();
		} catch {
			return false;
		}
	},
	daemonClientForProject,
	describe: async (client, name, signal) => {
		try {
			const result = await client.request({ op: "describe", name }, signal);
			return result.op === "describe" ? { daemon: result.daemon, spec: result.spec } : undefined;
		} catch {
			throwIfAborted(signal);
			return undefined;
		}
	},
	start: async (client, spec, owner, signal) => {
		const result = await client.request({ op: "start", spec, owner }, signal);
		if (result.op !== "start") throw new Error(`Unexpected daemon response ${result.op}`);
		return { daemon: result.daemon, readyTimedOut: result.readyTimedOut };
	},
	wait: (client, name, signal) => waitReady(client, name, VIEWER_LABEL, signal, READY_TIMEOUT_MS),
	stop: (client, name, signal) => stopQuietly(client, name, VIEWER_LABEL, signal),
};

type ProxyLaunch =
	| { readonly kind: "novnc_proxy"; readonly executable: string }
	| { readonly kind: "websockify"; readonly executable: string; readonly assetDir: string };

interface ViewerRecord {
	readonly stage: ComputerStageDescriptor;
	readonly daemonNames: ComputerStageViewerDaemonNames;
	client?: DaemonBrokerClient;
	pending: Promise<ComputerStageViewerDescriptor>;
	ready: boolean;
	closing?: Promise<void>;
	waiters: number;
	refCount: number;
}

function live(
	description: ComputerStageViewerDaemonDescription | undefined,
): description is ComputerStageViewerDaemonDescription {
	return (
		description !== undefined &&
		description.daemon.state !== "stopping" &&
		description.daemon.state !== "exited" &&
		description.daemon.state !== "failed"
	);
}

function daemonNames(stageId: string): ComputerStageViewerDaemonNames {
	const suffix = Bun.hash(stageId).toString(36);
	return {
		x11vnc: `chudcode.computer.vnc.${suffix}`,
		proxy: `chudcode.computer.novnc.${suffix}`,
	};
}

function stageMatches(left: ComputerStageDescriptor, right: ComputerStageDescriptor): boolean {
	return left.projectDir === right.projectDir && left.displayServer === right.displayServer;
}

function stageEnv(stage: ComputerStageDescriptor): Record<string, string> {
	return {
		DISPLAY: stage.displayServer,
		WAYLAND_DISPLAY: "",
	};
}

function x11vncArgs(stage: ComputerStageDescriptor, rfbPort: number): string[] {
	return [
		"-display",
		stage.displayServer,
		"-rfbport",
		String(rfbPort),
		"-listen",
		LOOPBACK,
		"-forever",
		"-shared",
		"-nopw",
	];
}

function proxyArgs(proxy: ProxyLaunch, webPort: number, rfbPort: number): string[] {
	if (proxy.kind === "novnc_proxy") {
		return ["--listen", `${LOOPBACK}:${webPort}`, "--vnc", `${LOOPBACK}:${rfbPort}`];
	}
	return ["--web", proxy.assetDir, `${LOOPBACK}:${webPort}`, `${LOOPBACK}:${rfbPort}`];
}

function daemonSpec(
	name: string,
	application: string,
	args: string[],
	env: Record<string, string>,
	projectDir: string,
	port: number,
): DaemonSpec {
	return {
		name,
		application,
		args,
		env,
		cwd: projectDir,
		pty: false,
		ready: { port, host: LOOPBACK, timeoutMs: READY_TIMEOUT_MS },
		restart: "no",
		persist: false,
		detached: false,
	};
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && !left.some((value, index) => value !== right[index]);
}

function equalEnv(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
	const keys = Object.keys(left);
	return keys.length === Object.keys(right).length && keys.every(key => left[key] === right[key]);
}

function specMatches(actual: DaemonSpec, expected: DaemonSpec): boolean {
	return (
		actual.name === expected.name &&
		actual.application === expected.application &&
		equalStrings(actual.args, expected.args) &&
		equalEnv(actual.env, expected.env) &&
		actual.cwd === expected.cwd &&
		actual.pty === expected.pty &&
		actual.ready?.port === expected.ready?.port &&
		actual.ready?.host === expected.ready?.host &&
		actual.ready?.timeoutMs === expected.ready?.timeoutMs &&
		actual.ready?.log === expected.ready?.log &&
		actual.restart === expected.restart &&
		actual.persist === expected.persist &&
		actual.detached === expected.detached
	);
}

function portAfter(args: readonly string[], option: string): number | undefined {
	const index = args.indexOf(option);
	if (index < 0) return undefined;
	const port = Number(args[index + 1]);
	return Number.isSafeInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

function webPortOf(proxy: ProxyLaunch, args: readonly string[]): number | undefined {
	const value = proxy.kind === "novnc_proxy" ? args[args.indexOf("--listen") + 1] : args[2];
	if (!value?.startsWith(`${LOOPBACK}:`)) return undefined;
	const port = Number(value.slice(LOOPBACK.length + 1));
	return Number.isSafeInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

function viewerUrl(port: number): string {
	return `http://${LOOPBACK}:${port}/vnc.html?autoconnect=1&resize=scale`;
}

function abortError(signal: AbortSignal): ToolAbortError {
	return signal.reason instanceof ToolAbortError
		? signal.reason
		: new ToolAbortError("Computer stage viewer acquisition aborted", { cause: signal.reason });
}

async function waitForAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	throwIfAborted(signal);
	if (!signal) return await promise;
	const aborted = Promise.withResolvers<never>();
	const onAbort = (): void => aborted.reject(abortError(signal));
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([promise, aborted.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

/** Process-local single-flight and ref-count manager for stage viewer daemons. */
export class ComputerStageViewerManager {
	readonly #runtime: ComputerStageViewerRuntime;
	readonly #records = new Map<string, ViewerRecord>();

	constructor(runtime: ComputerStageViewerRuntime = DEFAULT_RUNTIME) {
		this.#runtime = runtime;
	}

	async acquire(options: AcquireComputerStageViewerOptions): Promise<ComputerStageViewerLease> {
		throwIfAborted(options.signal);
		for (;;) {
			let record = this.#records.get(options.stage.id);
			if (record?.closing) {
				await waitForAbort(record.closing, options.signal);
				continue;
			}
			if (record && !stageMatches(record.stage, options.stage)) {
				throw new ToolError(
					`Computer stage ${JSON.stringify(options.stage.id)} already has a viewer for ${record.stage.displayServer} in ${record.stage.projectDir}`,
				);
			}
			if (!record) record = this.#createRecord(options.stage);

			record.waiters++;
			try {
				const descriptor = await waitForAbort(record.pending, options.signal);
				throwIfAborted(options.signal);
				record.refCount++;
				return this.#lease(record, descriptor);
			} finally {
				record.waiters--;
				if (record.ready && record.waiters === 0 && record.refCount === 0) {
					void this.#closeRecord(record).catch(() => undefined);
				}
			}
		}
	}

	#createRecord(stage: ComputerStageDescriptor): ViewerRecord {
		const names = daemonNames(stage.id);
		const initialized = Promise.withResolvers<ComputerStageViewerDescriptor>();
		const record: ViewerRecord = {
			stage,
			daemonNames: names,
			pending: initialized.promise,
			waiters: 0,
			refCount: 0,
			ready: false,
		};
		record.pending = initialized.promise
			.then(async descriptor => {
				record.ready = true;
				if (record.waiters === 0 && record.refCount === 0) await this.#closeRecord(record);
				return descriptor;
			})
			.catch(error => {
				if (this.#records.get(stage.id) === record) this.#records.delete(stage.id);
				throw error;
			});
		this.#records.set(stage.id, record);
		void this.#initializeRecord(record).then(initialized.resolve, initialized.reject);
		return record;
	}

	async #initializeRecord(record: ViewerRecord): Promise<ComputerStageViewerDescriptor> {
		let client: DaemonBrokerClient;
		try {
			client = await this.#runtime.daemonClientForProject(record.stage.projectDir);
		} catch (error) {
			throw new ToolError(
				`Unable to initialize the computer stage viewer daemon broker: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		record.client = client;
		return await this.#ensureViewer(client, record.daemonNames, record.stage);
	}

	#lease(record: ViewerRecord, descriptor: ComputerStageViewerDescriptor): ComputerStageViewerLease {
		let released = false;
		return {
			descriptor,
			release: async () => {
				if (released) return;
				released = true;
				if (record.refCount === 0) return;
				record.refCount--;
				if (record.refCount === 0) await this.#closeRecord(record);
			},
		};
	}

	async #closeRecord(record: ViewerRecord): Promise<void> {
		if (record.closing) return await record.closing;
		if (!record.client) {
			if (this.#records.get(record.stage.id) === record) this.#records.delete(record.stage.id);
			return;
		}
		record.closing = this.#stopPair(record.client, record.daemonNames).finally(() => {
			if (this.#records.get(record.stage.id) === record) this.#records.delete(record.stage.id);
		});
		await record.closing;
	}

	async #resolveProxy(): Promise<ProxyLaunch> {
		const novncProxy = this.#runtime.which("novnc_proxy");
		if (novncProxy) return { kind: "novnc_proxy", executable: novncProxy };
		const websockify = this.#runtime.which("websockify");
		if (websockify) {
			for (const assetDir of NOVNC_ASSET_DIRS) {
				if (await this.#runtime.isFile(`${assetDir}/vnc.html`)) {
					return { kind: "websockify", executable: websockify, assetDir };
				}
			}
		}
		throw new ToolError(NOVNC_INSTALL_GUIDANCE);
	}

	async #allocatePorts(): Promise<{ rfbPort: number; webPort: number }> {
		const rfbPort = await this.#runtime.allocatePort();
		for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
			const webPort = await this.#runtime.allocatePort();
			if (webPort !== rfbPort) return { rfbPort, webPort };
		}
		throw new ToolError("Unable to allocate distinct loopback ports for the computer stage viewer");
	}

	async #settled(
		client: DaemonBrokerClient,
		description: ComputerStageViewerDaemonDescription,
	): Promise<DaemonSnapshot | undefined> {
		if (description.daemon.readyAt !== undefined) return description.daemon;
		return await this.#runtime.wait(client, description.daemon.name);
	}

	async #adopt(
		client: DaemonBrokerClient,
		names: ComputerStageViewerDaemonNames,
		stage: ComputerStageDescriptor,
		x11vnc: string,
		proxy: ProxyLaunch,
		x11: ComputerStageViewerDaemonDescription | undefined,
		web: ComputerStageViewerDaemonDescription | undefined,
	): Promise<ComputerStageViewerDescriptor | undefined> {
		if (
			!live(x11) ||
			!live(web) ||
			(x11.daemon.owner !== undefined && x11.daemon.owner !== stage.id) ||
			(web.daemon.owner !== undefined && web.daemon.owner !== stage.id)
		) {
			return undefined;
		}
		const rfbPort = portAfter(x11.spec.args, "-rfbport");
		const webPort = webPortOf(proxy, web.spec.args);
		if (rfbPort === undefined || webPort === undefined || rfbPort === webPort) return undefined;
		const env = stageEnv(stage);
		const expectedX11 = daemonSpec(names.x11vnc, x11vnc, x11vncArgs(stage, rfbPort), env, client.projectDir, rfbPort);
		const expectedWeb = daemonSpec(
			names.proxy,
			proxy.executable,
			proxyArgs(proxy, webPort, rfbPort),
			env,
			client.projectDir,
			webPort,
		);
		if (!specMatches(x11.spec, expectedX11) || !specMatches(web.spec, expectedWeb)) return undefined;
		const settledX11 = await this.#settled(client, x11);
		const settledWeb = await this.#settled(client, web);
		if (
			!settledX11 ||
			!settledWeb ||
			!live({ daemon: settledX11, spec: x11.spec }) ||
			!live({ daemon: settledWeb, spec: web.spec })
		) {
			return undefined;
		}
		return {
			id: stage.id,
			url: viewerUrl(webPort),
			daemonNames: names,
			projectDir: client.projectDir,
		};
	}

	async #startReady(client: DaemonBrokerClient, spec: DaemonSpec, owner: string): Promise<DaemonSnapshot> {
		const started = await this.#runtime.start(client, spec, owner);
		if (!started.readyTimedOut && started.daemon.readyAt !== undefined) return started.daemon;
		const settled = await this.#runtime.wait(client, spec.name);
		if (!settled || settled.state === "stopping" || settled.state === "exited" || settled.state === "failed") {
			throw new Error(`${spec.name} did not become ready on ${LOOPBACK}:${spec.ready?.port}`);
		}
		return settled;
	}

	async #stopPair(client: DaemonBrokerClient, names: ComputerStageViewerDaemonNames): Promise<void> {
		let firstError: unknown;
		for (const name of [names.proxy, names.x11vnc]) {
			try {
				await this.#runtime.stop(client, name);
			} catch (error) {
				firstError ??= error;
			}
		}
		if (firstError) throw firstError;
	}

	async #ensureViewer(
		client: DaemonBrokerClient,
		names: ComputerStageViewerDaemonNames,
		stage: ComputerStageDescriptor,
	): Promise<ComputerStageViewerDescriptor> {
		const x11vnc = this.#runtime.which("x11vnc");
		if (!x11vnc) throw new ToolError(X11VNC_INSTALL_GUIDANCE);
		const proxy = await this.#resolveProxy();
		let lastError: unknown;

		for (let attempt = 0; attempt < ENSURE_ATTEMPTS; attempt++) {
			const [x11, web] = await Promise.all([
				this.#runtime.describe(client, names.x11vnc),
				this.#runtime.describe(client, names.proxy),
			]);
			const adopted = await this.#adopt(client, names, stage, x11vnc, proxy, x11, web);
			if (adopted) return adopted;
			if (live(x11) || live(web)) await this.#stopPair(client, names);

			try {
				const { rfbPort, webPort } = await this.#allocatePorts();
				const env = stageEnv(stage);
				const x11Spec = daemonSpec(
					names.x11vnc,
					x11vnc,
					x11vncArgs(stage, rfbPort),
					env,
					client.projectDir,
					rfbPort,
				);
				const webSpec = daemonSpec(
					names.proxy,
					proxy.executable,
					proxyArgs(proxy, webPort, rfbPort),
					env,
					client.projectDir,
					webPort,
				);
				await this.#startReady(client, x11Spec, stage.id);
				await this.#startReady(client, webSpec, stage.id);
				return {
					id: stage.id,
					url: viewerUrl(webPort),
					daemonNames: names,
					projectDir: client.projectDir,
				};
			} catch (error) {
				lastError = error;
				try {
					await this.#stopPair(client, names);
				} catch (cleanupError) {
					lastError = new AggregateError([error, cleanupError], "Viewer start and cleanup both failed");
				}
			}
		}

		throw new ToolError(
			`Unable to start the computer stage viewer${lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ""}`,
		);
	}
}

const defaultManager = new ComputerStageViewerManager();

/** Acquire one process-shared browser viewer for an existing computer stage. */
export function acquireComputerStageViewer(
	options: AcquireComputerStageViewerOptions,
): Promise<ComputerStageViewerLease> {
	return defaultManager.acquire(options);
}
