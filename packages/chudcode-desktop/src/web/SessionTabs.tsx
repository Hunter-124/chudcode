import { History, LoaderCircle, Plus, Square, X } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesktopSessionInfo, DesktopSessionTab } from "../protocol";
import type { DesktopClient } from "./desktop-client";

function projectName(path: string): string {
	const normalized = path.replace(/[\\/]+$/, "");
	return normalized.split(/[\\/]/).at(-1) || path;
}

function safeId(value: string): string {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}

export function sessionTabId(path: string): string {
	return `agent-session-tab-${safeId(path)}`;
}

export interface SessionTabsProps {
	client: DesktopClient;
	tabs: readonly DesktopSessionTab[];
	sessions: readonly DesktopSessionInfo[];
	newSessionCwd?: string;
	onActivate?(path: string): void;
	onClose?(path: string): void;
	onError?(message: string): void;
}

export function SessionTabs({
	client,
	tabs,
	sessions,
	newSessionCwd,
	onActivate,
	onClose,
	onError,
}: SessionTabsProps): ReactNode {
	const [pickerOpen, setPickerOpen] = useState(false);
	const [closeCandidate, setCloseCandidate] = useState<DesktopSessionTab | null>(null);
	const [busyPath, setBusyPath] = useState<string | null>(null);
	const tabsRef = useRef<HTMLDivElement>(null);
	const pickerRef = useRef<HTMLElement>(null);
	const closeDialogRef = useRef<HTMLElement>(null);
	const focusPath = useRef<string | null>(null);
	const activeIndex = Math.max(
		0,
		tabs.findIndex(tab => tab.active),
	);
	const inactiveSessions = useMemo(() => {
		const openPaths = new Set(tabs.map(tab => tab.path));
		return sessions.filter(session => !openPaths.has(session.path));
	}, [sessions, tabs]);

	const reportError = useCallback(
		(cause: unknown): void => {
			onError?.(cause instanceof Error ? cause.message : String(cause));
		},
		[onError],
	);

	const activate = useCallback(
		async (path: string, focusTab = false): Promise<void> => {
			if (focusTab) focusPath.current = path;
			setBusyPath(path);
			try {
				await client.activateSession(path);
				setPickerOpen(false);
				onActivate?.(path);
			} catch (cause) {
				if (focusPath.current === path) focusPath.current = null;
				reportError(cause);
			} finally {
				setBusyPath(null);
			}
		},
		[client, onActivate, reportError],
	);

	useEffect(() => {
		if (busyPath || focusPath.current === null) return;
		const path = focusPath.current;
		const target = path
			? document.getElementById(sessionTabId(path))
			: tabsRef.current?.querySelector<HTMLElement>(".session-tabs-actions button:not(:disabled)");
		if (target) {
			target.focus();
			focusPath.current = null;
		}
	}, [busyPath, tabs]);

	useEffect(() => {
		const overlay = closeCandidate ? closeDialogRef.current : pickerOpen ? pickerRef.current : null;
		if (!overlay) return;
		const previousFocus = document.activeElement;
		(overlay.querySelector<HTMLElement>("button:not(:disabled)") ?? overlay).focus();
		return () => {
			if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
			else
				tabsRef.current
					?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"], .session-tabs-actions button')
					?.focus();
		};
	}, [closeCandidate, pickerOpen]);

	const navigateTab = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
		if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
		const nextIndex =
			event.key === "ArrowRight"
				? (index + 1) % tabs.length
				: event.key === "ArrowLeft"
					? (index + tabs.length - 1) % tabs.length
					: event.key === "Home"
						? 0
						: event.key === "End"
							? tabs.length - 1
							: undefined;
		const tab = nextIndex === undefined ? undefined : tabs[nextIndex];
		if (!tab) return;
		event.preventDefault();
		document.getElementById(sessionTabId(tab.path))?.focus();
		void activate(tab.path);
	};

	const overlayKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
		if (event.nativeEvent.isComposing) return;
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			if (closeCandidate) setCloseCandidate(null);
			else setPickerOpen(false);
		} else if (closeCandidate && event.key === "Tab") {
			const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
			const first = buttons[0];
			const last = buttons[buttons.length - 1];
			if (
				(event.shiftKey && document.activeElement === first) ||
				(!event.shiftKey && document.activeElement === last)
			) {
				event.preventDefault();
				(event.shiftKey ? last : first)?.focus();
			}
			event.stopPropagation();
		}
	};

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent): void => {
			if (closeCandidate || pickerOpen || event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey))
				return;
			if (/^[1-9]$/.test(event.key) && !event.shiftKey) {
				const tab = tabs[Number(event.key) - 1];
				if (!tab) return;
				event.preventDefault();
				void activate(tab.path);
				return;
			}
			if (event.key === "Tab" && tabs.length > 1) {
				event.preventDefault();
				const offset = event.shiftKey ? -1 : 1;
				const nextIndex = (activeIndex + offset + tabs.length) % tabs.length;
				const tab = tabs[nextIndex];
				if (tab) void activate(tab.path);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [activate, activeIndex, tabs, closeCandidate, pickerOpen]);

	const newSession = useCallback(async (): Promise<void> => {
		if (!newSessionCwd) {
			reportError(new Error("Open a project before creating a session."));
			return;
		}
		setBusyPath("new");
		try {
			const result = await client.request("session.new", { cwd: newSessionCwd });
			await activate(result.session.path, true);
		} catch (cause) {
			reportError(cause);
		} finally {
			setBusyPath(null);
		}
	}, [activate, client, newSessionCwd, reportError]);

	const stop = useCallback(
		async (path: string): Promise<void> => {
			setBusyPath(path);
			try {
				await client.request("run.abort", { sessionPath: path });
			} catch (cause) {
				reportError(cause);
			} finally {
				setBusyPath(null);
			}
		},
		[client, reportError],
	);

	const requestClose = useCallback(
		async (tab: DesktopSessionTab): Promise<void> => {
			if (tab.running || tab.draftDirty) {
				setCloseCandidate(tab);
				return;
			}
			setBusyPath(tab.path);
			try {
				const result = await client.closeSession(tab.path);
				if (result.closed) {
					focusPath.current = result.tabs.find(candidate => candidate.active)?.path ?? "";
					onClose?.(tab.path);
				} else if (result.blockedReason)
					setCloseCandidate({
						...tab,
						running: result.blockedReason === "running",
						draftDirty: result.blockedReason === "dirty-draft",
					});
			} catch (cause) {
				reportError(cause);
			} finally {
				setBusyPath(null);
			}
		},
		[client, onClose, reportError],
	);

	const confirmClose = useCallback(async (): Promise<void> => {
		const tab = closeCandidate;
		if (!tab) return;
		setBusyPath(tab.path);
		try {
			if (tab.running) await client.request("run.abort", { sessionPath: tab.path });
			const result = await client.closeSession(tab.path, true);
			if (result.closed) {
				focusPath.current = result.tabs.find(candidate => candidate.active)?.path ?? "";
				onClose?.(tab.path);
				setCloseCandidate(null);
			}
		} catch (cause) {
			reportError(cause);
		} finally {
			setBusyPath(null);
		}
	}, [client, closeCandidate, onClose, reportError]);

	const preventAuxiliaryClose = (event: MouseEvent<HTMLButtonElement>): void => {
		event.preventDefault();
		event.stopPropagation();
	};

	const confirmLabel =
		closeCandidate?.running && closeCandidate.draftDirty
			? "Abort & Discard Draft & Close"
			: closeCandidate?.running
				? "Abort & Close"
				: "Discard Draft & Close";

	return (
		<>
			<div className="session-tabs-bar" ref={tabsRef}>
				<div className="session-tabs-scroll" role="tablist" aria-label="Agent sessions">
					{tabs.map((tab, index) => (
						<div
							key={tab.path}
							className={`session-tab${tab.active ? " is-active" : ""}${tab.running ? " is-running" : ""}`}
						>
							<button
								type="button"
								id={sessionTabId(tab.path)}
								className="session-tab-select"
								role="tab"
								aria-selected={tab.active}
								aria-controls="agent-session-panel"
								tabIndex={tab.active ? 0 : -1}
								onClick={() => void activate(tab.path)}
								onAuxClick={preventAuxiliaryClose}
								onKeyDown={event => navigateTab(event, index)}
								title={`${tab.title} — ${tab.cwd}`}
							>
								{tab.running ? (
									<LoaderCircle className="session-tab-spinner" size={13} aria-label="Running" />
								) : null}
								<span className="session-tab-copy">
									<strong>{tab.title}</strong>
									<span>{projectName(tab.cwd)}</span>
								</span>
								{tab.unread > 0 ? (
									<span className="session-tab-unread" aria-label={`${tab.unread} unread`}>
										{tab.unread > 99 ? "99+" : tab.unread}
									</span>
								) : null}
								{tab.draftDirty ? <span className="session-tab-dirty" aria-label="Unsaved draft" /> : null}
							</button>
							{tab.running ? (
								<button
									type="button"
									className="session-tab-stop"
									aria-label={`Stop ${tab.title}`}
									title={`Stop ${tab.title}`}
									onClick={() => void stop(tab.path)}
									disabled={busyPath === tab.path}
								>
									<Square size={10} aria-hidden />
								</button>
							) : null}
							<button
								type="button"
								className="session-tab-close"
								aria-label={`Close ${tab.title}`}
								title={`Close ${tab.title}`}
								onClick={() => void requestClose(tab)}
								onAuxClick={preventAuxiliaryClose}
								disabled={busyPath === tab.path}
							>
								<X size={13} aria-hidden />
							</button>
						</div>
					))}
				</div>
				<div className="session-tabs-actions">
					<button
						type="button"
						aria-label="New agent session"
						title="New agent session"
						onClick={() => void newSession()}
						disabled={busyPath === "new" || !newSessionCwd}
					>
						<Plus size={15} aria-hidden />
					</button>
					<button
						type="button"
						aria-label="Open existing session"
						aria-haspopup="dialog"
						aria-expanded={pickerOpen}
						title="Open existing session"
						onClick={() => setPickerOpen(value => !value)}
					>
						<History size={14} aria-hidden />
					</button>
				</div>
				{pickerOpen ? (
					<section
						className="session-picker"
						role="dialog"
						aria-label="Open existing session"
						ref={pickerRef}
						tabIndex={-1}
						onKeyDown={overlayKeyDown}
					>
						<header>
							<strong>Existing sessions</strong>
							<span>{inactiveSessions.length}</span>
						</header>
						<ul>
							{inactiveSessions.map(session => (
								<li key={session.path}>
									<button type="button" onClick={() => void activate(session.path)}>
										<strong>{session.title ?? projectName(session.cwd)}</strong>
										<span>{session.cwd}</span>
									</button>
								</li>
							))}
							{inactiveSessions.length === 0 ? (
								<li className="session-picker-empty">All sessions are open</li>
							) : null}
						</ul>
					</section>
				) : null}
			</div>
			{closeCandidate ? (
				<div className="session-close-backdrop">
					<section
						className="session-close-dialog"
						role="alertdialog"
						aria-modal="true"
						aria-labelledby="session-close-title"
						aria-describedby="session-close-description"
						ref={closeDialogRef}
						tabIndex={-1}
						onKeyDown={overlayKeyDown}
					>
						<h2 id="session-close-title">Close {closeCandidate.title}?</h2>
						<p id="session-close-description">
							{closeCandidate.running && closeCandidate.draftDirty
								? "This session is running and has an unsent draft. Closing will abort the run and discard the draft."
								: closeCandidate.running
									? "This session is still running. Closing will abort only this session."
									: "This session has an unsent draft. Closing will discard it."}
						</p>
						<div className="session-close-actions">
							<button type="button" onClick={() => setCloseCandidate(null)}>
								Cancel
							</button>
							<button
								type="button"
								className="is-danger"
								onClick={() => void confirmClose()}
								disabled={busyPath === closeCandidate.path}
							>
								{confirmLabel}
							</button>
						</div>
					</section>
				</div>
			) : null}
		</>
	);
}
