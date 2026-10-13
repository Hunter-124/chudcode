import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { type AgentLifecycleRecord, type GraphAgentRegistry, GraphService } from "./graph-service";
import { type ProjectController, ProjectService } from "./project-service";
import type {
	DesktopEvent,
	DesktopFrame,
	DesktopMethod,
	DesktopRequest,
	DesktopRequestMap,
	DesktopResponse,
	DocumentSnapshot,
	FileChange,
	GitBranch,
	GitRemote,
	GitSnapshot,
	GraphSnapshot,
	SearchQuery,
	SearchResult,
	WorkspaceDescriptor,
	WorkspaceEntry,
} from "./protocol";
import type { DesktopClientCapabilities, DesktopFrameSink } from "./runtime";
import type { DesktopRuntimeHost } from "./server";
import { FileWatcher } from "./services/file-watcher";
import { GitService } from "./services/git-service";
import { LspBroker, toDesktopDiagnostics } from "./services/lsp-broker";
import type { TrustedLspServerSpec } from "./services/lsp-types";
import { TerminalService } from "./services/terminal-service";
import { WorkspaceSearch } from "./services/workspace-search";
import { WorkspaceService, WorkspaceServiceError } from "./services/workspace-service";

export type ServiceMethod = Extract<
	DesktopMethod,
	`workspace.${string}` | `git.${string}` | `terminal.${string}` | "lsp.request" | "graph.snapshot"
>;
type ServiceRequest = Extract<DesktopRequest, { method: ServiceMethod }>;
type CoreMethod = Exclude<DesktopMethod, ServiceMethod>;
interface ParsedDesktopRequest {
	readonly t: "request";
	readonly id: number;
	readonly method: string;
	readonly params: object;
}

export const SERVICE_METHODS = [
	"workspace.recent",
	"workspace.pick",
	"workspace.open",
	"workspace.list",
	"workspace.read",
	"workspace.write",
	"workspace.stat",
	"workspace.create",
	"workspace.rename",
	"workspace.copy",
	"workspace.remove",
	"workspace.reveal",
	"workspace.search",
	"git.init",
	"git.branches",
	"git.remotes",
	"git.fetch",
	"git.pull",
	"git.push",
	"git.branch.create",
	"git.hunk",
	"git.snapshot",
	"git.diff",
	"git.stage",
	"git.unstage",
	"git.commit",
	"git.checkout",
	"terminal.create",
	"terminal.write",
	"terminal.resize",
	"terminal.close",
	"lsp.request",
	"graph.snapshot",
] as const satisfies readonly ServiceMethod[];

const CORE_METHODS: Record<CoreMethod, true> = {
	"runtime.hello": true,
	"prompt.send": true,
	"run.abort": true,
	"ui.respond": true,
	"agent.command": true,
	"agent.transcript": true,
	"session.list": true,
	"session.select": true,
	"session.new": true,
	"session.fork": true,
	"session.rename": true,
	"session.delete": true,
	"session.pin": true,
	"session.tabs": true,
	"session.activate": true,
	"session.tab.close": true,
	"session.tab.draft": true,
};

const SERVICE_METHOD_SET = new Set<string>(SERVICE_METHODS);
function isServiceRequest(request: ParsedDesktopRequest): request is ServiceRequest {
	return SERVICE_METHOD_SET.has(request.method);
}

function isCoreRequest(request: ParsedDesktopRequest): request is Extract<DesktopRequest, { method: CoreMethod }> {
	return Object.hasOwn(CORE_METHODS, request.method);
}

export interface RoutedWorkspace {
	readonly id: string;
	readonly rootPath: string;
	readonly descriptor: WorkspaceDescriptor;
	rootUri(): string;
	list(uri?: string): Promise<WorkspaceEntry[]>;
	read(uri: string): Promise<DocumentSnapshot>;
	write(
		uri: string,
		text: string,
		expectedSha256: string,
		origin?: "agent" | "user",
	): Promise<DocumentSnapshot["stamp"]>;
	stat(uri: string): Promise<WorkspaceEntry>;
	create(
		uri: string,
		options?: { directory?: boolean; text?: string; origin?: "agent" | "user" },
	): Promise<WorkspaceEntry>;
	rename(from: string, to: string, origin?: "agent" | "user"): Promise<WorkspaceEntry>;
	copy(
		from: string,
		to: string,
		options?: { recursive?: boolean; overwrite?: boolean; origin?: "agent" | "user" },
	): Promise<WorkspaceEntry>;
	remove(uri: string, mode?: "trash" | "permanent", origin?: "agent" | "user"): Promise<boolean>;
	reveal(uri: string): Promise<boolean>;
}

export interface RoutedWatcher {
	start(): Promise<void>;
	close(): void;
}

export interface RoutedSearch {
	search(query: SearchQuery): Promise<SearchResult[]>;
}

export interface RoutedGit {
	snapshot(): Promise<GitSnapshot>;
	branches(): Promise<GitBranch[]>;
	remotes(): Promise<GitRemote[]>;
	fetch(remote?: string): Promise<GitSnapshot>;
	pull(remote?: string, branch?: string): Promise<GitSnapshot>;
	push(remote?: string, branch?: string, setUpstream?: boolean): Promise<GitSnapshot>;
	createBranch(name: string, startPoint?: string, checkout?: boolean): Promise<GitSnapshot>;
	hunk(path: string, hunkId: string, action: "stage" | "unstage" | "revert"): Promise<GitSnapshot>;
	diff(path?: string, staged?: boolean): Promise<string>;
	stage(paths: readonly string[]): Promise<GitSnapshot>;
	unstage(paths: readonly string[]): Promise<GitSnapshot>;
	commit(
		message: string,
	): Promise<{ commit: DesktopRequestMap["git.commit"]["result"]["commit"]; snapshot: GitSnapshot }>;
	checkout(ref: string): Promise<GitSnapshot>;
}

export interface RoutedTerminal {
	create(
		params: DesktopRequestMap["terminal.create"]["params"],
	): Promise<DesktopRequestMap["terminal.create"]["result"]>;
	write(params: DesktopRequestMap["terminal.write"]["params"]): DesktopRequestMap["terminal.write"]["result"];
	resize(params: DesktopRequestMap["terminal.resize"]["params"]): DesktopRequestMap["terminal.resize"]["result"];
	close(params: DesktopRequestMap["terminal.close"]["params"]): Promise<DesktopRequestMap["terminal.close"]["result"]>;
	dispose(): Promise<void>;
}

export interface RoutedLsp {
	openWorkspace(id: string, rootPath: string): Promise<unknown>;
	closeWorkspace(id: string): Promise<void>;
	openDocument(workspaceId: string, document: { uri: string; languageId: string; text: string }): Promise<string>;
	changeDocument(workspaceId: string, uri: string, changes: Array<{ text: string }>): Promise<void>;
	saveDocument(workspaceId: string, uri: string, includeText?: boolean): Promise<void>;
	closeDocument(workspaceId: string, uri: string): Promise<void>;
	requestFromProtocol(params: DesktopRequestMap["lsp.request"]["params"]): Promise<unknown>;
	shutdown(): Promise<void>;
}

export interface ServiceRouterOptions {
	runtime: DesktopRuntimeHost;
	projects?: ProjectController;
	registry?: GraphAgentRegistry;
	workspaceFactory?: (rootPath: string) => Promise<RoutedWorkspace>;
	watcherFactory?: (workspace: RoutedWorkspace, onChanges: (changes: FileChange[]) => void) => RoutedWatcher;
	searchFactory?: (workspace: RoutedWorkspace) => RoutedSearch;
	gitFactory?: {
		discover(rootPath: string): Promise<RoutedGit>;
		init(rootPath: string): Promise<RoutedGit>;
	};
	terminalFactory?: (
		resolveWorkspace: (workspaceId: string) => WorkspaceDescriptor,
		emit: (event: DesktopEvent) => void,
	) => RoutedTerminal;
	lsp?: RoutedLsp;
	lspFactory?: (emit: (event: Extract<DesktopEvent, { t: "diagnostics" }>) => void) => RoutedLsp;
	loadLspServers?: (workspace: {
		id: string;
		rootPath: string;
	}) => readonly TrustedLspServerSpec[] | Promise<readonly TrustedLspServerSpec[]>;
	graph?: GraphService;
}

interface WorkspaceRecord {
	workspace: RoutedWorkspace;
	watcher: RoutedWatcher;
	search: RoutedSearch;
}

function isLifecycle(value: unknown): value is AgentLifecycleRecord {
	if (typeof value !== "object" || value === null) return false;
	if (!("id" in value) || typeof value.id !== "string") return false;
	if (!("agent" in value) || typeof value.agent !== "string") return false;
	if (!("status" in value) || !["started", "completed", "failed", "aborted"].includes(String(value.status)))
		return false;
	return "index" in value && typeof value.index === "number";
}

function response<M extends DesktopMethod>(
	request: Extract<DesktopRequest, { method: M }>,
	result: DesktopRequestMap[M]["result"],
): DesktopResponse<M> {
	return { t: "response", id: request.id, method: request.method, result } as DesktopResponse<M>;
}

function requestError(request: ParsedDesktopRequest, code: string, message: string): DesktopResponse {
	return { t: "response", id: request.id, method: request.method, error: { code, message } } as DesktopResponse;
}

function errorCode(error: unknown): string {
	if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string")
		return error.code;
	return "SERVICE_ERROR";
}

function exhaustive(value: never): never {
	throw new Error(`Unreachable desktop service method: ${String(value)}`);
}

function symbolSearchResults(value: unknown, limit: number): SearchResult[] {
	if (!Array.isArray(value)) return [];
	const results: SearchResult[] = [];
	for (const item of value) {
		if (results.length >= limit || typeof item !== "object" || item === null || !("name" in item)) break;
		if (typeof item.name !== "string") continue;
		const candidate =
			"location" in item && typeof item.location === "object" && item.location !== null ? item.location : item;
		if (!("uri" in candidate) || typeof candidate.uri !== "string") continue;
		const range =
			"range" in candidate && typeof candidate.range === "object" && candidate.range !== null
				? candidate.range
				: undefined;
		const start =
			range && "start" in range && typeof range.start === "object" && range.start !== null ? range.start : undefined;
		const line = start && "line" in start && typeof start.line === "number" ? start.line + 1 : undefined;
		const character =
			start && "character" in start && typeof start.character === "number" ? start.character + 1 : undefined;
		results.push({ uri: candidate.uri, line, column: character, preview: item.name });
	}
	return results;
}

/** Exhaustive service dispatcher layered directly over the in-process DesktopRuntime. */
export class ServiceRouter implements DesktopRuntimeHost {
	readonly #runtime: DesktopRuntimeHost;
	readonly #registry: GraphAgentRegistry;
	readonly #projects: ProjectController;
	readonly #workspaceFactory: NonNullable<ServiceRouterOptions["workspaceFactory"]>;
	readonly #watcherFactory: NonNullable<ServiceRouterOptions["watcherFactory"]>;
	readonly #searchFactory: NonNullable<ServiceRouterOptions["searchFactory"]>;
	readonly #gitFactory: NonNullable<ServiceRouterOptions["gitFactory"]>;
	readonly #lsp: RoutedLsp;
	readonly #terminal: RoutedTerminal;
	readonly #graph: GraphService;
	readonly #clients = new Map<DesktopFrameSink, DesktopFrameSink>();
	readonly #workspaces = new Map<string, WorkspaceRecord>();
	readonly #workspaceByRoot = new Map<string, string>();
	readonly #git = new Map<string, RoutedGit>();
	readonly #openDocuments = new Map<string, Set<string>>();
	readonly #codeGraphWorkspaces = new Set<string>();
	readonly #agentGraphWorkspaces = new Set<string>();
	readonly #gitGraphWorkspaces = new Set<string>();
	readonly #unsubscribeRegistry: () => void;
	#agentGraphScheduled = false;
	#disposed = false;

	constructor(options: ServiceRouterOptions) {
		this.#runtime = options.runtime;
		this.#projects = options.projects ?? new ProjectService();
		this.#registry = options.registry ?? AgentRegistry.global();
		this.#workspaceFactory = options.workspaceFactory ?? (rootPath => WorkspaceService.open(rootPath));
		this.#watcherFactory =
			options.watcherFactory ??
			((workspace, onChanges) => new FileWatcher(workspace as WorkspaceService, onChanges));
		this.#searchFactory = options.searchFactory ?? (workspace => new WorkspaceSearch(workspace as WorkspaceService));
		this.#gitFactory = options.gitFactory ?? {
			discover: rootPath => GitService.discover(rootPath),
			init: rootPath => GitService.init(rootPath),
		};
		const emitDiagnostics = (event: Extract<DesktopEvent, { t: "diagnostics" }>): void => this.#broadcast(event);
		this.#lsp =
			options.lsp ??
			options.lspFactory?.(emitDiagnostics) ??
			new LspBroker({
				loadServerSpecs: options.loadLspServers ?? (() => []),
				onDiagnostics: event => {
					emitDiagnostics({
						t: "diagnostics",
						workspaceId: event.workspaceId,
						diagnostics: toDesktopDiagnostics(event.params),
					});
				},
			});
		this.#terminal =
			options.terminalFactory?.(
				workspaceId => this.#workspace(workspaceId).workspace.descriptor,
				event => this.#broadcast(event),
			) ??
			new TerminalService({
				resolveWorkspace: workspaceId => this.#workspace(workspaceId).workspace.descriptor,
				emit: event => this.#broadcast(event),
			});
		this.#graph = options.graph ?? new GraphService({ lsp: this.#lsp, registry: this.#registry });
		this.#unsubscribeRegistry = this.#graph.onRegistryChange(() => this.#scheduleAgentGraphs());
	}

	async openWorkspace(rootPath: string): Promise<RoutedWorkspace> {
		const workspace = await this.#openWorkspace(rootPath);
		await this.#projects.recordOpened(workspace.rootPath);
		return workspace;
	}

	attach(client: DesktopFrameSink, capabilities?: DesktopClientCapabilities): void {
		if (this.#disposed) {
			client.close(1012, "desktop services stopped");
			return;
		}
		if (this.#clients.has(client)) return;
		const relay: DesktopFrameSink = {
			send: frame => {
				this.#observeRuntimeFrame(frame);
				return client.send(frame);
			},
			close: (code, reason) => client.close(code, reason),
		};
		this.#clients.set(client, relay);
		this.#runtime.attach(relay, capabilities);
	}

	detach(client: DesktopFrameSink): void {
		const relay = this.#clients.get(client);
		if (!relay) return;
		this.#clients.delete(client);
		this.#runtime.detach(relay);
	}

	async handleRequest(request: ParsedDesktopRequest): Promise<DesktopFrame> {
		if (isServiceRequest(request)) return await this.#handleServiceRequest(request);
		if (isCoreRequest(request)) return await this.#runtime.handleRequest(request);
		return requestError(request, "METHOD_NOT_SUPPORTED", `Unknown desktop method: ${request.method}`);
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribeRegistry();
		for (const record of this.#workspaces.values()) record.watcher.close();
		const failures: unknown[] = [];
		for (const operation of [this.#terminal.dispose(), this.#lsp.shutdown(), this.#runtime.dispose()]) {
			try {
				await operation;
			} catch (error) {
				failures.push(error);
			}
		}
		this.#clients.clear();
		if (failures.length > 0) throw new AggregateError(failures, "Desktop service teardown failed");
	}

	async #handleServiceRequest(request: ServiceRequest): Promise<DesktopResponse> {
		try {
			switch (request.method) {
				case "workspace.recent":
					return response(request, { projects: await this.#projects.recent() });
				case "workspace.pick":
					return response(request, await this.#projects.pick(request.params.initialPath));
				case "workspace.open": {
					const workspace = await this.openWorkspace(request.params.rootPath);
					return response(request, { workspace: workspace.descriptor });
				}
				case "workspace.list":
					return response(request, {
						entries: await this.#workspace(request.params.workspaceId).workspace.list(request.params.uri),
					});
				case "workspace.read": {
					const record = this.#workspace(request.params.workspaceId);
					const document = await record.workspace.read(request.params.uri);
					await this.#openLspDocument(record.workspace, document);
					this.#broadcast({ t: "document", document, origin: "user" });
					return response(request, { document });
				}
				case "workspace.write": {
					const record = this.#workspace(request.params.workspaceId);
					const stamp = await record.workspace.write(
						request.params.uri,
						request.params.text,
						request.params.expectedSha256,
						"user",
					);
					const document = await record.workspace.read(request.params.uri);
					await this.#syncLspDocument(record.workspace, document);
					this.#broadcast({ t: "document", document, origin: "user" });
					return response(request, { stamp });
				}
				case "workspace.stat":
					return response(request, {
						entry: await this.#workspace(request.params.workspaceId).workspace.stat(request.params.uri),
					});
				case "workspace.create": {
					const entry = await this.#workspace(request.params.workspaceId).workspace.create(request.params.uri, {
						directory: request.params.directory,
						origin: "user",
					});
					return response(request, { entry });
				}
				case "workspace.rename": {
					const record = this.#workspace(request.params.workspaceId);
					const entry = await record.workspace.rename(request.params.from, request.params.to, "user");
					await this.#moveOpenDocument(record.workspace, request.params.from, entry);
					return response(request, { entry });
				}
				case "workspace.copy": {
					const entry = await this.#workspace(request.params.workspaceId).workspace.copy(
						request.params.from,
						request.params.to,
						{
							recursive: request.params.recursive,
							origin: "user",
						},
					);
					return response(request, { entry });
				}
				case "workspace.remove": {
					const record = this.#workspace(request.params.workspaceId);
					const removed = await record.workspace.remove(request.params.uri, request.params.mode, "user");
					await this.#closeLspDocument(record.workspace.id, request.params.uri);
					return response(request, { removed });
				}
				case "workspace.reveal":
					return response(request, {
						revealed: await this.#workspace(request.params.workspaceId).workspace.reveal(request.params.uri),
					});
				case "workspace.search": {
					const record = this.#workspace(request.params.workspaceId);
					if (request.params.query.kind !== "symbols")
						return response(request, { results: await record.search.search(request.params.query) });
					const value = await this.#lsp.requestFromProtocol({
						workspaceId: record.workspace.id,
						method: "workspace/symbol",
						query: request.params.query.text,
					});
					return response(request, {
						results: symbolSearchResults(value, request.params.query.maxResults ?? 100),
					});
				}
				case "git.init": {
					const workspace = this.#workspace(request.params.workspaceId).workspace;
					const git = await this.#gitFactory.init(workspace.rootPath);
					this.#git.set(workspace.id, git);
					const snapshot = await git.snapshot();
					this.#publishGit(workspace.id, snapshot);
					return response(request, { snapshot });
				}
				case "git.branches":
					return response(request, {
						branches: await (await this.#gitService(request.params.workspaceId)).branches(),
					});
				case "git.remotes":
					return response(request, {
						remotes: await (await this.#gitService(request.params.workspaceId)).remotes(),
					});
				case "git.fetch": {
					const snapshot = await (await this.#gitService(request.params.workspaceId)).fetch(request.params.remote);
					this.#publishGit(request.params.workspaceId, snapshot);
					return response(request, { snapshot });
				}
				case "git.pull": {
					const snapshot = await (
						await this.#gitService(request.params.workspaceId)
					).pull(request.params.remote, request.params.branch);
					this.#publishGit(request.params.workspaceId, snapshot);
					return response(request, { snapshot });
				}
				case "git.push": {
					const snapshot = await (
						await this.#gitService(request.params.workspaceId)
					).push(request.params.remote, request.params.branch, request.params.setUpstream);
					this.#publishGit(request.params.workspaceId, snapshot);
					return response(request, { snapshot });
				}
				case "git.branch.create": {
					const snapshot = await (
						await this.#gitService(request.params.workspaceId)
					).createBranch(request.params.name, request.params.startPoint, request.params.checkout);
					this.#publishGit(request.params.workspaceId, snapshot);
					return response(request, { snapshot });
				}
				case "git.hunk": {
					const snapshot = await (
						await this.#gitService(request.params.workspaceId)
					).hunk(request.params.path, request.params.hunkId, request.params.action);
					this.#publishGit(request.params.workspaceId, snapshot);
					return response(request, { snapshot });
				}
				case "git.snapshot": {
					const snapshot = await (await this.#gitService(request.params.workspaceId)).snapshot();
					this.#publishGit(request.params.workspaceId, snapshot);
					return response(request, { snapshot });
				}
				case "git.diff":
					return response(request, {
						unified: await (
							await this.#gitService(request.params.workspaceId)
						).diff(request.params.path, request.params.staged),
					});
				case "git.stage": {
					const snapshot = await (await this.#gitService(request.params.workspaceId)).stage(request.params.paths);
					this.#publishGit(request.params.workspaceId, snapshot);
					return response(request, { snapshot });
				}
				case "git.unstage": {
					const snapshot = await (
						await this.#gitService(request.params.workspaceId)
					).unstage(request.params.paths);
					this.#publishGit(request.params.workspaceId, snapshot);
					return response(request, { snapshot });
				}
				case "git.commit": {
					const result = await (await this.#gitService(request.params.workspaceId)).commit(request.params.message);
					this.#publishGit(request.params.workspaceId, result.snapshot);
					return response(request, result);
				}
				case "git.checkout": {
					const snapshot = await (await this.#gitService(request.params.workspaceId)).checkout(request.params.ref);
					this.#publishGit(request.params.workspaceId, snapshot);
					return response(request, { snapshot });
				}
				case "terminal.create":
					this.#workspace(request.params.workspaceId);
					return response(request, await this.#terminal.create(request.params));
				case "terminal.write":
					return response(request, this.#terminal.write(request.params));
				case "terminal.resize":
					return response(request, this.#terminal.resize(request.params));
				case "terminal.close":
					return response(request, await this.#terminal.close(request.params));
				case "lsp.request":
					this.#workspace(request.params.workspaceId);
					return response(request, { value: await this.#lsp.requestFromProtocol(request.params) });
				case "graph.snapshot": {
					const record = this.#workspace(request.params.workspaceId);
					let graph: GraphSnapshot;
					if (request.params.kind === "code") {
						this.#codeGraphWorkspaces.add(record.workspace.id);
						graph = await this.#graph.code(record.workspace.descriptor);
					} else if (request.params.kind === "git") {
						this.#gitGraphWorkspaces.add(record.workspace.id);
						graph = await this.#graph.git(record.workspace.id, await this.#gitService(record.workspace.id));
					} else {
						this.#agentGraphWorkspaces.add(record.workspace.id);
						graph = this.#graph.agent(record.workspace.id);
					}
					this.#broadcast({ t: "graph", workspaceId: record.workspace.id, kind: request.params.kind, graph });
					return response(request, { graph });
				}
				default:
					return exhaustive(request);
			}
		} catch (error) {
			return requestError(request, errorCode(error), error instanceof Error ? error.message : String(error));
		}
	}

	async #openWorkspace(rootPath: string): Promise<RoutedWorkspace> {
		const existingId = this.#workspaceByRoot.get(rootPath);
		if (existingId) return this.#workspace(existingId).workspace;
		const workspace = await this.#workspaceFactory(rootPath);
		const existing = this.#workspaces.get(workspace.id);
		if (existing) return existing.workspace;
		await this.#lsp.openWorkspace(workspace.id, workspace.rootPath);
		const watcher = this.#watcherFactory(workspace, changes => this.#onWorkspaceChanges(workspace, changes));
		try {
			await watcher.start();
		} catch (error) {
			watcher.close();
			await this.#lsp.closeWorkspace(workspace.id);
			throw error;
		}
		this.#workspaces.set(workspace.id, { workspace, watcher, search: this.#searchFactory(workspace) });
		this.#workspaceByRoot.set(rootPath, workspace.id);
		this.#workspaceByRoot.set(workspace.rootPath, workspace.id);
		return workspace;
	}

	#workspace(workspaceId: string): WorkspaceRecord {
		const record = this.#workspaces.get(workspaceId);
		if (!record) throw new WorkspaceServiceError("WORKSPACE_NOT_FOUND", `Unknown workspace: ${workspaceId}`);
		return record;
	}

	async #gitService(workspaceId: string): Promise<RoutedGit> {
		const existing = this.#git.get(workspaceId);
		if (existing) return existing;
		const workspace = this.#workspace(workspaceId).workspace;
		const discovered = await this.#gitFactory.discover(workspace.rootPath);
		this.#git.set(workspaceId, discovered);
		return discovered;
	}

	#publishGit(workspaceId: string, snapshot: GitSnapshot): void {
		this.#broadcast({ t: "git", workspaceId, snapshot });
		const git = this.#git.get(workspaceId);
		if (git && this.#gitGraphWorkspaces.has(workspaceId)) {
			this.#publishGraphPromise(workspaceId, "git", this.#graph.git(workspaceId, git));
		}
	}

	#onWorkspaceChanges(workspace: RoutedWorkspace, changes: FileChange[]): void {
		this.#broadcast({ t: "workspace-change", workspaceId: workspace.id, changes });
		for (const change of changes) void this.#syncExternalDocument(workspace, change);
		if (this.#codeGraphWorkspaces.has(workspace.id)) {
			this.#publishGraphPromise(workspace.id, "code", this.#graph.code(workspace.descriptor));
		}
	}

	#publishGraphPromise(
		workspaceId: string,
		kind: "code" | "git",
		pending: Promise<DesktopRequestMap["graph.snapshot"]["result"]["graph"]>,
	): void {
		void pending.then(
			graph => this.#broadcast({ t: "graph", workspaceId, kind, graph }),
			error => {
				this.#broadcast({
					t: "error",
					code: "GRAPH_FAILED",
					message: error instanceof Error ? error.message : String(error),
				});
			},
		);
	}

	async #syncExternalDocument(workspace: RoutedWorkspace, change: FileChange): Promise<void> {
		const opened = this.#openDocuments.get(workspace.id);
		if (!opened) return;
		if (change.kind === "deleted") {
			await this.#closeLspDocument(workspace.id, change.uri);
			return;
		}
		if (change.kind === "renamed" && change.oldUri) await this.#closeLspDocument(workspace.id, change.oldUri);
		if (!opened.has(change.uri) && change.kind !== "renamed") return;
		try {
			const document = await workspace.read(change.uri);
			await this.#syncLspDocument(workspace, document);
			this.#broadcast({ t: "document", document, origin: "external" });
		} catch {}
	}

	async #openLspDocument(workspace: RoutedWorkspace, document: DocumentSnapshot): Promise<void> {
		let opened = this.#openDocuments.get(workspace.id);
		if (!opened) {
			opened = new Set();
			this.#openDocuments.set(workspace.id, opened);
		}
		if (opened.has(document.uri)) return;
		try {
			await this.#lsp.openDocument(workspace.id, {
				uri: document.uri,
				languageId: document.language,
				text: document.text,
			});
			opened.add(document.uri);
		} catch (error) {
			if (!(error instanceof Error) || !error.message.startsWith("No trusted LSP server configured")) throw error;
		}
	}

	async #syncLspDocument(workspace: RoutedWorkspace, document: DocumentSnapshot): Promise<void> {
		const opened = this.#openDocuments.get(workspace.id);
		if (!opened?.has(document.uri)) {
			await this.#openLspDocument(workspace, document);
			return;
		}
		await this.#lsp.changeDocument(workspace.id, document.uri, [{ text: document.text }]);
		await this.#lsp.saveDocument(workspace.id, document.uri, false);
	}

	async #closeLspDocument(workspaceId: string, uri: string): Promise<void> {
		const opened = this.#openDocuments.get(workspaceId);
		if (!opened?.delete(uri)) return;
		await this.#lsp.closeDocument(workspaceId, uri);
	}

	async #moveOpenDocument(workspace: RoutedWorkspace, oldUri: string, entry: WorkspaceEntry): Promise<void> {
		const opened = this.#openDocuments.get(workspace.id);
		if (!opened?.has(oldUri)) return;
		await this.#closeLspDocument(workspace.id, oldUri);
		if (entry.directory) return;
		const document = await workspace.read(entry.uri);
		await this.#openLspDocument(workspace, document);
		this.#broadcast({ t: "document", document, origin: "user" });
	}

	#observeRuntimeFrame(frame: DesktopFrame): void {
		if (frame.t !== "bus" || frame.channel !== "task:subagent:lifecycle" || !isLifecycle(frame.data)) return;
		if (this.#graph.recordAgentLifecycle(frame.data)) this.#scheduleAgentGraphs();
	}

	#scheduleAgentGraphs(): void {
		if (this.#agentGraphScheduled || this.#agentGraphWorkspaces.size === 0 || this.#disposed) return;
		this.#agentGraphScheduled = true;
		queueMicrotask(() => {
			this.#agentGraphScheduled = false;
			for (const workspaceId of this.#agentGraphWorkspaces) {
				const graph = this.#graph.agent(workspaceId);
				this.#broadcast({ t: "graph", workspaceId, kind: "agent", graph });
			}
		});
	}

	#broadcast(event: DesktopEvent): void {
		if (this.#disposed) return;
		for (const client of this.#clients.keys()) client.send(event);
	}
}
