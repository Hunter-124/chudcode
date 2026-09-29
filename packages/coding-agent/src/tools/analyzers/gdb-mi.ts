import type { ToolSession } from "..";

export type MiValue = string | MiTuple | MiValue[];
export interface MiTuple {
	[key: string]: MiValue;
}

export interface MiRecord {
	token?: number;
	type: "result" | "exec" | "status" | "notify" | "console" | "target" | "log" | "prompt" | "unknown";
	class?: string;
	results?: MiTuple;
	text?: string;
	raw: string;
}

class MiParser {
	#index = 0;
	constructor(private readonly source: string) {}

	parseResults(end = ""): MiTuple {
		const output: MiTuple = {};
		while (this.#index < this.source.length && this.source[this.#index] !== end) {
			if (this.source[this.#index] === ",") this.#index++;
			const key = this.#readUntil("=,{}[]");
			if (!key || this.source[this.#index] !== "=") break;
			this.#index++;
			const value = this.parseValue();
			const previous = output[key];
			if (previous === undefined) output[key] = value;
			else if (Array.isArray(previous)) previous.push(value);
			else output[key] = [previous, value];
		}
		if (end && this.source[this.#index] === end) this.#index++;
		return output;
	}

	parseValue(): MiValue {
		const char = this.source[this.#index];
		if (char === '"') return this.#parseCString();
		if (char === "{") {
			this.#index++;
			return this.parseResults("}");
		}
		if (char === "[") {
			this.#index++;
			const values: MiValue[] = [];
			while (this.#index < this.source.length && this.source[this.#index] !== "]") {
				if (this.source[this.#index] === ",") this.#index++;
				const saved = this.#index;
				const key = this.#readUntil("=,[]{}");
				if (key && this.source[this.#index] === "=") {
					this.#index++;
					values.push({ [key]: this.parseValue() });
				} else {
					this.#index = saved;
					values.push(this.parseValue());
				}
			}
			if (this.source[this.#index] === "]") this.#index++;
			return values;
		}
		return this.#readUntil(",]} ");
	}

	#parseCString(): string {
		const start = this.#index++;
		let escaped = false;
		while (this.#index < this.source.length) {
			const char = this.source[this.#index++];
			if (char === '"' && !escaped) break;
			escaped = char === "\\" && !escaped;
			if (char !== "\\") escaped = false;
		}
		const encoded = this.source.slice(start, this.#index);
		try {
			const parsed: unknown = JSON.parse(encoded);
			if (typeof parsed === "string") return parsed;
		} catch {
			// GDB occasionally emits C escapes that JSON does not recognize.
		}
		return encoded
			.slice(1, -1)
			.replace(/\\n/g, "\n")
			.replace(/\\t/g, "\t")
			.replace(/\\"/g, '"')
			.replace(/\\\\/g, "\\");
	}

	#readUntil(stoppers: string): string {
		const start = this.#index;
		while (this.#index < this.source.length && !stoppers.includes(this.source[this.#index]!)) this.#index++;
		return this.source.slice(start, this.#index).trim();
	}
}

const RECORD_TYPES: Record<string, MiRecord["type"]> = {
	"^": "result",
	"*": "exec",
	"+": "status",
	"=": "notify",
	"~": "console",
	"@": "target",
	"&": "log",
};

export function parseMiRecord(line: string): MiRecord | null {
	const raw = line.trimEnd();
	if (!raw) return null;
	if (raw === "(gdb)") return { type: "prompt", raw };
	const match = /^(\d+)?([\^*+=~@&])(.*)$/.exec(raw);
	if (!match) return { type: "unknown", raw, text: raw };
	const token = match[1] === undefined ? undefined : Number(match[1]);
	const marker = match[2]!;
	const body = match[3] ?? "";
	const type = RECORD_TYPES[marker] ?? "unknown";
	if (type === "console" || type === "target" || type === "log") {
		const text = new MiParser(body).parseValue();
		return { ...(token === undefined ? {} : { token }), type, text: typeof text === "string" ? text : body, raw };
	}
	const comma = body.indexOf(",");
	const resultClass = comma < 0 ? body : body.slice(0, comma);
	const results = comma < 0 ? {} : new MiParser(body.slice(comma + 1)).parseResults();
	return {
		...(token === undefined ? {} : { token }),
		type,
		...(resultClass ? { class: resultClass } : {}),
		...(Object.keys(results).length > 0 ? { results } : {}),
		raw,
	};
}

interface PendingRequest {
	token: number;
	records: MiRecord[];
	resolve: (records: MiRecord[]) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export interface GdbMiStartOptions {
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string | undefined>;
	signal?: AbortSignal;
	timeoutMs?: number;
}

function environment(extra?: Record<string, string | undefined>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries({ ...process.env, ...extra }))
		if (value !== undefined) result[key] = value;
	return result;
}

interface PendingStop {
	resolve: (record: MiRecord) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export class GdbMiSession {
	#alive = true;
	#nextToken = 1;
	#pending: PendingRequest | undefined;
	#queue: Promise<void> = Promise.resolve();
	#stops: MiRecord[] = [];
	#stopWaiters: PendingStop[] = [];
	#stdout = "";
	#stderr = "";
	#stdoutTruncated = false;
	#stderrTruncated = false;
	readonly exitCode: Promise<number>;

	private constructor(
		private readonly process: Bun.Subprocess<"pipe", "pipe", "pipe">,
		private readonly abortSignal?: AbortSignal,
	) {
		this.exitCode = process.exited;
		void this.#readStdout();
		void this.#readStderr();
		this.exitCode.finally(() => this.#onExit());
		if (this.abortSignal?.aborted) void this.close();
		else this.abortSignal?.addEventListener("abort", this.#abort, { once: true });
	}

	static async start(options: GdbMiStartOptions): Promise<GdbMiSession> {
		if (options.signal?.aborted) throw new Error("GDB/MI start aborted");
		const process = Bun.spawn([options.command, ...(options.args ?? [])], {
			cwd: options.cwd,
			env: environment(options.env),
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const session = new GdbMiSession(process, options.signal);
		try {
			await session.request("-gdb-version", options.timeoutMs ?? 15_000);
			return session;
		} catch (error) {
			await session.close();
			throw error;
		}
	}

	get alive(): boolean {
		return this.#alive;
	}

	request(command: string, timeoutMs = 30_000): Promise<MiRecord[]> {
		const task = this.#queue.then(() => this.#requestDirect(command, timeoutMs));
		this.#queue = task.then(
			() => undefined,
			() => undefined,
		);
		return task;
	}
	waitForStop(timeoutMs = 30_000): Promise<MiRecord> {
		const queued = this.#stops.shift();
		if (queued) return Promise.resolve(queued);
		if (!this.#alive) return Promise.reject(new Error("GDB/MI session is closed"));
		return new Promise<MiRecord>((resolve, reject) => {
			const waiter: PendingStop = {
				resolve,
				reject,
				timer: setTimeout(
					() => {
						const index = this.#stopWaiters.indexOf(waiter);
						if (index >= 0) this.#stopWaiters.splice(index, 1);
						reject(new Error("Timed out waiting for GDB/MI stop record"));
					},
					Math.max(1, timeoutMs),
				),
			};
			this.#stopWaiters.push(waiter);
		});
	}

	stdoutExcerpt(): string {
		return `${this.#stdoutTruncated ? "… stdout truncated …\n" : ""}${this.#stdout}`;
	}

	stderrExcerpt(): string {
		return `${this.#stderrTruncated ? "… stderr truncated …\n" : ""}${this.#stderr}`;
	}

	async close(): Promise<void> {
		if (!this.#alive) return;
		this.#alive = false;
		this.abortSignal?.removeEventListener("abort", this.#abort);
		try {
			this.process.stdin.write("-gdb-exit\n");
			this.process.stdin.flush();
		} catch {
			// Pipe already closed.
		}
		await Promise.race([this.exitCode, Bun.sleep(500)]);
		if (this.process.exitCode === null) this.process.kill("SIGTERM");
		await Promise.race([this.exitCode, Bun.sleep(1000)]);
		if (this.process.exitCode === null) this.process.kill("SIGKILL");
		await Promise.race([this.exitCode, Bun.sleep(1000)]);
	}

	async #requestDirect(command: string, timeoutMs: number): Promise<MiRecord[]> {
		if (!this.#alive) throw new Error("GDB/MI session is closed");
		const token = this.#nextToken++;
		return new Promise<MiRecord[]>((resolve, reject) => {
			const timer = setTimeout(
				() => {
					if (this.#pending?.token === token) this.#pending = undefined;
					reject(new Error(`GDB/MI request timed out: ${command}`));
				},
				Math.max(1, timeoutMs),
			);
			this.#pending = { token, records: [], resolve, reject, timer };
			try {
				this.process.stdin.write(`${token}${command}\n`);
				this.process.stdin.flush();
			} catch (error) {
				clearTimeout(timer);
				this.#pending = undefined;
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	async #readStdout(): Promise<void> {
		const reader = this.process.stdout.getReader();
		const decoder = new TextDecoder();
		let carry = "";
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				carry += decoder.decode(value, { stream: true });
				const lines = carry.split(/\r?\n/);
				carry = lines.pop() ?? "";
				for (const line of lines) this.#handleLine(line);
			}
			carry += decoder.decode();
			if (carry) this.#handleLine(carry);
		} finally {
			reader.releaseLock();
		}
	}

	async #readStderr(): Promise<void> {
		const reader = this.process.stderr.getReader();
		const decoder = new TextDecoder();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				this.#appendStderr(decoder.decode(value, { stream: true }));
			}
			this.#appendStderr(decoder.decode());
		} finally {
			reader.releaseLock();
		}
	}

	#handleLine(line: string): void {
		this.#appendStdout(`${line}\n`);
		const record = parseMiRecord(line);
		if (!record) return;
		if (record.type === "exec" && record.class === "stopped") {
			const waiter = this.#stopWaiters.shift();
			if (waiter) {
				clearTimeout(waiter.timer);
				waiter.resolve(record);
			} else {
				this.#stops.push(record);
				if (this.#stops.length > 10) this.#stops.shift();
			}
		}
		if (!this.#pending) return;
		if (this.#pending.records.length < 500) this.#pending.records.push(record);
		if (record.type !== "result" || (record.token !== undefined && record.token !== this.#pending.token)) return;
		const pending = this.#pending;
		this.#pending = undefined;
		clearTimeout(pending.timer);
		pending.resolve(pending.records);
	}

	#appendStdout(text: string): void {
		this.#stdout += text;
		if (this.#stdout.length > 256 * 1024) {
			this.#stdout = this.#stdout.slice(-256 * 1024);
			this.#stdoutTruncated = true;
		}
	}

	#appendStderr(text: string): void {
		this.#stderr += text;
		if (this.#stderr.length > 128 * 1024) {
			this.#stderr = this.#stderr.slice(-128 * 1024);
			this.#stderrTruncated = true;
		}
	}

	#onExit(): void {
		this.#alive = false;
		this.abortSignal?.removeEventListener("abort", this.#abort);
		const error = new Error(`GDB/MI process exited. ${this.stderrExcerpt()}`);
		for (const waiter of this.#stopWaiters.splice(0)) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		if (!this.#pending) return;
		const pending = this.#pending;
		this.#pending = undefined;
		clearTimeout(pending.timer);
		pending.reject(error);
	}

	#abort = (): void => {
		void this.close();
	};
}

export interface RunGdbMiOptions extends GdbMiStartOptions {
	commands: string[];
	toolSession?: ToolSession;
}

export async function runGdbMI(options: RunGdbMiOptions): Promise<{
	exitCode: number;
	records: MiRecord[];
	stdout: string;
	stderr: string;
	artifacts?: string[];
}> {
	const session = await GdbMiSession.start(options);
	const records: MiRecord[] = [];
	try {
		for (const command of options.commands) {
			const response = await session.request(command, options.timeoutMs);
			records.push(...response.slice(0, Math.max(0, 1000 - records.length)));
			if (records.length >= 1000) break;
		}
	} finally {
		await session.close();
	}
	return {
		exitCode: await Promise.race([session.exitCode, Bun.sleep(100).then(() => -1)]),
		records,
		stdout: session.stdoutExcerpt(),
		stderr: session.stderrExcerpt(),
	};
}
