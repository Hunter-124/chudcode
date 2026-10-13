import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, getProjectDir, isEexist, isEnoent } from "@oh-my-pi/pi-utils";
import type { DesktopFrame, DesktopRequest } from "./protocol";
import { createDesktopRuntime, type DesktopClientCapabilities, type DesktopFrameSink } from "./runtime";

const DEFAULT_MAX_OUTBOUND_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_OUTBOUND_FRAMES = 1_024;
const MAX_INBOUND_BYTES = 1024 * 1024;
const AUTH_COOKIE = "chudcode_desktop";
const PID_FILE = "desktop.pid";
const SESSION_PATH_METHODS: Record<string, true> = {
	"prompt.send": true,
	"run.abort": true,
	"ui.respond": true,
	"agent.command": true,
	"agent.transcript": true,
};

interface SocketLike {
	readonly bufferedAmount?: number;
	send(data: string): number | boolean | void;
	close(code?: number, reason?: string): void;
}

interface DesktopSocketData {
	connection?: DesktopConnection;
	capabilities?: DesktopClientCapabilities;
}

interface DesktopLease {
	path: string;
	instanceId: string;
}

export interface DesktopRuntimeHost {
	attach(client: DesktopFrameSink, capabilities?: DesktopClientCapabilities): void;
	detach(client: DesktopFrameSink): void;
	handleRequest(request: DesktopRequest): Promise<DesktopFrame>;
	dispose(): Promise<void>;
}

export interface OrderedSocketQueueOptions {
	maxBytes?: number;
	maxFrames?: number;
}

/** FIFO JSON frame queue with an application-level bound above Bun's socket buffer. */
export class OrderedSocketQueue implements DesktopFrameSink {
	readonly #socket: SocketLike;
	readonly #maxBytes: number;
	readonly #maxFrames: number;
	readonly #queue: Array<{ json: string; bytes: number }> = [];
	#queuedBytes = 0;
	#draining = false;
	#closed = false;

	constructor(socket: SocketLike, options: OrderedSocketQueueOptions = {}) {
		this.#socket = socket;
		this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_OUTBOUND_BYTES;
		this.#maxFrames = options.maxFrames ?? DEFAULT_MAX_OUTBOUND_FRAMES;
	}

	send(frame: DesktopFrame): boolean {
		if (this.#closed) return false;
		let json: string;
		try {
			const encoded = JSON.stringify(frame);
			if (encoded === undefined) throw new Error("Frame serialized to undefined");
			json = encoded;
		} catch {
			this.#closed = true;
			try {
				this.#socket.send(
					'{"t":"error","code":"SERIALIZATION_FAILED","message":"An outbound frame could not be serialized"}',
				);
			} finally {
				this.#socket.close(1011, "outbound frame serialization failed");
			}
			return false;
		}
		const bytes = Buffer.byteLength(json);
		const buffered = this.#socket.bufferedAmount ?? 0;
		if (
			bytes > this.#maxBytes ||
			this.#queue.length + 1 > this.#maxFrames ||
			this.#queuedBytes + buffered + bytes > this.#maxBytes
		) {
			this.#disconnectSlowClient();
			return false;
		}
		this.#queue.push({ json, bytes });
		this.#queuedBytes += bytes;
		this.#drain();
		return true;
	}

	drain(): void {
		this.#drain();
	}

	close(code = 1000, reason = "closed"): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#queue.length = 0;
		this.#queuedBytes = 0;
		this.#socket.close(code, reason);
	}

	#drain(): void {
		if (this.#closed || this.#draining) return;
		this.#draining = true;
		try {
			while (this.#queue.length > 0) {
				const next = this.#queue[0];
				if (!next) break;
				let result: number | boolean | void;
				try {
					result = this.#socket.send(next.json);
				} catch {
					this.close(1011, "socket send failed");
					break;
				}
				if (result === false || (typeof result === "number" && result <= 0)) break;
				this.#queue.shift();
				this.#queuedBytes -= next.bytes;
			}
		} finally {
			this.#draining = false;
		}
	}

	#disconnectSlowClient(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#queue.length = 0;
		this.#queuedBytes = 0;
		const error = JSON.stringify({
			t: "error",
			code: "SLOW_CLIENT",
			message: "Outbound queue limit exceeded; reconnect to request a fresh snapshot",
		});
		try {
			this.#socket.send(error);
		} finally {
			this.#socket.close(1013, "SLOW_CLIENT: outbound queue limit exceeded");
		}
	}
}

class DesktopConnection implements DesktopFrameSink {
	readonly #runtime: DesktopRuntimeHost;
	readonly #queue: OrderedSocketQueue;
	#inboundTail: Promise<void> = Promise.resolve();

	constructor(runtime: DesktopRuntimeHost, socket: SocketLike, options: OrderedSocketQueueOptions) {
		this.#runtime = runtime;
		this.#queue = new OrderedSocketQueue(socket, options);
	}

	send(frame: DesktopFrame): boolean {
		return this.#queue.send(frame);
	}

	drain(): void {
		this.#queue.drain();
	}

	receive(data: string | Uint8Array): void {
		const owned = typeof data === "string" ? data : Buffer.from(data);
		this.#inboundTail = this.#inboundTail
			.then(() => this.#receiveOne(owned))
			.catch(() => this.close(1011, "request handling failed"));
	}

	async #receiveOne(data: string | Uint8Array): Promise<void> {
		const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
		if (bytes > MAX_INBOUND_BYTES) {
			this.close(1009, "request frame too large");
			return;
		}
		let decoded: unknown;
		try {
			const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
			decoded = JSON.parse(text);
		} catch {
			this.send({ t: "error", code: "INVALID_JSON", message: "Request frame is not valid JSON" });
			return;
		}
		if (!isDesktopRequest(decoded)) {
			this.send({ t: "error", code: "INVALID_REQUEST", message: "Expected a desktop request frame" });
			return;
		}
		this.send(await this.#runtime.handleRequest(decoded));
	}

	close(code?: number, reason?: string): void {
		this.#queue.close(code, reason);
	}

	detach(): void {
		this.#runtime.detach(this);
	}
}

export interface DesktopServerOptions {
	cwd?: string;
	port?: number;
	token?: string;
	webDist?: string;
	/** Serve only the authenticated WebSocket transport, without resolving browser assets. */
	websocketOnly?: boolean;
	runtime?: DesktopRuntimeHost;
	runtimeDir?: string;
	singleInstance?: boolean;
	maxOutboundBytes?: number;
	maxOutboundFrames?: number;
}

export interface DesktopServerHandle {
	readonly hostname: "127.0.0.1";
	readonly port: number;
	readonly token: string;
	readonly url: string;
	readonly bootstrapUrl: string;
	stop(): Promise<void>;
}

export class DesktopAlreadyRunningError extends Error {
	constructor() {
		super("A Chudcode desktop process is already running");
		this.name = "DesktopAlreadyRunningError";
	}
}

export async function startDesktopServer(options: DesktopServerOptions = {}): Promise<DesktopServerHandle> {
	const cwd = path.resolve(options.cwd ?? getProjectDir());
	const runtimeDir = options.runtimeDir ?? path.join(getAgentDir(), "run", "chudcode-desktop");
	const lease = options.singleInstance === false ? undefined : await acquireDesktopLease(runtimeDir);
	if (options.singleInstance !== false && !lease) throw new DesktopAlreadyRunningError();

	let runtime: DesktopRuntimeHost | undefined = options.runtime;
	let server: Bun.Server<DesktopSocketData> | undefined;
	let stopped = false;
	try {
		runtime ??= await createDesktopRuntime({ cwd });
		const webDist = options.websocketOnly ? undefined : await resolveWebDist(options.webDist);
		const token = options.token ?? randomBytes(32).toString("base64url");
		if (Buffer.from(token).byteLength < 32) throw new Error("Desktop bearer token must contain at least 256 bits");
		const configuredPort = options.port ?? readConfiguredPort();
		if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65_535) {
			throw new Error("Desktop port must be an integer from 0 through 65535");
		}
		const queueOptions: OrderedSocketQueueOptions = {
			maxBytes: options.maxOutboundBytes,
			maxFrames: options.maxOutboundFrames,
		};

		server = Bun.serve<DesktopSocketData>({
			hostname: "127.0.0.1",
			port: configuredPort,
			fetch: async (request, bunServer) => {
				const requestPort = bunServer.port;
				if (requestPort === undefined) throw new Error("Desktop server has no bound TCP port");
				const rejected = rejectUntrustedRequest(request, requestPort);
				if (rejected) return rejected;
				const url = new URL(request.url);
				if (!requestHasToken(request, url, token)) return unauthorized();

				if (url.pathname === "/ws") {
					if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
						return new Response("Not Found", { status: 404 });
					}
					const upgraded = bunServer.upgrade(request, {
						data: { capabilities: { presentsUi: url.searchParams.get("client") !== "control" } },
					});
					return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
				}
				if (webDist === undefined) return new Response("Not Found", { status: 404 });

				if (request.method !== "GET" && request.method !== "HEAD") {
					return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
				}
				if (url.pathname === "/" && url.searchParams.has("token")) {
					return new Response(null, {
						status: 302,
						headers: {
							Location: "/",
							"Set-Cookie": `${AUTH_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`,
							"Cache-Control": "no-store",
							"Referrer-Policy": "no-referrer",
						},
					});
				}
				return await serveStatic(request, url, webDist);
			},
			websocket: {
				maxPayloadLength: MAX_INBOUND_BYTES,
				backpressureLimit: options.maxOutboundBytes ?? DEFAULT_MAX_OUTBOUND_BYTES,
				closeOnBackpressureLimit: false,
				open(socket) {
					if (!runtime) {
						socket.close(1012, "runtime unavailable");
						return;
					}
					const connection = new DesktopConnection(runtime, socket, queueOptions);
					socket.data.connection = connection;
					runtime.attach(connection, socket.data.capabilities);
				},
				message(socket, message) {
					void socket.data.connection?.receive(message);
				},
				drain(socket) {
					socket.data.connection?.drain();
				},
				close(socket) {
					socket.data.connection?.detach();
					socket.data.connection = undefined;
				},
			},
		});

		const hostname = "127.0.0.1" as const;
		const port = server.port;
		if (port === undefined) throw new Error("Desktop server did not bind a TCP port");
		const url = `http://${hostname}:${port}`;
		const ownedRuntime = runtime;
		const ownedServer = server;
		return {
			hostname,
			port,
			token,
			url,
			bootstrapUrl: `${url}/?token=${encodeURIComponent(token)}`,
			async stop() {
				if (stopped) return;
				stopped = true;
				try {
					await ownedRuntime.dispose();
				} finally {
					await ownedServer.stop(true);
					if (lease) await releaseDesktopLease(lease);
				}
			},
		};
	} catch (error) {
		if (server) await server.stop(true);
		await runtime?.dispose().catch(() => undefined);
		if (lease) await releaseDesktopLease(lease);
		throw error;
	}
}

export function rejectUntrustedRequest(request: Request, port: number): Response | undefined {
	const host = request.headers.get("host");
	if (!host || !isLoopbackAuthority(host, port)) return new Response("Misdirected Request", { status: 421 });
	const origin = request.headers.get("origin");
	if (origin && !isLoopbackOrigin(origin, port)) return new Response("Forbidden", { status: 403 });
	return undefined;
}

export function requestHasToken(request: Request, url: URL, token: string): boolean {
	const authorization = request.headers.get("authorization");
	if (authorization?.startsWith("Bearer ") && secureTokenEqual(authorization.slice(7), token)) return true;
	const queryToken = url.searchParams.get("token");
	if (queryToken && secureTokenEqual(queryToken, token)) return true;
	const cookie = request.headers.get("cookie");
	if (!cookie) return false;
	for (const part of cookie.split(";")) {
		const [name, ...valueParts] = part.trim().split("=");
		if (name === AUTH_COOKIE && secureTokenEqual(valueParts.join("="), token)) return true;
	}
	return false;
}

function isDesktopRequest(value: unknown): value is DesktopRequest {
	if (
		typeof value !== "object" ||
		value === null ||
		!("t" in value) ||
		value.t !== "request" ||
		!("id" in value) ||
		typeof value.id !== "number" ||
		!Number.isSafeInteger(value.id) ||
		!("method" in value) ||
		typeof value.method !== "string" ||
		!("params" in value) ||
		typeof value.params !== "object" ||
		value.params === null
	) {
		return false;
	}
	if (!SESSION_PATH_METHODS[value.method]) return true;
	return (
		"sessionPath" in value.params &&
		typeof value.params.sessionPath === "string" &&
		value.params.sessionPath.length > 0
	);
}

function isLoopbackAuthority(authority: string, port: number): boolean {
	try {
		const parsed = new URL(`http://${authority}`);
		const hostPort = parsed.port ? Number(parsed.port) : 80;
		return (
			hostPort === port &&
			(parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]")
		);
	} catch {
		return false;
	}
}

function isLoopbackOrigin(origin: string, port: number): boolean {
	try {
		const parsed = new URL(origin);
		const originPort = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
		return (
			parsed.protocol === "http:" &&
			originPort === port &&
			(parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]")
		);
	} catch {
		return false;
	}
}

function secureTokenEqual(provided: string, expected: string): boolean {
	const providedBytes = Buffer.from(provided);
	const expectedBytes = Buffer.from(expected);
	return providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes);
}

function unauthorized(): Response {
	return new Response("Unauthorized", {
		status: 401,
		headers: {
			"WWW-Authenticate": "Bearer",
			"Cache-Control": "no-store",
		},
	});
}

async function serveStatic(request: Request, url: URL, webDist: string): Promise<Response> {
	let decoded: string;
	try {
		decoded = decodeURIComponent(url.pathname);
	} catch {
		return new Response("Bad Request", { status: 400 });
	}
	if (decoded.includes("\0") || decoded.includes("\\")) return new Response("Not Found", { status: 404 });
	const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
	if (!relative || relative.split("/").includes("..")) return new Response("Not Found", { status: 404 });
	const candidate = path.resolve(webDist, relative);
	if (!isWithin(webDist, candidate)) return new Response("Not Found", { status: 404 });
	let realFile: string;
	try {
		realFile = await fs.realpath(candidate);
		if (!isWithin(webDist, realFile)) return new Response("Not Found", { status: 404 });
		const stat = await fs.stat(realFile);
		if (!stat.isFile()) return new Response("Not Found", { status: 404 });
	} catch (error) {
		if (isEnoent(error)) return new Response("Not Found", { status: 404 });
		return new Response("Not Found", { status: 404 });
	}
	const file = Bun.file(realFile);
	const headers = new Headers({
		"Content-Type": file.type || "application/octet-stream",
		"Content-Length": String(file.size),
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy": "no-referrer",
		"Cross-Origin-Opener-Policy": "same-origin",
		"Cross-Origin-Resource-Policy": "same-origin",
	});
	if (relative === "index.html") {
		headers.set("Cache-Control", "no-store");
		headers.set(
			"Content-Security-Policy",
			"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
		);
	} else {
		headers.set("Cache-Control", "public, max-age=31536000, immutable");
	}
	return new Response(request.method === "HEAD" ? null : file, { status: 200, headers });
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveWebDist(configured?: string): Promise<string> {
	const candidates = configured
		? [path.resolve(configured)]
		: [path.resolve(import.meta.dir, "../web"), path.resolve(import.meta.dir, "../dist/web")];
	for (const candidate of candidates) {
		try {
			const real = await fs.realpath(candidate);
			const stat = await fs.stat(real);
			if (stat.isDirectory()) return real;
		} catch {
			// Try the source-tree and bundled layouts; never fall back to serving source.
		}
	}
	throw new Error("Desktop web distribution is unavailable");
}

function readConfiguredPort(): number {
	const raw = process.env.CHUDCODE_DESKTOP_PORT;
	if (!raw) return 0;
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 0 || port > 65_535)
		throw new Error("CHUDCODE_DESKTOP_PORT must be an integer from 0 through 65535");
	return port;
}

async function acquireDesktopLease(runtimeDir: string): Promise<DesktopLease | undefined> {
	await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
	const pidPath = path.join(runtimeDir, PID_FILE);
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const handle = await fs.open(pidPath, "wx", 0o600);
			const instanceId = randomUUID();
			try {
				await handle.writeFile(JSON.stringify({ pid: process.pid, instanceId }), "utf8");
			} finally {
				await handle.close();
			}
			return { path: pidPath, instanceId };
		} catch (error) {
			if (!isEexist(error)) throw error;
			try {
				const raw: unknown = await Bun.file(pidPath).json();
				if (typeof raw === "object" && raw !== null && "pid" in raw && typeof raw.pid === "number") {
					try {
						process.kill(raw.pid, 0);
						return undefined;
					} catch {
						// Dead owner: remove its stale lease and retry the exclusive create.
					}
				}
			} catch {
				// Malformed or partial pid files are stale.
			}
			await fs.rm(pidPath, { force: true });
		}
	}
	return undefined;
}

async function releaseDesktopLease(lease: DesktopLease): Promise<void> {
	try {
		const raw: unknown = await Bun.file(lease.path).json();
		if (typeof raw === "object" && raw !== null && "instanceId" in raw && raw.instanceId === lease.instanceId) {
			await fs.rm(lease.path, { force: true });
		}
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}

async function main(): Promise<void> {
	const { promise: interrupted, resolve } = Promise.withResolvers<void>();
	const shutdown = (): void => resolve();
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
	let handle: DesktopServerHandle | undefined;
	try {
		handle = await startDesktopServer();
		process.stdout.write(`${handle.bootstrapUrl}\n`);
		await interrupted;
	} finally {
		try {
			await handle?.stop();
		} finally {
			process.removeListener("SIGINT", shutdown);
			process.removeListener("SIGTERM", shutdown);
		}
	}
}

// The server is also synchronously required by the compiled workbench host.
// Its standalone lifetime must not mark the imported module graph as async.
if (import.meta.main) {
	main().then(
		() => process.exit(0),
		error => {
			console.error(`Chudcode desktop server failed: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		},
	);
}
