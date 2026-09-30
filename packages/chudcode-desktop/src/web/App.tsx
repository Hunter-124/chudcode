import { AgentDrawer } from "@oh-my-pi/collab-web/agent-drawer";
import { AgentsPanel } from "@oh-my-pi/collab-web/agents-panel";
import { Banners } from "@oh-my-pi/collab-web/banners";
import { Composer } from "@oh-my-pi/collab-web/composer";
import { HeaderBar } from "@oh-my-pi/collab-web/header";
import { Toasts } from "@oh-my-pi/collab-web/toasts";
import { Transcript } from "@oh-my-pi/collab-web/transcript";
import {
	Files,
	GitBranch,
	ListTree,
	PanelBottomClose,
	PanelBottomOpen,
	PanelLeftClose,
	PanelRightClose,
	PlaySquare,
	Search,
	Share2,
	TerminalSquare,
} from "lucide-react";
import type { CSSProperties, ReactNode, PointerEvent as ReactPointerEvent, RefAttributes } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesktopSessionInfo, WorkspaceDescriptor } from "../protocol";
import type { DesktopClient } from "./desktop-client";
import { EditorWorkspace, type EditorWorkspaceHandle } from "./editor/EditorWorkspace";
import { GitPanel, type GitPanelProps } from "./git/GitPanel";
import type { GraphKind } from "./graph/force-graph";
import { GraphPanel, type GraphPanelProps } from "./graph/GraphPanel";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { SessionTabs, sessionTabId } from "./SessionTabs";
import { LspStatus, type LspStatusProps } from "./terminal/LspStatus";
import { TerminalPanel, type TerminalPanelProps } from "./terminal/TerminalPanel";
import { UtilityRail, type UtilityRoute } from "./UtilityRail";
import { desktopSelectors, useDesktop } from "./use-desktop";

const LAYOUT_STORAGE_KEY = "chudcode.ide.layout.v1";
const DEFAULT_PRIMARY_WIDTH = 268;
const DEFAULT_SECONDARY_WIDTH = 390;
const DEFAULT_BOTTOM_HEIGHT = 250;

export type Activity = "explorer" | "search" | "source-control" | "terminal" | "graph" | "sessions";

interface LayoutState {
	primaryOpen: boolean;
	secondaryOpen: boolean;
	bottomOpen: boolean;
	primaryWidth: number;
	secondaryWidth: number;
	bottomHeight: number;
	activity: Activity;
	utilityRoute: UtilityRoute;
}

const DEFAULT_LAYOUT: LayoutState = {
	primaryOpen: true,
	secondaryOpen: true,
	bottomOpen: false,
	primaryWidth: DEFAULT_PRIMARY_WIDTH,
	secondaryWidth: DEFAULT_SECONDARY_WIDTH,
	bottomHeight: DEFAULT_BOTTOM_HEIGHT,
	activity: "explorer",
	utilityRoute: "sessions",
};

const ACTIVITIES: readonly {
	id: Activity;
	label: string;
	shortcut: string;
	icon: typeof Files;
}[] = [
	{ id: "explorer", label: "Explorer", shortcut: "Ctrl+Shift+E", icon: Files },
	{ id: "search", label: "Search", shortcut: "Ctrl+Shift+F", icon: Search },
	{ id: "source-control", label: "Source Control", shortcut: "Ctrl+Shift+G", icon: GitBranch },
	{ id: "terminal", label: "Run and Terminal", shortcut: "Ctrl+`", icon: PlaySquare },
	{ id: "graph", label: "Graph", shortcut: "Ctrl+Shift+Y", icon: Share2 },
	{ id: "sessions", label: "Sessions", shortcut: "Ctrl+Shift+U", icon: ListTree },
];

function isActivity(value: unknown): value is Activity {
	return typeof value === "string" && ACTIVITIES.some(item => item.id === value);
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

function loadLayout(): LayoutState {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) ?? "null");
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ...DEFAULT_LAYOUT };
		const value = parsed as Partial<LayoutState>;
		const activity: Activity = isActivity(value.activity) ? value.activity : DEFAULT_LAYOUT.activity;
		const utilityRoute =
			value.utilityRoute === "sessions" ||
			value.utilityRoute === "tasks" ||
			value.utilityRoute === "settings-basic" ||
			value.utilityRoute === "settings-advanced"
				? value.utilityRoute
				: DEFAULT_LAYOUT.utilityRoute;
		return {
			primaryOpen: typeof value.primaryOpen === "boolean" ? value.primaryOpen : DEFAULT_LAYOUT.primaryOpen,
			secondaryOpen: typeof value.secondaryOpen === "boolean" ? value.secondaryOpen : DEFAULT_LAYOUT.secondaryOpen,
			bottomOpen: typeof value.bottomOpen === "boolean" ? value.bottomOpen : DEFAULT_LAYOUT.bottomOpen,
			primaryWidth: clamp(Number(value.primaryWidth) || DEFAULT_PRIMARY_WIDTH, 200, 520),
			secondaryWidth: clamp(Number(value.secondaryWidth) || DEFAULT_SECONDARY_WIDTH, 280, 640),
			bottomHeight: clamp(Number(value.bottomHeight) || DEFAULT_BOTTOM_HEIGHT, 120, 520),
			activity,
			utilityRoute,
		};
	} catch {
		return { ...DEFAULT_LAYOUT };
	}
}

function activityTitle(activity: Activity): string {
	return ACTIVITIES.find(item => item.id === activity)?.label ?? "Explorer";
}

function isTextEditingTarget(target: unknown): boolean {
	if (target === null || typeof target !== "object") return false;
	const tagName = "tagName" in target && typeof target.tagName === "string" ? target.tagName.toUpperCase() : "";
	return (
		tagName === "INPUT" ||
		tagName === "TEXTAREA" ||
		tagName === "SELECT" ||
		("isContentEditable" in target && target.isContentEditable === true)
	);
}

export interface ShellKeyboardEvent {
	readonly target: unknown;
	readonly isComposing: boolean;
	readonly key: string;
	readonly code: string;
	readonly ctrlKey: boolean;
	readonly shiftKey: boolean;
	readonly altKey: boolean;
	readonly metaKey: boolean;
	preventDefault(): void;
}

export interface ShellShortcutBindings {
	togglePrimary(): void;
	toggleSecondary(): void;
	focusEditor(): void;
	setActivity(activity: Activity): void;
}

export function handleShellShortcut(event: ShellKeyboardEvent, bindings: ShellShortcutBindings): boolean {
	if (isTextEditingTarget(event.target) || event.isComposing) return false;
	const key = event.key.toLowerCase();
	if (event.ctrlKey && !event.shiftKey && !event.altKey && key === "b") bindings.togglePrimary();
	else if (event.ctrlKey && event.altKey && !event.shiftKey && key === "b") bindings.toggleSecondary();
	else if (event.ctrlKey && !event.shiftKey && !event.altKey && key === "1") bindings.focusEditor();
	else if (event.ctrlKey && event.shiftKey && !event.altKey && key === "e") bindings.setActivity("explorer");
	else if (event.ctrlKey && event.shiftKey && !event.altKey && key === "f") bindings.setActivity("search");
	else if (event.ctrlKey && event.shiftKey && !event.altKey && key === "g") bindings.setActivity("source-control");
	else if (event.ctrlKey && !event.shiftKey && !event.altKey && event.code === "Backquote")
		bindings.setActivity("terminal");
	else if (event.ctrlKey && event.shiftKey && !event.altKey && key === "y") bindings.setActivity("graph");
	else if (event.ctrlKey && event.shiftKey && !event.altKey && key === "u") bindings.setActivity("sessions");
	else return false;
	event.preventDefault();
	return true;
}

export interface AppEditorWorkspaceProps {
	client: DesktopClient;
	workspace?: WorkspaceDescriptor;
	onWorkspaceChange?(workspace: WorkspaceDescriptor): void;
}

export interface AppComponents {
	EditorWorkspace(props: AppEditorWorkspaceProps & RefAttributes<EditorWorkspaceHandle>): ReactNode;
	GitPanel(props: GitPanelProps): ReactNode;
	GraphPanel(props: GraphPanelProps): ReactNode;
	TerminalPanel(props: TerminalPanelProps): ReactNode;
	LspStatus(props: LspStatusProps): ReactNode;
}

export interface AppProps {
	client: DesktopClient;
	components?: Partial<AppComponents>;
}

export function App({ client, components }: AppProps): ReactNode {
	const EditorWorkspaceSurface = components?.EditorWorkspace ?? EditorWorkspace;
	const GitSurface = components?.GitPanel ?? GitPanel;
	const GraphSurface = components?.GraphPanel ?? GraphPanel;
	const TerminalSurface = components?.TerminalPanel ?? TerminalPanel;
	const LspSurface = components?.LspStatus ?? LspStatus;
	const snapshot = useDesktop(client, desktopSelectors.session);
	const sessions = useDesktop(client, desktopSelectors.sessions);
	const lastError = useDesktop(client, desktopSelectors.lastError);
	const activeSessionPath = useDesktop(client, desktopSelectors.activeSessionPath);
	const sessionTabs = useDesktop(client, desktopSelectors.sessionTabs) ?? [];
	const [layout, setLayout] = useState<LayoutState>(loadLayout);
	const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
	const [requestError, setRequestError] = useState<string | null>(null);
	const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceDescriptor>();
	const [draftsBySession, setDraftsBySession] = useState<Record<string, string>>({});
	const [graphKind, setGraphKind] = useState<GraphKind>("code");
	const workspaceOpenCwdRef = useRef<string | null>(null);
	const workspaceSessionPathRef = useRef<string | null>(null);
	const editorWorkspaceRef = useRef<EditorWorkspaceHandle>(null);

	useEffect(() => {
		localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
	}, [layout]);

	const setActivity = useCallback((activity: Activity): void => {
		setLayout(current => ({
			...current,
			activity,
			primaryOpen: true,
			bottomOpen: activity === "terminal" ? true : current.bottomOpen,
		}));
	}, []);

	useEffect(() => {
		const bindings: ShellShortcutBindings = {
			togglePrimary: () => setLayout(current => ({ ...current, primaryOpen: !current.primaryOpen })),
			toggleSecondary: () => setLayout(current => ({ ...current, secondaryOpen: !current.secondaryOpen })),
			focusEditor: () => document.getElementById("editor-host")?.focus({ preventScroll: true }),
			setActivity,
		};
		const onKeyDown = (event: KeyboardEvent): void => {
			handleShellShortcut(event, bindings);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [setActivity]);

	const startResize = useCallback(
		(kind: "primary" | "secondary" | "bottom", event: ReactPointerEvent): void => {
			if (event.button !== 0) return;
			const startX = event.clientX;
			const startY = event.clientY;
			const start = layout;
			const target = event.currentTarget as HTMLElement;
			target.setPointerCapture(event.pointerId);
			const onMove = (moveEvent: PointerEvent): void => {
				setLayout(current => {
					switch (kind) {
						case "primary":
							return {
								...current,
								primaryWidth: clamp(start.primaryWidth + moveEvent.clientX - startX, 200, 520),
							};
						case "secondary":
							return {
								...current,
								secondaryWidth: clamp(start.secondaryWidth + startX - moveEvent.clientX, 280, 640),
							};
						case "bottom":
							return {
								...current,
								bottomHeight: clamp(start.bottomHeight + startY - moveEvent.clientY, 120, 520),
							};
					}
				});
			};
			const onUp = (): void => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
			};
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp, { once: true });
		},
		[layout],
	);

	const resetLayout = useCallback((): void => {
		localStorage.removeItem(LAYOUT_STORAGE_KEY);
		setLayout({ ...DEFAULT_LAYOUT });
	}, []);

	const selectedAgent = useMemo(
		() => snapshot.agents.find(agent => agent.id === selectedAgentId) ?? null,
		[snapshot.agents, selectedAgentId],
	);
	const subagentCount = snapshot.agents.reduce((count, agent) => count + (agent.kind === "sub" ? 1 : 0), 0);
	const activeHost = layout.activity === "source-control" ? "git" : layout.activity === "graph" ? "graph" : "editor";
	const primaryVisible = layout.primaryOpen && layout.activity === "sessions";
	const selectedSession: DesktopSessionInfo | undefined =
		sessions.find(session => session.path === activeSessionPath) ??
		sessions.find(session => session.id === snapshot.header?.id);
	const sessionCwd = snapshot.header?.cwd ?? snapshot.state?.cwd ?? selectedSession?.cwd;

	useEffect(() => {
		if (snapshot.phase !== "live" || !sessionCwd) return;
		const sessionKey = activeSessionPath ?? snapshot.header?.id ?? sessionCwd;
		const sessionChanged = workspaceSessionPathRef.current !== sessionKey;
		if (!sessionChanged && activeWorkspace) return;
		workspaceSessionPathRef.current = sessionKey;
		if (activeWorkspace?.rootPath === sessionCwd) return;
		workspaceOpenCwdRef.current = sessionCwd;
		void client
			.request("workspace.open", { rootPath: sessionCwd })
			.then(({ workspace }) => {
				if (workspaceOpenCwdRef.current !== sessionCwd) return;
				setActiveWorkspace(workspace);
				setRequestError(null);
			})
			.catch(cause => {
				if (workspaceOpenCwdRef.current !== sessionCwd) return;
				workspaceOpenCwdRef.current = null;
				setRequestError(cause instanceof Error ? cause.message : String(cause));
			});
	}, [activeSessionPath, activeWorkspace, client, sessionCwd, snapshot.header?.id, snapshot.phase]);

	const selectWorkspace = useCallback((workspace: WorkspaceDescriptor): void => {
		workspaceOpenCwdRef.current = workspace.rootPath;
		setActiveWorkspace(workspace);
		setRequestError(null);
	}, []);

	const openEditorLocation = useCallback(
		(uri: string, line?: number, column?: number): void => {
			setActivity("explorer");
			void editorWorkspaceRef.current?.openLocation(uri, line, column);
		},
		[setActivity],
	);

	const openGitGraph = useCallback((): void => {
		setGraphKind("git");
		setActivity("graph");
	}, [setActivity]);

	const createNewSession = useCallback((): void => {
		const cwd = activeWorkspace?.rootPath ?? sessionCwd;
		if (!cwd) {
			setRequestError("Open a workspace before creating a session.");
			return;
		}
		const create = (): void => {
			setRequestError(null);
			void client
				.request("session.new", { cwd })
				.then(result => client.activateSession(result.session.path))
				.catch(cause => setRequestError(cause instanceof Error ? cause.message : String(cause)));
		};
		if (client.getSnapshot().phase === "live") {
			create();
			return;
		}
		client.connect();
		let unsubscribe = (): void => {};
		unsubscribe = client.subscribe(() => {
			const phase = client.getSnapshot().phase;
			if (phase === "live") {
				unsubscribe();
				create();
			} else if (phase === "ended") {
				unsubscribe();
				setRequestError(client.getSnapshot().endedReason ?? "Unable to create a session while disconnected.");
			}
		});
	}, [activeWorkspace?.rootPath, client, sessionCwd]);

	const rootStyle = {
		"--primary-sidebar-width": `${layout.primaryWidth}px`,
		"--secondary-sidebar-width": `${layout.secondaryWidth}px`,
		"--bottom-panel-height": `${layout.bottomHeight}px`,
	} as CSSProperties;

	return (
		<div
			className={`ide-shell${primaryVisible ? " has-primary" : ""}${layout.secondaryOpen ? " has-secondary" : ""}`}
			style={rootStyle}
		>
			<div className="ide-topbar">
				<ProjectSwitcher
					client={client}
					workspace={activeWorkspace}
					fallbackPath={sessionCwd}
					onWorkspaceOpen={selectWorkspace}
					onError={setRequestError}
				/>
				<HeaderBar
					snapshot={snapshot}
					subCount={subagentCount}
					railOpen={layout.secondaryOpen}
					onToggleRail={() => setLayout(current => ({ ...current, secondaryOpen: !current.secondaryOpen }))}
					onLeave={() => client.close()}
				/>
			</div>
			<Banners
				phase={snapshot.phase}
				endedReason={snapshot.endedReason}
				onRejoin={() => client.connect()}
				onNewLink={createNewSession}
			/>
			<div className="ide-workbench">
				<nav className="activitybar" aria-label="IDE activities">
					<div className="activitybar-main">
						{ACTIVITIES.map(item => {
							const Icon = item.icon;
							return (
								<button
									key={item.id}
									type="button"
									className={layout.activity === item.id ? "activity-button is-active" : "activity-button"}
									onClick={() => setActivity(item.id)}
									aria-label={item.label}
									aria-pressed={layout.activity === item.id}
									title={`${item.label} (${item.shortcut})`}
								>
									<Icon size={21} strokeWidth={1.7} aria-hidden />
								</button>
							);
						})}
					</div>
					<div className="activitybar-bottom">
						<button
							type="button"
							className="activity-button"
							onClick={() => setLayout(current => ({ ...current, primaryOpen: !current.primaryOpen }))}
							aria-label="Toggle primary sidebar"
							title="Toggle primary sidebar (Ctrl+B)"
						>
							<PanelLeftClose size={20} strokeWidth={1.7} aria-hidden />
						</button>
					</div>
				</nav>

				<aside
					className="primary-sidebar"
					aria-label={`${activityTitle(layout.activity)} sidebar`}
					aria-hidden={!primaryVisible}
					hidden={!primaryVisible}
				>
					{layout.activity === "sessions" ? (
						<UtilityRail
							client={client}
							snapshot={snapshot}
							sessions={sessions}
							route={layout.utilityRoute}
							onRouteChange={utilityRoute => setLayout(current => ({ ...current, utilityRoute }))}
							onResetLayout={resetLayout}
						/>
					) : null}
				</aside>
				<div
					className="resize-handle resize-handle-vertical primary-resize"
					role="separator"
					aria-label="Resize primary sidebar"
					aria-orientation="vertical"
					hidden={!primaryVisible}
					onPointerDown={event => startResize("primary", event)}
				/>

				<main className="editor-group" aria-label="Editor group">
					<SessionTabs
						client={client}
						tabs={sessionTabs}
						sessions={sessions}
						newSessionCwd={activeWorkspace?.rootPath ?? sessionCwd}
						onClose={path => {
							setDraftsBySession(current => {
								if (!(path in current)) return current;
								const next = { ...current };
								delete next[path];
								return next;
							});
						}}
						onError={setRequestError}
					/>
					<div
						id="agent-session-panel"
						className="editor-deck"
						role="tabpanel"
						aria-labelledby={activeSessionPath ? sessionTabId(activeSessionPath) : undefined}
					>
						<section
							id="editor-host"
							className="component-host editor-host"
							aria-label="Editor workspace"
							tabIndex={-1}
							hidden={activeHost !== "editor"}
						>
							<EditorWorkspaceSurface
								ref={editorWorkspaceRef}
								client={client}
								workspace={activeWorkspace}
								onWorkspaceChange={selectWorkspace}
							/>
						</section>
						<section
							id="git-host"
							className="component-host git-host"
							aria-label="Source control"
							tabIndex={-1}
							hidden={activeHost !== "git"}
						>
							{activeWorkspace ? (
								<GitSurface client={client} workspaceId={activeWorkspace.id} onOpenGraph={openGitGraph} />
							) : (
								<div className="surface-state">
									<strong>Open a project for Source Control</strong>
									<button type="button" onClick={() => setActivity("explorer")}>
										Open project
									</button>
								</div>
							)}
						</section>
						<section
							id="graph-host"
							className="component-host graph-host"
							aria-label="Relationship graph"
							tabIndex={-1}
							hidden={activeHost !== "graph"}
						>
							{activeWorkspace ? (
								<>
									<nav className="graph-kind-tabs" aria-label="Graph kind">
										{(["code", "git", "agent"] as const).map(kind => (
											<button
												key={kind}
												type="button"
												aria-pressed={graphKind === kind}
												onClick={() => setGraphKind(kind)}
											>
												{kind === "code" ? "Code" : kind === "git" ? "Git" : "Agent"}
											</button>
										))}
									</nav>
									<GraphSurface
										client={client}
										workspaceId={activeWorkspace.id}
										kind={graphKind}
										onOpenSource={({ uri, line, column }) => openEditorLocation(uri, line, column)}
									/>
								</>
							) : (
								<div className="surface-state">
									<strong>Open a project to view relationships</strong>
									<button type="button" onClick={() => setActivity("explorer")}>
										Open project
									</button>
								</div>
							)}
						</section>
					</div>
					<div
						className="resize-handle resize-handle-horizontal bottom-resize"
						role="separator"
						aria-label="Resize bottom panel"
						aria-orientation="horizontal"
						hidden={!layout.bottomOpen}
						onPointerDown={event => startResize("bottom", event)}
					/>
					<section className="bottom-panel" aria-label="Terminal panel" hidden={!layout.bottomOpen}>
						<header className="bottom-panel-header">
							<span>
								<TerminalSquare size={14} aria-hidden /> Terminal and Problems
							</span>
							<button
								type="button"
								onClick={() => setLayout(current => ({ ...current, bottomOpen: false }))}
								aria-label="Close terminal panel"
							>
								<PanelBottomClose size={15} aria-hidden />
							</button>
						</header>
						{layout.bottomOpen ? (
							activeWorkspace ? (
								<div id="terminal-host" className="terminal-host" tabIndex={-1} aria-label="Local terminal">
									<TerminalSurface client={client} workspaceId={activeWorkspace.id} />
									<LspSurface
										client={client}
										workspaceId={activeWorkspace.id}
										onOpenDiagnostic={openEditorLocation}
									/>
								</div>
							) : (
								<div className="surface-state">
									<strong>Open a project to start a terminal</strong>
									<button type="button" onClick={() => setActivity("explorer")}>
										Open project
									</button>
								</div>
							)
						) : null}
					</section>
					<section className="composer-dock" aria-label="Agent prompt composer">
						<Composer
							client={client}
							snapshot={snapshot}
							draft={activeSessionPath ? (draftsBySession[activeSessionPath] ?? "") : ""}
							onDraftChange={value => {
								if (!activeSessionPath) return;
								setDraftsBySession(current => ({ ...current, [activeSessionPath]: value }));
								client.setSessionDraft(activeSessionPath, value.trim().length > 0);
							}}
						/>
					</section>
				</main>

				<div
					className="resize-handle resize-handle-vertical secondary-resize"
					role="separator"
					aria-label="Resize secondary sidebar"
					aria-orientation="vertical"
					onPointerDown={event => startResize("secondary", event)}
				/>
				<aside className="secondary-sidebar" aria-label="Copilot and agents" aria-hidden={!layout.secondaryOpen}>
					<section
						className={snapshot.working ? "secondary-transcript motion-stream-live-edge" : "secondary-transcript"}
						aria-labelledby="transcript-title"
					>
						<header className="panel-heading">
							<h2 id="transcript-title">Transcript</h2>
							<span className={`connection-state connection-${snapshot.phase}`}>{snapshot.phase}</span>
						</header>
						<div className="secondary-scroll">
							<Transcript
								entries={snapshot.entries}
								stream={snapshot.stream}
								streamDone={snapshot.streamDone}
								activeTools={snapshot.activeTools}
								working={snapshot.working}
							/>
						</div>
					</section>
					<section className="secondary-agents" aria-labelledby="agents-title">
						<header className="panel-heading">
							<h2 id="agents-title">Agents</h2>
							<span>{snapshot.agents.length}</span>
						</header>
						<div className="secondary-scroll">
							<AgentsPanel
								agents={snapshot.agents}
								progress={snapshot.progress}
								lifecycle={snapshot.lifecycle}
								selectedId={selectedAgentId}
								onSelect={setSelectedAgentId}
							/>
						</div>
					</section>
					{selectedAgent !== null ? (
						<AgentDrawer
							agent={selectedAgent}
							progress={snapshot.progress.get(selectedAgent.id)}
							client={client}
							readOnly={snapshot.readOnly}
							onClose={() => setSelectedAgentId(null)}
						/>
					) : null}
				</aside>
			</div>

			<footer className="statusbar" aria-label="IDE status">
				<span className={`status-connection status-${snapshot.phase}`}>{snapshot.phase}</span>
				<span className="status-path" title={activeWorkspace?.rootPath ?? sessionCwd}>
					{activeWorkspace?.rootPath ?? sessionCwd ?? "No workspace"}
				</span>
				<span className="status-spacer" />
				{requestError || lastError ? (
					<span className="status-error" role="alert">
						{requestError ?? lastError?.message}
					</span>
				) : null}
				<button
					type="button"
					onClick={() => setLayout(current => ({ ...current, bottomOpen: !current.bottomOpen }))}
					aria-label="Toggle terminal panel"
					title="Toggle terminal panel"
				>
					{layout.bottomOpen ? (
						<PanelBottomClose size={13} aria-hidden />
					) : (
						<PanelBottomOpen size={13} aria-hidden />
					)}{" "}
					Terminal
				</button>
				<button
					type="button"
					onClick={() => setLayout(current => ({ ...current, secondaryOpen: !current.secondaryOpen }))}
					aria-label="Toggle copilot sidebar"
					title="Toggle copilot sidebar (Ctrl+Alt+B)"
				>
					<PanelRightClose size={13} aria-hidden /> Copilot
				</button>
			</footer>
			<Toasts notices={snapshot.notices} />
		</div>
	);
}
