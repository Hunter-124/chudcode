import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { SessionSnapshot, TranscriptResult } from "@oh-my-pi/collab-web/session-client";
import type { CollabUiResponseValue, ImageContent } from "@oh-my-pi/pi-wire";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";
import {
	act,
	forwardRef,
	type ReactNode,
	useEffect,
	useImperativeHandle,
} from "react";
import type { WorkspaceDescriptor } from "../src/protocol";
import type { AppComponents, AppEditorWorkspaceProps } from "../src/web/App";
import type { DesktopClient } from "../src/web/desktop-client";
import type { DesktopStoreSnapshot } from "../src/web/desktop-store";
import type { EditorWorkspaceHandle } from "../src/web/editor/EditorWorkspace";

type OpenedLocation = { uri: string; line?: number; column?: number };

let editorMountCount = 0;
const openedLocations: OpenedLocation[] = [];

const FakeEditorWorkspace = forwardRef<EditorWorkspaceHandle, AppEditorWorkspaceProps>(function FakeEditorWorkspace(
	{ workspace },
	ref,
) {
	useEffect(() => {
		editorMountCount += 1;
	}, []);
	useImperativeHandle(ref, () => ({
		async openLocation(uri: string, line?: number, column?: number): Promise<void> {
			openedLocations.push({ uri, line, column });
		},
		focus(): void {},
	}), []);
	return (
		<section className="editor-workspace" aria-label="Editor workspace" data-workspace-id={workspace?.id ?? ""}>
			<input aria-label="Editor buffer" defaultValue="preserved editor state" />
			{workspace ? null : <button type="button">Open a project</button>}
		</section>
	);
});

const FakeGitPanel: AppComponents["GitPanel"] = ({ workspaceId, onOpenGraph }) => (
	<section className="git-panel" aria-label="Source Control" data-workspace-id={workspaceId}>
		<button type="button" onClick={() => onOpenGraph?.("git")}>Open commit graph</button>
	</section>
);

const FakeGraphPanel: AppComponents["GraphPanel"] = ({ workspaceId, kind, onOpenSource }) => (
	<section className="graph-panel" aria-label={`${kind} graph`} data-workspace-id={workspaceId}>
		<button type="button" aria-label="Open graph source" onClick={() => onOpenSource?.({ uri: "file:///repo/src/from-graph.ts", line: 7, column: 3 })}>Open source</button>
	</section>
);

const FakeTerminalPanel: AppComponents["TerminalPanel"] = ({ workspaceId }) => (
	<section className="terminal-panel" aria-label="Terminal panel" data-workspace-id={workspaceId} />
);

const FakeLspStatus: AppComponents["LspStatus"] = ({ workspaceId, onOpenDiagnostic }) => (
	<section className="lsp-status" aria-label="Language services" data-workspace-id={workspaceId}>
		<button type="button" aria-label="Open diagnostic" onClick={() => onOpenDiagnostic?.("file:///repo/src/problem.ts", 12, 5)}>Open diagnostic</button>
	</section>
);

const testComponents: AppComponents = {
	EditorWorkspace: FakeEditorWorkspace,
	GitPanel: FakeGitPanel,
	GraphPanel: FakeGraphPanel,
	TerminalPanel: FakeTerminalPanel,
	LspStatus: FakeLspStatus,
};

const session: SessionSnapshot = {
	phase: "live",
	endedReason: null,
	header: null,
	entries: [],
	state: { isStreaming: false, queuedMessageCount: 0, cwd: "/repo", participants: [] },
	agents: [],
	progress: new Map(),
	lifecycle: new Map(),
	stream: null,
	streamDone: false,
	activeTools: new Map(),
	working: false,
	readOnly: false,
	uiRequest: null,
	notices: [],
};

function desktopSnapshot(): DesktopStoreSnapshot {
	return {
		revision: 1,
		session,
		activeSessionPath: null,
		sessionTabs: [],
		sessionSnapshots: new Map(),
		sessions: [],
		workspaces: new Map(),
		workspaceEntries: new Map(),
		workspaceChanges: new Map(),
		documents: new Map(),
		git: new Map(),
		terminals: new Map(),
		diagnostics: new Map(),
		graphs: new Map(),
		lastError: null,
	};
}

interface RecordedCall {
	method: string;
	params: unknown;
}

class FakeDesktopClient {
	readonly calls: RecordedCall[] = [];
	readonly workspace: WorkspaceDescriptor = { id: "workspace-1", rootPath: "/repo", displayName: "repo" };
	readonly snapshot = desktopSnapshot();

	subscribe = (_listener: () => void): (() => void) => () => {};
	getSnapshot = (): SessionSnapshot => session;
	getDesktopSnapshot = (): DesktopStoreSnapshot => this.snapshot;
	connect(): void {}
	close(): void {}

	async request(method: string, params: unknown): Promise<unknown> {
		this.calls.push({ method, params });
		if (method === "workspace.open") return { workspace: this.workspace };
		return {};
	}

	sendPrompt(_text: string, _images?: ImageContent[]): void {}
	sendAbort(): void {}
	sendUiResponse(_reqId: number, _value?: CollabUiResponseValue): void {}
	sendAgentCmd(_cmd: "chat" | "kill" | "revive", _agentId: string, _text?: string): void {}
	fetchTranscript(_agentId: string, _fromByte: number): Promise<TranscriptResult | null> {
		return Promise.resolve(null);
	}
}

const testWindow = parseHTML("<!doctype html><html><body></body></html>");
type MatchMediaFixture = (
	query: string,
) => Pick<MediaQueryList, "matches" | "addEventListener" | "removeEventListener">;
const matchMedia: MatchMediaFixture = () => ({
	matches: false,
	addEventListener() {},
	removeEventListener() {},
});
Object.defineProperty(testWindow, "matchMedia", {
	configurable: true,
	value: matchMedia,
});

const storageValues = new Map<string, string>();
const localStorage = {
	get length(): number { return storageValues.size; },
	clear(): void { storageValues.clear(); },
	getItem(key: string): string | null { return storageValues.get(key) ?? null; },
	key(index: number): string | null { return [...storageValues.keys()][index] ?? null; },
	removeItem(key: string): void { storageValues.delete(key); },
	setItem(key: string, value: string): void { storageValues.set(key, value); },
};
const browserGlobals = {
	window: testWindow,
	document: testWindow.document,
	Node: testWindow.Node,
	Element: testWindow.Element,
	HTMLElement: testWindow.HTMLElement,
	HTMLIFrameElement: testWindow.HTMLIFrameElement,
	Event: testWindow.Event,
	localStorage,
	navigator: testWindow.navigator,
	IS_REACT_ACT_ENVIRONMENT: true,
} as const;
type BrowserGlobal = keyof typeof browserGlobals;
const previousGlobals = new Map<BrowserGlobal, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries(browserGlobals) as [BrowserGlobal, unknown][]) {
	previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

// ReactDOM and the real App module load after the browser globals are installed.
const { createRoot } = await import("react-dom/client");
const { App, handleShellShortcut } = await import("../src/web/App");

afterAll(() => {
	for (const [key, descriptor] of previousGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

beforeEach(() => {
	localStorage.clear();
	editorMountCount = 0;
	openedLocations.length = 0;
});

async function mount(element: ReactNode): Promise<{ container: HTMLElement; unmount(): Promise<void> }> {
	const container = testWindow.document.createElement("div") as unknown as HTMLElement;
	testWindow.document.body.appendChild(container as unknown as InstanceType<typeof testWindow.HTMLElement>);
	const root = createRoot(container);
	await act(async () => {
		root.render(element);
		await Promise.resolve();
		await Promise.resolve();
	});
	return {
		container,
		async unmount(): Promise<void> {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
	const result = container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
	if (!result) throw new Error(`Missing ${label} button`);
	return result;
}

function textareaReactProps(textarea: HTMLTextAreaElement): { onChange(event: { target: HTMLTextAreaElement }): void } {
	const key = Object.keys(textarea).find(candidate => candidate.startsWith("__reactProps$"));
	if (!key) throw new Error("React textarea props were not attached");
	return (textarea as unknown as Record<string, unknown>)[key] as { onChange(event: { target: HTMLTextAreaElement }): void };
}

describe("desktop application shell integration", () => {
	it("bootstraps the session workspace and keeps the real editor mounted across activities", async () => {
		const client = new FakeDesktopClient();
		const mounted = await mount(<App client={client as unknown as DesktopClient} components={testComponents} />);
		try {
			expect(client.calls).toContainEqual({ method: "workspace.open", params: { rootPath: "/repo" } });
			const editor = mounted.container.querySelector(".editor-workspace") as HTMLElement;
			const buffer = mounted.container.querySelector('input[aria-label="Editor buffer"]') as HTMLInputElement;
			expect(editor.dataset.workspaceId).toBe("workspace-1");
			expect(editorMountCount).toBe(1);

			await act(async () => button(mounted.container, "Source Control").click());
			expect(mounted.container.querySelector(".git-panel")?.getAttribute("data-workspace-id")).toBe("workspace-1");
			await act(async () => button(mounted.container, "Explorer").click());
			expect(mounted.container.querySelector('input[aria-label="Editor buffer"]')).toBe(buffer);
			expect(editorMountCount).toBe(1);
			expect(mounted.container.textContent?.toLowerCase()).not.toContain("loading…");
		} finally {
			await mounted.unmount();
		}
	});

	it("hands Git to the git graph, mounts workspace terminal/LSP, and routes sources into the editor", async () => {
		const client = new FakeDesktopClient();
		const mounted = await mount(<App client={client as unknown as DesktopClient} components={testComponents} />);
		try {
			await act(async () => button(mounted.container, "Source Control").click());
			const openGraph = Array.from(mounted.container.querySelectorAll("button")).find(item => item.textContent === "Open commit graph");
			expect(openGraph).toBeDefined();
			await act(async () => openGraph?.click());
			expect(mounted.container.querySelector('.graph-panel[aria-label="git graph"]')).not.toBeNull();
			const gitKind = Array.from(mounted.container.querySelectorAll(".graph-kind-tabs button")).find(item => item.textContent === "Git");
			expect(gitKind).toBeDefined();
			expect(gitKind?.getAttribute("aria-pressed")).toBe("true");

			await act(async () => button(mounted.container, "Open graph source").click());
			expect(openedLocations).toContainEqual({ uri: "file:///repo/src/from-graph.ts", line: 7, column: 3 });
			expect(mounted.container.querySelector("#editor-host")?.getAttribute("hidden")).toBeNull();

			await act(async () => button(mounted.container, "Run and Terminal").click());
			expect(mounted.container.querySelector(".terminal-panel")?.getAttribute("data-workspace-id")).toBe("workspace-1");
			expect(mounted.container.querySelector(".lsp-status")?.getAttribute("data-workspace-id")).toBe("workspace-1");
			await act(async () => button(mounted.container, "Open diagnostic").click());
			expect(openedLocations).toContainEqual({ uri: "file:///repo/src/problem.ts", line: 12, column: 5 });
			expect(mounted.container.querySelector("#editor-host")?.getAttribute("hidden")).toBeNull();
		} finally {
			await mounted.unmount();
		}
	});

	it("leaves the shared prompt textarea caret and shell shortcuts untouched while editing", async () => {
		const client = new FakeDesktopClient();
		const mounted = await mount(<App client={client as unknown as DesktopClient} components={testComponents} />);
		try {
			const textarea = mounted.container.querySelector("textarea") as HTMLTextAreaElement;
			textarea.value = "alpha beta gamma";
			textarea.selectionStart = 6;
			textarea.selectionEnd = 10;
			await act(async () => textareaReactProps(textarea).onChange({ target: textarea }));
			textarea.click();
			let prevented = false;
			const sidebarVisibilityBefore = mounted.container.querySelector(".primary-sidebar")?.getAttribute("aria-hidden");
			let shortcutAction = false;
			const handled = handleShellShortcut({
				target: textarea,
				isComposing: false,
				key: "b",
				code: "KeyB",
				ctrlKey: true,
				shiftKey: false,
				altKey: false,
				metaKey: false,
				preventDefault(): void {
					prevented = true;
				},
			}, {
				togglePrimary(): void { shortcutAction = true; },
				toggleSecondary(): void { shortcutAction = true; },
				focusEditor(): void { shortcutAction = true; },
				setActivity(): void { shortcutAction = true; },
			});

			const after = mounted.container.querySelector("textarea") as HTMLTextAreaElement;
			expect(after).toBe(textarea);
			expect(handled).toBe(false);
			expect(prevented).toBe(false);
			expect(shortcutAction).toBe(false);
			expect(after.value).toBe("alpha beta gamma");
			expect(after.selectionStart).toBe(6);
			expect(after.selectionEnd).toBe(10);
			expect(mounted.container.querySelector(".primary-sidebar")?.getAttribute("aria-hidden")).toBe(sidebarVisibilityBefore);
		} finally {
			await mounted.unmount();
		}
	});
});
