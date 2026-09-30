import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { SessionSnapshot, TranscriptResult } from "@oh-my-pi/collab-web/session-client";
import type { CollabUiResponseValue, ImageContent } from "@oh-my-pi/pi-wire";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";
import { act, forwardRef, type ReactNode, useEffect, useImperativeHandle } from "react";
import type { DesktopSessionInfo, DesktopSessionTab, WorkspaceDescriptor } from "../src/protocol";
import type { AppComponents, AppEditorWorkspaceProps } from "../src/web/App";
import { DEFAULT_REQUEST_TIMEOUT_MS, type DesktopClient } from "../src/web/desktop-client";
import type { DesktopStoreSnapshot } from "../src/web/desktop-store";
import type { EditorWorkspaceHandle } from "../src/web/editor/EditorWorkspace";

const testWindow = parseHTML("<!doctype html><html><body></body></html>");
Object.defineProperty(testWindow, "matchMedia", {
	configurable: true,
	value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
});
const storage = new Map<string, string>();
const localStorage = {
	get length(): number { return storage.size; },
	clear(): void { storage.clear(); },
	getItem(key: string): string | null { return storage.get(key) ?? null; },
	key(index: number): string | null { return [...storage.keys()][index] ?? null; },
	removeItem(key: string): void { storage.delete(key); },
	setItem(key: string, value: string): void { storage.set(key, value); },
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

// These modules read browser globals at evaluation time, so the DOM fixture must be installed first.
const { createRoot } = await import("react-dom/client");
const { App } = await import("../src/web/App");
const { ProjectSwitcher } = await import("../src/web/ProjectSwitcher");
const { SessionTabs } = await import("../src/web/SessionTabs");

afterAll(() => {
	for (const [key, descriptor] of previousGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

beforeEach(() => localStorage.clear());

async function mount(element: ReactNode): Promise<{
	container: HTMLElement;
	dispatchEvent(selector: string, event: InstanceType<typeof testWindow.Event>): void;
	unmount(): Promise<void>;
}> {
	const fixtureContainer = testWindow.document.createElement("div");
	testWindow.document.body.appendChild(fixtureContainer);
	const container = fixtureContainer as unknown as HTMLElement;
	const root = createRoot(container);
	await act(async () => {
		root.render(element);
		await Promise.resolve();
		await Promise.resolve();
	});
	return {
		container,
		dispatchEvent(selector, event): void {
			const target = fixtureContainer.querySelector(selector);
			if (!target) throw new Error(`Missing event target ${selector}`);
			target.dispatchEvent(event);
		},
		async unmount(): Promise<void> {
			await act(async () => root.unmount());
			fixtureContainer.remove();
		},
	};
}

function clickButton(container: HTMLElement, label: string): Promise<void> {
	const button = container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
	if (!button) throw new Error(`Missing ${label}`);
	return act(async () => {
		button.click();
		await Promise.resolve();
		await Promise.resolve();
	});
}

function dispatchKey(key: string, init: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {}): void {
	const event = new testWindow.Event("keydown", { bubbles: true, cancelable: true });
	for (const [name, value] of Object.entries({ key, code: key === "Tab" ? "Tab" : `Key${key.toUpperCase()}`, isComposing: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...init })) {
		Object.defineProperty(event, name, { configurable: true, value });
	}
	testWindow.dispatchEvent(event);
}

function textareaReactProps(textarea: HTMLTextAreaElement): { onChange(event: { target: HTMLTextAreaElement }): void } {
	const key = Object.keys(textarea).find(candidate => candidate.startsWith("__reactProps$"));
	if (!key) throw new Error("React textarea props were not attached");
	return (textarea as unknown as Record<string, unknown>)[key] as { onChange(event: { target: HTMLTextAreaElement }): void };
}

interface Call { method: string; params: Record<string, unknown> }

function session(cwd: string, working = false): SessionSnapshot {
	return {
		phase: "live",
		endedReason: null,
		header: null,
		entries: [],
		state: { isStreaming: working, queuedMessageCount: 0, cwd, participants: [] },
		agents: [],
		progress: new Map(),
		lifecycle: new Map(),
		stream: null,
		streamDone: false,
		activeTools: new Map(),
		working,
		readOnly: false,
		uiRequest: null,
		notices: [],
	};
}

const tabA: DesktopSessionTab = { path: "/sessions/a.jsonl", title: "Build API", cwd: "/work/alpha", active: true, running: true, unread: 0, draftDirty: false };
const tabB: DesktopSessionTab = { path: "/sessions/b.jsonl", title: "Review UI", cwd: "/work/beta", active: false, running: false, unread: 7, draftDirty: true };
const oldSession: DesktopSessionInfo = { id: "old", path: "/sessions/old.jsonl", cwd: "/work/legacy", title: "Legacy fix", createdMs: 1, modifiedMs: 2, messageCount: 3, size: 4 };

class FakeDesktopClient {
	calls: Call[] = [];
	listeners = new Set<() => void>();
	snapshot: DesktopStoreSnapshot;
	pickedPath = "/picked/project";
	pickTimeoutMs: number | undefined;

	constructor(tabs: readonly DesktopSessionTab[] = [tabA, tabB]) {
		const snapshots = new Map<string, SessionSnapshot>([
			[tabA.path, session(tabA.cwd, tabA.running)],
			[tabB.path, session(tabB.cwd, tabB.running)],
		]);
		const active = tabs.find(tab => tab.active)?.path ?? null;
		const activeSnapshot = active === null ? undefined : snapshots.get(active);
		this.snapshot = {
			revision: 1,
			session: activeSnapshot ?? session("/work/alpha"),
			activeSessionPath: active,
			sessionTabs: tabs,
			sessionSnapshots: snapshots,
			sessions: [oldSession],
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

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	getSnapshot = (): SessionSnapshot => this.snapshot.session;
	getDesktopSnapshot = (): DesktopStoreSnapshot => this.snapshot;
	connect(): void {}
	close(): void {}
	emit(): void { for (const listener of this.listeners) listener(); }

	async request(method: string, params: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<unknown> {
		this.calls.push({ method, params });
		if (method === "workspace.pick") this.pickTimeoutMs = options?.timeoutMs;
		if (method === "workspace.recent") return { projects: [
			{ rootPath: "/work/alpha", displayName: "alpha", lastOpenedMs: 2 },
			{ rootPath: "/work/deep/nested/beta", displayName: "beta", lastOpenedMs: 1 },
		] };
		if (method === "workspace.pick") return { rootPath: this.pickedPath, cancelled: false };
		if (method === "workspace.open") {
			const rootPath = String(params.rootPath);
			return { workspace: { id: `ws:${rootPath}`, rootPath, displayName: rootPath.split("/").at(-1) } };
		}
		if (method === "session.new") return { session: { ...oldSession, path: "/sessions/new.jsonl", cwd: String(params.cwd) } };
		if (method === "session.activate") {
			const path = String(params.path);
			const snapshots = this.snapshot.sessionSnapshots;
			const selected = snapshots.get(path) ?? session(path === oldSession.path ? oldSession.cwd : "/work/new");
			this.snapshot = {
				...this.snapshot,
				revision: this.snapshot.revision + 1,
				activeSessionPath: path,
				session: selected,
				sessionTabs: this.snapshot.sessionTabs.map(tab => ({ ...tab, active: tab.path === path, unread: tab.path === path ? 0 : tab.unread })),
			};
			this.emit();
			return { tabs: this.snapshot.sessionTabs };
		}
		if (method === "session.tab.close") return { closed: true, tabs: [] };
		if (method === "run.abort") return { accepted: true };
		return {};
	}

	activateSession(path: string): Promise<unknown> {
		return this.request("session.activate", { path });
	}

	async closeSession(path: string, force = false): Promise<{ closed: boolean; tabs: readonly DesktopSessionTab[] }> {
		await this.request("session.tab.close", force ? { path, force: true } : { path });
		return { closed: true, tabs: [] };
	}

	setSessionDraft(path: string, dirty: boolean): void {
		this.calls.push({ method: "session.tab.draft", params: { path, dirty } });
		this.snapshot = { ...this.snapshot, revision: this.snapshot.revision + 1, sessionTabs: this.snapshot.sessionTabs.map(tab => tab.path === path ? { ...tab, draftDirty: dirty } : tab) };
		this.emit();
	}
	sendPrompt(_text: string, _images?: ImageContent[]): void {}
	sendAbort(): void {}
	sendUiResponse(_reqId: number, _value?: CollabUiResponseValue): void {}
	sendAgentCmd(_cmd: "chat" | "kill" | "revive", _agentId: string, _text?: string): void {}
	fetchTranscript(_agentId: string, _fromByte: number): Promise<TranscriptResult | null> { return Promise.resolve(null); }
}

describe("project switcher", () => {
	it("keeps the current full path prominent and exposes recent projects plus the native picker", async () => {
		const client = new FakeDesktopClient();
		const opened: WorkspaceDescriptor[] = [];
		const mounted = await mount(<ProjectSwitcher client={client as unknown as DesktopClient} workspace={{ id: "alpha", rootPath: "/work/alpha", displayName: "alpha" }} onWorkspaceOpen={workspace => opened.push(workspace)} />);
		try {
			const current = mounted.container.querySelector(".project-switcher-current");
			expect(current?.textContent).toContain("alpha");
			expect(current?.textContent).toContain("/work/alpha");

			await clickButton(mounted.container, "Switch project");
			expect(mounted.container.textContent).toContain("/work/deep/nested/beta");
			const recent = Array.from(mounted.container.querySelectorAll(".project-recent-list button")).find(button => button.textContent?.includes("nested/beta")) as HTMLButtonElement;
			await act(async () => { recent.click(); await Promise.resolve(); });
			expect(client.calls).toContainEqual({ method: "workspace.open", params: { rootPath: "/work/deep/nested/beta" } });

			await act(async () => { dispatchKey("k", { ctrlKey: true }); dispatchKey("p"); await Promise.resolve(); });
			expect(mounted.container.querySelector('[role="dialog"][aria-label="Projects"]')).not.toBeNull();
			const openFolder = Array.from(mounted.container.querySelectorAll("button")).find(button => button.textContent?.includes("Open Folder")) as HTMLButtonElement;
			await act(async () => { openFolder.click(); await Promise.resolve(); await Promise.resolve(); });
			expect(client.calls).toContainEqual({ method: "workspace.pick", params: { initialPath: "/work/alpha" } });
			expect(client.calls).toContainEqual({ method: "workspace.open", params: { rootPath: client.pickedPath } });
			expect(opened.at(-1)?.rootPath).toBe(client.pickedPath);
			// The host answers workspace.pick only once a person has finished
			// browsing a modal native dialog. Under the ordinary request timeout the
			// promise was abandoned mid-dialog, the host still opened the chosen
			// directory, and picking a folder changed nothing on screen.
			expect(client.pickTimeoutMs).toBeGreaterThan(DEFAULT_REQUEST_TIMEOUT_MS);
		} finally {
			await mounted.unmount();
		}
	});
});

describe("concurrent session tabs", () => {
	it("renders accessible independent status, clears unread on activation, targets Stop, and ignores middle-click close", async () => {
		const client = new FakeDesktopClient();
		const mounted = await mount(<SessionTabs client={client as unknown as DesktopClient} tabs={[tabA, tabB]} sessions={[oldSession]} newSessionCwd="/work/alpha" />);
		try {
			expect(mounted.container.querySelector('[role="tablist"]')?.getAttribute("aria-label")).toBe("Agent sessions");
			expect(mounted.container.querySelector('[role="tablist"]')?.classList.contains("session-tabs-scroll")).toBe(true);
			const tabs = mounted.container.querySelectorAll('[role="tab"]');
			expect(tabs.length).toBe(2);
			expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
			expect(tabs[0]?.querySelector('[aria-label="Running"]')).not.toBeNull();
			expect(tabs[1]?.querySelector('[aria-label="7 unread"]')).not.toBeNull();
			expect(tabs[1]?.querySelector('[aria-label="Unsaved draft"]')).not.toBeNull();

			await act(async () => { (tabs[1] as HTMLButtonElement).click(); await Promise.resolve(); });
			expect(client.calls).toContainEqual({ method: "session.activate", params: { path: tabB.path } });
			await clickButton(mounted.container, "Stop Build API");
			expect(client.calls).toContainEqual({ method: "run.abort", params: { sessionPath: tabA.path } });

			const auxiliaryClick = new testWindow.Event("auxclick", { bubbles: true, cancelable: true });
			Object.defineProperty(auxiliaryClick, "button", { configurable: true, value: 1 });
			mounted.dispatchEvent('button[aria-label="Close Build API"]', auxiliaryClick);
			expect(client.calls.some(call => call.method === "session.tab.close")).toBe(false);
		} finally {
			await mounted.unmount();
		}
	});

	it("guards running and dirty tabs with explicit destructive actions", async () => {
		const client = new FakeDesktopClient();
		const mounted = await mount(<SessionTabs client={client as unknown as DesktopClient} tabs={[tabA, tabB]} sessions={[]} />);
		try {
			await clickButton(mounted.container, "Close Review UI");
			expect(mounted.container.querySelector('[role="alertdialog"]')?.textContent).toContain("Discard Draft & Close");
			const cancel = Array.from(mounted.container.querySelectorAll("button")).find(button => button.textContent === "Cancel") as HTMLButtonElement;
			await act(async () => cancel.click());

			await clickButton(mounted.container, "Close Build API");
			const confirm = Array.from(mounted.container.querySelectorAll("button")).find(button => button.textContent === "Abort & Close") as HTMLButtonElement;
			expect(confirm).toBeDefined();
			await act(async () => { confirm.click(); await Promise.resolve(); await Promise.resolve(); });
			const abortIndex = client.calls.findIndex(call => call.method === "run.abort" && call.params.sessionPath === tabA.path);
			const closeIndex = client.calls.findIndex(call => call.method === "session.tab.close" && call.params.path === tabA.path);
			expect(abortIndex).toBeGreaterThanOrEqual(0);
			expect(closeIndex).toBeGreaterThan(abortIndex);
			expect(client.calls[closeIndex]?.params).toEqual({ path: tabA.path, force: true });
		} finally {
			await mounted.unmount();
		}
	});

	it("opens new and existing sessions and supports numeric and cycling shortcuts", async () => {
		const client = new FakeDesktopClient();
		const mounted = await mount(<SessionTabs client={client as unknown as DesktopClient} tabs={[tabA, tabB]} sessions={[oldSession]} newSessionCwd="/work/current" />);
		try {
			await clickButton(mounted.container, "New agent session");
			expect(client.calls).toContainEqual({ method: "session.new", params: { cwd: "/work/current" } });
			expect(client.calls).toContainEqual({ method: "session.activate", params: { path: "/sessions/new.jsonl" } });

			await clickButton(mounted.container, "Open existing session");
			const existing = Array.from(mounted.container.querySelectorAll(".session-picker button")).find(button => button.textContent?.includes("Legacy fix")) as HTMLButtonElement;
			await act(async () => { existing.click(); await Promise.resolve(); });
			expect(client.calls).toContainEqual({ method: "session.activate", params: { path: oldSession.path } });

			await act(async () => { dispatchKey("2", { ctrlKey: true }); await Promise.resolve(); });
			expect(client.calls.at(-1)).toEqual({ method: "session.activate", params: { path: tabB.path } });
			await act(async () => { dispatchKey("Tab", { ctrlKey: true }); await Promise.resolve(); });
			expect(client.calls.at(-1)).toEqual({ method: "session.activate", params: { path: tabB.path } });
		} finally {
			await mounted.unmount();
		}
	});
});

let editorMounts = 0;
const FakeEditor = forwardRef<EditorWorkspaceHandle, AppEditorWorkspaceProps>(function FakeEditor({ workspace }, ref) {
	useEffect(() => { editorMounts += 1; }, []);
	useImperativeHandle(ref, () => ({ async openLocation() {}, focus() {} }), []);
	return <div className="fake-editor" data-workspace={workspace?.rootPath ?? ""} />;
});
const appComponents: AppComponents = {
	EditorWorkspace: FakeEditor,
	GitPanel: ({ workspaceId }) => <div data-git={workspaceId} />,
	GraphPanel: ({ workspaceId }) => <div data-graph={workspaceId} />,
	TerminalPanel: ({ workspaceId }) => <div data-terminal={workspaceId} />,
	LspStatus: ({ workspaceId }) => <div data-lsp={workspaceId} />,
};

describe("App session composition", () => {
	it("restores each session draft and keeps the editor mounted while projects switch", async () => {
		editorMounts = 0;
		const client = new FakeDesktopClient();
		const mounted = await mount(<App client={client as unknown as DesktopClient} components={appComponents} />);
		try {
			let textarea = mounted.container.querySelector("textarea") as HTMLTextAreaElement;
			textarea.value = "alpha draft";
			await act(async () => textareaReactProps(textarea).onChange({ target: textarea }));
			expect(client.calls).toContainEqual({ method: "session.tab.draft", params: { path: tabA.path, dirty: true } });

			await clickButton(mounted.container, "Switch project");
			const betaProject = Array.from(mounted.container.querySelectorAll(".project-recent-list button")).find(button => button.textContent?.includes("nested/beta")) as HTMLButtonElement;
			await act(async () => { betaProject.click(); await Promise.resolve(); await Promise.resolve(); });
			expect(mounted.container.querySelector(".fake-editor")?.getAttribute("data-workspace")).toBe("/work/deep/nested/beta");
			expect(editorMounts).toBe(1);

			await act(async () => { (mounted.container.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement).click(); await Promise.resolve(); await Promise.resolve(); });
			expect(mounted.container.querySelector('[aria-label="7 unread"]')).toBeNull();
			textarea = mounted.container.querySelector("textarea") as HTMLTextAreaElement;
			expect(textarea.value).toBe("");
			textarea.value = "beta draft";
			await act(async () => textareaReactProps(textarea).onChange({ target: textarea }));

			await act(async () => { (mounted.container.querySelectorAll('[role="tab"]')[0] as HTMLButtonElement).click(); await Promise.resolve(); await Promise.resolve(); });
			textarea = mounted.container.querySelector("textarea") as HTMLTextAreaElement;
			expect(textarea.value).toBe("alpha draft");
			expect(editorMounts).toBe(1);
			expect(mounted.container.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby")).toContain("agent-session-tab-");
		} finally {
			await mounted.unmount();
		}
	});
});
