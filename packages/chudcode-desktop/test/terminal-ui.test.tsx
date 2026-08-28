import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";
import { act, type ReactNode } from "react";
import type { ITerminalAddon } from "@xterm/xterm";
import type { DesktopMethod, DesktopRequestMap, LspDiagnostic, TerminalId } from "../src/protocol";
import type { DesktopClient } from "../src/web/desktop-client";
import type { DesktopStoreSnapshot, TerminalSnapshot } from "../src/web/desktop-store";
import { LspStatus } from "../src/web/terminal/LspStatus";
import {
	TerminalPanel,
	readXtermTheme,
	type FitAddonLike,
	type TerminalAdapter,
	type TerminalAdapterFactory,
	type TerminalConstructorOptions,
	type TerminalKeyEvent,
	type TerminalMutationObserver,
	type TerminalResizeObserver,
	type XtermLike,
} from "../src/web/terminal/TerminalPanel";

const testWindow = parseHTML("<!doctype html><html><body></body></html>");

class ResizeObserverStub implements TerminalResizeObserver {
	static instances: ResizeObserverStub[] = [];
	readonly targets: Element[] = [];
	disconnected = false;

	constructor(readonly callback: () => void) {
		ResizeObserverStub.instances.push(this);
	}

	observe(target: Element): void {
		this.targets.push(target);
	}

	disconnect(): void {
		this.disconnected = true;
	}

	trigger(): void {
		this.callback();
	}
}

class MutationObserverStub implements TerminalMutationObserver {
	static instances: MutationObserverStub[] = [];
	disconnected = false;

	constructor(readonly callback: () => void) {
		MutationObserverStub.instances.push(this);
	}

	observe(): void {}

	disconnect(): void {
		this.disconnected = true;
	}
}

const clipboard = {
	written: [] as string[],
	readValue: "pasted text",
	async writeText(value: string): Promise<void> {
		this.written.push(value);
	},
	async readText(): Promise<string> {
		return this.readValue;
	},
};

const browserGlobals = {
	window: testWindow,
	document: testWindow.document,
	Node: testWindow.Node,
	Element: testWindow.Element,
	HTMLElement: testWindow.HTMLElement,
	HTMLIFrameElement: testWindow.HTMLIFrameElement,
	Event: testWindow.Event,
	navigator: testWindow.navigator,
	IS_REACT_ACT_ENVIRONMENT: true,
} as const;

type BrowserGlobal = keyof typeof browserGlobals;
const previousGlobals = new Map<BrowserGlobal, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries(browserGlobals) as [BrowserGlobal, unknown][]) {
	previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
Object.defineProperty(testWindow.navigator, "clipboard", { configurable: true, value: clipboard });
Object.defineProperty(testWindow, "requestAnimationFrame", {
	configurable: true,
	value: (callback: FrameRequestCallback) => {
		callback(0);
		return 1;
	},
});
Object.defineProperty(testWindow, "cancelAnimationFrame", { configurable: true, value: () => {} });
Object.defineProperty(testWindow, "matchMedia", {
	configurable: true,
	value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
});

const { createRoot } = await import("react-dom/client");

afterAll(() => {
	for (const [key, descriptor] of previousGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

function sessionSnapshot(phase: "connecting" | "waiting" | "live" | "reconnecting" | "ended" = "live") {
	return {
		phase,
		endedReason: phase === "ended" ? "socket closed" : null,
		header: null,
		entries: [],
		state: null,
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
}

function makeStore(
	terminals: ReadonlyMap<TerminalId, TerminalSnapshot> = new Map(),
	diagnostics: readonly LspDiagnostic[] = [],
): DesktopStoreSnapshot {
	return {
		revision: 1,
		session: sessionSnapshot(),
		activeSessionPath: null,
		sessionTabs: [],
		sessionSnapshots: new Map(),
		sessions: [],
		workspaces: new Map(),
		workspaceEntries: new Map(),
		workspaceChanges: new Map(),
		documents: new Map(),
		git: new Map(),
		terminals,
		diagnostics: new Map([["workspace-1", diagnostics]]),
		graphs: new Map(),
		lastError: null,
	};
}

function terminalSnapshot(
	id: TerminalId,
	chunks: readonly Uint8Array[],
	closed = false,
): TerminalSnapshot {
	return {
		id,
		chunks: chunks.map((data, sequence) => ({ sequence, data })),
		byteLength: chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
		nextSequence: chunks.length,
		closed,
	};
}

class FakeClient {
	readonly calls: Array<{ method: DesktopMethod; params: unknown }> = [];
	readonly listeners = new Set<() => void>();
	connectCount = 0;
	#nextTerminal = 2;

	constructor(public snapshot: DesktopStoreSnapshot) {}

	connect = (): void => {
		this.connectCount += 1;
	};

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	getDesktopSnapshot = (): DesktopStoreSnapshot => this.snapshot;

	request<M extends DesktopMethod>(
		method: M,
		params: DesktopRequestMap[M]["params"],
	): Promise<DesktopRequestMap[M]["result"]> {
		this.calls.push({ method, params });
		let result: unknown = {};
		if (method === "terminal.create") result = { terminalId: `term-${this.#nextTerminal++}` };
		else if (method === "terminal.write") result = { accepted: true };
		else if (method === "lsp.request") result = { value: [{ uri: "file:///work/result.ts" }] };
		return Promise.resolve(result as DesktopRequestMap[M]["result"]);
	}

	emit(snapshot: DesktopStoreSnapshot): void {
		this.snapshot = snapshot;
		for (const listener of this.listeners) listener();
	}
}

class FakeFitAddon implements FitAddonLike {
	disposed = false;
	proposed = { cols: 900, rows: 1 };
	activate(): void {}
	dispose(): void {
		this.disposed = true;
	}
	proposeDimensions(): { cols: number; rows: number } {
		return this.proposed;
	}
}

class FakeTerminal implements XtermLike {
	cols = 80;
	rows = 24;
	options: XtermLike["options"];
	opened: HTMLElement | null = null;
	addon: ITerminalAddon | null = null;
	dataListener: ((data: string) => void) | null = null;
	keyListener: ((event: TerminalKeyEvent) => boolean) | null = null;
	writes: Array<string | Uint8Array> = [];
	pastes: string[] = [];
	resizes: Array<[number, number]> = [];
	focused = 0;
	disposed = false;
	dataDisposed = false;
	selection = "";

	constructor({ cols = 80, rows = 24, ...options }: TerminalConstructorOptions) {
		this.cols = cols;
		this.rows = rows;
		this.options = options;
	}

	open(element: HTMLElement): void {
		this.opened = element;
	}
	loadAddon(addon: ITerminalAddon): void {
		this.addon = addon;
	}
	onData(listener: (data: string) => void): { dispose(): void } {
		this.dataListener = listener;
		return { dispose: () => { this.dataDisposed = true; } };
	}
	write(data: string | Uint8Array): void {
		this.writes.push(data);
	}
	paste(data: string): void {
		this.pastes.push(data);
		this.dataListener?.(data);
	}
	focus(): void {
		this.focused += 1;
	}
	resize(cols: number, rows: number): void {
		this.cols = cols;
		this.rows = rows;
		this.resizes.push([cols, rows]);
	}
	hasSelection(): boolean {
		return this.selection.length > 0;
	}
	getSelection(): string {
		return this.selection;
	}
	selectAll(): void {
		this.selection = "all";
	}
	dispose(): void {
		this.disposed = true;
	}
}

function createFakeAdapter(terminal: FakeTerminal, fitAddon = new FakeFitAddon()): TerminalAdapter {
	return {
		terminal,
		fitAddon,
		attachCustomKeyEventHandler: listener => {
			terminal.keyListener = listener;
		},
		ResizeObserver: ResizeObserverStub,
		MutationObserver: MutationObserverStub,
	};
}

interface Mounted {
	container: HTMLElement;
	unmount(): Promise<void>;
}

async function mount(node: ReactNode): Promise<Mounted> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	await act(async () => root.render(node));
	return {
		container,
		async unmount(): Promise<void> {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

function reactProps<T>(element: Element): T {
	const key = Object.keys(element).find(candidate => candidate.startsWith("__reactProps$"));
	if (!key) throw new Error("React props were not attached");
	return (element as unknown as Record<string, unknown>)[key] as T;
}

beforeEach(() => {
	ResizeObserverStub.instances = [];
	MutationObserverStub.instances = [];
	clipboard.written = [];
	clipboard.readValue = "pasted text";
});

describe("TerminalPanel", () => {
	it("passes ordered binary, split UTF-8, and ANSI chunks to xterm as Uint8Array", async () => {
		const binary = Uint8Array.from([0x00, 0xff, 0x7f]);
		const utf8Lead = Uint8Array.from([0xe2]);
		const utf8Tail = Uint8Array.from([0x82, 0xac]);
		const ansi = Uint8Array.from([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x1b, 0x5b, 0x30, 0x6d]);
		const client = new FakeClient(
			makeStore(new Map([["term-1", terminalSnapshot("term-1", [binary, utf8Lead])]])),
		);
		const desktopClient = client as unknown as DesktopClient;
		const terminals: FakeTerminal[] = [];
		const fits: FakeFitAddon[] = [];
		const factory: TerminalAdapterFactory = options => {
			const terminal = new FakeTerminal(options);
			const fitAddon = new FakeFitAddon();
			terminals.push(terminal);
			fits.push(fitAddon);
			return createFakeAdapter(terminal, fitAddon);
		};
		const mounted = await mount(
			<TerminalPanel client={desktopClient} workspaceId="workspace-1" initialTerminalIds={["term-1"]} adapterFactory={factory} />,
		);

		expect(terminals).toHaveLength(1);
		expect(terminals[0]?.writes).toEqual([binary, utf8Lead]);
		expect(terminals[0]?.writes.every(write => write instanceof Uint8Array)).toBe(true);
		expect(terminals[0]?.resizes).toContainEqual([500, 2]);
		expect(client.calls).toContainEqual({ method: "terminal.resize", params: { terminalId: "term-1", cols: 500, rows: 2 } });

		await act(async () => {
			terminals[0]?.dataListener?.("echo hi\r");
			await Promise.resolve();
		});
		expect(client.calls).toContainEqual({ method: "terminal.write", params: { terminalId: "term-1", data: "echo hi\r" } });

		await act(async () => {
			client.emit(
				makeStore(
					new Map([
						["term-1", terminalSnapshot("term-1", [binary, utf8Lead, utf8Tail, ansi])],
					]),
				),
			);
			await Promise.resolve();
		});
		expect(terminals[0]?.writes).toEqual([binary, utf8Lead, utf8Tail, ansi]);

		await mounted.unmount();
		expect(terminals[0]?.disposed).toBe(true);
		expect(terminals[0]?.dataDisposed).toBe(true);
		expect(fits[0]?.disposed).toBe(true);
		expect(ResizeObserverStub.instances[0]?.disconnected).toBe(true);
		expect(MutationObserverStub.instances[0]?.disconnected).toBe(true);
	});

	it("routes clipboard and command shortcuts inside the focused terminal", async () => {
		const client = new FakeClient(makeStore(new Map([["term-1", terminalSnapshot("term-1", [])]])));
		const desktopClient = client as unknown as DesktopClient;
		let terminal: FakeTerminal | undefined;
		const mounted = await mount(
			<TerminalPanel
				client={desktopClient}
				workspaceId="workspace-1"
				initialTerminalIds={["term-1"]}
				adapterFactory={options => {
					terminal = new FakeTerminal(options);
					return createFakeAdapter(terminal);
				}}
			/>,
		);
		if (!terminal?.keyListener) throw new Error("terminal key listener was not installed");
		terminal.selection = "selected output";
		const event: TerminalKeyEvent = {
			type: "keydown",
			key: "c",
			ctrlKey: true,
			metaKey: false,
			shiftKey: false,
			preventDefault() {},
			stopPropagation() {},
		};
		expect(terminal.keyListener(event)).toBe(false);
		await Promise.resolve();
		expect(clipboard.written).toEqual(["selected output"]);

		terminal.selection = "";
		expect(terminal.keyListener(event)).toBe(true);
		const pasteEvent: TerminalKeyEvent = { ...event, key: "v" };
		expect(terminal.keyListener(pasteEvent)).toBe(false);
		await act(async () => Promise.resolve());
		expect(terminal.pastes).toEqual(["pasted text"]);

		const host = mounted.container.querySelector(".terminal-session");
		if (!host) throw new Error("terminal host missing");
		let stopped = false;
		reactProps<{ onKeyDown(event: { ctrlKey: boolean; metaKey: boolean; stopPropagation(): void }): void }>(host).onKeyDown({
			ctrlKey: true,
			metaKey: false,
			stopPropagation: () => { stopped = true; },
		});
		expect(stopped).toBe(true);
		await mounted.unmount();
	});

	it("creates multiple tabs and closes the requested pty", async () => {
		const client = new FakeClient(makeStore(new Map([["term-1", terminalSnapshot("term-1", [])]])));
		const desktopClient = client as unknown as DesktopClient;
		const mounted = await mount(
			<TerminalPanel
				client={desktopClient}
				workspaceId="workspace-1"
				initialTerminalIds={["term-1"]}
				adapterFactory={options => createFakeAdapter(new FakeTerminal(options))}
			/>,
		);
		const add = mounted.container.querySelector(".terminal-new");
		if (!add) throw new Error("new terminal button missing");
		await act(async () => reactProps<{ onClick(): void }>(add).onClick());
		expect(client.calls.some(call => call.method === "terminal.create")).toBe(true);
		expect(mounted.container.querySelectorAll('[role="tab"]')).toHaveLength(2);

		const close = mounted.container.querySelector(".terminal-tab-close");
		if (!close) throw new Error("close button missing");
		await act(async () => reactProps<{ onClick(): void }>(close).onClick());
		expect(client.calls).toContainEqual({ method: "terminal.close", params: { terminalId: "term-1" } });
		await mounted.unmount();
	});
});

describe("LspStatus", () => {
	it("opens diagnostic protocol positions and requests definitions, references, and symbols", async () => {
		const diagnostic: LspDiagnostic = {
			uri: "file:///work/main.ts",
			severity: 1,
			message: "Cannot find name",
			source: "typescript",
			startLine: 12,
			startColumn: 7,
			endLine: 12,
			endColumn: 11,
		};
		const client = new FakeClient(makeStore(new Map(), [diagnostic]));
		const desktopClient = client as unknown as DesktopClient;
		const opened: unknown[] = [];
		const results: unknown[] = [];
		const mounted = await mount(
			<LspStatus
				client={desktopClient}
				workspaceId="workspace-1"
				activeUri="file:///work/main.ts"
				position={{ line: 12, column: 7 }}
				servers={[{ id: "ts", name: "TypeScript", language: "typescript", state: "ready" }]}
				onOpenDiagnostic={(...args) => opened.push(args)}
				onResult={(...args) => results.push(args)}
			/>,
		);
		const diagnosticButton = mounted.container.querySelector(".lsp-diagnostic");
		if (!diagnosticButton) throw new Error("diagnostic button missing");
		await act(async () => reactProps<{ onClick(): void }>(diagnosticButton).onClick());
		expect(opened).toEqual([["file:///work/main.ts", 13, 8]]);

		const buttons = [...mounted.container.querySelectorAll(".lsp-actions > button")];
		await act(async () => reactProps<{ onClick(): void }>(buttons[0]!).onClick());
		await act(async () => Promise.resolve());
		await act(async () => reactProps<{ onClick(): void }>(buttons[1]!).onClick());
		await act(async () => Promise.resolve());
		const symbolButton = mounted.container.querySelector('.lsp-symbol-search button');
		if (!symbolButton) throw new Error("symbol button missing");
		await act(async () => reactProps<{ onClick(): void }>(symbolButton).onClick());
		await act(async () => Promise.resolve());

		const lspCalls = client.calls.filter(call => call.method === "lsp.request");
		const lspMethods = lspCalls.map(call => {
			const params = call.params as DesktopRequestMap["lsp.request"]["params"];
			return params.method;
		});
		expect(lspMethods).toEqual(["textDocument/definition", "textDocument/references", "workspace/symbol"]);
		expect(results).toHaveLength(3);
		await mounted.unmount();
	});

	it("maps every xterm palette role from CSS tokens", () => {
		const element = document.createElement("div");
		const values = {
			"--color-editor": "editor-bg",
			"--color-text": "editor-fg",
			"--accent-primary": "cursor",
			"--color-selection": "selection",
			"--ansi-red": "red",
			"--ansi-bright-cyan": "bright-cyan",
		};
		for (const [name, value] of Object.entries(values)) element.style.setProperty(name, value);
		document.body.appendChild(element);
		const theme = readXtermTheme(element);
		expect(theme).toMatchObject({
			background: "editor-bg",
			foreground: "editor-fg",
			cursor: "cursor",
			selectionBackground: "selection",
			red: "red",
			brightCyan: "bright-cyan",
		});
		element.remove();
	});
});
