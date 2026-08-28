import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	DesktopRequestMap,
	GitSnapshot,
	GraphEdge,
	GraphNode,
	GraphSnapshot,
	WorkspaceDescriptor,
} from "./protocol";
import { GitGraphAdapter } from "./services/git-graph";

const DEFAULT_MAX_CODE_NODES = 250;
const DEFAULT_MAX_CODE_EDGES = 750;
const DEFAULT_MAX_REFERENCE_QUERIES = 64;

type LspRequestParams = DesktopRequestMap["lsp.request"]["params"];

export interface GraphGitService {
	snapshot(): Promise<GitSnapshot>;
}

export interface GraphLspService {
	requestFromProtocol(params: LspRequestParams): Promise<unknown>;
}

export interface GraphAgentRef {
	id: string;
	displayName: string;
	kind: "main" | "sub" | "advisor";
	parentId?: string;
	status: "running" | "idle" | "parked" | "aborted";
	sessionFile?: string | null;
	createdAt: number;
	lastActivity: number;
}

export interface GraphAgentRegistry {
	list(): GraphAgentRef[];
	onChange(listener: () => void): () => void;
}

export interface AgentLifecycleRecord {
	id: string;
	agent: string;
	description?: string;
	status: "started" | "completed" | "failed" | "aborted";
	sessionFile?: string;
	parentToolCallId?: string;
	index: number;
}

export interface GraphServiceOptions {
	lsp: GraphLspService;
	registry: GraphAgentRegistry;
	maxCodeNodes?: number;
	maxCodeEdges?: number;
	maxReferenceQueries?: number;
	readFile?: (filePath: string) => Promise<string>;
}

interface SymbolLocation {
	uri: string;
	line: number;
	column: number;
}

interface ParsedSymbol {
	name: string;
	kind: string;
	location: SymbolLocation;
}

const GRAPHIFY_META_OMITTED: Record<string, true> = {
	id: true,
	label: true,
	name: true,
	kind: true,
	type: true,
	group: true,
	community: true,
	meta: true,
};

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveBound(value: number | undefined, fallback: number): number {
	return value === undefined || !Number.isFinite(value) ? fallback : Math.max(1, Math.trunc(value));
}

function primitiveMeta(source: Record<string, unknown>): GraphNode["meta"] {
	const nested = isUnknownRecord(source.meta) ? Object.entries(source.meta) : [];
	const direct = Object.entries(source).filter(([key]) => !(key in GRAPHIFY_META_OMITTED));
	const entries = [...nested, ...direct].filter(([, value]) => {
		return value === null || ["string", "number", "boolean"].includes(typeof value);
	});
	return entries.length === 0 ? undefined : (Object.fromEntries(entries) as NonNullable<GraphNode["meta"]>);
}

function endpointId(value: unknown): string | undefined {
	if (typeof value === "string" || typeof value === "number") return String(value);
	if (isUnknownRecord(value) && "id" in value) {
		const id = value.id;
		if (typeof id === "string" || typeof id === "number") return String(id);
	}
	return undefined;
}

function parseGraphify(contents: string, revision: number, maxNodes: number, maxEdges: number): GraphSnapshot {
	const parsed: unknown = JSON.parse(contents);
	if (!isUnknownRecord(parsed) || !Array.isArray(parsed.nodes)) {
		throw new Error("Graphify graph.json must contain a nodes array");
	}
	const nodes: GraphNode[] = [];
	const seen = new Set<string>();
	for (const source of parsed.nodes) {
		if (nodes.length >= maxNodes) break;
		if (!isUnknownRecord(source)) continue;
		const id = endpointId(source.id);
		if (!id || seen.has(id)) continue;
		const label =
			typeof source.label === "string" ? source.label : typeof source.name === "string" ? source.name : id;
		const kind =
			typeof source.kind === "string" ? source.kind : typeof source.type === "string" ? source.type : "graphify";
		const groupValue = source.group ?? source.community;
		seen.add(id);
		nodes.push({
			id,
			label,
			kind,
			...(typeof groupValue === "string" || typeof groupValue === "number" ? { group: String(groupValue) } : {}),
			meta: primitiveMeta(source),
		});
	}
	const rawEdges = Array.isArray(parsed.edges) ? parsed.edges : Array.isArray(parsed.links) ? parsed.links : [];
	const edges: GraphEdge[] = [];
	const edgeIds = new Set<string>();
	for (const [index, source] of rawEdges.entries()) {
		if (edges.length >= maxEdges) break;
		if (!isUnknownRecord(source)) continue;
		const from = endpointId(source.source);
		const to = endpointId(source.target);
		if (!from || !to || !seen.has(from) || !seen.has(to)) continue;
		const kind =
			typeof source.kind === "string" ? source.kind : typeof source.type === "string" ? source.type : "related";
		let id = endpointId(source.id) ?? `graphify:${from}:${to}:${kind}:${index}`;
		if (edgeIds.has(id)) id = `${id}:${index}`;
		edgeIds.add(id);
		edges.push({ id, source: from, target: to, kind });
	}
	return { revision, nodes, edges };
}

function position(value: unknown): { line: number; column: number } | undefined {
	if (!isUnknownRecord(value) || typeof value.line !== "number") return undefined;
	const column = typeof value.character === "number" ? value.character : value.column;
	return typeof column === "number" ? { line: value.line, column } : undefined;
}

function rangeStart(value: unknown): { line: number; column: number } | undefined {
	return isUnknownRecord(value) ? position(value.start) : undefined;
}

function location(value: unknown): SymbolLocation | undefined {
	if (!isUnknownRecord(value)) return undefined;
	if (value.location !== undefined) return location(value.location);
	if (typeof value.uri !== "string") return undefined;
	const start = rangeStart(value.range);
	return start ? { uri: value.uri, ...start } : undefined;
}

function parseSymbols(value: unknown): ParsedSymbol[] {
	if (!Array.isArray(value)) return [];
	const symbols: ParsedSymbol[] = [];
	const visit = (item: unknown, inheritedUri?: string): void => {
		if (!isUnknownRecord(item)) return;
		const direct = location(item.location);
		const uri = direct?.uri ?? (typeof item.uri === "string" ? item.uri : inheritedUri);
		const start = direct ?? (uri ? (rangeStart(item.selectionRange) ?? rangeStart(item.range)) : undefined);
		if (typeof item.name === "string" && uri && start) {
			symbols.push({
				name: item.name,
				kind: typeof item.kind === "string" || typeof item.kind === "number" ? String(item.kind) : "symbol",
				location: { uri, line: start.line, column: start.column },
			});
		}
		if (Array.isArray(item.children)) for (const child of item.children) visit(child, uri);
	};
	for (const item of value) visit(item);
	return symbols;
}

function symbolId(symbol: ParsedSymbol): string {
	return `lsp:symbol:${symbol.location.uri}:${symbol.location.line}:${symbol.location.column}:${symbol.name}`;
}

function referenceLocation(value: unknown): SymbolLocation | undefined {
	if (!isUnknownRecord(value)) return undefined;
	const uri = typeof value.uri === "string" ? value.uri : value.targetUri;
	const start = rangeStart(value.range) ?? rangeStart(value.targetRange);
	return typeof uri === "string" && start ? { uri, ...start } : undefined;
}

function referenceId(reference: SymbolLocation): string {
	return `lsp:reference:${reference.uri}:${reference.line}:${reference.column}`;
}

function lifecycleKey(record: AgentLifecycleRecord): string {
	return `${record.id}\0${record.status}\0${record.index}\0${record.sessionFile ?? ""}`;
}

/** Builds only graphs backed by Git, Graphify, LSP, or the process agent registry. */
export class GraphService {
	readonly #lsp: GraphLspService;
	readonly #registry: GraphAgentRegistry;
	readonly #maxCodeNodes: number;
	readonly #maxCodeEdges: number;
	readonly #maxReferenceQueries: number;
	readonly #readFile: (filePath: string) => Promise<string>;
	readonly #revisions = new Map<string, number>();
	readonly #gitAdapters = new Map<string, GitGraphAdapter>();
	readonly #lifecycles = new Map<string, { order: number; record: AgentLifecycleRecord; key: string }>();
	#lifecycleSequence = 0;

	constructor(options: GraphServiceOptions) {
		this.#lsp = options.lsp;
		this.#registry = options.registry;
		this.#maxCodeNodes = positiveBound(options.maxCodeNodes, DEFAULT_MAX_CODE_NODES);
		this.#maxCodeEdges = positiveBound(options.maxCodeEdges, DEFAULT_MAX_CODE_EDGES);
		this.#maxReferenceQueries = positiveBound(options.maxReferenceQueries, DEFAULT_MAX_REFERENCE_QUERIES);
		this.#readFile = options.readFile ?? (filePath => fs.readFile(filePath, "utf8"));
	}

	recordAgentLifecycle(record: AgentLifecycleRecord): boolean {
		const key = lifecycleKey(record);
		const prior = this.#lifecycles.get(record.id);
		if (prior?.key === key) return false;
		this.#lifecycles.set(record.id, { order: prior?.order ?? ++this.#lifecycleSequence, record: { ...record }, key });
		return true;
	}

	onRegistryChange(listener: () => void): () => void {
		return this.#registry.onChange(listener);
	}

	async git(workspaceId: string, service: GraphGitService): Promise<GraphSnapshot> {
		const snapshot = await service.snapshot();
		let adapter = this.#gitAdapters.get(workspaceId);
		if (!adapter) {
			adapter = new GitGraphAdapter();
			this.#gitAdapters.set(workspaceId, adapter);
		}
		return adapter.snapshot(snapshot.commits);
	}

	async code(workspace: WorkspaceDescriptor): Promise<GraphSnapshot> {
		const revision = this.#nextRevision(`${workspace.id}:code`);
		const graphifyPath = path.join(workspace.rootPath, "graphify-out", "graph.json");
		try {
			const contents = await this.#readFile(graphifyPath);
			return parseGraphify(contents, revision, this.#maxCodeNodes, this.#maxCodeEdges);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		return await this.#lspCodeGraph(workspace.id, revision);
	}

	agent(workspaceId: string): GraphSnapshot {
		const revision = this.#nextRevision(`${workspaceId}:agent`);
		const registry = this.#registry.list().map((ref, order) => ({ ref, order }));
		registry.sort(
			(left, right) =>
				left.ref.createdAt - right.ref.createdAt ||
				left.order - right.order ||
				left.ref.id.localeCompare(right.ref.id),
		);
		const refs = new Map(registry.map(item => [item.ref.id, item.ref]));
		const lifecycleOnly = [...this.#lifecycles.values()]
			.filter(item => !refs.has(item.record.id))
			.sort((left, right) => left.order - right.order);
		const nodes: GraphNode[] = registry.map(({ ref }, order) => ({
			id: `agent:${ref.id}`,
			label: ref.displayName,
			kind: ref.kind,
			group: ref.parentId,
			meta: {
				status: ref.status,
				order,
				createdAt: ref.createdAt,
				lastActivity: ref.lastActivity,
				...(ref.sessionFile ? { sessionFile: ref.sessionFile } : {}),
				...(this.#lifecycles.get(ref.id) ? { lifecycleStatus: this.#lifecycles.get(ref.id)!.record.status } : {}),
			},
		}));
		for (const { record, order } of lifecycleOnly) {
			nodes.push({
				id: `agent:${record.id}`,
				label: record.description ?? record.agent,
				kind: "sub",
				meta: {
					status: record.status,
					order: registry.length + order,
					index: record.index,
					...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
				},
			});
		}
		const nodeIds = new Set(nodes.map(node => node.id));
		const edges: GraphEdge[] = [];
		for (const { ref } of registry) {
			if (!ref.parentId) continue;
			const source = `agent:${ref.parentId}`;
			const target = `agent:${ref.id}`;
			if (nodeIds.has(source) && nodeIds.has(target))
				edges.push({ id: `agent-parent:${ref.parentId}:${ref.id}`, source, target, kind: "parent" });
		}
		return { revision, nodes, edges };
	}

	async #lspCodeGraph(workspaceId: string, revision: number): Promise<GraphSnapshot> {
		const symbols = parseSymbols(
			await this.#lsp.requestFromProtocol({ workspaceId, method: "workspace/symbol", query: "" }),
		).slice(0, this.#maxCodeNodes);
		const nodes: GraphNode[] = symbols.map(symbol => ({
			id: symbolId(symbol),
			label: symbol.name,
			kind: symbol.kind,
			group: symbol.location.uri,
			meta: { uri: symbol.location.uri, line: symbol.location.line, column: symbol.location.column },
		}));
		const nodeIds = new Set(nodes.map(node => node.id));
		const edges: GraphEdge[] = [];
		for (const symbol of symbols.slice(0, this.#maxReferenceQueries)) {
			if (nodes.length >= this.#maxCodeNodes || edges.length >= this.#maxCodeEdges) break;
			let references: unknown;
			try {
				references = await this.#lsp.requestFromProtocol({
					workspaceId,
					method: "textDocument/references",
					uri: symbol.location.uri,
					position: { line: symbol.location.line, column: symbol.location.column },
					includeDeclaration: false,
				});
			} catch {
				continue;
			}
			if (!Array.isArray(references)) continue;
			for (const raw of references) {
				if (nodes.length >= this.#maxCodeNodes || edges.length >= this.#maxCodeEdges) break;
				const reference = referenceLocation(raw);
				if (!reference) continue;
				const id = referenceId(reference);
				if (!nodeIds.has(id)) {
					nodeIds.add(id);
					nodes.push({
						id,
						label: `${path.basename(new URL(reference.uri).pathname)}:${reference.line + 1}:${reference.column + 1}`,
						kind: "reference",
						group: reference.uri,
						meta: { uri: reference.uri, line: reference.line, column: reference.column },
					});
				}
				const source = symbolId(symbol);
				const edgeId = `lsp:reference-edge:${source}:${id}`;
				if (!edges.some(edge => edge.id === edgeId))
					edges.push({ id: edgeId, source, target: id, kind: "references" });
			}
		}
		return { revision, nodes, edges };
	}

	#nextRevision(key: string): number {
		const revision = (this.#revisions.get(key) ?? 0) + 1;
		this.#revisions.set(key, revision);
		return revision;
	}
}
