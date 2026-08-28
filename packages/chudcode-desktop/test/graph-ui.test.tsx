import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { GraphSnapshot } from "../src/protocol";
import { GraphPanelPreview } from "../src/web/graph/GraphPanel";
import {
	adaptGraph,
	CameraAuthority,
	ForceGraphLayout,
	keyboardTarget,
	layoutCacheKey,
	openNodeSource,
	readLayoutCache,
	tweenPoint,
	visibleGraph,
	writeLayoutCache,
	type LayoutStorage,
} from "../src/web/graph/force-graph";

const base: GraphSnapshot = {
	revision: 1,
	nodes: [
		{ id: "src:a", label: "alpha", kind: "symbol", group: "core", meta: { uri: "file:///workspace/a.ts", line: 7, column: 3 } },
		{ id: "src:b", label: "beta", kind: "symbol", group: "core" },
	],
	edges: [{ id: "calls:a:b", source: "src:a", target: "src:b", kind: "calls" }],
};

class MemoryStorage implements LayoutStorage {
	readonly values = new Map<string, string>();
	getItem(key: string): string | null { return this.values.get(key) ?? null; }
	setItem(key: string, value: string): void { this.values.set(key, value); }
}

describe("incremental graph layout", () => {
	test("retains keyed node objects and pinned positions when one event arrives", () => {
		const layout = new ForceGraphLayout("code");
		layout.update(base);
		layout.stop();
		layout.pin("src:a", 41, -13);
		layout.stop();
		const alpha = layout.nodes.find(node => node.id === "src:a")!;
		const result = layout.update({ ...base, revision: 2, nodes: [...base.nodes, { id: "src:c", label: "gamma", kind: "symbol", group: "leaf", state: "entering" }] });
		layout.stop();
		expect(result.insertedNodeIds).toEqual(new Set(["src:c"]));
		expect(result.removedNodeIds.size).toBe(0);
		expect(layout.nodes.find(node => node.id === "src:a")).toBe(alpha);
		expect({ x: alpha.x, y: alpha.y, fx: alpha.fx, fy: alpha.fy }).toEqual({ x: 41, y: -13, fx: 41, fy: -13 });
	});

	test("persists the workspace/kind/version cache schema and camera", () => {
		const storage = new MemoryStorage();
		const layout = new ForceGraphLayout("code");
		layout.update(base); layout.stop(); layout.pin("src:a", 9, 11); layout.stop();
		writeLayoutCache(storage, "workspace one", "code", "layout-2", layout.nodes, { x: 100, y: 40, k: 1.5 }, 1234);
		const key = layoutCacheKey("workspace one", "code", "layout-2");
		expect(key).toContain("workspace%20one:code:layout-2");
		expect(JSON.parse(storage.values.get(key)!)).toMatchObject({ schema: 1, workspaceId: "workspace one", kind: "code", layoutVersion: "layout-2", updatedAt: 1234 });
		expect(readLayoutCache(storage, "workspace one", "code", "layout-2")).toMatchObject({ camera: { x: 100, y: 40, k: 1.5 }, nodes: { "src:a": { x: 9, y: 11, pinned: true } } });
	});
});

describe("graph adapters and interaction contracts", () => {
	test("preserves agent arrival order and parent edges", () => {
		const adapted = adaptGraph("agent", {
			revision: 4,
			nodes: [{ id: "lead", label: "Lead", kind: "agent" }, { id: "child", label: "Child", kind: "agent" }],
			edges: [{ id: "parent:lead:child", source: "lead", target: "child", kind: "parent" }],
		});
		expect(adapted.nodes.map(node => node.meta?.arrivalOrder)).toEqual([0, 1]);
		expect(adapted.edges[0]).toMatchObject({ source: "lead", target: "child", kind: "parent" });
	});

	test("uses deterministic lanes for git and source locations for code", () => {
		const git: GraphSnapshot = {
			revision: 1,
			nodes: [{ id: "c2", label: "second", kind: "commit" }, { id: "c1", label: "first", kind: "commit" }],
			edges: [{ id: "parent", source: "c2", target: "c1", kind: "parent" }],
		};
		const first = new ForceGraphLayout("git"); const second = new ForceGraphLayout("git");
		first.update(git); second.update(git);
		expect(first.nodes.map(node => [node.id, node.x, node.y])).toEqual(second.nodes.map(node => [node.id, node.x, node.y]));
		const code = new ForceGraphLayout("code"); code.update(base); code.stop();
		expect(code.nodes[0]?.source).toEqual({ uri: "file:///workspace/a.ts", line: 7, column: 3 });
	});

	test("opens only code source nodes", () => {
		const layout = new ForceGraphLayout("code"); layout.update(base); layout.stop();
		const opened: unknown[] = [];
		expect(openNodeSource("code", layout.nodes[0]!, source => opened.push(source))).toBeTrue();
		expect(opened).toEqual([{ uri: "file:///workspace/a.ts", line: 7, column: 3 }]);
		expect(openNodeSource("agent", layout.nodes[0]!, source => opened.push(source))).toBeFalse();
	});

	test("filters and scopes to the selected node neighborhood", () => {
		const layout = new ForceGraphLayout("code"); layout.update(base); layout.stop();
		expect(visibleGraph(layout.nodes, layout.edges, "alp", new Set(), undefined).nodes.map(node => node.id)).toEqual(["src:a"]);
		expect(visibleGraph(layout.nodes, layout.edges, "", new Set(["core"]), "src:a").nodes.map(node => node.id)).toEqual(["src:a", "src:b"]);
	});
});

describe("camera, motion, and accessibility", () => {
	test("keeps one current camera owner", () => {
		const camera = new CameraAuthority();
		const fit = camera.claim("fit", { x: 10, y: 20, k: 2 });
		expect(camera.isCurrent(fit, "fit")).toBeTrue();
		const user = camera.claim("user", { x: -3, y: 8, k: 1.2 });
		expect(camera.isCurrent(fit, "fit")).toBeFalse();
		expect(camera.isCurrent(user, "user")).toBeTrue();
		expect(camera.transform).toEqual({ x: -3, y: 8, k: 1.2 });
	});

	test("snaps coordinates under reduced motion", () => {
		expect(tweenPoint({ x: 0, y: 0 }, { x: 80, y: -20 }, 0.1, true)).toEqual({ x: 80, y: -20 });
		expect(tweenPoint({ x: 0, y: 0 }, { x: 80, y: -20 }, 0.1, false)).not.toEqual({ x: 80, y: -20 });
	});

	test("navigates nodes by keyboard in stable arrival order", () => {
		const layout = new ForceGraphLayout("git"); layout.update(base);
		expect(keyboardTarget(layout.nodes, "src:a", "ArrowRight")).toBe("src:b");
		expect(keyboardTarget(layout.nodes, "src:a", "ArrowLeft")).toBe("src:b");
		expect(keyboardTarget(layout.nodes, "src:b", "Home")).toBe("src:a");
	});

	test("renders a semantic list fallback with labelled node controls", () => {
		const html = renderToStaticMarkup(<GraphPanelPreview graph={base} kind="git" />);
		expect(html).toContain('aria-label="git graph nodes"');
		expect(html).toContain("<ol");
		expect(html).toContain("<button type=\"button\">alpha<span>symbol</span></button>");
		expect(html).toContain("beta");
	});
});
