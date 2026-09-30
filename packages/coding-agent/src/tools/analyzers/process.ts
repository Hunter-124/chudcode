import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { cfgToolsArtifactSpillThreshold } from "../settings";
import type { ToolSession } from "..";

const DEFAULT_CAPTURE_BYTES = 2 * 1024 * 1024;
const MAX_SPILL_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export interface CommandResult {
	command: string[];
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	truncated: boolean;
	artifacts?: string[];
}

export interface RunCommandOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
	signal?: AbortSignal;
	timeoutMs?: number;
	captureBytes?: number;
	session?: ToolSession;
	artifactType?: string;
	stdin?: string;
}

class BoundedText {
	readonly #limit: number;
	readonly #half: number;
	#full: string | undefined = "";
	#head = "";
	#tail = "";
	#seen = 0;

	constructor(limit: number) {
		this.#limit = Math.max(1024, limit);
		this.#half = Math.floor(this.#limit / 2);
	}

	push(text: string): void {
		this.#seen += Buffer.byteLength(text);
		if (this.#full !== undefined) {
			this.#full += text;
			if (Buffer.byteLength(this.#full) > this.#limit) this.#full = undefined;
		}
		if (Buffer.byteLength(this.#head) < this.#half) {
			const missing = this.#half - Buffer.byteLength(this.#head);
			this.#head += Buffer.from(text).subarray(0, missing).toString();
		}
		this.#tail = (this.#tail + text).slice(-this.#half);
	}

	get truncated(): boolean {
		return this.#seen > this.#limit;
	}

	text(): string {
		if (this.#full !== undefined) return this.#full;
		return `${this.#head}\n… subprocess output truncated; bounded raw stream spilled to artifact …\n${this.#tail}`;
	}
}

function cleanEnv(extra?: Record<string, string | undefined>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries({ ...process.env, ...extra })) {
		if (value !== undefined) env[key] = value;
	}
	return env;
}

async function consume(
	stream: ReadableStream<Uint8Array>,
	rawPath: string,
	limit: number,
): Promise<{ text: string; truncated: boolean; bytes: number }> {
	const reader = stream.getReader();
	const output = new BoundedText(limit);
	const decoder = new TextDecoder();
	const file = await fs.open(rawPath, "w");
	let bytes = 0;
	let written = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (written < MAX_SPILL_BYTES) {
				const retained = value.subarray(0, Math.min(value.byteLength, MAX_SPILL_BYTES - written));
				await file.write(retained);
				written += retained.byteLength;
			}
			output.push(decoder.decode(value, { stream: true }));
		}
		output.push(decoder.decode());
	} finally {
		await file.close();
	}
	return { text: output.text(), truncated: output.truncated, bytes };
}

async function spill(
	session: ToolSession | undefined,
	artifactType: string,
	rawPath: string,
	streamName: string,
): Promise<string | undefined> {
	try {
		const allocated = await session?.allocateOutputArtifact?.(`${artifactType}-${streamName}`);
		if (!allocated?.path) return undefined;
		await fs.copyFile(rawPath, allocated.path);
		return allocated.id ? `artifact://${allocated.id}` : allocated.path;
	} catch {
		return undefined;
	}
}

export async function runCommand(command: string[], options: RunCommandOptions = {}): Promise<CommandResult> {
	if (command.length === 0) throw new Error("runCommand requires a command");
	const spillThresholdKb = options.session ? cfgToolsArtifactSpillThreshold.get(options.session) : undefined;
	const defaultCaptureBytes =
		typeof spillThresholdKb === "number" && Number.isFinite(spillThresholdKb)
			? spillThresholdKb * 1024
			: DEFAULT_CAPTURE_BYTES;
	const captureBytes = Math.max(4096, options.captureBytes ?? defaultCaptureBytes);
	const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "chud-analyzer-output-"));
	const stdoutPath = path.join(tmp, "stdout");
	const stderrPath = path.join(tmp, "stderr");
	let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
	try {
		proc = Bun.spawn(command, {
			cwd: options.cwd,
			env: cleanEnv(options.env),
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (error) {
		await fs.rm(tmp, { recursive: true, force: true });
		throw error;
	}
	if (options.stdin !== undefined) proc.stdin.write(options.stdin);
	proc.stdin.end();
	let timedOut = false;
	let killTimer: NodeJS.Timeout | undefined;
	const terminate = () => {
		try {
			proc.kill("SIGTERM");
			killTimer ??= setTimeout(() => {
				if (proc.exitCode === null) proc.kill("SIGKILL");
			}, 1000);
		} catch {
			// Process already exited.
		}
	};
	const timer = setTimeout(() => {
		timedOut = true;
		terminate();
	}, timeoutMs);
	const abort = () => terminate();
	if (options.signal?.aborted) terminate();
	else options.signal?.addEventListener("abort", abort, { once: true });
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			consume(proc.stdout, stdoutPath, captureBytes),
			consume(proc.stderr, stderrPath, captureBytes),
			proc.exited,
		]);
		const artifacts: string[] = [];
		if (stdout.truncated) {
			const artifact = await spill(options.session, options.artifactType ?? "analyzer", stdoutPath, "stdout");
			if (artifact) artifacts.push(artifact);
		}
		if (stderr.truncated) {
			const artifact = await spill(options.session, options.artifactType ?? "analyzer", stderrPath, "stderr");
			if (artifact) artifacts.push(artifact);
		}
		return {
			command,
			exitCode,
			stdout: stdout.text,
			stderr: stderr.text,
			timedOut,
			truncated: stdout.truncated || stderr.truncated,
			artifacts: artifacts.length > 0 ? artifacts : undefined,
		};
	} finally {
		if (proc.exitCode === null) {
			terminate();
			await Promise.race([proc.exited, Bun.sleep(1200)]);
		}
		clearTimeout(timer);
		clearTimeout(killTimer);
		options.signal?.removeEventListener("abort", abort);
		await fs.rm(tmp, { recursive: true, force: true });
	}
}

export function commandFailure(
	result: CommandResult,
	reason = result.timedOut ? "timeout" : "tool_failed",
	hint?: string,
): { ok: false; reason: string; hint: string; exit_code: number; stderr_excerpt?: string; artifacts?: string[] } {
	return {
		ok: false,
		reason,
		hint: hint ?? `Command failed: ${result.command.join(" ").slice(0, 4000)}`,
		exit_code: result.exitCode,
		stderr_excerpt: result.stderr.trim().slice(-16_000) || undefined,
		artifacts: result.artifacts,
	};
}
