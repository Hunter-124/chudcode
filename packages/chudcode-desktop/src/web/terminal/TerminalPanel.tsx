import { FitAddon } from "@xterm/addon-fit";
import {
	type IDisposable,
	type ITerminalAddon,
	type ITerminalInitOnlyOptions,
	type ITerminalOptions,
	type ITheme,
	Terminal,
} from "@xterm/xterm";
import { Plus, RotateCcw, X } from "lucide-react";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	startTransition,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import type { TerminalId, WorkspaceId } from "../../protocol";
import type { DesktopClient } from "../desktop-client";
import { desktopSelectors, selectTerminal, useDesktop } from "../use-desktop";
import "./terminal.css";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MIN_COLS = 2;
const MAX_COLS = 500;
const MIN_ROWS = 2;
const MAX_ROWS = 200;
const EMPTY_TERMINAL_CHUNKS = [] as const;

export interface XtermLike {
	readonly cols: number;
	readonly rows: number;
	options: ITerminalOptions;
	open(element: HTMLElement): void;
	loadAddon(addon: ITerminalAddon): void;
	onData(listener: (data: string) => void): IDisposable;
	write(data: string | Uint8Array, callback?: () => void): void;
	paste(data: string): void;
	focus(): void;
	resize(cols: number, rows: number): void;
	hasSelection(): boolean;
	getSelection(): string;
	selectAll(): void;
	dispose(): void;
}

export interface FitAddonLike extends ITerminalAddon {
	proposeDimensions(): { cols: number; rows: number } | undefined;
}

export interface TerminalKeyEvent {
	readonly type: string;
	readonly key: string;
	readonly ctrlKey: boolean;
	readonly metaKey: boolean;
	readonly shiftKey: boolean;
	preventDefault(): void;
	stopPropagation(): void;
}

export interface TerminalResizeObserver {
	observe(target: Element): void;
	disconnect(): void;
}

export interface TerminalMutationObserver {
	observe(target: Node, options?: MutationObserverInit): void;
	disconnect(): void;
}

export interface TerminalAdapter {
	terminal: XtermLike;
	fitAddon: FitAddonLike;
	attachCustomKeyEventHandler(listener: (event: TerminalKeyEvent) => boolean): void;
	ResizeObserver?: new (callback: () => void) => TerminalResizeObserver;
	MutationObserver?: new (callback: () => void) => TerminalMutationObserver;
}

export type TerminalConstructorOptions = ITerminalOptions & ITerminalInitOnlyOptions;
export type TerminalAdapterFactory = (options: TerminalConstructorOptions) => TerminalAdapter;

export const createXtermAdapter: TerminalAdapterFactory = options => {
	const terminal = new Terminal(options);
	return {
		terminal,
		fitAddon: new FitAddon(),
		attachCustomKeyEventHandler: listener => terminal.attachCustomKeyEventHandler(listener),
		ResizeObserver: typeof ResizeObserver !== "undefined" ? ResizeObserver : undefined,
		MutationObserver: typeof MutationObserver !== "undefined" ? MutationObserver : undefined,
	};
};

interface TerminalTab {
	key: string;
	title: string;
	terminalId: TerminalId | null;
	status: "creating" | "live" | "error";
	error?: string;
}

export interface TerminalPanelProps {
	client: DesktopClient;
	workspaceId: WorkspaceId;
	adapterFactory?: TerminalAdapterFactory;
	initialTerminalIds?: readonly TerminalId[];
	className?: string;
}

type XtermCssColorRole = {
	[Role in keyof ITheme]-?: Exclude<ITheme[Role], undefined> extends string ? Role : never;
}[keyof ITheme];

const XTERM_THEME_VARIABLES = [
	["background", "--color-editor"],
	["foreground", "--color-text"],
	["cursor", "--accent-primary"],
	["cursorAccent", "--color-editor"],
	["selectionBackground", "--color-selection"],
	["black", "--ansi-black"],
	["red", "--ansi-red"],
	["green", "--ansi-green"],
	["yellow", "--ansi-yellow"],
	["blue", "--ansi-blue"],
	["magenta", "--ansi-magenta"],
	["cyan", "--ansi-cyan"],
	["white", "--ansi-white"],
	["brightBlack", "--ansi-bright-black"],
	["brightRed", "--ansi-bright-red"],
	["brightGreen", "--ansi-bright-green"],
	["brightYellow", "--ansi-bright-yellow"],
	["brightBlue", "--ansi-bright-blue"],
	["brightMagenta", "--ansi-bright-magenta"],
	["brightCyan", "--ansi-bright-cyan"],
	["brightWhite", "--ansi-bright-white"],
] as const satisfies readonly (readonly [XtermCssColorRole, string])[];

/** Maps the normative CSS tokens to xterm without duplicating theme colors in JS. */
export function readXtermTheme(element: Element): ITheme {
	const view = element.ownerDocument.defaultView;
	const style = view?.getComputedStyle(element) ?? globalThis.getComputedStyle?.(element);
	if (!style) return {};
	const theme: Partial<Record<XtermCssColorRole, string>> = {};
	for (const [role, variable] of XTERM_THEME_VARIABLES) {
		const value = style.getPropertyValue(variable).trim();
		if (value) theme[role] = value;
	}
	return theme;
}

function clampDimension(value: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function stopShellShortcut(event: ReactKeyboardEvent<HTMLDivElement>): void {
	if (event.ctrlKey || event.metaKey) event.stopPropagation();
}

function TerminalSession({
	client,
	terminalId,
	active,
	adapterFactory,
	onError,
}: {
	client: DesktopClient;
	terminalId: TerminalId;
	active: boolean;
	adapterFactory: TerminalAdapterFactory;
	onError(message: string): void;
}) {
	const hostRef = useRef<HTMLDivElement>(null);
	const activeRef = useRef(active);
	activeRef.current = active;
	const onErrorRef = useRef(onError);
	onErrorRef.current = onError;
	const snapshot = useDesktop(client, store => selectTerminal(store, terminalId));
	const snapshotChunks = snapshot?.chunks ?? EMPTY_TERMINAL_CHUNKS;
	const snapshotNextSequence = snapshot?.nextSequence ?? 0;
	const nextWrittenSequenceRef = useRef(0);
	const terminalRef = useRef<XtermLike | null>(null);
	const resizeRef = useRef<(() => void) | null>(null);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const root = host.ownerDocument.documentElement;
		const view = host.ownerDocument.defaultView;
		const computedStyle = view?.getComputedStyle(host) ?? globalThis.getComputedStyle(host);
		const reducedMotion =
			root.dataset.motionScale === "0" || view?.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
		const {
			terminal,
			fitAddon,
			attachCustomKeyEventHandler,
			ResizeObserver: ResizeObserverConstructor,
			MutationObserver: MutationObserverConstructor,
		} = adapterFactory({
			cols: DEFAULT_COLS,
			rows: DEFAULT_ROWS,
			allowTransparency: true,
			convertEol: false,
			cursorBlink: !reducedMotion,
			fontFamily: computedStyle.getPropertyValue("--font-code").trim() || undefined,
			fontSize: Number.parseFloat(computedStyle.getPropertyValue("--font-size-code")) || undefined,
			scrollback: 10_000,
			theme: readXtermTheme(host),
		});
		terminalRef.current = terminal;
		terminal.loadAddon(fitAddon);
		terminal.open(host);

		let disposed = false;
		let scheduled: number | ReturnType<typeof setTimeout> | null = null;
		let lastRemoteCols = 0;
		let lastRemoteRows = 0;
		const cancelScheduled = () => {
			if (scheduled === null) return;
			if (view?.cancelAnimationFrame && typeof scheduled === "number") view.cancelAnimationFrame(scheduled);
			else clearTimeout(scheduled as ReturnType<typeof setTimeout>);
			scheduled = null;
		};
		const resize = () => {
			if (disposed || !activeRef.current) return;
			const proposed = fitAddon.proposeDimensions();
			if (!proposed) return;
			const cols = clampDimension(proposed.cols, MIN_COLS, MAX_COLS);
			const rows = clampDimension(proposed.rows, MIN_ROWS, MAX_ROWS);
			if (terminal.cols !== cols || terminal.rows !== rows) terminal.resize(cols, rows);
			if (lastRemoteCols === cols && lastRemoteRows === rows) return;
			lastRemoteCols = cols;
			lastRemoteRows = rows;
			void client
				.request("terminal.resize", { terminalId, cols, rows })
				.catch(error => onErrorRef.current(errorMessage(error)));
		};
		const scheduleResize = () => {
			if (scheduled !== null) return;
			const run = () => {
				scheduled = null;
				resize();
			};
			scheduled = view?.requestAnimationFrame ? view.requestAnimationFrame(run) : setTimeout(run, 0);
		};
		resizeRef.current = scheduleResize;

		const dataDisposable = terminal.onData(data => {
			void client
				.request("terminal.write", { terminalId, data })
				.catch(error => onErrorRef.current(errorMessage(error)));
		});
		attachCustomKeyEventHandler(event => {
			if (event.type !== "keydown") return true;
			const key = event.key.toLowerCase();
			const copy = (event.metaKey || (event.ctrlKey && event.shiftKey) || event.ctrlKey) && key === "c";
			if (copy && terminal.hasSelection()) {
				event.preventDefault();
				event.stopPropagation();
				void host.ownerDocument.defaultView?.navigator.clipboard
					?.writeText(terminal.getSelection())
					.catch(error => onErrorRef.current(errorMessage(error)));
				return false;
			}
			const paste = (event.metaKey || event.ctrlKey) && key === "v";
			if (paste) {
				event.preventDefault();
				event.stopPropagation();
				void host.ownerDocument.defaultView?.navigator.clipboard
					?.readText()
					.then(text => terminal.paste(text))
					.catch(error => onErrorRef.current(errorMessage(error)));
				return false;
			}
			if (event.metaKey && key === "a") {
				event.preventDefault();
				event.stopPropagation();
				terminal.selectAll();
				return false;
			}
			return true;
		});

		const resizeObserver = ResizeObserverConstructor ? new ResizeObserverConstructor(scheduleResize) : null;
		resizeObserver?.observe(host);
		const themeObserver = MutationObserverConstructor
			? new MutationObserverConstructor(() => {
					terminal.options.theme = readXtermTheme(host);
					scheduleResize();
				})
			: null;
		themeObserver?.observe(root, { attributes: true, attributeFilter: ["data-theme", "style"] });
		scheduleResize();
		if (activeRef.current) terminal.focus();

		return () => {
			disposed = true;
			cancelScheduled();
			resizeObserver?.disconnect();
			themeObserver?.disconnect();
			dataDisposable.dispose();
			fitAddon.dispose();
			terminal.dispose();
			terminalRef.current = null;
			resizeRef.current = null;
		};
	}, [adapterFactory, client, terminalId]);

	useEffect(() => {
		const terminal = terminalRef.current;
		if (!terminal) return;
		if (snapshotNextSequence < nextWrittenSequenceRef.current) {
			nextWrittenSequenceRef.current = 0;
		}
		for (const chunk of snapshotChunks) {
			if (chunk.sequence < nextWrittenSequenceRef.current) continue;
			terminal.write(chunk.data);
			nextWrittenSequenceRef.current = chunk.sequence + 1;
		}
	}, [snapshotChunks, snapshotNextSequence]);

	useEffect(() => {
		if (!active) return;
		terminalRef.current?.focus();
		resizeRef.current?.();
	}, [active]);

	return (
		<div
			ref={hostRef}
			className={`terminal-session${active ? " is-active" : ""}`}
			aria-hidden={!active}
			onKeyDown={stopShellShortcut}
		/>
	);
}

export function TerminalPanel({
	client,
	workspaceId,
	adapterFactory = createXtermAdapter,
	initialTerminalIds = [],
	className = "",
}: TerminalPanelProps) {
	const reactId = useId();
	const sequenceRef = useRef(initialTerminalIds.length);
	const session = useDesktop(client, desktopSelectors.session);
	const lastError = useDesktop(client, desktopSelectors.lastError);
	const [tabs, setTabs] = useState<TerminalTab[]>(() =>
		initialTerminalIds.map((terminalId, index) => ({
			key: terminalId,
			title: `Terminal ${index + 1}`,
			terminalId,
			status: "live",
		})),
	);
	const [activeKey, setActiveKey] = useState<string | null>(() => initialTerminalIds[0] ?? null);
	const mountedRef = useRef(true);
	useEffect(
		() => () => {
			mountedRef.current = false;
		},
		[],
	);

	const reportTabError = useCallback((key: string, message: string) => {
		setTabs(current => current.map(tab => (tab.key === key ? { ...tab, status: "error", error: message } : tab)));
	}, []);

	const createTab = useCallback(() => {
		sequenceRef.current += 1;
		const key = `${reactId}-${sequenceRef.current}`;
		const title = `Terminal ${sequenceRef.current}`;
		setTabs(current => [...current, { key, title, terminalId: null, status: "creating" }]);
		setActiveKey(key);
		void client
			.request("terminal.create", { workspaceId, cols: DEFAULT_COLS, rows: DEFAULT_ROWS })
			.then(({ terminalId }) => {
				if (!mountedRef.current) {
					void client.request("terminal.close", { terminalId });
					return;
				}
				startTransition(() => {
					setTabs(current =>
						current.map(tab =>
							tab.key === key ? { ...tab, terminalId, status: "live", error: undefined } : tab,
						),
					);
				});
			})
			.catch(error => reportTabError(key, errorMessage(error)));
	}, [client, reactId, reportTabError, workspaceId]);

	useEffect(() => {
		if (tabs.length === 0 && session.phase === "live") createTab();
	}, [createTab, session.phase, tabs.length]);

	const closeTab = useCallback(
		(key: string) => {
			setTabs(current => {
				const index = current.findIndex(tab => tab.key === key);
				if (index < 0) return current;
				const tab = current[index];
				if (tab?.terminalId) {
					void client
						.request("terminal.close", { terminalId: tab.terminalId })
						.catch(error => reportTabError(key, errorMessage(error)));
				}
				const next = current.filter(item => item.key !== key);
				setActiveKey(active => {
					if (active !== key) return active;
					return next[Math.min(index, next.length - 1)]?.key ?? null;
				});
				return next;
			});
		},
		[client, reportTabError],
	);

	const activeTab = tabs.find(tab => tab.key === activeKey) ?? null;
	const activeSnapshot = useDesktop(client, store =>
		activeTab?.terminalId ? selectTerminal(store, activeTab.terminalId) : undefined,
	);
	const activeClosed = activeSnapshot?.closed === true;

	return (
		<section className={`terminal-panel ${className}`.trim()} aria-label="Terminal panel">
			<div className="terminal-tabs" role="tablist" aria-label="Terminal sessions">
				{tabs.map(tab => {
					const selected = tab.key === activeKey;
					return (
						<div className={`terminal-tab-wrap${selected ? " is-active" : ""}`} key={tab.key}>
							<button
								type="button"
								role="tab"
								aria-selected={selected}
								aria-controls={`${tab.key}-panel`}
								className="terminal-tab"
								onClick={() => setActiveKey(tab.key)}
							>
								<span className={`terminal-tab-status is-${tab.status}`} aria-hidden="true" />
								{tab.title}
							</button>
							<button
								type="button"
								className="terminal-tab-close"
								aria-label={`Close ${tab.title}`}
								onClick={() => closeTab(tab.key)}
							>
								<X aria-hidden="true" size={14} />
							</button>
						</div>
					);
				})}
				<button
					type="button"
					className="terminal-new"
					aria-label="New terminal"
					onClick={createTab}
					disabled={session.phase !== "live"}
				>
					<Plus aria-hidden="true" size={15} />
				</button>
				<span className="terminal-connection" data-phase={session.phase}>
					{session.phase}
				</span>
			</div>

			<div className="terminal-viewport">
				{tabs.map(tab =>
					tab.terminalId ? (
						<div
							key={tab.key}
							id={`${tab.key}-panel`}
							role="tabpanel"
							hidden={tab.key !== activeKey}
							className="terminal-tab-panel"
						>
							<TerminalSession
								client={client}
								terminalId={tab.terminalId}
								active={tab.key === activeKey}
								adapterFactory={adapterFactory}
								onError={message => reportTabError(tab.key, message)}
							/>
						</div>
					) : null,
				)}
				{activeTab?.status === "creating" ? <div className="terminal-state">Starting terminal…</div> : null}
				{activeTab?.status === "error" ? (
					<div className="terminal-state is-error" role="alert">
						<span>{activeTab.error}</span>
						<button
							type="button"
							onClick={() => {
								closeTab(activeTab.key);
								createTab();
							}}
						>
							<RotateCcw aria-hidden="true" size={14} /> Retry
						</button>
					</div>
				) : null}
				{activeClosed ? (
					<div className="terminal-exit" role="status">
						Terminal exited{activeSnapshot?.exitCode == null ? "" : ` with code ${activeSnapshot.exitCode}`}
						{activeSnapshot?.signal ? ` (${activeSnapshot.signal})` : ""}
					</div>
				) : null}
				{session.phase !== "live" ? (
					<div className="terminal-state terminal-reconnect" role="status">
						<span>{session.endedReason ?? lastError?.message ?? `Session ${session.phase}`}</span>
						<button
							type="button"
							onClick={() => client.connect()}
							disabled={session.phase === "connecting" || session.phase === "reconnecting"}
						>
							<RotateCcw aria-hidden="true" size={14} /> Reconnect
						</button>
					</div>
				) : null}
				{tabs.length === 0 && session.phase === "live" ? (
					<div className="terminal-state">No terminal sessions</div>
				) : null}
			</div>
		</section>
	);
}
