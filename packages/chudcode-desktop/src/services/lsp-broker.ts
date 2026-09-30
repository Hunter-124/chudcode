import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { LspClient } from "./lsp-client";
import type {
	CodeActionContext,
	DesktopLspDiagnostic,
	DesktopLspRequestParams,
	Diagnostic,
	LspBrokerDiagnosticsEvent,
	LspBrokerRequest,
	LspDocument,
	LspRequestOptions,
	LspRestartPolicy,
	LspWorkspaceSpec,
	Position,
	PublishDiagnosticsParams,
	Range,
	TextDocumentContentChangeEvent,
	TrustedLspServerSpec,
} from "./lsp-types";

const DEFAULT_RESTART_POLICY: LspRestartPolicy = {
	maxRestarts: 3,
	windowMs: 60_000,
	backoffMs: 100,
	maxBackoffMs: 2_000,
};

interface ServerState {
	spec: TrustedLspServerSpec;
	client?: LspClient;
	start?: Promise<LspClient>;
	crashes: number[];
	documents: Map<string, LspDocument>;
}

interface WorkspaceState {
	workspace: LspWorkspaceSpec;
	rootUri: string;
	servers: ServerState[];
	closing: boolean;
}

export interface LspBrokerOptions {
	/** The only command source: trusted local host settings, never a wire request. */
	loadServerSpecs(
		workspace: LspWorkspaceSpec,
	): readonly TrustedLspServerSpec[] | Promise<readonly TrustedLspServerSpec[]>;
	onDiagnostics?(event: LspBrokerDiagnosticsEvent): void | Promise<void>;
}

export class LspBroker {
	readonly #options: LspBrokerOptions;
	readonly #workspaces = new Map<string, WorkspaceState>();

	constructor(options: LspBrokerOptions) {
		this.#options = options;
	}

	async openWorkspace(id: string, rootPath: string): Promise<LspWorkspaceSpec> {
		if (this.#workspaces.has(id)) throw new Error(`LSP workspace already open: ${id}`);
		const canonicalRoot = await canonicalizeWorkspaceRoot(rootPath);
		const workspace = { id, rootPath: canonicalRoot };
		const specs = await this.#options.loadServerSpecs(workspace);
		const seen = new Set<string>();
		const servers = specs.map(source => {
			const spec: TrustedLspServerSpec = {
				...source,
				args: source.args ? [...source.args] : undefined,
				languages: source.languages.map(selector => ({ ...selector, extensions: [...selector.extensions] })),
				env: source.env ? { ...source.env } : undefined,
				restart: source.restart ? { ...source.restart } : undefined,
			};
			validateTrustedSpec(spec);
			if (seen.has(spec.id)) throw new Error(`Duplicate LSP server id for workspace ${id}: ${spec.id}`);
			seen.add(spec.id);
			return { spec, crashes: [], documents: new Map<string, LspDocument>() };
		});
		this.#workspaces.set(id, {
			workspace,
			rootUri: pathToFileURL(canonicalRoot).href,
			servers,
			closing: false,
		});
		return workspace;
	}

	async closeWorkspace(id: string): Promise<void> {
		const state = this.#workspaces.get(id);
		if (!state) return;
		state.closing = true;
		this.#workspaces.delete(id);
		await Promise.all(
			state.servers.map(async server => {
				let client = server.client;
				if (!client && server.start) {
					try {
						client = await server.start;
					} catch {
						return;
					}
				}
				await client?.shutdown();
			}),
		);
	}

	async shutdown(): Promise<void> {
		await Promise.all(Array.from(this.#workspaces.keys(), id => this.closeWorkspace(id)));
	}

	async openDocument(workspaceId: string, document: LspDocument): Promise<string> {
		const state = this.#workspace(workspaceId);
		const uri = await canonicalizeDocumentUri(document.uri, state.workspace.rootPath);
		const canonicalDocument = { ...document, uri };
		const servers = this.#matchingServers(state, canonicalDocument.languageId, uri);
		if (servers.length === 0) {
			throw new Error(`No trusted LSP server configured for ${canonicalDocument.languageId}: ${uri}`);
		}
		for (const server of servers) server.documents.set(uri, canonicalDocument);
		await Promise.all(servers.map(async server => (await this.#client(state, server)).didOpen(canonicalDocument)));
		return uri;
	}

	async changeDocument(
		workspaceId: string,
		documentUri: string,
		contentChanges: TextDocumentContentChangeEvent[],
	): Promise<void> {
		const state = this.#workspace(workspaceId);
		const uri = await canonicalizeDocumentUri(documentUri, state.workspace.rootPath);
		const servers = state.servers.filter(server => server.documents.has(uri));
		if (servers.length === 0) throw new Error(`LSP document is not open: ${uri}`);
		const clients = await Promise.all(servers.map(server => this.#client(state, server)));
		for (const server of servers) {
			const document = server.documents.get(uri);
			if (!document) continue;
			server.documents.set(uri, { ...document, text: applyContentChanges(document.text, contentChanges) });
		}
		await Promise.all(clients.map(client => client.didChange(uri, contentChanges)));
	}

	async saveDocument(workspaceId: string, documentUri: string, includeText = false): Promise<void> {
		const state = this.#workspace(workspaceId);
		const uri = await canonicalizeDocumentUri(documentUri, state.workspace.rootPath);
		const servers = state.servers.filter(server => server.documents.has(uri));
		if (servers.length === 0) throw new Error(`LSP document is not open: ${uri}`);
		await Promise.all(
			servers.map(async server => {
				const text = includeText ? server.documents.get(uri)?.text : undefined;
				await (await this.#client(state, server)).didSave(uri, text);
			}),
		);
	}

	async closeDocument(workspaceId: string, documentUri: string): Promise<void> {
		const state = this.#workspace(workspaceId);
		const uri = await canonicalizeDocumentUri(documentUri, state.workspace.rootPath);
		const servers = state.servers.filter(server => server.documents.delete(uri));
		await Promise.all(
			servers.map(async server => {
				const client = server.client;
				if (client?.state === "ready") await client.didClose(uri);
			}),
		);
	}

	async request(workspaceId: string, request: LspBrokerRequest, options: LspRequestOptions = {}): Promise<unknown> {
		const state = this.#workspace(workspaceId);
		if (request.method === "workspaceSymbols") {
			const server = state.servers[0];
			if (!server) throw new Error(`No trusted LSP server configured for workspace ${workspaceId}`);
			return (await this.#client(state, server)).workspaceSymbols(request.query, options);
		}

		const uri = await canonicalizeDocumentUri(request.uri, state.workspace.rootPath);
		const server = state.servers.find(candidate => candidate.documents.has(uri));
		if (!server) throw new Error(`No LSP server has the document open: ${uri}`);
		const client = await this.#client(state, server);
		switch (request.method) {
			case "completion":
				return client.completion(uri, request.position, request.context, options);
			case "hover":
				return client.hover(uri, request.position, options);
			case "definition":
				return client.definition(uri, request.position, options);
			case "references":
				return client.references(uri, request.position, request.includeDeclaration, options);
			case "documentSymbols":
				return client.documentSymbols(uri, options);
			case "codeActions":
				return client.codeActions(uri, request.range, request.context, options);
			case "rename":
				return client.rename(uri, request.position, request.newName, options);
		}
	}
	/** Validate and adapt the desktop protocol's column-based request into standard LSP params. */
	async requestFromProtocol(params: DesktopLspRequestParams, options: LspRequestOptions = {}): Promise<unknown> {
		switch (params.method) {
			case "workspace/symbol":
				return this.request(params.workspaceId, { method: "workspaceSymbols", query: params.query ?? "" }, options);
			case "textDocument/documentSymbol":
				if (!params.uri) throw new Error("textDocument/documentSymbol requires uri");
				return this.request(params.workspaceId, { method: "documentSymbols", uri: params.uri }, options);
			case "textDocument/completion":
				if (!params.uri || !params.position) throw new Error("textDocument/completion requires uri and position");
				return this.request(
					params.workspaceId,
					{ method: "completion", uri: params.uri, position: protocolPosition(params.position) },
					options,
				);
			case "textDocument/hover":
				if (!params.uri || !params.position) throw new Error("textDocument/hover requires uri and position");
				return this.request(
					params.workspaceId,
					{ method: "hover", uri: params.uri, position: protocolPosition(params.position) },
					options,
				);
			case "textDocument/definition":
				if (!params.uri || !params.position) throw new Error("textDocument/definition requires uri and position");
				return this.request(
					params.workspaceId,
					{ method: "definition", uri: params.uri, position: protocolPosition(params.position) },
					options,
				);
			case "textDocument/references":
				if (!params.uri || !params.position) throw new Error("textDocument/references requires uri and position");
				return this.request(
					params.workspaceId,
					{
						method: "references",
						uri: params.uri,
						position: protocolPosition(params.position),
						includeDeclaration: params.includeDeclaration,
					},
					options,
				);
			case "textDocument/codeAction": {
				if (!params.uri || !params.range || !params.context) {
					throw new Error("textDocument/codeAction requires uri, range, and context");
				}
				const context: CodeActionContext = {
					diagnostics: params.context.diagnostics.map(protocolDiagnostic),
					only: params.context.only,
				};
				return this.request(
					params.workspaceId,
					{ method: "codeActions", uri: params.uri, range: protocolRange(params.range), context },
					options,
				);
			}
			case "textDocument/rename":
				if (!params.uri || !params.position || params.newName === undefined) {
					throw new Error("textDocument/rename requires uri, position, and newName");
				}
				return this.request(
					params.workspaceId,
					{
						method: "rename",
						uri: params.uri,
						position: protocolPosition(params.position),
						newName: params.newName,
					},
					options,
				);
			default:
				throw new Error(`Unsupported desktop LSP method: ${params.method}`);
		}
	}

	async #client(state: WorkspaceState, server: ServerState): Promise<LspClient> {
		if (state.closing) throw new Error(`LSP workspace is closing: ${state.workspace.id}`);
		if (server.client?.state === "ready") return server.client;
		if (server.start) return server.start;

		const now = Date.now();
		const policy = restartPolicy(server.spec);
		server.crashes = server.crashes.filter(at => now - at <= policy.windowMs);
		if (server.crashes.length > policy.maxRestarts) {
			throw new Error(
				`LSP server ${server.spec.id} exceeded ${policy.maxRestarts} restarts in ${policy.windowMs}ms`,
			);
		}

		const start = (async () => {
			let initialized = false;
			try {
				if (server.crashes.length > 0 && policy.backoffMs > 0) {
					const maxBackoff = policy.maxBackoffMs ?? DEFAULT_RESTART_POLICY.maxBackoffMs ?? policy.backoffMs;
					const backoff = Math.min(policy.backoffMs * 2 ** (server.crashes.length - 1), maxBackoff);
					const gate = Promise.withResolvers<void>();
					setTimeout(gate.resolve, backoff);
					await gate.promise;
				}
				if (state.closing) throw new Error(`LSP workspace is closing: ${state.workspace.id}`);
				const client = await LspClient.start(server.spec, state.workspace.rootPath, state.rootUri, params =>
					this.#publishDiagnostics(state, server, params),
				);
				initialized = true;
				server.client = client;
				client.onExit(event => {
					if (server.client === client) server.client = undefined;
					if (!event.expected && !state.closing) this.#recordCrash(server);
				});
				for (const document of server.documents.values()) await client.didOpen(document);
				return client;
			} catch (error) {
				if (!initialized && !state.closing) this.#recordCrash(server);
				throw error;
			} finally {
				server.start = undefined;
			}
		})();
		server.start = start;
		return start;
	}

	async #publishDiagnostics(
		state: WorkspaceState,
		server: ServerState,
		params: PublishDiagnosticsParams,
	): Promise<void> {
		if (!this.#options.onDiagnostics || state.closing) return;
		let uri: string;
		try {
			uri = await canonicalizeDocumentUri(params.uri, state.workspace.rootPath);
		} catch {
			return;
		}
		await this.#options.onDiagnostics({
			workspaceId: state.workspace.id,
			serverId: server.spec.id,
			params: { ...params, uri },
		});
	}

	#matchingServers(state: WorkspaceState, languageId: string, uri: string): ServerState[] {
		const extension = path.extname(fileURLToPath(uri)).toLowerCase();
		return state.servers.filter(server =>
			server.spec.languages.some(selector => {
				if (selector.languageId === languageId) return true;
				return selector.extensions.some(value => normalizeExtension(value) === extension);
			}),
		);
	}

	#workspace(id: string): WorkspaceState {
		const state = this.#workspaces.get(id);
		if (!state) throw new Error(`Unknown LSP workspace: ${id}`);
		return state;
	}

	#recordCrash(server: ServerState): void {
		server.crashes.push(Date.now());
	}
}

export async function canonicalizeWorkspaceRoot(rootPath: string): Promise<string> {
	if (!rootPath) throw new Error("LSP workspace root is required");
	if (rootPath.startsWith("file:")) {
		rootPath = fileURLToPath(rootPath);
	} else if (!path.isAbsolute(rootPath) && /^[a-z][a-z\d+.-]*:/i.test(rootPath)) {
		throw new Error(`Unsupported LSP workspace URI scheme: ${rootPath}`);
	}
	const canonical = await canonicalizePath(rootPath);
	const stat = await fs.stat(canonical);
	if (!stat.isDirectory()) throw new Error(`LSP workspace root is not a directory: ${rootPath}`);
	return canonical;
}

export async function canonicalizeDocumentUri(document: string, canonicalRoot: string): Promise<string> {
	if (!document) throw new Error("LSP document path or URI is required");
	let filePath: string;
	if (document.startsWith("file:")) {
		filePath = fileURLToPath(document);
	} else if (path.isAbsolute(document)) {
		filePath = document;
	} else if (/^[a-z][a-z\d+.-]*:/i.test(document)) {
		throw new Error(`Unsupported LSP document URI scheme: ${document}`);
	} else {
		filePath = path.resolve(canonicalRoot, document);
	}
	const canonical = await canonicalizePath(filePath);
	const relative = path.relative(canonicalRoot, canonical);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`LSP document is outside workspace root: ${document}`);
	}
	return pathToFileURL(canonical).href;
}
export function toDesktopDiagnostics(params: PublishDiagnosticsParams): DesktopLspDiagnostic[] {
	return params.diagnostics.map(diagnostic => ({
		uri: params.uri,
		severity: diagnostic.severity ?? 3,
		message: diagnostic.message,
		source: diagnostic.source,
		startLine: diagnostic.range.start.line,
		startColumn: diagnostic.range.start.character,
		endLine: diagnostic.range.end.line,
		endColumn: diagnostic.range.end.character,
	}));
}

export function applyContentChanges(text: string, changes: readonly TextDocumentContentChangeEvent[]): string {
	let next = text;
	for (const change of changes) {
		if (!change.range) {
			next = change.text;
			continue;
		}
		const start = positionOffset(next, change.range.start.line, change.range.start.character);
		const end = positionOffset(next, change.range.end.line, change.range.end.character);
		if (end < start) throw new Error("LSP content change range ends before it starts");
		if (change.rangeLength !== undefined && change.rangeLength !== end - start) {
			throw new Error(
				`LSP content change rangeLength ${change.rangeLength} does not match range size ${end - start}`,
			);
		}
		next = next.slice(0, start) + change.text + next.slice(end);
	}
	return next;
}
function protocolPosition(position: { line: number; column: number }): Position {
	return { line: position.line, character: position.column };
}

function protocolRange(range: {
	start: { line: number; column: number };
	end: { line: number; column: number };
}): Range {
	return { start: protocolPosition(range.start), end: protocolPosition(range.end) };
}

function protocolDiagnostic(diagnostic: DesktopLspDiagnostic): Diagnostic {
	return {
		range: {
			start: { line: diagnostic.startLine, character: diagnostic.startColumn },
			end: { line: diagnostic.endLine, character: diagnostic.endColumn },
		},
		severity: diagnostic.severity,
		message: diagnostic.message,
		source: diagnostic.source,
	};
}

async function canonicalizePath(input: string): Promise<string> {
	let cursor = path.resolve(input);
	const suffix: string[] = [];
	while (true) {
		try {
			const existing = await fs.realpath(cursor);
			return path.resolve(existing, ...suffix.reverse());
		} catch (error) {
			if (!isEnoent(error)) throw error;
			const parent = path.dirname(cursor);
			if (parent === cursor) throw error;
			suffix.push(path.basename(cursor));
			cursor = parent;
		}
	}
}

function positionOffset(text: string, line: number, character: number): number {
	if (!Number.isSafeInteger(line) || line < 0 || !Number.isSafeInteger(character) || character < 0) {
		throw new Error(`Invalid LSP position ${line}:${character}`);
	}
	let offset = 0;
	for (let currentLine = 0; currentLine < line; currentLine++) {
		const newline = text.indexOf("\n", offset);
		if (newline < 0) throw new Error(`LSP position line ${line} is outside document`);
		offset = newline + 1;
	}
	const lineEnd = text.indexOf("\n", offset);
	const max = (lineEnd < 0 ? text.length : lineEnd) - offset;
	if (character > max) throw new Error(`LSP position character ${character} is outside line ${line}`);
	return offset + character;
}

function restartPolicy(spec: TrustedLspServerSpec): LspRestartPolicy {
	return { ...DEFAULT_RESTART_POLICY, ...spec.restart };
}

function normalizeExtension(value: string): string {
	const extension = value.toLowerCase();
	return extension.startsWith(".") ? extension : `.${extension}`;
}

function validateTrustedSpec(spec: TrustedLspServerSpec): void {
	if (!spec.id || !spec.command) throw new Error("Trusted LSP server settings require id and command");
	if (spec.command.includes("\0") || spec.args?.some(arg => arg.includes("\0"))) {
		throw new Error(`Trusted LSP server ${spec.id} contains a NUL byte`);
	}
	if (spec.languages.length === 0) throw new Error(`Trusted LSP server ${spec.id} has no language selectors`);
	const policy = restartPolicy(spec);
	if (
		!Number.isSafeInteger(policy.maxRestarts) ||
		policy.maxRestarts < 0 ||
		!Number.isSafeInteger(policy.windowMs) ||
		policy.windowMs <= 0 ||
		!Number.isSafeInteger(policy.backoffMs) ||
		policy.backoffMs < 0 ||
		(policy.maxBackoffMs !== undefined && (!Number.isSafeInteger(policy.maxBackoffMs) || policy.maxBackoffMs < 0))
	) {
		throw new Error(`Trusted LSP server ${spec.id} has an invalid restart policy`);
	}
}
