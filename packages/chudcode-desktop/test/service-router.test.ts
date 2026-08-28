import { describe, expect, it } from "bun:test";
import { type AgentLifecycleRecord, type GraphAgentRef, GraphService } from "../src/graph-service";
import { chromiumAppArgv, defaultBrowserArgv, openDesktopBrowser } from "../src/launch";
import type {
	DesktopEvent,
	DesktopFrame,
	DesktopMethod,
	DesktopRequest,
	DesktopRequestMap,
	DocumentSnapshot,
	GitSnapshot,
	WorkspaceDescriptor,
	WorkspaceEntry,
} from "../src/protocol";
import type { DesktopFrameSink } from "../src/runtime";
import type { DesktopRuntimeHost } from "../src/server";
import {
	type RoutedGit,
	type RoutedLsp,
	type RoutedTerminal,
	type RoutedWorkspace,
	SERVICE_METHODS,
	ServiceRouter,
} from "../src/service-router";

const STAMP = { sha256: "abc", size: 3, mtimeNs: 1, generation: 1 };
const DOCUMENT = {
	id: "file:///workspace/a.ts",
	uri: "file:///workspace/a.ts",
	language: "typescript",
	text: "abc",
	stamp: STAMP,
	dirty: false,
	conflict: false,
};
const COMMIT = {
	hash: "0123456789abcdef",
	parents: [],
	author: "A",
	timestampMs: 1,
	subject: "initial",
	refs: ["HEAD -> main"],
};
const GIT_SNAPSHOT: GitSnapshot = {
	root: "/workspace",
	branch: "main",
	ahead: 0,
	behind: 0,
	files: [],
	commits: [COMMIT],
};

class FakeRuntime implements DesktopRuntimeHost {
	readonly clients = new Set<DesktopFrameSink>();
	readonly delegated: string[] = [];
	disposed = false;

	attach(client: DesktopFrameSink): void {
		this.clients.add(client);
	}

	detach(client: DesktopFrameSink): void {
		this.clients.delete(client);
	}

	async handleRequest(request: DesktopRequest): Promise<DesktopFrame> {
		this.delegated.push(request.method);
		return {
			t: "response",
			id: request.id,
			method: "runtime.hello",
			result: { protocol: 1, product: "test" },
		};
	}

	async dispose(): Promise<void> {
		this.disposed = true;
	}

	emit(frame: DesktopFrame): void {
		for (const client of this.clients) client.send(frame);
	}
}

class FakeRegistry {
	refs: GraphAgentRef[] = [
		{
			id: "Main",
			displayName: "Main",
			kind: "main",
			status: "running",
			createdAt: 1,
			lastActivity: 2,
		},
	];
	readonly listeners = new Set<() => void>();

	list(): GraphAgentRef[] {
		return this.refs.map(ref => ({ ...ref }));
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(): void {
		for (const listener of this.listeners) listener();
	}
}

class FakeWorkspace implements RoutedWorkspace {
	readonly id = "workspace-1";
	readonly rootPath = "/workspace";
	readonly descriptor: WorkspaceDescriptor = { id: this.id, rootPath: this.rootPath, displayName: "workspace" };
	readonly calls: string[] = [];

	rootUri(): string {
		return "file:///workspace";
	}

	async list(_uri?: string): Promise<WorkspaceEntry[]> {
		this.calls.push("list");
		return [
			{ uri: DOCUMENT.uri, name: "a.ts", relativePath: "a.ts", directory: false, ignored: false, stamp: STAMP },
		];
	}

	async read(_uri: string): Promise<DocumentSnapshot> {
		this.calls.push("read");
		return { ...DOCUMENT };
	}

	async write(
		_uri: string,
		_text: string,
		_expectedSha256: string,
		_origin?: "agent" | "user",
	): Promise<DocumentSnapshot["stamp"]> {
		this.calls.push("write");
		return STAMP;
	}

	async stat(_uri: string): Promise<WorkspaceEntry> {
		this.calls.push("stat");
		return { uri: DOCUMENT.uri, name: "a.ts", relativePath: "a.ts", directory: false, ignored: false, stamp: STAMP };
	}

	async create(
		uri: string,
		options?: { directory?: boolean; text?: string; origin?: "agent" | "user" },
	): Promise<WorkspaceEntry> {
		this.calls.push("create");
		return {
			uri,
			name: "new.ts",
			relativePath: "new.ts",
			directory: options?.directory ?? false,
			ignored: false,
			stamp: STAMP,
		};
	}

	async rename(_from: string, to: string, _origin?: "agent" | "user"): Promise<WorkspaceEntry> {
		this.calls.push("rename");
		return { uri: to, name: "b.ts", relativePath: "b.ts", directory: false, ignored: false, stamp: STAMP };
	}

	async copy(
		_from: string,
		to: string,
		_options?: { recursive?: boolean; overwrite?: boolean; origin?: "agent" | "user" },
	): Promise<WorkspaceEntry> {
		this.calls.push("copy");
		return { uri: to, name: "copy.ts", relativePath: "copy.ts", directory: false, ignored: false, stamp: STAMP };
	}

	async remove(_uri: string, _mode?: "trash" | "permanent", _origin?: "agent" | "user"): Promise<boolean> {
		this.calls.push("remove");
		return true;
	}

	async reveal(_uri: string): Promise<boolean> {
		this.calls.push("reveal");
		return true;
	}
}

class FakeGit implements RoutedGit {
	readonly calls: string[] = [];

	async snapshot() {
		this.calls.push("snapshot");
		return GIT_SNAPSHOT;
	}
	async branches() {
		this.calls.push("branches");
		return [{ name: "main", current: true, remote: false }];
	}
	async remotes() {
		this.calls.push("remotes");
		return [{ name: "origin", fetchUrl: "local", pushUrl: "local" }];
	}
	async fetch() {
		this.calls.push("fetch");
		return GIT_SNAPSHOT;
	}
	async pull() {
		this.calls.push("pull");
		return GIT_SNAPSHOT;
	}
	async push() {
		this.calls.push("push");
		return GIT_SNAPSHOT;
	}
	async createBranch() {
		this.calls.push("createBranch");
		return GIT_SNAPSHOT;
	}
	async hunk() {
		this.calls.push("hunk");
		return GIT_SNAPSHOT;
	}
	async diff() {
		this.calls.push("diff");
		return "diff";
	}
	async stage() {
		this.calls.push("stage");
		return GIT_SNAPSHOT;
	}
	async unstage() {
		this.calls.push("unstage");
		return GIT_SNAPSHOT;
	}
	async commit() {
		this.calls.push("commit");
		return { commit: COMMIT, snapshot: GIT_SNAPSHOT };
	}
	async checkout() {
		this.calls.push("checkout");
		return GIT_SNAPSHOT;
	}
}

class FakeLsp implements RoutedLsp {
	readonly calls: string[] = [];

	async openWorkspace() {
		this.calls.push("openWorkspace");
	}
	async closeWorkspace() {
		this.calls.push("closeWorkspace");
	}
	async openDocument() {
		this.calls.push("openDocument");
		return DOCUMENT.uri;
	}
	async changeDocument() {
		this.calls.push("changeDocument");
	}
	async saveDocument() {
		this.calls.push("saveDocument");
	}
	async closeDocument() {
		this.calls.push("closeDocument");
	}
	async requestFromProtocol(params: DesktopRequestMap["lsp.request"]["params"]): Promise<unknown> {
		this.calls.push(params.method);
		if (params.method === "workspace/symbol") {
			return [
				{
					name: "alpha",
					kind: 12,
					location: { uri: DOCUMENT.uri, range: { start: { line: 0, character: 0 } } },
				},
			];
		}
		if (params.method === "textDocument/references") {
			return [{ uri: DOCUMENT.uri, range: { start: { line: 2, character: 4 } } }];
		}
		return { ok: true };
	}
	async shutdown() {
		this.calls.push("shutdown");
	}
}

class FakeTerminal implements RoutedTerminal {
	readonly calls: string[] = [];

	async create() {
		this.calls.push("create");
		return { terminalId: "terminal-1" };
	}
	write() {
		this.calls.push("write");
		return { accepted: true };
	}
	resize() {
		this.calls.push("resize");
		return {};
	}
	async close() {
		this.calls.push("close");
		return {};
	}
	async dispose() {
		this.calls.push("dispose");
	}
}
class FakeProjects {
	readonly calls: string[] = [];

	async recent() {
		this.calls.push("recent");
		return [{ rootPath: "/workspace", displayName: "workspace", lastOpenedMs: 1 }];
	}

	async pick(initialPath?: string) {
		this.calls.push(`pick:${initialPath ?? ""}`);
		return { rootPath: "/workspace", cancelled: false };
	}

	async recordOpened(rootPath: string) {
		this.calls.push(`record:${rootPath}`);
	}
}

function request<M extends DesktopMethod>(
	id: number,
	method: M,
	params: DesktopRequestMap[M]["params"],
): DesktopRequest<M> {
	return { t: "request", id, method, params } as DesktopRequest<M>;
}

describe("ServiceRouter", () => {
	it("exhaustively dispatches every workspace, Git, terminal, LSP, and graph method", async () => {
		const runtime = new FakeRuntime();
		const registry = new FakeRegistry();
		const workspace = new FakeWorkspace();
		const git = new FakeGit();
		const lsp = new FakeLsp();
		const terminal = new FakeTerminal();
		const projects = new FakeProjects();
		let watcherCreated = false;
		const graph = new GraphService({
			lsp,
			registry,
			readFile: async () => {
				const error = new Error("missing") as NodeJS.ErrnoException;
				error.code = "ENOENT";
				throw error;
			},
		});
		const router = new ServiceRouter({
			runtime,
			projects,
			registry,
			workspaceFactory: async () => workspace,
			watcherFactory: () => {
				watcherCreated = true;
				return { start: async () => {}, close: () => {} };
			},
			searchFactory: () => ({ search: async () => [{ uri: DOCUMENT.uri, preview: "a.ts" }] }),
			gitFactory: { discover: async () => git, init: async () => git },
			terminalFactory: () => terminal,
			lsp,
			graph,
		});

		const called: DesktopMethod[] = [];
		let id = 0;
		const invoke = async <M extends DesktopMethod>(method: M, params: DesktopRequestMap[M]["params"]) => {
			called.push(method);
			const frame = await router.handleRequest(request(++id, method, params));
			expect(frame.t).toBe("response");
			if (frame.t === "response") expect(frame.error).toBeUndefined();
		};
		await invoke("workspace.recent", {});
		await invoke("workspace.pick", { initialPath: "/workspace" });
		await invoke("workspace.open", { rootPath: "/workspace" });
		await invoke("workspace.list", { workspaceId: workspace.id });
		await invoke("workspace.read", { workspaceId: workspace.id, uri: DOCUMENT.uri });
		await invoke("workspace.write", {
			workspaceId: workspace.id,
			uri: DOCUMENT.uri,
			text: "abc",
			expectedSha256: "abc",
		});
		await invoke("workspace.stat", { workspaceId: workspace.id, uri: DOCUMENT.uri });
		await invoke("workspace.create", { workspaceId: workspace.id, uri: "file:///workspace/new.ts" });
		await invoke("workspace.rename", { workspaceId: workspace.id, from: DOCUMENT.uri, to: "file:///workspace/b.ts" });
		await invoke("workspace.copy", {
			workspaceId: workspace.id,
			from: DOCUMENT.uri,
			to: "file:///workspace/copy.ts",
		});
		await invoke("workspace.remove", { workspaceId: workspace.id, uri: DOCUMENT.uri, mode: "permanent" });
		await invoke("workspace.reveal", { workspaceId: workspace.id, uri: DOCUMENT.uri });
		await invoke("workspace.search", { workspaceId: workspace.id, query: { text: "a", kind: "files" } });
		await invoke("git.init", { workspaceId: workspace.id });
		await invoke("git.branches", { workspaceId: workspace.id });
		await invoke("git.remotes", { workspaceId: workspace.id });
		await invoke("git.fetch", { workspaceId: workspace.id });
		await invoke("git.pull", { workspaceId: workspace.id });
		await invoke("git.push", { workspaceId: workspace.id });
		await invoke("git.branch.create", { workspaceId: workspace.id, name: "feature" });
		await invoke("git.hunk", { workspaceId: workspace.id, path: "a.ts", hunkId: "h1", action: "stage" });
		await invoke("git.snapshot", { workspaceId: workspace.id });
		await invoke("git.diff", { workspaceId: workspace.id });
		await invoke("git.stage", { workspaceId: workspace.id, paths: ["a.ts"] });
		await invoke("git.unstage", { workspaceId: workspace.id, paths: ["a.ts"] });
		await invoke("git.commit", { workspaceId: workspace.id, message: "commit" });
		await invoke("git.checkout", { workspaceId: workspace.id, ref: "main" });
		await invoke("terminal.create", { workspaceId: workspace.id, cols: 80, rows: 24 });
		await invoke("terminal.write", { terminalId: "terminal-1", data: "x" });
		await invoke("terminal.resize", { terminalId: "terminal-1", cols: 100, rows: 30 });
		await invoke("terminal.close", { terminalId: "terminal-1" });
		await invoke("lsp.request", { workspaceId: workspace.id, method: "workspace/symbol", query: "a" });
		await invoke("graph.snapshot", { workspaceId: workspace.id, kind: "code" });
		await invoke("graph.snapshot", { workspaceId: workspace.id, kind: "git" });
		await invoke("graph.snapshot", { workspaceId: workspace.id, kind: "agent" });

		expect(new Set(called)).toEqual(new Set(SERVICE_METHODS));
		expect(watcherCreated).toBeTrue();
		await router.dispose();
		expect(runtime.disposed).toBeTrue();
	});

	it("forwards service and lifecycle events through attached runtime sinks", async () => {
		const runtime = new FakeRuntime();
		const registry = new FakeRegistry();
		const workspace = new FakeWorkspace();
		const git = new FakeGit();
		const lsp = new FakeLsp();
		const projects = new FakeProjects();
		let onChanges: ((changes: Array<{ kind: "modified"; uri: string; origin: "external" }>) => void) | undefined;
		let terminalEmit: ((event: DesktopEvent) => void) | undefined;
		let diagnosticsEmit: ((event: Extract<DesktopEvent, { t: "diagnostics" }>) => void) | undefined;
		const graph = new GraphService({
			lsp,
			registry,
			readFile: async () => JSON.stringify({ nodes: [{ id: "code:one", label: "one", kind: "symbol" }], edges: [] }),
		});
		const router = new ServiceRouter({
			runtime,
			projects,
			registry,
			workspaceFactory: async () => workspace,
			watcherFactory: (_workspace, callback) => {
				onChanges = callback as typeof onChanges;
				return { start: async () => {}, close: () => {} };
			},
			searchFactory: () => ({ search: async () => [] }),
			gitFactory: { discover: async () => git, init: async () => git },
			terminalFactory: (_resolve, emit) => {
				terminalEmit = emit;
				return new FakeTerminal();
			},
			lspFactory: emit => {
				diagnosticsEmit = emit;
				return lsp;
			},
			graph,
		});
		const frames: DesktopFrame[] = [];
		const sink: DesktopFrameSink = {
			send: frame => {
				frames.push(frame);
				return true;
			},
			close: () => {},
		};
		router.attach(sink);
		await router.handleRequest(request(1, "workspace.open", { rootPath: "/workspace" }));
		await router.handleRequest(request(2, "workspace.read", { workspaceId: workspace.id, uri: DOCUMENT.uri }));
		await router.handleRequest(request(3, "git.snapshot", { workspaceId: workspace.id }));
		await router.handleRequest(request(4, "graph.snapshot", { workspaceId: workspace.id, kind: "agent" }));
		onChanges?.([{ kind: "modified", uri: DOCUMENT.uri, origin: "external" }]);
		terminalEmit?.({
			t: "terminal-data",
			terminalId: "terminal-1",
			dataBase64: Buffer.from("hello").toString("base64"),
		});
		diagnosticsEmit?.({ t: "diagnostics", workspaceId: workspace.id, diagnostics: [] });
		const lifecycle: AgentLifecycleRecord = { id: "worker", agent: "task", status: "started", index: 0 };
		runtime.emit({
			t: "bus",
			sessionPath: "/sessions/main.jsonl",
			channel: "task:subagent:lifecycle",
			data: lifecycle,
		});
		registry.emit();
		await Promise.resolve();

		const eventTypes = new Set(frames.map(frame => frame.t));
		for (const type of [
			"document",
			"git",
			"graph",
			"workspace-change",
			"terminal-data",
			"diagnostics",
			"bus",
		] as const) {
			expect(eventTypes.has(type)).toBeTrue();
		}
		expect(
			frames.some(
				frame =>
					frame.t === "graph" &&
					frame.kind === "agent" &&
					frame.graph.nodes.some(node => node.id === "agent:worker"),
			),
		).toBeTrue();
		await router.dispose();
	});

	it("delegates core methods and rejects unknown methods without reaching the runtime", async () => {
		const runtime = new FakeRuntime();
		const registry = new FakeRegistry();
		const lsp = new FakeLsp();
		const router = new ServiceRouter({
			runtime,
			registry,
			projects: new FakeProjects(),
			lsp,
			workspaceFactory: async () => new FakeWorkspace(),
			watcherFactory: () => ({ start: async () => {}, close: () => {} }),
			searchFactory: () => ({ search: async () => [] }),
			gitFactory: { discover: async () => new FakeGit(), init: async () => new FakeGit() },
			terminalFactory: () => new FakeTerminal(),
		});
		const core = await router.handleRequest(request(1, "runtime.hello", { protocol: 1 }));
		expect(core.t).toBe("response");
		await router.handleRequest(
			request(2, "agent.command", {
				sessionPath: "/sessions/main.jsonl",
				cmd: "chat",
				agentId: "worker",
				text: "hello",
			}),
		);
		await router.handleRequest(
			request(3, "agent.transcript", { sessionPath: "/sessions/main.jsonl", agentId: "worker", fromByte: 0 }),
		);
		expect(runtime.delegated).toEqual(["runtime.hello", "agent.command", "agent.transcript"]);
		const unknown = await router.handleRequest({ t: "request", id: 4, method: "unknown.method", params: {} });
		expect(unknown).toMatchObject({ t: "response", error: { code: "METHOD_NOT_SUPPORTED" } });
		expect(runtime.delegated).toEqual(["runtime.hello", "agent.command", "agent.transcript"]);
		await router.dispose();
	});
});

describe("GraphService", () => {
	it("adapts Git and ordered agent lifecycle data without invented parent nodes", async () => {
		const registry = new FakeRegistry();
		registry.refs.push({
			id: "child",
			displayName: "Child",
			kind: "sub",
			parentId: "Main",
			status: "idle",
			createdAt: 2,
			lastActivity: 3,
		});
		const lsp = new FakeLsp();
		const graphs = new GraphService({ lsp, registry });
		graphs.recordAgentLifecycle({
			id: "lifecycle-only",
			agent: "task",
			description: "Lifecycle",
			status: "completed",
			index: 4,
		});
		const agent = graphs.agent("workspace-1");
		expect(agent.nodes.map(node => node.id)).toEqual(["agent:Main", "agent:child", "agent:lifecycle-only"]);
		expect(agent.edges).toEqual([
			{ id: "agent-parent:Main:child", source: "agent:Main", target: "agent:child", kind: "parent" },
		]);
		const git = await graphs.git("workspace-1", new FakeGit());
		expect(git.nodes.map(node => node.id)).toEqual([`git:${COMMIT.hash}`]);
	});

	it("prefers valid Graphify nodes and drops edges whose bounded endpoint was not loaded", async () => {
		const graphs = new GraphService({
			lsp: new FakeLsp(),
			registry: new FakeRegistry(),
			maxCodeNodes: 1,
			readFile: async () =>
				JSON.stringify({
					nodes: [
						{ id: "one", label: "One", kind: "function", source_location: "a.ts:1" },
						{ id: "two", label: "Two", kind: "function" },
					],
					edges: [{ id: "edge", source: "one", target: "two", kind: "calls" }],
				}),
		});
		const graph = await graphs.code({ id: "workspace-1", rootPath: "/workspace", displayName: "workspace" });
		expect(graph.nodes).toEqual([
			expect.objectContaining({ id: "one", label: "One", kind: "function", meta: { source_location: "a.ts:1" } }),
		]);
		expect(graph.edges).toEqual([]);
	});

	it("falls back to bounded LSP symbol and reference nodes when Graphify is absent", async () => {
		const lsp = new FakeLsp();
		const graphs = new GraphService({
			lsp,
			registry: new FakeRegistry(),
			readFile: async () => {
				const error = new Error("missing") as NodeJS.ErrnoException;
				error.code = "ENOENT";
				throw error;
			},
		});
		const graph = await graphs.code({ id: "workspace-1", rootPath: "/workspace", displayName: "workspace" });
		expect(graph.nodes.map(node => node.kind)).toEqual(["12", "reference"]);
		expect(graph.edges).toHaveLength(1);
		expect(lsp.calls).toContain("workspace/symbol");
		expect(lsp.calls).toContain("textDocument/references");
	});
});

describe("desktop browser launch", () => {
	it("builds Chromium app argv with a Linux application class and no shell command", () => {
		const url = "http://127.0.0.1:1234/?token=a;touch /tmp/nope";
		expect(chromiumAppArgv("/usr/bin/chromium", url, "linux")).toEqual([
			"/usr/bin/chromium",
			`--app=${url}`,
			"--class=chudcode",
		]);
		expect(defaultBrowserArgv(url, "win32")).toEqual(["rundll32.exe", "url.dll,FileProtocolHandler", url]);
	});

	it("uses an installed Chromium family executable and falls back to the default browser with the URL printed", () => {
		const appSpawns: string[][] = [];
		const app = openDesktopBrowser("http://127.0.0.1:1/?token=x", {
			platform: "linux",
			which: executable => (executable === "chromium" ? "/usr/bin/chromium" : null),
			spawn: argv => {
				appSpawns.push(argv);
				return {};
			},
			print: () => {
				throw new Error("app launch must not print fallback URL");
			},
		});
		expect(app).toMatchObject({
			mode: "app",
			argv: ["/usr/bin/chromium", "--app=http://127.0.0.1:1/?token=x", "--class=chudcode"],
		});
		expect(appSpawns).toEqual([app.argv]);

		const fallbackSpawns: string[][] = [];
		const printed: string[] = [];
		const fallback = openDesktopBrowser("http://127.0.0.1:2/?token=y", {
			platform: "linux",
			which: () => null,
			spawn: argv => {
				fallbackSpawns.push(argv);
				return {};
			},
			print: line => printed.push(line),
		});
		expect(fallback).toEqual({ mode: "default", argv: ["xdg-open", "http://127.0.0.1:2/?token=y"] });
		expect(fallbackSpawns).toEqual([fallback.argv]);
		expect(printed).toEqual(["http://127.0.0.1:2/?token=y"]);
		expect(fallback.argv).not.toContain("sh");
		expect(fallback.argv).not.toContain("-c");
	});
});
