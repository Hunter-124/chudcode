import type { GitCommit, GraphEdge, GraphNode, GraphSnapshot } from "../protocol";

function nodeId(hash: string): string {
	return `git:${hash}`;
}

function edgeId(child: string, parent: string): string {
	return `git-parent:${child}:${parent}`;
}

function transitionIdentity(
	priorRevision: number,
	currentRevision: number,
	id: string,
	state: NonNullable<GraphNode["state"]>,
): string {
	return `${priorRevision}:${currentRevision}:${state}:${id}`;
}

interface CoreNode {
	id: string;
	label: string;
	kind: string;
	group?: string;
	meta: Record<string, string | number | boolean | null>;
}

function coreNodes(commits: readonly GitCommit[]): CoreNode[] {
	const nodes: CoreNode[] = commits.map(commit => ({
		id: nodeId(commit.hash),
		label: commit.subject || commit.hash.slice(0, 12),
		kind: "commit",
		group: commit.refs[0],
		meta: {
			hash: commit.hash,
			author: commit.author,
			timestampMs: commit.timestampMs,
			refs: commit.refs.join(", "),
			abbreviatedHash: commit.hash.slice(0, 12),
		},
	}));
	const known = new Set(nodes.map(node => node.id));
	for (const commit of commits) {
		for (const parent of commit.parents) {
			const id = nodeId(parent);
			if (known.has(id)) continue;
			known.add(id);
			nodes.push({
				id,
				label: parent.slice(0, 12),
				kind: "commit-boundary",
				meta: { hash: parent, abbreviatedHash: parent.slice(0, 12), truncated: true },
			});
		}
	}
	return nodes;
}

function coreEdges(commits: readonly GitCommit[]): GraphEdge[] {
	return commits.flatMap(commit =>
		commit.parents.map(parent => ({
			id: edgeId(commit.hash, parent),
			source: nodeId(commit.hash),
			target: nodeId(parent),
			kind: "parent",
		})),
	);
}

function semanticMeta(meta: GraphNode["meta"]): string {
	if (meta === undefined) return "";
	const filtered = Object.entries(meta)
		.filter(([key]) => key !== "priorRevision" && key !== "currentRevision" && key !== "changeIdentity")
		.sort(([left], [right]) => left.localeCompare(right));
	return JSON.stringify(filtered);
}

function nodeChanged(previous: GraphNode, current: CoreNode): boolean {
	return (
		previous.label !== current.label ||
		previous.kind !== current.kind ||
		previous.group !== current.group ||
		semanticMeta(previous.meta) !== semanticMeta(current.meta)
	);
}

/**
 * Stateful adapter that marks graph transitions while keeping commit and parent-edge IDs stable.
 * The frontend owns timing/animation; this adapter only supplies revision/change identity.
 */
export class GitGraphAdapter {
	#previous: GraphSnapshot | undefined;
	#revision = 0;

	reset(): void {
		this.#previous = undefined;
		this.#revision = 0;
	}

	snapshot(commits: readonly GitCommit[]): GraphSnapshot {
		const priorRevision = this.#previous?.revision ?? 0;
		const currentRevision = ++this.#revision;
		const previousNodes = new Map(this.#previous?.nodes.map(node => [node.id, node]) ?? []);
		const nextCoreNodes = coreNodes(commits);
		const nextIds = new Set(nextCoreNodes.map(node => node.id));
		const nodes: GraphNode[] = nextCoreNodes.map(node => {
			const previous = previousNodes.get(node.id);
			const state: NonNullable<GraphNode["state"]> =
				previous === undefined ? "entering" : nodeChanged(previous, node) ? "changing" : "stable";
			return {
				...node,
				state,
				meta: {
					...node.meta,
					priorRevision,
					currentRevision,
					changeIdentity: transitionIdentity(priorRevision, currentRevision, node.id, state),
				},
			};
		});
		for (const previous of previousNodes.values()) {
			if (nextIds.has(previous.id) || previous.state === "leaving") continue;
			nodes.push({
				...previous,
				state: "leaving",
				meta: {
					...previous.meta,
					priorRevision,
					currentRevision,
					changeIdentity: transitionIdentity(priorRevision, currentRevision, previous.id, "leaving"),
				},
			});
		}

		const previousEdges = new Map(this.#previous?.edges.map(edge => [edge.id, edge]) ?? []);
		const currentEdges = coreEdges(commits);
		const currentEdgeIds = new Set(currentEdges.map(edge => edge.id));
		const edges: GraphEdge[] = currentEdges.map(edge => ({
			...edge,
			state: previousEdges.has(edge.id) ? "stable" : "entering",
		}));
		for (const previous of previousEdges.values()) {
			if (currentEdgeIds.has(previous.id) || previous.state === "leaving") continue;
			edges.push({ ...previous, state: "leaving" });
		}

		const snapshot = { revision: currentRevision, nodes, edges } satisfies GraphSnapshot;
		this.#previous = snapshot;
		return snapshot;
	}
}

export function gitGraphSnapshot(commits: readonly GitCommit[], revision = 1): GraphSnapshot {
	const adapter = new GitGraphAdapter();
	const snapshot = adapter.snapshot(commits);
	if (revision === snapshot.revision) return snapshot;
	return {
		...snapshot,
		revision,
		nodes: snapshot.nodes.map(node => ({
			...node,
			meta: { ...node.meta, currentRevision: revision, changeIdentity: `0:${revision}:${node.state}:${node.id}` },
		})),
	};
}
