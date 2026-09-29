import {
	forceCollide,
	forceLink,
	forceManyBody,
	forceSimulation,
	forceX,
	forceY,
	randomLcg,
	type Simulation,
	type SimulationLinkDatum,
	type SimulationNodeDatum,
} from "d3";
import type { GraphEdge, GraphNode, GraphSnapshot } from "../../protocol";

export type GraphKind = "code" | "git" | "agent";
export type GraphChangeState = "entering" | "stable" | "changing" | "leaving";

export interface GraphSourceLocation {
	uri: string;
	line?: number;
	column?: number;
}

export interface LayoutNode extends SimulationNodeDatum {
	id: string;
	label: string;
	kind: string;
	group?: string;
	state: GraphChangeState;
	order: number;
	source?: GraphSourceLocation;
	meta: Readonly<Record<string, string | number | boolean | null>>;
	pinned: boolean;
}

export interface LayoutEdge extends SimulationLinkDatum<LayoutNode> {
	id: string;
	source: string | LayoutNode;
	target: string | LayoutNode;
	kind: string;
	state: GraphChangeState;
}

export interface AdaptedGraph {
	kind: GraphKind;
	revision: number;
	nodes: GraphNode[];
	edges: GraphEdge[];
}

export interface CameraTransform {
	x: number;
	y: number;
	k: number;
}

export interface GraphLayoutCacheV1 {
	schema: 1;
	workspaceId: string;
	kind: GraphKind;
	layoutVersion: string;
	nodes: Record<string, { x: number; y: number; pinned: boolean; fx?: number; fy?: number }>;
	camera: CameraTransform;
	updatedAt: number;
}

export interface LayoutStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

export interface LayoutUpdate {
	nodes: readonly LayoutNode[];
	edges: readonly LayoutEdge[];
	insertedNodeIds: ReadonlySet<string>;
	changedNodeIds: ReadonlySet<string>;
	removedNodeIds: ReadonlySet<string>;
	insertedEdgeIds: ReadonlySet<string>;
	removedEdgeIds: ReadonlySet<string>;
}

const CACHE_SCHEMA = 1 as const;
const CACHE_PREFIX = "chudcode.graph-layout.v1";
const DEFAULT_CAMERA: CameraTransform = Object.freeze({ x: 0, y: 0, k: 1 });

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

export function deterministicSeed(id: string): number {
	let hash = 2166136261;
	for (let index = 0; index < id.length; index += 1) {
		hash ^= id.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0) / 0x1_0000_0000;
}

function deterministicPoint(id: string): { x: number; y: number } {
	const angle = deterministicSeed(`${id}:angle`) * Math.PI * 2;
	const radius = 32 + deterministicSeed(`${id}:radius`) * 168;
	return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

function sourceLocation(node: GraphNode): GraphSourceLocation | undefined {
	const uri = node.meta?.uri ?? node.meta?.path;
	if (typeof uri !== "string") return undefined;
	const line = finite(node.meta?.line) ? node.meta.line : undefined;
	const column = finite(node.meta?.column) ? node.meta.column : undefined;
	return { uri, line, column };
}

function copyNode(node: GraphNode): GraphNode {
	return { ...node, meta: node.meta ? { ...node.meta } : undefined };
}

/** Normalizes all wire formats without losing agent arrival order. */
export function adaptGraph(kind: GraphKind, snapshot: GraphSnapshot): AdaptedGraph {
	const ids = new Set<string>();
	const nodes = snapshot.nodes.map((node, order) => {
		if (!node.id || ids.has(node.id)) throw new Error(`Graph node id must be unique: ${node.id}`);
		ids.add(node.id);
		const copied = copyNode(node);
		if (kind === "agent") copied.meta = { ...copied.meta, arrivalOrder: order };
		return copied;
	});
	const edgeIds = new Set<string>();
	const edges = snapshot.edges.map(edge => {
		if (!edge.id || edgeIds.has(edge.id)) throw new Error(`Graph edge id must be unique: ${edge.id}`);
		if (!ids.has(edge.source) || !ids.has(edge.target))
			throw new Error(`Graph edge ${edge.id} has a missing endpoint`);
		edgeIds.add(edge.id);
		return { ...edge };
	});
	if (kind === "git") assignGitLanes(nodes, edges);
	return { kind, revision: snapshot.revision, nodes, edges };
}

function assignGitLanes(nodes: GraphNode[], edges: readonly GraphEdge[]): void {
	const childLanes = new Map<string, number>();
	const parents = new Map<string, string[]>();
	for (const edge of edges) parents.set(edge.source, [...(parents.get(edge.source) ?? []), edge.target]);
	for (let index = 0; index < nodes.length; index += 1) {
		const node = nodes[index]!;
		const explicit = finite(node.meta?.lane) ? Math.max(0, Math.floor(node.meta.lane)) : undefined;
		const inherited = parents
			.get(node.id)
			?.map(id => childLanes.get(id))
			.find(finite);
		const lane = explicit ?? inherited ?? (index === 0 ? 0 : deterministicSeed(node.id) > 0.82 ? 1 : 0);
		childLanes.set(node.id, lane);
		node.meta = { ...node.meta, lane, commitOrder: index };
	}
}

export function layoutCacheKey(workspaceId: string, kind: GraphKind, layoutVersion: string): string {
	return `${CACHE_PREFIX}:${encodeURIComponent(workspaceId)}:${kind}:${encodeURIComponent(layoutVersion)}`;
}

export function readLayoutCache(
	storage: LayoutStorage | undefined,
	workspaceId: string,
	kind: GraphKind,
	layoutVersion: string,
): GraphLayoutCacheV1 | undefined {
	if (!storage) return undefined;
	try {
		const parsed = JSON.parse(
			storage.getItem(layoutCacheKey(workspaceId, kind, layoutVersion)) ?? "null",
		) as Partial<GraphLayoutCacheV1> | null;
		if (
			parsed?.schema !== CACHE_SCHEMA ||
			parsed.workspaceId !== workspaceId ||
			parsed.kind !== kind ||
			parsed.layoutVersion !== layoutVersion ||
			typeof parsed.nodes !== "object" ||
			parsed.nodes === null ||
			!finite(parsed.camera?.x) ||
			!finite(parsed.camera?.y) ||
			!finite(parsed.camera?.k)
		)
			return undefined;
		return parsed as GraphLayoutCacheV1;
	} catch {
		return undefined;
	}
}

export function writeLayoutCache(
	storage: LayoutStorage | undefined,
	workspaceId: string,
	kind: GraphKind,
	layoutVersion: string,
	nodes: readonly LayoutNode[],
	camera: CameraTransform,
	now = Date.now(),
): void {
	if (!storage) return;
	const cachedNodes: GraphLayoutCacheV1["nodes"] = {};
	for (const node of nodes) {
		if (!finite(node.x) || !finite(node.y)) continue;
		cachedNodes[node.id] = {
			x: node.x,
			y: node.y,
			pinned: node.pinned,
			...(finite(node.fx) ? { fx: node.fx } : {}),
			...(finite(node.fy) ? { fy: node.fy } : {}),
		};
	}
	storage.setItem(
		layoutCacheKey(workspaceId, kind, layoutVersion),
		JSON.stringify({
			schema: CACHE_SCHEMA,
			workspaceId,
			kind,
			layoutVersion,
			nodes: cachedNodes,
			camera: { ...camera },
			updatedAt: now,
		} satisfies GraphLayoutCacheV1),
	);
}

function sameNodeData(current: LayoutNode, incoming: GraphNode): boolean {
	return (
		current.label === incoming.label &&
		current.kind === incoming.kind &&
		current.group === incoming.group &&
		JSON.stringify(current.meta) === JSON.stringify(incoming.meta)
	);
}

export function endpointId(endpoint: string | LayoutNode): string {
	return typeof endpoint === "string" ? endpoint : endpoint.id;
}

export class ForceGraphLayout {
	readonly kind: GraphKind;
	private readonly byId = new Map<string, LayoutNode>();
	private readonly edgeById = new Map<string, LayoutEdge>();
	private readonly simulation: Simulation<LayoutNode, LayoutEdge> | undefined;
	private tickListener: (() => void) | undefined;
	private readonly cache: GraphLayoutCacheV1 | undefined;

	constructor(kind: GraphKind, cache?: GraphLayoutCacheV1) {
		this.kind = kind;
		this.cache = cache;
		if (kind !== "git") {
			this.simulation = forceSimulation<LayoutNode>()
				.randomSource(randomLcg(0.417))
				.alphaDecay(0.055)
				.velocityDecay(0.36)
				.force(
					"link",
					forceLink<LayoutNode, LayoutEdge>()
						.id(node => node.id)
						.distance(72)
						.strength(0.25),
				)
				.force("charge", forceManyBody<LayoutNode>().strength(-155).distanceMax(520))
				.force("collide", forceCollide<LayoutNode>().radius(28).strength(0.8))
				.force("x", forceX<LayoutNode>(0).strength(0.025))
				.force("y", forceY<LayoutNode>(0).strength(0.025))
				.stop()
				.on("tick", () => this.tickListener?.());
		}
	}

	onTick(listener: (() => void) | undefined): void {
		this.tickListener = listener;
	}
	get nodes(): readonly LayoutNode[] {
		return [...this.byId.values()];
	}
	get edges(): readonly LayoutEdge[] {
		return [...this.edgeById.values()];
	}

	update(snapshot: GraphSnapshot): LayoutUpdate {
		const adapted = adaptGraph(this.kind, snapshot);
		const incomingIds = new Set(adapted.nodes.map(node => node.id));
		const incomingEdgeIds = new Set(adapted.edges.map(edge => edge.id));
		const insertedNodeIds = new Set<string>();
		const changedNodeIds = new Set<string>();
		const removedNodeIds = new Set([...this.byId.keys()].filter(id => !incomingIds.has(id)));
		const insertedEdgeIds = new Set(adapted.edges.filter(edge => !this.edgeById.has(edge.id)).map(edge => edge.id));
		const removedEdgeIds = new Set([...this.edgeById.keys()].filter(id => !incomingEdgeIds.has(id)));
		for (const id of removedNodeIds) this.byId.delete(id);
		for (const id of removedEdgeIds) this.edgeById.delete(id);

		for (let order = 0; order < adapted.nodes.length; order += 1) {
			const incoming = adapted.nodes[order]!;
			const current = this.byId.get(incoming.id);
			if (current) {
				if (!sameNodeData(current, incoming) || incoming.state === "changing") changedNodeIds.add(incoming.id);
				Object.assign(current, {
					label: incoming.label,
					kind: incoming.kind,
					group: incoming.group,
					meta: Object.freeze({ ...incoming.meta }),
					source: sourceLocation(incoming),
					order,
					state: incoming.state ?? (changedNodeIds.has(incoming.id) ? "changing" : "stable"),
				});
				continue;
			}
			insertedNodeIds.add(incoming.id);
			const cached = this.cache?.nodes[incoming.id];
			const seeded = cached ?? deterministicPoint(incoming.id);
			this.byId.set(incoming.id, {
				id: incoming.id,
				label: incoming.label,
				kind: incoming.kind,
				group: incoming.group,
				state: incoming.state ?? "entering",
				order,
				source: sourceLocation(incoming),
				meta: Object.freeze({ ...incoming.meta }),
				x: seeded.x,
				y: seeded.y,
				pinned: cached?.pinned ?? false,
				fx: cached?.pinned ? (cached.fx ?? seeded.x) : null,
				fy: cached?.pinned ? (cached.fy ?? seeded.y) : null,
			});
		}
		for (const incoming of adapted.edges) {
			const current = this.edgeById.get(incoming.id);
			if (current)
				Object.assign(current, {
					source: incoming.source,
					target: incoming.target,
					kind: incoming.kind,
					state: incoming.state ?? "stable",
				});
			else this.edgeById.set(incoming.id, { ...incoming, state: incoming.state ?? "entering" });
		}
		if (this.kind === "git") this.layoutGit();
		else this.updateSimulation(insertedNodeIds.size > 0 || removedNodeIds.size > 0);
		return {
			nodes: this.nodes,
			edges: this.edges,
			insertedNodeIds,
			changedNodeIds,
			removedNodeIds,
			insertedEdgeIds,
			removedEdgeIds,
		};
	}

	private updateSimulation(topologyChanged: boolean): void {
		if (!this.simulation) return;
		this.simulation.nodes(this.nodes as LayoutNode[]);
		(this.simulation.force("link") as ReturnType<typeof forceLink<LayoutNode, LayoutEdge>>).links(
			this.edges as LayoutEdge[],
		);
		if (topologyChanged) this.simulation.alpha(Math.max(this.simulation.alpha(), 0.24)).restart();
		else if (this.simulation.alpha() < 0.03) this.simulation.stop();
	}

	private layoutGit(): void {
		for (const node of this.byId.values()) {
			const lane = finite(node.meta.lane) ? node.meta.lane : 0;
			Object.assign(node, { x: lane * 42, y: node.order * 64, vx: 0, vy: 0 });
		}
		this.tickListener?.();
	}

	pin(id: string, x?: number, y?: number): void {
		const node = this.byId.get(id);
		if (!node) return;
		const px = x ?? node.x ?? 0;
		const py = y ?? node.y ?? 0;
		Object.assign(node, { pinned: true, fx: px, fy: py, x: px, y: py });
		this.simulation?.alpha(Math.max(this.simulation.alpha(), 0.08)).restart();
	}
	unpin(id: string): void {
		const node = this.byId.get(id);
		if (!node) return;
		Object.assign(node, { pinned: false, fx: null, fy: null });
		this.simulation?.alpha(Math.max(this.simulation.alpha(), 0.12)).restart();
	}
	stop(): void {
		this.simulation?.stop();
	}
}

export type CameraOwner = "initial" | "user" | "fit" | "search" | "selection";

/** Single writer for both D3 zoom events and programmatic camera moves. */
export class CameraAuthority {
	private transformValue: CameraTransform;
	private ownerValue: CameraOwner = "initial";
	private sequence = 0;
	constructor(initial: CameraTransform = DEFAULT_CAMERA) {
		this.transformValue = { ...initial };
	}
	get transform(): CameraTransform {
		return { ...this.transformValue };
	}
	get owner(): CameraOwner {
		return this.ownerValue;
	}
	claim(owner: CameraOwner, transform: CameraTransform): number {
		if (!finite(transform.x) || !finite(transform.y) || !finite(transform.k) || transform.k <= 0)
			throw new RangeError("Camera transform must be finite with positive scale");
		this.ownerValue = owner;
		this.transformValue = { ...transform };
		this.sequence += 1;
		return this.sequence;
	}
	isCurrent(sequence: number, owner: CameraOwner): boolean {
		return this.sequence === sequence && this.ownerValue === owner;
	}
}

export function tweenPoint(
	from: { x: number; y: number },
	to: { x: number; y: number },
	progress: number,
	reducedMotion: boolean,
): { x: number; y: number } {
	if (reducedMotion) return { ...to };
	const t = Math.min(1, Math.max(0, progress));
	const eased = 1 - (1 - t) ** 3;
	return { x: from.x + (to.x - from.x) * eased, y: from.y + (to.y - from.y) * eased };
}

export function nodeMatches(node: LayoutNode, search: string, groups: ReadonlySet<string>): boolean {
	if (groups.size > 0 && !groups.has(node.group ?? node.kind)) return false;
	const needle = search.trim().toLocaleLowerCase();
	return (
		needle.length === 0 ||
		node.label.toLocaleLowerCase().includes(needle) ||
		node.id.toLocaleLowerCase().includes(needle)
	);
}

export function visibleGraph(
	nodes: readonly LayoutNode[],
	edges: readonly LayoutEdge[],
	search: string,
	groups: ReadonlySet<string>,
	scopeId?: string,
): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
	let allowed = new Set(nodes.filter(node => nodeMatches(node, search, groups)).map(node => node.id));
	if (scopeId) {
		const scoped = new Set([scopeId]);
		for (const edge of edges) {
			const source = endpointId(edge.source);
			const target = endpointId(edge.target);
			if (source === scopeId) scoped.add(target);
			if (target === scopeId) scoped.add(source);
		}
		allowed = new Set([...allowed].filter(id => scoped.has(id)));
	}
	return {
		nodes: nodes.filter(node => allowed.has(node.id)),
		edges: edges.filter(edge => allowed.has(endpointId(edge.source)) && allowed.has(endpointId(edge.target))),
	};
}

export function keyboardTarget(
	nodes: readonly LayoutNode[],
	currentId: string | undefined,
	key: string,
): string | undefined {
	if (nodes.length === 0) return undefined;
	const ordered = [...nodes].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
	const index = Math.max(
		0,
		ordered.findIndex(node => node.id === currentId),
	);
	if (key === "Home") return ordered[0]?.id;
	if (key === "End") return ordered.at(-1)?.id;
	if (key === "ArrowRight" || key === "ArrowDown") return ordered[(index + 1) % ordered.length]?.id;
	if (key === "ArrowLeft" || key === "ArrowUp") return ordered[(index - 1 + ordered.length) % ordered.length]?.id;
	return currentId;
}

export function openNodeSource(
	kind: GraphKind,
	node: LayoutNode,
	open: ((source: GraphSourceLocation) => void) | undefined,
): boolean {
	if (kind !== "code" || !node.source || !open) return false;
	open(node.source);
	return true;
}
