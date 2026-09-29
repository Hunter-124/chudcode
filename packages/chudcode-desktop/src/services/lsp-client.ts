import type { LspTransport } from "@oh-my-pi/pi-coding-agent/lsp/types";
import { isRecord, ptree } from "@oh-my-pi/pi-utils";
import { MessageFramer } from "../../../coding-agent/src/jsonrpc/message-framing";
import type {
	CodeActionContext,
	JsonRpcMessage,
	JsonRpcNotification,
	JsonRpcRequest,
	JsonRpcResponse,
	LspClientNotification,
	LspDefinitionResult,
	LspDocument,
	LspReferencesResult,
	LspRequestOptions,
	LspServerExitEvent,
	Position,
	PublishDiagnosticsParams,
	Range,
	TextDocumentContentChangeEvent,
	TrustedLspServerSpec,
	WorkspaceEdit,
} from "./lsp-types";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const EXIT_TIMEOUT_MS = 1_000;
const STDERR_LIMIT = 64 * 1024;

const CLIENT_CAPABILITIES = {
	workspace: {
		workspaceFolders: true,
		configuration: true,
	},
	textDocument: {
		synchronization: { dynamicRegistration: false, didSave: true },
		completion: { completionItem: { snippetSupport: true } },
		hover: { contentFormat: ["markdown", "plaintext"] },
		definition: { linkSupport: true },
		references: {},
		documentSymbol: { hierarchicalDocumentSymbolSupport: true },
		codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: [] } } },
		rename: { prepareSupport: true },
		publishDiagnostics: { relatedInformation: true, versionSupport: true },
	},
} as const;

type NotificationHandler = (notification: LspClientNotification) => void | Promise<void>;
type DiagnosticsHandler = (params: PublishDiagnosticsParams) => void | Promise<void>;
type ExitHandler = (event: LspServerExitEvent) => void | Promise<void>;

interface PendingRequest {
	method: string;
	resolve(value: unknown): void;
	reject(error: Error): void;
}

interface OpenDocumentState {
	version: number;
}

export class LspRequestError extends Error {
	constructor(
		readonly method: string,
		readonly code: number,
		message: string,
		readonly data?: unknown,
	) {
		super(`LSP ${method} failed (${code}): ${message}`);
		this.name = "LspRequestError";
	}
}

export class LspConnectionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LspConnectionError";
	}
}

export class LspClient {
	readonly spec: TrustedLspServerSpec;
	readonly rootPath: string;
	readonly rootUri: string;
	readonly #proc: LspTransport;
	readonly #pending = new Map<number | string, PendingRequest>();
	readonly #openDocuments = new Map<string, OpenDocumentState>();
	readonly #notificationHandlers = new Set<NotificationHandler>();
	readonly #diagnosticsHandlers = new Set<DiagnosticsHandler>();
	readonly #exitHandlers = new Set<ExitHandler>();
	#requestId = 0;
	#writeQueue = Promise.resolve();
	#state: "starting" | "ready" | "shutting-down" | "closed" = "starting";
	#expectedExit = false;
	#exitEvent?: LspServerExitEvent;
	#readerDone: Promise<void>;

	private constructor(spec: TrustedLspServerSpec, rootPath: string, rootUri: string, proc: LspTransport) {
		this.spec = spec;
		this.rootPath = rootPath;
		this.rootUri = rootUri;
		this.#proc = proc;
		this.#readerDone = this.#readMessages();
		void proc.exited.then(
			code => this.#handleExit(code),
			() => this.#handleExit(proc.exitCode),
		);
	}

	static async start(
		spec: TrustedLspServerSpec,
		rootPath: string,
		rootUri: string,
		onDiagnostics?: DiagnosticsHandler,
	): Promise<LspClient> {
		const proc = ptree.spawn([spec.command, ...(spec.args ?? [])], {
			cwd: rootPath,
			stdin: "pipe",
			env: spec.env ? { ...process.env, ...spec.env } : undefined,
		}) as LspTransport;
		const client = new LspClient(spec, rootPath, rootUri, proc);
		if (onDiagnostics) client.onDiagnostics(onDiagnostics);
		try {
			await client.#initialize();
			return client;
		} catch (error) {
			client.#expectedExit = true;
			try {
				proc.kill();
			} catch {
				// It may have exited during initialization.
			}
			throw error;
		}
	}

	get state(): "starting" | "ready" | "shutting-down" | "closed" {
		return this.#state;
	}

	#isClosed(): boolean {
		return this.#state === "closed";
	}

	get pid(): number | undefined {
		return this.#proc.pid;
	}

	get stderr(): string {
		return this.#capturedStderr();
	}

	onNotification(handler: NotificationHandler): () => void {
		this.#notificationHandlers.add(handler);
		return () => this.#notificationHandlers.delete(handler);
	}

	onDiagnostics(handler: DiagnosticsHandler): () => void {
		this.#diagnosticsHandlers.add(handler);
		return () => this.#diagnosticsHandlers.delete(handler);
	}

	onExit(handler: ExitHandler): () => void {
		this.#exitHandlers.add(handler);
		if (this.#exitEvent) void runEventHandler(handler, this.#exitEvent);
		return () => this.#exitHandlers.delete(handler);
	}

	async request<T = unknown>(method: string, params: unknown, options: LspRequestOptions = {}): Promise<T> {
		if (this.#state === "closed") {
			throw new LspConnectionError(`LSP server ${this.spec.id} is closed`);
		}
		if (this.#state === "shutting-down" && method !== "shutdown") {
			throw new LspConnectionError(`LSP server ${this.spec.id} is shutting down`);
		}
		if (options.signal?.aborted) throw abortError(options.signal);

		const id = ++this.#requestId;
		const timeoutMs = options.timeoutMs ?? this.spec.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		const message: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
		const result = Promise.withResolvers<unknown>();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let settled = false;

		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			callback();
		};
		const onAbort = () => {
			finish(() => {
				this.#pending.delete(id);
				void this.notify("$/cancelRequest", { id }).catch(() => {});
				result.reject(abortError(options.signal));
			});
		};
		const cleanup = () => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
		};
		this.#pending.set(id, {
			method,
			resolve: value => finish(() => result.resolve(value)),
			reject: error => finish(() => result.reject(error)),
		});
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (timeoutMs > 0) {
			timer = setTimeout(() => {
				finish(() => {
					this.#pending.delete(id);
					void this.notify("$/cancelRequest", { id }).catch(() => {});
					result.reject(new Error(`LSP request ${method} timed out after ${timeoutMs}ms`));
				});
			}, timeoutMs);
		}

		void this.#queueMessage(message).catch(error => {
			this.#pending.delete(id);
			const reason = error instanceof Error ? error : new Error(String(error));
			finish(() => result.reject(reason));
		});
		return result.promise.finally(cleanup) as Promise<T>;
	}

	async notify(method: string, params?: unknown): Promise<void> {
		if (this.#state === "closed") throw new LspConnectionError(`LSP server ${this.spec.id} is closed`);
		const message: JsonRpcNotification = { jsonrpc: "2.0", method };
		if (params !== undefined) message.params = params;
		await this.#queueMessage(message);
	}

	async didOpen(document: LspDocument): Promise<void> {
		if (this.#openDocuments.has(document.uri)) return;
		this.#openDocuments.set(document.uri, { version: 1 });
		try {
			await this.notify("textDocument/didOpen", {
				textDocument: {
					uri: document.uri,
					languageId: document.languageId,
					version: 1,
					text: document.text,
				},
			});
		} catch (error) {
			this.#openDocuments.delete(document.uri);
			throw error;
		}
	}

	async didChange(uri: string, contentChanges: TextDocumentContentChangeEvent[]): Promise<number> {
		const document = this.#openDocuments.get(uri);
		if (!document) throw new Error(`Cannot change unopened LSP document: ${uri}`);
		if (contentChanges.length === 0) return document.version;
		const version = ++document.version;
		await this.notify("textDocument/didChange", {
			textDocument: { uri, version },
			contentChanges,
		});
		return version;
	}

	async didSave(uri: string, text?: string): Promise<void> {
		if (!this.#openDocuments.has(uri)) throw new Error(`Cannot save unopened LSP document: ${uri}`);
		await this.notify("textDocument/didSave", {
			textDocument: { uri },
			...(text === undefined ? {} : { text }),
		});
	}

	async didClose(uri: string): Promise<void> {
		if (!this.#openDocuments.delete(uri)) return;
		await this.notify("textDocument/didClose", { textDocument: { uri } });
	}

	completion(uri: string, position: Position, context?: unknown, options?: LspRequestOptions): Promise<unknown> {
		return this.request("textDocument/completion", { textDocument: { uri }, position, context }, options);
	}

	hover(uri: string, position: Position, options?: LspRequestOptions): Promise<unknown> {
		return this.request("textDocument/hover", { textDocument: { uri }, position }, options);
	}

	definition(uri: string, position: Position, options?: LspRequestOptions): Promise<LspDefinitionResult> {
		return this.request("textDocument/definition", { textDocument: { uri }, position }, options);
	}

	references(
		uri: string,
		position: Position,
		includeDeclaration = true,
		options?: LspRequestOptions,
	): Promise<LspReferencesResult> {
		return this.request(
			"textDocument/references",
			{ textDocument: { uri }, position, context: { includeDeclaration } },
			options,
		);
	}

	documentSymbols(uri: string, options?: LspRequestOptions): Promise<unknown> {
		return this.request("textDocument/documentSymbol", { textDocument: { uri } }, options);
	}

	workspaceSymbols(query: string, options?: LspRequestOptions): Promise<unknown> {
		return this.request("workspace/symbol", { query }, options);
	}

	codeActions(uri: string, range: Range, context: CodeActionContext, options?: LspRequestOptions): Promise<unknown> {
		return this.request("textDocument/codeAction", { textDocument: { uri }, range, context }, options);
	}

	rename(
		uri: string,
		position: Position,
		newName: string,
		options?: LspRequestOptions,
	): Promise<WorkspaceEdit | null> {
		return this.request("textDocument/rename", { textDocument: { uri }, position, newName }, options);
	}

	async shutdown(): Promise<void> {
		if (this.#state === "closed") return;
		if (this.#state === "shutting-down") {
			await Promise.race([this.#readerDone, delay(SHUTDOWN_TIMEOUT_MS)]);
			return;
		}
		this.#state = "shutting-down";
		this.#expectedExit = true;
		try {
			await this.request("shutdown", null, { timeoutMs: SHUTDOWN_TIMEOUT_MS });
			await this.notify("exit");
		} catch {
			// A server may close immediately after replying to shutdown.
		}
		const exited = await Promise.race([
			this.#proc.exited.then(
				() => true,
				() => true,
			),
			delay(EXIT_TIMEOUT_MS, false),
		]);
		if (!exited) {
			try {
				this.#proc.kill();
			} catch {
				// Already exited.
			}
		}
		await Promise.race([this.#readerDone, delay(EXIT_TIMEOUT_MS)]);
	}

	async #initialize(): Promise<void> {
		const result = await this.request<{ capabilities?: Record<string, unknown> }>(
			"initialize",
			{
				processId: process.pid,
				clientInfo: { name: "chudcode", version: "0.1.0" },
				rootUri: this.rootUri,
				rootPath: this.rootPath,
				workspaceFolders: [{ uri: this.rootUri, name: this.rootPath.split(/[\\/]/).at(-1) || "workspace" }],
				capabilities: CLIENT_CAPABILITIES,
				initializationOptions: this.spec.initializationOptions ?? {},
			},
			{ timeoutMs: this.spec.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS },
		);
		if (!result || typeof result !== "object")
			throw new Error(`LSP server ${this.spec.id} returned no initialize result`);
		await this.notify("initialized", {});
		if (this.spec.settings !== undefined) {
			await this.notify("workspace/didChangeConfiguration", { settings: this.spec.settings });
		}
		this.#state = "ready";
	}

	async #readMessages(): Promise<void> {
		const reader = this.#proc.stdout.getReader();
		const framer = new MessageFramer(Buffer.alloc(0));
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				framer.push(Buffer.from(value));
				for (const text of framer.drain(() => {})) {
					let message: JsonRpcMessage;
					try {
						message = JSON.parse(text) as JsonRpcMessage;
					} catch {
						continue;
					}
					await this.#routeMessage(message);
				}
			}
		} catch (error) {
			const reason = error instanceof Error ? error : new Error(String(error));
			if (this.#state !== "closed")
				this.#failPending(new LspConnectionError(`LSP reader failed: ${reason.message}`));
		} finally {
			reader.releaseLock();
			if (!this.#isClosed() && this.#proc.exitCode === null) {
				const exited = await Promise.race([
					this.#proc.exited.then(
						() => true,
						() => true,
					),
					delay(100, false),
				]);
				if (!exited && !this.#isClosed() && this.#proc.exitCode === null) {
					const error = new LspConnectionError(`LSP server ${this.spec.id} closed stdout while still running`);
					this.#failPending(error);
					try {
						this.#proc.kill();
					} catch {
						// Process exited between the state check and kill.
					}
				}
			}
		}
	}

	async #routeMessage(message: JsonRpcMessage): Promise<void> {
		if ("method" in message) {
			if ("id" in message) await this.#handleServerRequest(message as JsonRpcRequest);
			else await this.#handleNotification(message as JsonRpcNotification);
			return;
		}
		if (!("id" in message)) return;
		const response = message as JsonRpcResponse;
		const pending = this.#pending.get(response.id);
		if (!pending) return;
		this.#pending.delete(response.id);
		if (response.error) {
			pending.reject(
				new LspRequestError(pending.method, response.error.code, response.error.message, response.error.data),
			);
		} else {
			pending.resolve(response.result);
		}
	}

	async #handleNotification(message: JsonRpcNotification): Promise<void> {
		if (message.method === "textDocument/publishDiagnostics" && isDiagnostics(message.params)) {
			for (const handler of this.#diagnosticsHandlers) await runEventHandler(handler, message.params);
		}
		const notification = { method: message.method, params: message.params };
		for (const handler of this.#notificationHandlers) await runEventHandler(handler, notification);
	}

	async #handleServerRequest(message: JsonRpcRequest): Promise<void> {
		let result: unknown;
		let error: JsonRpcResponse["error"];
		switch (message.method) {
			case "workspace/workspaceFolders":
				result = [{ uri: this.rootUri, name: this.rootPath.split(/[\\/]/).at(-1) || "workspace" }];
				break;
			case "workspace/configuration": {
				const items = isRecord(message.params) && Array.isArray(message.params.items) ? message.params.items : [];
				result = items.map(() => this.spec.settings ?? null);
				break;
			}
			case "client/registerCapability":
			case "client/unregisterCapability":
			case "window/workDoneProgress/create":
				result = null;
				break;
			default:
				error = { code: -32601, message: `Unsupported server request: ${message.method}` };
		}
		await this.#queueMessage({ jsonrpc: "2.0", id: message.id, ...(error ? { error } : { result }) });
	}

	#queueMessage(message: JsonRpcMessage): Promise<void> {
		const write = this.#writeQueue.catch(() => {}).then(() => this.#writeMessage(message));
		this.#writeQueue = write.catch(() => {});
		return write;
	}

	async #writeMessage(message: JsonRpcMessage): Promise<void> {
		if (this.#state === "closed" || this.#proc.exitCode !== null) {
			throw new LspConnectionError(this.#exitMessage(this.#proc.exitCode));
		}
		const json = JSON.stringify(message);
		const frame = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
		await this.#proc.stdin.write(frame);
		await this.#proc.stdin.flush();
	}

	#handleExit(code: number | null): void {
		if (this.#exitEvent) return;
		this.#state = "closed";
		const event: LspServerExitEvent = {
			code,
			expected: this.#expectedExit,
			stderr: this.#capturedStderr(),
		};
		this.#exitEvent = event;
		this.#failPending(new LspConnectionError(this.#exitMessage(code)));
		for (const handler of this.#exitHandlers) void runEventHandler(handler, event);
	}

	#failPending(error: Error): void {
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
	}

	#capturedStderr(): string {
		const stderr = this.#proc.peekStderr();
		return stderr.length <= STDERR_LIMIT ? stderr : stderr.slice(-STDERR_LIMIT);
	}

	#exitMessage(code: number | null): string {
		const stderr = this.#capturedStderr().trim();
		return stderr
			? `LSP server ${this.spec.id} exited with code ${String(code)}: ${stderr}`
			: `LSP server ${this.spec.id} exited with code ${String(code)}`;
	}
}

function abortError(signal?: AbortSignal): Error {
	if (signal?.reason instanceof Error) return signal.reason;
	const error = new Error("LSP request cancelled");
	error.name = "AbortError";
	return error;
}

function isDiagnostics(value: unknown): value is PublishDiagnosticsParams {
	return isRecord(value) && typeof value.uri === "string" && Array.isArray(value.diagnostics);
}

async function runEventHandler<T>(handler: (value: T) => void | Promise<void>, value: T): Promise<void> {
	try {
		await handler(value);
	} catch {
		// A UI/event consumer must not tear down the protocol reader.
	}
}

function delay(ms: number): Promise<void>;
function delay<T>(ms: number, value: T): Promise<T>;
function delay<T>(ms: number, value?: T): Promise<T | void> {
	const deferred = Promise.withResolvers<T | void>();
	setTimeout(deferred.resolve, ms, value);
	return deferred.promise;
}
