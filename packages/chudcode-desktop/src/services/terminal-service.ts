import { randomUUID } from "node:crypto";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, resolve, sep } from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import type { TerminalId, WorkspaceId } from "../protocol";
import {
	DEFAULT_TERMINAL_ENVIRONMENT_ALLOWLIST,
	type TerminalCloseParams,
	type TerminalCloseResult,
	type TerminalCreateParams,
	type TerminalCreateResult,
	type TerminalResizeParams,
	type TerminalResizeResult,
	type TerminalServiceEvent,
	type TerminalServiceOptions,
	type TerminalSnapshot,
	type TerminalWriteParams,
	type TerminalWriteResult,
} from "./terminal-types";

const DEFAULT_MAX_TERMINALS = 32;
const DEFAULT_MAX_INPUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_BUFFERED_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_CLOSE_GRACE_MS = 750;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const MIN_DIMENSION = 1;
const MAX_DIMENSION = 10_000;

export function encodeTerminalDataBase64(data: Uint8Array): string {
	return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64");
}

export class TerminalServiceError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "TerminalServiceError";
	}
}

interface TerminalRecord {
	id: TerminalId;
	workspaceId: WorkspaceId;
	cwd: string;
	cols: number;
	rows: number;
	terminal: Bun.Terminal;
	process?: Bun.Subprocess;
	nativeProcess?: Process;
	bufferedOutputBytes: number;
	closing: boolean;
	overflowed: boolean;
	ptyClosed: boolean;
	processExited: boolean;
	exitCode: number | null;
	signal?: string;
	finalized: boolean;
	closePromise?: Promise<void>;
}

interface QueuedEvent {
	event: TerminalServiceEvent;
	record?: TerminalRecord;
	outputBytes: number;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
	const selected = value ?? fallback;
	if (!Number.isSafeInteger(selected) || selected <= 0) {
		throw new TerminalServiceError("TERMINAL_INVALID_OPTION", `${name} must be a positive integer`);
	}
	return selected;
}

function validateDimension(value: number, name: "cols" | "rows"): void {
	if (!Number.isSafeInteger(value) || value < MIN_DIMENSION || value > MAX_DIMENSION) {
		throw new TerminalServiceError(
			"TERMINAL_INVALID_DIMENSIONS",
			`${name} must be an integer between ${MIN_DIMENSION} and ${MAX_DIMENSION}`,
		);
	}
}

function validateEnvironmentName(name: string): void {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
		throw new TerminalServiceError("TERMINAL_INVALID_ENVIRONMENT", `Invalid environment variable name: ${name}`);
	}
}

function validateEnvironmentValue(name: string, value: string): void {
	if (value.includes("\0")) {
		throw new TerminalServiceError("TERMINAL_INVALID_ENVIRONMENT", `${name} contains a NUL byte`);
	}
}

function isExecutable(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function hasPathSeparator(candidate: string): boolean {
	return candidate.includes("/") || candidate.includes("\\") || candidate.includes(sep);
}

function executableNames(candidate: string, pathExt: string | undefined): string[] {
	if (process.platform !== "win32" || /\.[^./\\]+$/.test(candidate)) return [candidate];
	const extensions = (pathExt ?? ".COM;.EXE;.BAT;.CMD")
		.split(";")
		.filter(Boolean)
		.map(extension => (extension.startsWith(".") ? extension : `.${extension}`));
	return [candidate, ...extensions.map(extension => `${candidate}${extension.toLowerCase()}`)];
}

function resolveExecutable(
	candidate: string,
	pathValue: string | undefined,
	pathExt: string | undefined,
): string | undefined {
	if (!candidate || candidate.includes("\0")) return undefined;
	if (isAbsolute(candidate)) return isExecutable(candidate) ? candidate : undefined;
	if (hasPathSeparator(candidate)) return undefined;

	const searchPath = pathValue ?? (process.platform === "win32" ? "" : "/usr/local/bin:/usr/bin:/bin");
	for (const directory of searchPath.split(delimiter)) {
		if (!directory) continue;
		for (const name of executableNames(candidate, pathExt)) {
			const path = resolve(directory, name);
			if (isExecutable(path)) return path;
		}
	}
	return undefined;
}

export function resolveTerminalShell(
	explicitShell: string | undefined,
	environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
	const pathValue = environment.PATH;
	const pathExt = environment.PATHEXT;
	if (explicitShell !== undefined) {
		const resolved = resolveExecutable(explicitShell, pathValue, pathExt);
		if (!resolved) {
			throw new TerminalServiceError(
				"TERMINAL_SHELL_NOT_FOUND",
				`Terminal shell is not executable: ${explicitShell}`,
			);
		}
		return resolved;
	}

	const candidates =
		process.platform === "win32"
			? [environment.COMSPEC, "pwsh.exe", "powershell.exe", "cmd.exe"]
			: [environment.SHELL, "/bin/bash", "/bin/zsh", "/bin/sh"];
	for (const candidate of candidates) {
		if (!candidate) continue;
		const resolved = resolveExecutable(candidate, pathValue, pathExt);
		if (resolved) return resolved;
	}
	throw new TerminalServiceError("TERMINAL_SHELL_NOT_FOUND", "No executable interactive shell was found");
}

export function buildTerminalEnvironment(
	shell: string,
	termName: string,
	inherited: Readonly<Record<string, string | undefined>>,
	allowlist: readonly string[],
	explicit: Readonly<Record<string, string>>,
): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const name of allowlist) {
		validateEnvironmentName(name);
		const value = inherited[name];
		if (value === undefined) continue;
		validateEnvironmentValue(name, value);
		environment[name] = value;
	}
	for (const [name, value] of Object.entries(explicit)) {
		validateEnvironmentName(name);
		validateEnvironmentValue(name, value);
		environment[name] = value;
	}
	validateEnvironmentValue("TERM", termName);
	environment.TERM = termName;
	environment.SHELL = shell;
	return environment;
}

export class TerminalService implements AsyncDisposable {
	readonly #options: TerminalServiceOptions;
	readonly #inheritedEnvironment: Readonly<Record<string, string | undefined>>;
	readonly #environmentAllowlist: readonly string[];
	readonly #explicitEnvironment: Readonly<Record<string, string>>;
	readonly #termName: string;
	readonly #maxTerminals: number;
	readonly #maxInputBytes: number;
	readonly #maxBufferedOutputBytes: number;
	readonly #closeGraceMs: number;
	readonly #closeTimeoutMs: number;
	readonly #terminals = new Map<TerminalId, TerminalRecord>();
	readonly #eventQueue: QueuedEvent[] = [];
	#dispatching = false;
	#disposed = false;

	constructor(options: TerminalServiceOptions) {
		if (typeof Bun.Terminal !== "function") {
			throw new TerminalServiceError(
				"TERMINAL_PTY_UNAVAILABLE",
				"This Bun runtime does not expose Bun.Terminal; a real PTY/ConPTY runtime is required",
			);
		}
		this.#options = options;
		this.#inheritedEnvironment = options.inheritedEnvironment ?? process.env;
		this.#environmentAllowlist = options.environmentAllowlist ?? DEFAULT_TERMINAL_ENVIRONMENT_ALLOWLIST;
		this.#explicitEnvironment = options.environment ?? {};
		this.#termName = options.termName ?? "xterm-256color";
		this.#maxTerminals = positiveInteger(options.maxTerminals, DEFAULT_MAX_TERMINALS, "maxTerminals");
		this.#maxInputBytes = positiveInteger(options.maxInputBytes, DEFAULT_MAX_INPUT_BYTES, "maxInputBytes");
		this.#maxBufferedOutputBytes = positiveInteger(
			options.maxBufferedOutputBytes,
			DEFAULT_MAX_BUFFERED_OUTPUT_BYTES,
			"maxBufferedOutputBytes",
		);
		this.#closeGraceMs = positiveInteger(options.closeGraceMs, DEFAULT_CLOSE_GRACE_MS, "closeGraceMs");
		this.#closeTimeoutMs = positiveInteger(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS, "closeTimeoutMs");
	}

	async create(params: TerminalCreateParams): Promise<TerminalCreateResult> {
		if (this.#disposed) throw new TerminalServiceError("TERMINAL_SERVICE_CLOSED", "Terminal service is closed");
		validateDimension(params.cols, "cols");
		validateDimension(params.rows, "rows");
		if (this.#terminals.size >= this.#maxTerminals) {
			throw new TerminalServiceError(
				"TERMINAL_LIMIT_REACHED",
				`At most ${this.#maxTerminals} terminals may be active`,
			);
		}

		const workspace = await this.#options.resolveWorkspace(params.workspaceId);
		if (typeof workspace !== "string" && workspace.id !== params.workspaceId) {
			throw new TerminalServiceError(
				"TERMINAL_WORKSPACE_MISMATCH",
				"Workspace resolver returned a different workspace",
			);
		}
		const requestedCwd = typeof workspace === "string" ? workspace : workspace.rootPath;
		if (!isAbsolute(requestedCwd)) {
			throw new TerminalServiceError("TERMINAL_INVALID_WORKSPACE", "Workspace root must be an absolute path");
		}
		let cwd: string;
		try {
			cwd = realpathSync(requestedCwd);
			if (!statSync(cwd).isDirectory()) throw new Error("not a directory");
		} catch {
			throw new TerminalServiceError(
				"TERMINAL_INVALID_WORKSPACE",
				`Workspace root is not a readable directory: ${requestedCwd}`,
			);
		}

		const shell = resolveTerminalShell(this.#options.shell, this.#inheritedEnvironment);
		const environment = buildTerminalEnvironment(
			shell,
			this.#termName,
			this.#inheritedEnvironment,
			this.#environmentAllowlist,
			this.#explicitEnvironment,
		);
		const id = randomUUID();
		const terminal = new Bun.Terminal({
			cols: params.cols,
			rows: params.rows,
			name: this.#termName,
			data: (_terminal, data) => this.#handleData(id, data),
			exit: () => this.#handlePtyExit(id),
		});
		const record: TerminalRecord = {
			id,
			workspaceId: params.workspaceId,
			cwd,
			cols: params.cols,
			rows: params.rows,
			terminal,
			bufferedOutputBytes: 0,
			closing: false,
			overflowed: false,
			ptyClosed: false,
			processExited: false,
			exitCode: null,
			finalized: false,
		};
		this.#terminals.set(id, record);

		try {
			const subprocess = Bun.spawn([shell], {
				cwd,
				env: environment,
				detached: true,
				terminal,
			});
			record.process = subprocess;
			record.nativeProcess = Process.fromPid(subprocess.pid) ?? undefined;
			void subprocess.exited.then(
				exitCode => this.#handleProcessExit(id, exitCode),
				error => {
					this.#enqueue({
						event: { t: "error", code: "TERMINAL_PROCESS_ERROR", message: String(error) },
						outputBytes: 0,
					});
					this.#handleProcessExit(id, subprocess.exitCode ?? -1);
				},
			);
		} catch (error) {
			this.#terminals.delete(id);
			terminal.close();
			throw new TerminalServiceError("TERMINAL_SPAWN_FAILED", `Failed to start terminal shell: ${String(error)}`);
		}
		return { terminalId: id };
	}

	write(params: TerminalWriteParams): TerminalWriteResult {
		const record = this.#terminals.get(params.terminalId);
		if (!record || record.closing || record.finalized || record.terminal.closed) return { accepted: false };
		const inputBytes = Buffer.byteLength(params.data);
		if (inputBytes > this.#maxInputBytes) return { accepted: false };
		try {
			return { accepted: record.terminal.write(params.data) === inputBytes };
		} catch {
			return { accepted: false };
		}
	}

	resize(params: TerminalResizeParams): TerminalResizeResult {
		validateDimension(params.cols, "cols");
		validateDimension(params.rows, "rows");
		const record = this.#terminals.get(params.terminalId);
		if (!record || record.closing || record.finalized) {
			throw new TerminalServiceError("TERMINAL_NOT_FOUND", `Unknown terminal: ${params.terminalId}`);
		}
		record.terminal.resize(params.cols, params.rows);
		record.cols = params.cols;
		record.rows = params.rows;
		return {};
	}

	async close(params: TerminalCloseParams): Promise<TerminalCloseResult> {
		const record = this.#terminals.get(params.terminalId);
		if (record) await this.#closeRecord(record);
		return {};
	}

	list(): TerminalSnapshot[] {
		return [...this.#terminals.values()].map(record => ({
			id: record.id,
			workspaceId: record.workspaceId,
			cwd: record.cwd,
			pid: record.process?.pid ?? -1,
			cols: record.cols,
			rows: record.rows,
			bufferedOutputBytes: record.bufferedOutputBytes,
			closing: record.closing,
		}));
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		await Promise.allSettled([...this.#terminals.values()].map(record => this.#closeRecord(record)));
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.dispose();
	}

	#handleData(id: TerminalId, data: Uint8Array): void {
		const record = this.#terminals.get(id);
		if (!record || record.finalized || record.overflowed) return;
		if (record.bufferedOutputBytes + data.byteLength > this.#maxBufferedOutputBytes) {
			record.overflowed = true;
			this.#enqueue({
				event: {
					t: "error",
					code: "TERMINAL_OUTPUT_OVERFLOW",
					message: `Terminal ${id} exceeded its ${this.#maxBufferedOutputBytes}-byte buffered output limit`,
				},
				outputBytes: 0,
			});
			void this.#closeRecord(record);
			return;
		}
		if (data.byteLength === 0) return;
		record.bufferedOutputBytes += data.byteLength;
		this.#enqueue({
			event: {
				t: "terminal-data",
				terminalId: id,
				dataBase64: encodeTerminalDataBase64(data),
			},
			record,
			outputBytes: data.byteLength,
		});
	}

	#handlePtyExit(id: TerminalId): void {
		const record = this.#terminals.get(id);
		if (!record || record.ptyClosed) return;
		record.ptyClosed = true;
		this.#finalizeIfExited(record);
	}

	#handleProcessExit(id: TerminalId, exitCode: number): void {
		const record = this.#terminals.get(id);
		if (!record || record.processExited) return;
		record.processExited = true;
		record.signal = record.process?.signalCode ?? undefined;
		record.exitCode = record.signal ? null : exitCode;
		// Bun keeps an attached Terminal open after the subprocess exits. Closing
		// the master after `exited` has settled releases it and delivers PTY EOF.
		if (!record.terminal.closed) record.terminal.close();
		this.#handlePtyExit(id);
	}

	#finalizeIfExited(record: TerminalRecord): void {
		if (record.finalized || !record.processExited || !record.ptyClosed) return;
		record.finalized = true;
		this.#terminals.delete(record.id);
		this.#enqueue({
			event: {
				t: "terminal-exit",
				terminalId: record.id,
				exitCode: record.exitCode,
				...(record.signal ? { signal: record.signal } : {}),
			},
			outputBytes: 0,
		});
	}

	#closeRecord(record: TerminalRecord): Promise<void> {
		if (record.closePromise) return record.closePromise;
		record.closing = true;
		record.closePromise = this.#terminateRecord(record);
		return record.closePromise;
	}

	async #terminateRecord(record: TerminalRecord): Promise<void> {
		try {
			if (record.nativeProcess) {
				const exited = await record.nativeProcess.terminate({
					group: true,
					gracefulMs: this.#closeGraceMs,
					timeoutMs: this.#closeTimeoutMs,
				});
				if (!exited) {
					record.nativeProcess.killTree(9);
					await record.nativeProcess.waitForExit({ timeoutMs: this.#closeTimeoutMs });
				}
			} else if (record.process && record.process.exitCode === null) {
				// The native stable handle should always be available for a live process.
				// This fallback still targets the detached POSIX process group, never a shell command.
				if (process.platform !== "win32") {
					try {
						process.kill(-record.process.pid, "SIGTERM");
					} catch {}
				} else {
					record.process.kill("SIGTERM");
				}
			}
		} finally {
			if (!record.terminal.closed) record.terminal.close();
			record.ptyClosed = true;
			if (record.process && !record.processExited) {
				try {
					const exitCode = await Promise.race([
						record.process.exited,
						Bun.sleep(this.#closeTimeoutMs).then(() => record.process?.exitCode ?? -1),
					]);
					this.#handleProcessExit(record.id, exitCode);
				} catch {
					this.#handleProcessExit(record.id, record.process.exitCode ?? -1);
				}
			}
			this.#finalizeIfExited(record);
		}
	}

	#enqueue(item: QueuedEvent): void {
		this.#eventQueue.push(item);
		this.#pumpEvents();
	}

	#pumpEvents(): void {
		if (this.#dispatching) return;
		this.#dispatching = true;
		while (this.#eventQueue.length > 0) {
			const item = this.#eventQueue.shift()!;
			let result: void | Promise<void>;
			try {
				result = this.#options.emit(item.event);
			} catch {
				this.#settleEvent(item);
				continue;
			}
			if (result && typeof result.then === "function") {
				void Promise.resolve(result).then(
					() => this.#resumeEvents(item),
					() => this.#resumeEvents(item),
				);
				return;
			}
			this.#settleEvent(item);
		}
		this.#dispatching = false;
	}

	#resumeEvents(item: QueuedEvent): void {
		this.#settleEvent(item);
		this.#dispatching = false;
		this.#pumpEvents();
	}

	#settleEvent(item: QueuedEvent): void {
		if (item.record && item.outputBytes > 0) {
			item.record.bufferedOutputBytes = Math.max(0, item.record.bufferedOutputBytes - item.outputBytes);
		}
	}
}
