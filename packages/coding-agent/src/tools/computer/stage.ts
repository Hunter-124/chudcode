import { $which, logger } from "@chudware/utils";
import { type DaemonBrokerClient, daemonClientForProject } from "../../launch/client";
import { describeQuietly, stopQuietly, waitReady } from "../../launch/ensure";
import type { DaemonRpcResult, DaemonSnapshot } from "../../launch/protocol";
import { ToolAbortError, ToolError, throwIfAborted } from "../tool-errors";

const STAGE_LABEL = "Computer stage";
const READY_LOG_PATTERN = String.raw`(?:^|\r?\n)[0-9]{1,4}\r?\n`;
const READY_TIMEOUT_MS = 30_000;
const ENSURE_ATTEMPTS = 3;
const MIN_WIDTH = 320;
const MIN_HEIGHT = 200;
const MAX_WIDTH = 7_680;
const MAX_HEIGHT = 4_320;

export type ComputerSurfaceMode = "auto" | "isolated" | "host";

/** Resolve whether a configured computer surface should use a private Linux stage. */
export function usesComputerStage(
	mode: ComputerSurfaceMode | undefined,
	platform: NodeJS.Platform = process.platform,
): boolean {
	return mode === "isolated" || ((mode === undefined || mode === "auto") && platform === "linux");
}

/** Environment and broker identity of one private virtual desktop. */
export interface ComputerStageDescriptor {
	readonly id: string;
	readonly daemonName: string;
	readonly projectDir: string;
	readonly displayServer: string;
	readonly env: Readonly<Record<string, string>>;
	readonly unsetEnv: readonly string[];
}

/** Ref-counted hold on a computer stage. Release is safe to call more than once. */
export interface ComputerStageLease {
	readonly descriptor: ComputerStageDescriptor;
	release(): Promise<void>;
}

export interface AcquireComputerStageOptions {
	projectDir: string;
	ownerId: string;
	width: number;
	height: number;
	signal?: AbortSignal;
}

/** Injectable operating-system and daemon boundary used by focused lifecycle tests. */
export interface ComputerStageRuntime {
	readonly platform: NodeJS.Platform;
	which(name: string): string | null | undefined;
	daemonClientForProject(projectDir: string): Promise<DaemonBrokerClient>;
	describeQuietly(
		client: DaemonBrokerClient,
		name: string,
		label: string,
		signal?: AbortSignal,
	): Promise<DaemonSnapshot | undefined>;
	waitReady(
		client: DaemonBrokerClient,
		name: string,
		label: string,
		signal?: AbortSignal,
		timeoutMs?: number,
	): Promise<DaemonSnapshot | undefined>;
	stopQuietly(client: DaemonBrokerClient, name: string, label: string, signal?: AbortSignal): Promise<void>;
}

const DEFAULT_RUNTIME: ComputerStageRuntime = {
	platform: process.platform,
	which: $which,
	daemonClientForProject,
	describeQuietly,
	waitReady,
	stopQuietly,
};

interface StageRecord {
	readonly key: string;
	readonly client: DaemonBrokerClient;
	readonly daemonName: string;
	readonly width: number;
	readonly height: number;
	pending: Promise<ComputerStageDescriptor>;
	descriptor?: ComputerStageDescriptor;
	closing?: Promise<void>;
	waiters: number;
	refCount: number;
}

function normalizedDimension(value: number, minimum: number, maximum: number, label: string): number {
	if (!Number.isFinite(value)) throw new ToolError(`Computer stage ${label} must be a finite number`);
	return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function daemonNameForOwner(ownerId: string): string {
	return `chudcode.computer.xvfb.${Bun.hash(ownerId).toString(36)}`;
}

function live(snapshot: DaemonSnapshot | undefined): snapshot is DaemonSnapshot {
	return snapshot !== undefined && snapshot.state !== "exited" && snapshot.state !== "failed";
}

function xvfbArgs(width: number, height: number): string[] {
	return [
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
	];
}

function displayServerOf(snapshot: DaemonSnapshot | undefined): string | undefined {
	const display = snapshot?.readyMatch?.trim();
	if (!display || !/^[0-9]{1,4}$/.test(display)) return undefined;
	const number = Number(display);
	return Number.isSafeInteger(number) ? `:${number}` : undefined;
}

function descriptorOf(
	snapshot: DaemonSnapshot,
	daemonName: string,
	projectDir: string,
): ComputerStageDescriptor | undefined {
	const displayServer = displayServerOf(snapshot);
	if (!displayServer) return undefined;
	return {
		id: snapshot.id,
		daemonName,
		projectDir,
		displayServer,
		env: { DISPLAY: displayServer },
		unsetEnv: ["WAYLAND_DISPLAY"],
	};
}

function abortError(signal: AbortSignal): ToolAbortError {
	return signal.reason instanceof ToolAbortError
		? signal.reason
		: new ToolAbortError("Computer stage acquisition aborted", { cause: signal.reason });
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

/** Process-local single-flight and ref-count manager for broker-owned Xvfb stages. */
export class ComputerStageManager {
	readonly #runtime: ComputerStageRuntime;
	readonly #records = new Map<string, StageRecord>();

	constructor(runtime: ComputerStageRuntime = DEFAULT_RUNTIME) {
		this.#runtime = runtime;
	}

	async acquire(options: AcquireComputerStageOptions): Promise<ComputerStageLease> {
		if (this.#runtime.platform !== "linux") {
			throw new ToolError("Private computer stages currently require Linux and Xvfb");
		}
		if (!options.ownerId.trim()) throw new ToolError("Computer stage ownerId must be non-empty");
		throwIfAborted(options.signal);

		const width = normalizedDimension(options.width, MIN_WIDTH, MAX_WIDTH, "width");
		const height = normalizedDimension(options.height, MIN_HEIGHT, MAX_HEIGHT, "height");
		let client: DaemonBrokerClient;
		try {
			client = await waitForAbort(this.#runtime.daemonClientForProject(options.projectDir), options.signal);
		} catch (error) {
			if (error instanceof ToolAbortError) throw error;
			throwIfAborted(options.signal);
			throw new ToolError(
				`Unable to initialize the computer stage daemon broker: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		const key = `${client.projectDir.length}:${client.projectDir}${options.ownerId}`;
		for (;;) {
			throwIfAborted(options.signal);
			let record = this.#records.get(key);
			if (record?.closing) {
				await waitForAbort(record.closing, options.signal);
				continue;
			}
			if (record && (record.width !== width || record.height !== height)) {
				throw new ToolError(
					`Computer stage owner ${JSON.stringify(options.ownerId)} already has ${record.width}x${record.height} geometry; ` +
						`release its live leases before requesting ${width}x${height}`,
				);
			}
			if (!record) record = this.#createRecord(client, key, options.ownerId, width, height);

			record.waiters++;
			try {
				const descriptor = await waitForAbort(record.pending, options.signal);
				throwIfAborted(options.signal);
				record.refCount++;
				return this.#lease(record, descriptor);
			} finally {
				record.waiters--;
			}
		}
	}

	#createRecord(client: DaemonBrokerClient, key: string, ownerId: string, width: number, height: number): StageRecord {
		const daemonName = daemonNameForOwner(ownerId);
		let record: StageRecord;
		const opening = this.#ensureStage(client, daemonName, ownerId, width, height);
		record = {
			key,
			client,
			daemonName,
			width,
			height,
			pending: opening,
			waiters: 0,
			refCount: 0,
		};
		record.pending = opening
			.then(async descriptor => {
				record.descriptor = descriptor;
				if (record.waiters === 0 && record.refCount === 0) await this.#closeRecord(record);
				return descriptor;
			})
			.catch(error => {
				if (this.#records.get(key) === record) this.#records.delete(key);
				throw error;
			});
		this.#records.set(key, record);
		return record;
	}

	#lease(record: StageRecord, descriptor: ComputerStageDescriptor): ComputerStageLease {
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

	async #closeRecord(record: StageRecord): Promise<void> {
		if (record.closing) return await record.closing;
		record.closing = this.#runtime.stopQuietly(record.client, record.daemonName, STAGE_LABEL).finally(() => {
			if (this.#records.get(record.key) === record) this.#records.delete(record.key);
		});
		await record.closing;
	}

	async #assertCompatibleStage(
		client: DaemonBrokerClient,
		snapshot: DaemonSnapshot,
		ownerId: string,
		executable: string,
		width: number,
		height: number,
	): Promise<void> {
		if (snapshot.owner !== undefined && snapshot.owner !== ownerId) {
			throw new ToolError(
				`Computer stage daemon ${snapshot.name} belongs to another owner; refusing to reuse its display`,
			);
		}
		let described: DaemonRpcResult;
		try {
			described = await client.request({ op: "describe", name: snapshot.name });
		} catch (error) {
			throw new ToolError(
				`Unable to verify the live computer stage geometry: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (described.op !== "describe") throw new ToolError("Unable to verify the live computer stage geometry");
		const screenIndex = described.spec.args.indexOf("-screen");
		const actual =
			screenIndex >= 0 && described.spec.args[screenIndex + 1] === "0"
				? described.spec.args[screenIndex + 2]
				: undefined;
		const expected = `${width}x${height}x24`;
		if (actual !== expected) {
			throw new ToolError(
				`Computer stage owner ${JSON.stringify(ownerId)} already has ${actual ?? "unknown"} geometry; ` +
					`release that live stage before requesting ${expected}`,
			);
		}
		const expectedArgs = xvfbArgs(width, height);
		const spec = described.spec;
		const launchMatches =
			spec.application === executable &&
			spec.cwd === client.projectDir &&
			spec.pty === false &&
			spec.restart === "no" &&
			spec.persist === false &&
			spec.detached === false &&
			spec.args.length === expectedArgs.length &&
			!spec.args.some((arg, index) => arg !== expectedArgs[index]);
		if (!launchMatches) {
			throw new ToolError(
				`Computer stage owner ${JSON.stringify(ownerId)} has a live daemon with an incompatible Xvfb launch configuration; ` +
					"release or stop that stage before acquiring it",
			);
		}
	}

	async #ensureStage(
		client: DaemonBrokerClient,
		daemonName: string,
		ownerId: string,
		width: number,
		height: number,
	): Promise<ComputerStageDescriptor> {
		const executable = this.#runtime.which("Xvfb");
		if (!executable) {
			throw new ToolError(
				"Xvfb is required for a private computer stage but was not found on PATH. " +
					"Install it with your system package manager (for example `sudo dnf install xorg-x11-server-Xvfb` or `sudo apt install xvfb`).",
			);
		}

		let lastError: unknown;
		for (let attempt = 0; attempt < ENSURE_ATTEMPTS; attempt++) {
			const existing = await this.#runtime.describeQuietly(client, daemonName, STAGE_LABEL);
			if (live(existing)) {
				const settled =
					existing.readyAt !== undefined
						? existing
						: await this.#runtime.waitReady(client, daemonName, STAGE_LABEL, undefined, READY_TIMEOUT_MS);
				const adopted = settled && descriptorOf(settled, daemonName, client.projectDir);
				if (!adopted) {
					await this.#runtime.stopQuietly(client, daemonName, STAGE_LABEL);
					continue;
				}
				await this.#assertCompatibleStage(client, settled, ownerId, executable, width, height);
				return adopted;
			}

			try {
				const started = await client.request({
					op: "start",
					owner: ownerId,
					spec: {
						name: daemonName,
						application: executable,
						args: xvfbArgs(width, height),
						env: {},
						cwd: client.projectDir,
						pty: false,
						ready: { log: READY_LOG_PATTERN, timeoutMs: READY_TIMEOUT_MS },
						restart: "no",
						persist: false,
						detached: false,
					},
				});
				if (started.op === "start" && !started.readyTimedOut) {
					const descriptor = descriptorOf(started.daemon, daemonName, client.projectDir);
					if (descriptor) return descriptor;
				}
				await this.#runtime.stopQuietly(client, daemonName, STAGE_LABEL);
			} catch (error) {
				lastError = error;
				logger.debug("Computer stage Xvfb start contention", {
					daemonName,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		// The last start may have reached the broker even if its response was
		// lost. Adopt a valid winner, or stop the named record before failing so
		// acquisition errors never leave an unreferenced Xvfb behind.
		const finalExisting = await this.#runtime.describeQuietly(client, daemonName, STAGE_LABEL);
		if (live(finalExisting)) {
			const settled =
				finalExisting.readyAt !== undefined
					? finalExisting
					: await this.#runtime.waitReady(client, daemonName, STAGE_LABEL, undefined, READY_TIMEOUT_MS);
			const adopted = settled && descriptorOf(settled, daemonName, client.projectDir);
			if (adopted) {
				await this.#assertCompatibleStage(client, settled, ownerId, executable, width, height);
				return adopted;
			}
			await this.#runtime.stopQuietly(client, daemonName, STAGE_LABEL);
		}

		throw new ToolError(
			`Unable to start a ready Xvfb computer stage${lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ""}. ` +
				`Inspect ${daemonName} with \`hub ps\`/\`hub logs\` and verify Xvfb can start in ${client.projectDir}.`,
		);
	}
}

const defaultManager = new ComputerStageManager();

/** Acquire one ref-counted private desktop stage for a canonical project and owner. */
export function acquireComputerStage(options: AcquireComputerStageOptions): Promise<ComputerStageLease> {
	return defaultManager.acquire(options);
}
