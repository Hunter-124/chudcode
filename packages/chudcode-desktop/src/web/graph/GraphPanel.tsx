import {
	type D3DragEvent,
	type D3ZoomEvent,
	drag as d3Drag,
	zoom as d3Zoom,
	select,
	type ZoomBehavior,
	zoomIdentity,
} from "d3";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GraphSnapshot } from "../../protocol";
import type { DesktopClient } from "../desktop-client";
import { selectGraph, useDesktop } from "../use-desktop";
import {
	CameraAuthority,
	type CameraOwner,
	type CameraTransform,
	endpointId,
	ForceGraphLayout,
	type GraphKind,
	type GraphSourceLocation,
	keyboardTarget,
	type LayoutNode,
	openNodeSource,
	readLayoutCache,
	tweenPoint,
	visibleGraph,
	writeLayoutCache,
} from "./force-graph";
import "./graph.css";

export interface GraphPanelProps {
	client: DesktopClient;
	workspaceId: string;
	kind: GraphKind;
	layoutVersion?: string;
	onOpenSource?: (source: GraphSourceLocation) => void;
	className?: string;
}

type PointMap = ReadonlyMap<string, { x: number; y: number }>;

function localStorageOrUndefined(): Storage | undefined {
	try {
		return globalThis.localStorage;
	} catch {
		return undefined;
	}
}

function reducedMotion(): boolean {
	if (typeof document !== "undefined" && document.documentElement.dataset.motionScale === "0") return true;
	return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function nodePoint(node: LayoutNode): { x: number; y: number } {
	return { x: node.x ?? 0, y: node.y ?? 0 };
}

function boundsTransform(nodes: readonly LayoutNode[], width: number, height: number): CameraTransform {
	if (nodes.length === 0) return { x: width / 2, y: height / 2, k: 1 };
	const xs = nodes.map(node => node.x ?? 0);
	const ys = nodes.map(node => node.y ?? 0);
	const minX = Math.min(...xs);
	const maxX = Math.max(...xs);
	const minY = Math.min(...ys);
	const maxY = Math.max(...ys);
	const graphWidth = Math.max(80, maxX - minX + 88);
	const graphHeight = Math.max(80, maxY - minY + 88);
	const k = Math.min(2.4, Math.max(0.15, Math.min(width / graphWidth, height / graphHeight)));
	return { x: width / 2 - ((minX + maxX) / 2) * k, y: height / 2 - ((minY + maxY) / 2) * k, k };
}

function motionClass(state: LayoutNode["state"]): string {
	if (state === "entering") return "motion-graph-node-insert";
	if (state === "changing") return "motion-graph-changed";
	if (state === "leaving") return "motion-graph-node-remove";
	return "motion-graph-settle";
}

export function GraphPanel({
	client,
	workspaceId,
	kind,
	layoutVersion = "1",
	onOpenSource,
	className = "",
}: GraphPanelProps) {
	const graph = useDesktop(
		client,
		useCallback(snapshot => selectGraph(snapshot, workspaceId, kind), [workspaceId, kind]),
	);
	const storage = useMemo(localStorageOrUndefined, []);
	const cache = useMemo(
		() => readLayoutCache(storage, workspaceId, kind, layoutVersion),
		[storage, workspaceId, kind, layoutVersion],
	);
	const layout = useMemo(() => new ForceGraphLayout(kind, cache), [kind, cache]);
	const camera = useMemo(() => new CameraAuthority(cache?.camera), [cache]);
	const svgRef = useRef<SVGSVGElement>(null);
	const sceneRef = useRef<SVGGElement>(null);
	const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | undefined>(undefined);
	const rafRef = useRef<number | undefined>(undefined);
	const renderedRef = useRef<PointMap>(new Map());
	const previousNodesRef = useRef(new Map<string, LayoutNode>());
	const [points, setPoints] = useState<PointMap>(new Map());
	const [leaving, setLeaving] = useState<LayoutNode[]>([]);
	const [selectedId, setSelectedId] = useState<string>();
	const [search, setSearch] = useState("");
	const [group, setGroup] = useState("");
	const [scoped, setScoped] = useState(false);
	const [showList, setShowList] = useState(false);
	const [announcement, setAnnouncement] = useState("");
	const [sceneRevision, setSceneRevision] = useState(0);
	const isReduced = reducedMotion();

	const schedulePaint = useCallback(() => {
		const targets = new Map(layout.nodes.map(node => [node.id, nodePoint(node)]));
		if (isReduced || typeof requestAnimationFrame !== "function") {
			renderedRef.current = targets;
			setPoints(targets);
			return;
		}
		if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current);
		const from = new Map(renderedRef.current);
		const start = performance.now();
		const frame = (now: number) => {
			const progress = (now - start) / 220;
			const next = new Map<string, { x: number; y: number }>();
			for (const [id, target] of targets) next.set(id, tweenPoint(from.get(id) ?? target, target, progress, false));
			renderedRef.current = next;
			setPoints(next);
			if (progress < 1) rafRef.current = requestAnimationFrame(frame);
			else rafRef.current = undefined;
		};
		rafRef.current = requestAnimationFrame(frame);
	}, [layout, isReduced]);

	useEffect(() => {
		layout.onTick(schedulePaint);
		return () => {
			layout.onTick(undefined);
			layout.stop();
			if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current);
		};
	}, [layout, schedulePaint]);

	useEffect(() => {
		if (graph) return;
		void client.request("graph.snapshot", { workspaceId, kind });
	}, [client, workspaceId, kind, graph]);

	useEffect(() => {
		if (!graph) return;
		const previous = previousNodesRef.current;
		const update = layout.update(graph);
		if (!isReduced && update.removedNodeIds.size > 0) {
			const ghosts = [...update.removedNodeIds]
				.map(id => previous.get(id))
				.filter((node): node is LayoutNode => node !== undefined)
				.map(node => ({ ...node, state: "leaving" as const }));
			setLeaving(ghosts);
			const timer = globalThis.setTimeout(() => setLeaving([]), 240);
			previousNodesRef.current = new Map(layout.nodes.map(node => [node.id, node]));
			schedulePaint();
			setSceneRevision(graph.revision);
			return () => globalThis.clearTimeout(timer);
		}
		setLeaving([]);
		previousNodesRef.current = new Map(layout.nodes.map(node => [node.id, node]));
		schedulePaint();
		setSceneRevision(graph.revision);
	}, [graph, layout, isReduced, schedulePaint]);

	const allGroups = useMemo(
		() => [...new Set(layout.nodes.map(node => node.group ?? node.kind))].sort(),
		[layout, sceneRevision],
	);
	const filtered = useMemo(
		() =>
			visibleGraph(
				layout.nodes,
				layout.edges,
				search,
				group ? new Set([group]) : new Set(),
				scoped ? selectedId : undefined,
			),
		[layout, sceneRevision, points, search, group, scoped, selectedId],
	);

	useEffect(() => {
		const svg = svgRef.current;
		const scene = sceneRef.current;
		if (!svg || !scene) return;
		const behavior = d3Zoom<SVGSVGElement, unknown>()
			.scaleExtent([0.1, 8])
			.on("zoom", (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
				select(scene).attr("transform", event.transform.toString());
				if (event.sourceEvent)
					camera.claim("user", { x: event.transform.x, y: event.transform.y, k: event.transform.k });
			});
		zoomRef.current = behavior;
		select(svg)
			.call(behavior)
			.call(
				behavior.transform,
				zoomIdentity.translate(camera.transform.x, camera.transform.y).scale(camera.transform.k),
			);
		return () => {
			select(svg).on(".zoom", null);
		};
	}, [camera]);

	useEffect(() => {
		const scene = sceneRef.current;
		if (!scene) return;
		const drag = d3Drag<SVGGElement, LayoutNode>()
			.on("start", function (event: D3DragEvent<SVGGElement, LayoutNode, LayoutNode>, node) {
				layout.pin(node.id, event.x, event.y);
				select(this).classed("graph-node--dragging", true);
			})
			.on("drag", (_event: D3DragEvent<SVGGElement, LayoutNode, LayoutNode>, node) => {
				layout.pin(node.id, _event.x, _event.y);
				schedulePaint();
			})
			.on("end", function (_event, node) {
				select(this).classed("graph-node--dragging", false);
				setSelectedId(node.id);
			});
		select(scene)
			.selectAll<SVGGElement, LayoutNode>(".graph-node")
			.data(filtered.nodes, node => node.id)
			.call(drag);
		return () => {
			select(scene).selectAll(".graph-node").on(".drag", null);
		};
	}, [layout, filtered.nodes, schedulePaint]);

	const moveCamera = useCallback(
		(owner: CameraOwner, transform: CameraTransform) => {
			const svg = svgRef.current;
			const behavior = zoomRef.current;
			camera.claim(owner, transform);
			if (!svg || !behavior) return;
			const selection = select(svg);
			const target = zoomIdentity.translate(transform.x, transform.y).scale(transform.k);
			if (isReduced) selection.call(behavior.transform, target);
			else selection.transition().duration(220).call(behavior.transform, target);
		},
		[camera, isReduced],
	);

	const fit = useCallback(() => {
		const svg = svgRef.current;
		if (!svg) return;
		moveCamera("fit", boundsTransform(filtered.nodes, svg.clientWidth || 800, svg.clientHeight || 520));
	}, [filtered.nodes, moveCamera]);

	const selectNode = useCallback(
		(node: LayoutNode, open = false) => {
			setSelectedId(node.id);
			setAnnouncement(`${node.label}, ${node.kind}${node.pinned ? ", pinned" : ""}`);
			if (open) openNodeSource(kind, node, onOpenSource);
		},
		[kind, onOpenSource],
	);

	const focusNode = useCallback(
		(node: LayoutNode, owner: "search" | "selection") => {
			const svg = svgRef.current;
			if (!svg) return;
			const k = camera.transform.k;
			moveCamera(owner, {
				x: (svg.clientWidth || 800) / 2 - (node.x ?? 0) * k,
				y: (svg.clientHeight || 520) / 2 - (node.y ?? 0) * k,
				k,
			});
		},
		[camera, moveCamera],
	);

	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent<SVGSVGElement>) => {
			if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Enter", " "].includes(event.key))
				return;
			event.preventDefault();
			const node = layout.nodes.find(candidate => candidate.id === selectedId);
			if ((event.key === "Enter" || event.key === " ") && node) {
				selectNode(node, true);
				return;
			}
			const target = keyboardTarget(filtered.nodes, selectedId, event.key);
			if (target) {
				const targetNode = layout.nodes.find(candidate => candidate.id === target);
				setSelectedId(target);
				setAnnouncement(`Selected ${targetNode?.label ?? target}`);
				if (targetNode) focusNode(targetNode, "selection");
			}
		},
		[layout, filtered.nodes, selectedId, selectNode, focusNode],
	);

	useEffect(() => {
		return () => writeLayoutCache(storage, workspaceId, kind, layoutVersion, layout.nodes, camera.transform);
	}, [storage, workspaceId, kind, layoutVersion, layout, camera]);

	const selected = layout.nodes.find(node => node.id === selectedId);
	const summary = `${kind} graph, ${filtered.nodes.length} nodes and ${filtered.edges.length} edges`;

	return (
		<section className={`graph-panel ${className}`.trim()} aria-label={`${kind} graph`}>
			<header className="graph-toolbar">
				<label className="graph-search">
					<span className="graph-control-label">Search</span>
					<input
						type="search"
						value={search}
						onChange={event => setSearch(event.currentTarget.value)}
						onKeyDown={event => {
							if (event.key === "Enter") {
								const match = filtered.nodes[0];
								if (match) {
									selectNode(match);
									focusNode(match, "search");
								}
							}
						}}
						placeholder="Node id or label"
					/>
				</label>
				<label>
					<span className="graph-control-label">Filter</span>
					<select value={group} onChange={event => setGroup(event.currentTarget.value)}>
						<option value="">All groups</option>
						{allGroups.map(value => (
							<option key={value} value={value}>
								{value}
							</option>
						))}
					</select>
				</label>
				<button type="button" onClick={fit}>
					Fit
				</button>
				<button
					type="button"
					aria-pressed={scoped}
					disabled={!selectedId}
					onClick={() => setScoped(value => !value)}
				>
					Scope
				</button>
				<button type="button" aria-pressed={showList} onClick={() => setShowList(value => !value)}>
					List
				</button>
				{selected && (
					<button
						type="button"
						aria-pressed={selected.pinned}
						onClick={() => {
							if (selected.pinned) layout.unpin(selected.id);
							else layout.pin(selected.id);
							setSceneRevision(value => value + 1);
						}}
					>
						{selected.pinned ? "Unpin" : "Pin"}
					</button>
				)}
				<output className="graph-summary" aria-live="polite">
					{summary}
				</output>
			</header>
			<div className="graph-canvas-wrap">
				<svg
					ref={svgRef}
					className="graph-canvas"
					role="application"
					aria-label={`${summary}. Use arrow keys to navigate nodes and Enter to open source.`}
					tabIndex={0}
					onKeyDown={handleKeyDown}
				>
					<g ref={sceneRef} className="graph-scene">
						<g className="graph-edges" aria-hidden="true">
							{filtered.edges.map(edge => {
								const source = points.get(endpointId(edge.source));
								const target = points.get(endpointId(edge.target));
								if (!source || !target) return null;
								return (
									<line
										key={edge.id}
										className={`graph-edge ${edge.state === "entering" ? "motion-graph-edge-insert" : edge.state === "changing" ? "motion-graph-flow" : ""}`}
										x1={source.x}
										y1={source.y}
										x2={target.x}
										y2={target.y}
									/>
								);
							})}
						</g>
						<g className="graph-nodes">
							{filtered.nodes.map(node => {
								const point = points.get(node.id) ?? nodePoint(node);
								return (
									<g
										key={node.id}
										data-node-id={node.id}
										className={`graph-node graph-node--${node.kind} ${motionClass(node.state)}${selectedId === node.id ? " graph-node--selected" : ""}${node.pinned ? " graph-node--pinned" : ""}`}
										transform={`translate(${point.x},${point.y})`}
										role="button"
										aria-label={`${node.label}, ${node.kind}`}
										tabIndex={selectedId === node.id ? 0 : -1}
										onClick={() => selectNode(node, true)}
										onDoubleClick={() => layout.pin(node.id)}
									>
										<circle className="graph-node-halo" r="17" />
										<circle className="graph-node-dot" r="7" />
										<text x="12" y="4">
											{node.label}
										</text>
									</g>
								);
							})}
							{leaving.map(node => {
								const point = renderedRef.current.get(node.id) ?? nodePoint(node);
								return (
									<g
										key={`leaving:${node.id}`}
										className="graph-node motion-graph-node-remove"
										transform={`translate(${point.x},${point.y})`}
										aria-hidden="true"
									>
										<circle className="graph-node-halo" r="17" />
										<circle className="graph-node-dot" r="7" />
									</g>
								);
							})}
						</g>
					</g>
				</svg>
				<p className="graph-announcement" aria-live="polite">
					{announcement}
				</p>
				<ol
					className={showList ? "graph-list" : "graph-list graph-list--fallback"}
					aria-label={`${kind} graph nodes`}
				>
					{filtered.nodes.map(node => (
						<li key={node.id}>
							<button
								type="button"
								aria-current={selectedId === node.id ? "true" : undefined}
								onClick={() => selectNode(node, true)}
							>
								{node.label}
								<span>{node.kind}</span>
							</button>
						</li>
					))}
				</ol>
			</div>
		</section>
	);
}

export function GraphPanelPreview({
	graph,
	kind,
	onOpenSource,
}: {
	graph: GraphSnapshot;
	kind: GraphKind;
	onOpenSource?: (source: GraphSourceLocation) => void;
}) {
	const layout = useMemo(() => new ForceGraphLayout(kind), [kind]);
	const nodes = useMemo(() => layout.update(graph).nodes, [layout, graph]);
	useEffect(() => () => layout.stop(), [layout]);
	return (
		<ol className="graph-list graph-list--preview" aria-label={`${kind} graph nodes`}>
			{nodes.map(node => (
				<li key={node.id}>
					<button type="button" onClick={() => openNodeSource(kind, node, onOpenSource)}>
						{node.label}
						<span>{node.kind}</span>
					</button>
				</li>
			))}
		</ol>
	);
}
