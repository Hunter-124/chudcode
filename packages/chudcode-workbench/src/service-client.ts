import * as childProcess from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as ws from "ws";
import type { RawData } from "ws";

export const MAX_REQUEST_BYTES = 1024 * 1024;
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const STARTUP_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PENDING_REQUESTS = 256;
const MAX_STARTUP_BYTES = 16 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;

export type ServiceState = "idle" | "starting" | "ready" | "failed" | "stopped";

interface Readiness {
	url: string;
	wsUrl: string;
	token: string;
}

interface PendingRequest {
	method: string;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export interface ServiceOptions {
	workspace: string;
	executable: string;
	args: readonly string[];
	onFailure: (message: string) => void;
}

export interface BridgeSocket {
	send(data: string): void;
	close(): void;
}

export interface BridgeListener {
	open(): void;
	message(data: string): void;
	close(code: number, reason: string): void;
	error(message: string): void;
}

/** Validate the public desktop request envelope before forwarding webview bytes. */
export function validateRequest(data: string): void {
	if (Buffer.byteLength(data) > MAX_REQUEST_BYTES) throw new Error("Desktop request exceeds the 1 MiB limit");
	let value: unknown;
	try {
		value = JSON.parse(data);
	} catch {
		throw new Error("Desktop request is not valid JSON");
	}
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		!("t" in value) ||
		value.t !== "request" ||
		!("id" in value) ||
		!Number.isSafeInteger(value.id) ||
		!("method" in value) ||
		typeof value.method !== "string" ||
		value.method.length === 0 ||
		value.method.length > 128 ||
		!("params" in value) ||
		typeof value.params !== "object" ||
		value.params === null ||
		Array.isArray(value.params) ||
		Object.keys(value).some(key => !["t", "id", "method", "params"].includes(key))
	)
		throw new Error("Expected a desktop request envelope");
}

function parseReadiness(data: string): Readiness {
	let value: unknown;
	try {
		value = JSON.parse(data);
	} catch {
		throw new Error("Service emitted invalid readiness JSON");
	}
	if (
		typeof value !== "object" ||
		value === null ||
		!("type" in value) ||
		value.type !== "ready" ||
		!("protocol" in value) ||
		value.protocol !== 1 ||
		!("url" in value) ||
		typeof value.url !== "string" ||
		!("wsUrl" in value) ||
		typeof value.wsUrl !== "string" ||
		!("token" in value) ||
		typeof value.token !== "string" ||
		!/^[A-Za-z0-9_-]{16,512}$/.test(value.token)
	)
		throw new Error("Service emitted invalid readiness information");
	let http: URL;
	let socket: URL;
	try {
		http = new URL(value.url);
		socket = new URL(value.wsUrl);
	} catch {
		throw new Error("Service readiness URL is invalid");
	}
	if (
		http.protocol !== "http:" ||
		socket.protocol !== "ws:" ||
		http.hostname !== "127.0.0.1" ||
		socket.hostname !== "127.0.0.1" ||
		!http.port ||
		http.host !== socket.host ||
		http.pathname !== "/" ||
		socket.pathname !== "/ws" ||
		http.username ||
		http.password ||
		http.search ||
		http.hash ||
		socket.username ||
		socket.password ||
		socket.search ||
		socket.hash
	)
		throw new Error("Service readiness must use matching loopback endpoints");
	return { url: http.origin, wsUrl: socket.toString(), token: value.token };
}

function frameText(data: RawData, binary: boolean): string {
	if (binary) throw new Error("Service sent a binary desktop frame");
	const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
	if (buffer.byteLength > MAX_FRAME_BYTES) throw new Error("Service frame exceeds transport limit");
	return buffer.toString("utf8");
}

/** One real service process, with authenticated sockets kept exclusively in the extension host. */
export class ServiceClient {
	readonly #options: ServiceOptions;
	readonly #sockets = new Set<ws.WebSocket>();
	readonly #pending = new Map<number, PendingRequest>();
	#state: ServiceState = "idle";
	#child: ChildProcessWithoutNullStreams | undefined;
	#readiness: Readiness | undefined;
	#control: ws.WebSocket | undefined;
	#starting: Promise<void> | undefined;
	#shutdown: Promise<void> | undefined;
	#cancelStartup: ((error: Error) => void) | undefined;
	#sequence = 0;
	#stderr = Buffer.alloc(0);

	constructor(options: ServiceOptions) {
		this.#options = options;
	}

	get state(): ServiceState {
		return this.#state;
	}

	whenReady(): Promise<void> {
		if (this.#state === "ready") return Promise.resolve();
		if (this.#state === "failed") return Promise.reject(new Error("Service failed; use ChudCode: Restart Service"));
		if (this.#state === "stopped") return Promise.reject(new Error("Service is stopped"));
		if (this.#starting) return this.#starting;
		this.#state = "starting";
		this.#starting = this.#start().catch(error => {
			const message = error instanceof Error ? error.message : "Service startup failed";
			this.#fail(message);
			throw new Error(message);
		});
		return this.#starting;
	}

	async #start(): Promise<void> {
		if (!path.isAbsolute(this.#options.executable))
			throw new Error("Service executable must be an absolute trusted launcher path");
		const stat = await fs.stat(this.#options.executable).catch(() => {
			throw new Error("Service executable is unavailable");
		});
		if (!stat.isFile()) throw new Error("Service executable is not a regular file");
		if (this.#state !== "starting") throw new Error("Service startup cancelled");
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		let output = Buffer.alloc(0);
		let announced = false;
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			this.#cancelStartup = undefined;
			if (error) reject(error);
			else resolve();
		};
		const timer = setTimeout(() => finish(new Error("Service startup timed out")), STARTUP_TIMEOUT_MS);
		this.#cancelStartup = error => finish(error);
		const child = childProcess.spawn(
			this.#options.executable,
			[...this.#options.args, "--workspace", this.#options.workspace],
			{
				cwd: this.#options.workspace,
				env: process.env,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
				shell: false,
			},
		);
		this.#child = child;
		child.stdin.on("error", () => this.#fail("Service input pipe failed"));
		child.stdout.on("error", () => this.#fail("Service readiness pipe failed"));
		child.stderr.on("error", () => this.#fail("Service diagnostics pipe failed"));
		child.stderr.on("data", (chunk: Buffer) => {
			// Private bounded diagnostics; never publish raw stderr (it can contain credentials).
			const bytes = chunk.subarray(0, MAX_STDERR_BYTES);
			this.#stderr = Buffer.concat([this.#stderr, bytes]).subarray(-MAX_STDERR_BYTES);
		});
		child.once("error", () => finish(new Error("Could not launch the ChudCode service")));
		child.once("exit", () => {
			finish(new Error("Service exited before becoming ready"));
			if (this.#state !== "stopped") this.#fail("ChudCode service exited; use Restart Service");
		});
		child.stdout.on("end", () => {
			if (this.#state !== "stopped") this.#fail("Service readiness pipe closed");
		});
		child.stdout.on("data", (chunk: Buffer) => {
			if (announced || output.byteLength + chunk.byteLength > MAX_STARTUP_BYTES) {
				finish(new Error("Service emitted unexpected startup output"));
				this.#fail("Service emitted unexpected startup output");
				return;
			}
			output = Buffer.concat([output, chunk]);
			const end = output.indexOf(10);
			if (end < 0) return;
			if (end !== output.byteLength - 1) {
				finish(new Error("Service emitted unexpected startup output"));
				return;
			}
			try {
				this.#readiness = parseReadiness(output.subarray(0, end).toString("utf8"));
				announced = true;
				output = Buffer.alloc(0);
				finish();
			} catch (error) {
				finish(error instanceof Error ? error : new Error("Invalid service readiness"));
			}
		});
		await promise;
		if (this.#state !== "starting") throw new Error("Service startup cancelled");
		await this.#connectControl();
		const hello = await this.#sendRequest("runtime.hello", { protocol: 1 });
		if (typeof hello !== "object" || hello === null || !("protocol" in hello) || hello.protocol !== 1)
			throw new Error("Service desktop protocol mismatch");
		if (this.#state !== "starting") throw new Error("Service startup cancelled");
		this.#state = "ready";
	}

	#socket(control = false): ws.WebSocket {
		const readiness = this.#readiness;
		if (!readiness || this.#state === "failed" || this.#state === "stopped")
			throw new Error("Service is not available");
		const url = new URL(readiness.wsUrl);
		if (control) url.searchParams.set("client", "control");
		const socket = new ws.WebSocket(url, {
			headers: { Authorization: `Bearer ${readiness.token}`, Origin: readiness.url },
			maxPayload: MAX_FRAME_BYTES,
			handshakeTimeout: REQUEST_TIMEOUT_MS,
			perMessageDeflate: false,
			followRedirects: false,
		});
		this.#sockets.add(socket);
		socket.once("close", () => this.#sockets.delete(socket));
		return socket;
	}

	#connectControl(): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const socket = this.#socket(true);
		this.#control = socket;
		socket.once("open", resolve);
		socket.on("error", () => {
			reject(new Error("Service connection failed"));
			this.#fail("Service connection failed; use Restart Service");
		});
		socket.on("close", () => {
			reject(new Error("Service connection closed"));
			if (this.#state !== "stopped") this.#fail("Service connection closed; use Restart Service");
		});
		socket.on("message", (data: RawData, binary: boolean) => {
			try {
				const frame: unknown = JSON.parse(frameText(data, binary));
				if (typeof frame !== "object" || frame === null || !("t" in frame) || typeof frame.t !== "string")
					throw new Error("Malformed desktop frame");
				if (frame.t !== "response") return;
				if (!("id" in frame) || typeof frame.id !== "number" || !Number.isSafeInteger(frame.id))
					throw new Error("Malformed desktop response");
				const pending = this.#pending.get(frame.id);
				if (!pending) return;
				if (!("method" in frame) || frame.method !== pending.method)
					throw new Error("Desktop response method mismatch");
				this.#pending.delete(frame.id);
				clearTimeout(pending.timer);
				if ("error" in frame && frame.error !== undefined) {
					if (
						typeof frame.error !== "object" ||
						frame.error === null ||
						!("message" in frame.error) ||
						typeof frame.error.message !== "string"
					) {
						pending.reject(new Error("Malformed desktop error response"));
						throw new Error("Malformed desktop error response");
					}
					pending.reject(new Error(frame.error.message));
				} else pending.resolve("result" in frame ? frame.result : undefined);
			} catch {
				this.#fail("Service sent an invalid desktop frame");
			}
		});
		return promise;
	}

	async request(method: string, params: unknown): Promise<unknown> {
		await this.whenReady();
		return this.#sendRequest(method, params);
	}

	#sendRequest(method: string, params: unknown): Promise<unknown> {
		const socket = this.#control;
		if (!socket || socket.readyState !== ws.WebSocket.OPEN)
			return Promise.reject(new Error("Service is disconnected"));
		if (this.#pending.size >= MAX_PENDING_REQUESTS)
			return Promise.reject(new Error("Too many pending desktop requests"));
		const id = ++this.#sequence;
		let data: string;
		try {
			data = JSON.stringify({ t: "request", id, method, params });
			validateRequest(data);
			if (socket.bufferedAmount + Buffer.byteLength(data) > MAX_FRAME_BYTES)
				throw new Error("Service outbound buffer is full");
		} catch (error) {
			return Promise.reject(error);
		}
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const timer = setTimeout(() => {
			this.#pending.delete(id);
			reject(new Error("Desktop request timed out"));
		}, REQUEST_TIMEOUT_MS);
		this.#pending.set(id, { method, resolve, reject, timer });
		socket.send(data, error => {
			if (!error) return;
			const pending = this.#pending.get(id);
			if (!pending) return;
			this.#pending.delete(id);
			clearTimeout(timer);
			reject(new Error("Desktop request could not be sent"));
		});
		return promise;
	}

	async bridge(listener: BridgeListener): Promise<BridgeSocket> {
		await this.whenReady();
		const socket = this.#socket();
		socket.once("open", () => listener.open());
		socket.on("message", (data: RawData, binary: boolean) => {
			try {
				listener.message(frameText(data, binary));
			} catch {
				listener.error("Invalid service frame");
				socket.terminate();
			}
		});
		socket.on("error", () => listener.error("Service bridge connection failed"));
		socket.once("close", (code: number) => listener.close(code, "Service connection closed"));
		return {
			send(data: string): void {
				validateRequest(data);
				if (socket.readyState !== ws.WebSocket.OPEN) throw new Error("Service bridge is not connected");
				if (socket.bufferedAmount + Buffer.byteLength(data) > MAX_FRAME_BYTES) {
					socket.terminate();
					throw new Error("Service bridge outbound buffer exceeded");
				}
				socket.send(data, error => {
					if (error) listener.error("Service bridge could not send request");
				});
			},
			close(): void {
				socket.terminate();
			},
		};
	}

	#fail(message: string): void {
		if (this.#state === "failed" || this.#state === "stopped") return;
		this.#state = "failed";
		this.#cancelStartup?.(new Error(message));
		this.#options.onFailure(message);
		void this.#teardown();
	}

	stop(): Promise<void> {
		this.#state = "stopped";
		this.#cancelStartup?.(new Error("Service stopped"));
		return this.#teardown();
	}

	#teardown(): Promise<void> {
		if (this.#shutdown) return this.#shutdown;
		for (const socket of this.#sockets) socket.terminate();
		this.#sockets.clear();
		this.#control = undefined;
		this.#readiness = undefined;
		this.#stderr = Buffer.alloc(0);
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Service disconnected"));
		}
		this.#pending.clear();
		const child = this.#child;
		this.#child = undefined;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#shutdown = promise;
		if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) {
			resolve();
			return promise;
		}
		const killTimer = setTimeout(() => {
			child.kill("SIGKILL");
		}, 3_000);
		child.once("exit", () => {
			clearTimeout(killTimer);
			resolve();
		});
		// EOF is the service's graceful shutdown contract; SIGTERM also covers a wedged startup.
		child.stdin.end();
		child.kill("SIGTERM");
		return this.#shutdown;
	}
}
