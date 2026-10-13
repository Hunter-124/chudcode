import { AgentDrawer } from "@oh-my-pi/collab-web/agent-drawer";
import { AgentsPanel } from "@oh-my-pi/collab-web/agents-panel";
import { Banners } from "@oh-my-pi/collab-web/banners";
import { Composer } from "@oh-my-pi/collab-web/composer";
import type { SessionClient } from "@oh-my-pi/collab-web/session-client";
import { Toasts } from "@oh-my-pi/collab-web/toasts";
import { Transcript } from "@oh-my-pi/collab-web/transcript";
import type { ImageContent } from "@oh-my-pi/pi-wire";
import {
	Bot,
	Check,
	ChevronDown,
	Copy,
	FolderOpen,
	GitBranch,
	ImagePlus,
	ListTodo,
	MessageSquare,
	Pencil,
	Pin,
	Plus,
	Settings,
	Trash2,
	X,
} from "lucide-react";
import type { ChangeEvent, MouseEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	DESKTOP_PROTOCOL_VERSION,
	type DesktopSessionInfo,
	type WorkspaceDescriptor,
} from "../../../chudcode-desktop/src/protocol";
import type { DesktopClient } from "../../../chudcode-desktop/src/web/desktop-client";
import type { GraphKind } from "../../../chudcode-desktop/src/web/graph/force-graph";
import { GraphPanel } from "../../../chudcode-desktop/src/web/graph/GraphPanel";
import { SessionTabs, sessionTabId } from "../../../chudcode-desktop/src/web/SessionTabs";
import { UtilityRail } from "../../../chudcode-desktop/src/web/UtilityRail";
import { desktopSelectors, useDesktop } from "../../../chudcode-desktop/src/web/use-desktop";
import type { WorkbenchBridge, WorkbenchView } from "./bridge";

interface Attachment {
	id: string;
	name: string;
	content: ImageContent;
}

type PanelView = WorkbenchView | "settings";
const VIEW_LABELS: Record<PanelView, string> = {
	chat: "Chat",
	sessions: "Sessions",
	tasks: "Tasks",
	graphs: "Graphs",
	settings: "Settings",
};
const VIEW_ICONS = { chat: MessageSquare, sessions: Copy, tasks: ListTodo, graphs: GitBranch, settings: Settings };
const MAX_IMAGE_BYTES = 600 * 1024;

function readImage(file: File): Promise<Attachment> {
	const { promise, resolve, reject } = Promise.withResolvers<Attachment>();
	if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) {
		reject(new Error("Choose a PNG, JPEG, WebP or GIF image."));
		return promise;
	}
	if (file.size > MAX_IMAGE_BYTES) {
		reject(new Error("Images must be smaller than 600 KiB to fit the desktop protocol. Resize the image first."));
		return promise;
	}
	const reader = new FileReader();
	reader.onerror = () => reject(new Error(`Unable to read ${file.name}`));
	reader.onload = () => {
		if (typeof reader.result !== "string" || !reader.result.includes(",")) {
			reject(new Error(`Unable to decode ${file.name}`));
			return;
		}
		resolve({
			id: crypto.randomUUID(),
			name: file.name,
			content: {
				type: "image",
				mimeType: file.type,
				data: reader.result.slice(reader.result.indexOf(",") + 1),
			},
		});
	};
	reader.readAsDataURL(file);
	return promise;
}

/** VS Code's webviews cannot use synchronous browser prompt/confirm dialogs. */
function SessionsView({
	client,
	sessions,
	activePath,
	cwd,
	live,
	onError,
	onOpenChat,
	onDelete,
}: {
	client: DesktopClient;
	sessions: readonly DesktopSessionInfo[];
	activePath: string | null;
	cwd?: string;
	live: boolean;
	onError(message: string): void;
	onOpenChat(): void;
	onDelete(path: string): void;
}): ReactNode {
	const [busy, setBusy] = useState(false);
	const [renamePath, setRenamePath] = useState<string>();
	const [title, setTitle] = useState("");
	const [deletePath, setDeletePath] = useState<string>();
	const [query, setQuery] = useState("");
	const selected = sessions.find(session => session.path === activePath);
	const filtered = sessions.filter(session =>
		`${session.title ?? ""} ${session.cwd} ${session.id}`.toLowerCase().includes(query.toLowerCase()),
	);

	const run = async (action: () => Promise<void>): Promise<void> => {
		if (!live || busy) return;
		setBusy(true);
		try {
			await action();
		} catch (cause) {
			onError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className="wb-sessions" aria-labelledby="sessions-title">
			<header className="panel-heading">
				<h2 id="sessions-title">
					Sessions <small>{sessions.length}</small>
				</h2>
				<div className="wb-actions">
					<button
						type="button"
						title="Fork active session"
						aria-label="Fork active session"
						disabled={!live || busy || !selected}
						onClick={() =>
							void run(async () => {
								if (!selected) return;
								const result = await client.request("session.fork", { path: selected.path });
								if (!result.cancelled) {
									await client.activateSession(result.session.path);
									onOpenChat();
								}
							})
						}
					>
						<Copy size={14} />
					</button>
					<button
						type="button"
						title="New session"
						aria-label="New session"
						disabled={!live || busy || !cwd}
						onClick={() =>
							void run(async () => {
								if (!cwd) return;
								const result = await client.request("session.new", { cwd });
								await client.activateSession(result.session.path);
								onOpenChat();
							})
						}
					>
						<Plus size={15} />
					</button>
				</div>
			</header>
			<label className="wb-filter">
				<span className="sr-only">Filter sessions</span>
				<input
					type="search"
					placeholder="Find a session…"
					value={query}
					onChange={event => setQuery(event.target.value)}
				/>
			</label>
			{filtered.length === 0 ? (
				<div className="surface-state" role="status">
					{query ? "No matching sessions" : "Create a session to start working."}
				</div>
			) : null}
			<ul className="session-list">
				{filtered.map(session => (
					<li key={session.path} className={`session-row${session.path === activePath ? " is-active" : ""}`}>
						<button
							type="button"
							className="session-select"
							disabled={!live || busy}
							aria-current={session.path === activePath ? "true" : undefined}
							onClick={() =>
								void run(async () => {
									await client.activateSession(session.path);
									onOpenChat();
								})
							}
							title={session.cwd}
						>
							<span className={`session-status session-status-${session.status ?? "completed"}`} aria-hidden />
							<span className="session-copy">
								<strong>{session.title?.trim() || session.id}</strong>
								<small>{session.cwd}</small>
							</span>
						</button>
						<div className="session-row-actions">
							<button
								type="button"
								aria-label={`${session.pinned ? "Unpin" : "Pin"} session`}
								aria-pressed={!!session.pinned}
								disabled={!live || busy}
								onClick={() =>
									void run(async () => {
										await client.request("session.pin", { path: session.path, pinned: !session.pinned });
									})
								}
							>
								<Pin size={12} />
							</button>
							<button
								type="button"
								aria-label="Rename session"
								disabled={!live || busy}
								onClick={() => {
									setRenamePath(session.path);
									setTitle(session.title ?? "");
									setDeletePath(undefined);
								}}
							>
								<Pencil size={12} />
							</button>
							<button
								type="button"
								aria-label="Delete session"
								disabled={!live || busy}
								onClick={() => {
									setDeletePath(session.path);
									setRenamePath(undefined);
								}}
							>
								<Trash2 size={12} />
							</button>
						</div>
						{renamePath === session.path ? (
							<form
								className="wb-session-dialog"
								aria-label="Rename session"
								onSubmit={event => {
									event.preventDefault();
									void run(async () => {
										await client.request("session.rename", { path: session.path, title: title.trim() });
										setRenamePath(undefined);
									});
								}}
							>
								<label>
									Session name
									<input autoFocus value={title} onChange={event => setTitle(event.target.value)} />
								</label>
								<div className="wb-actions">
									<button type="submit" disabled={!title.trim() || busy || !live}>
										<Check size={12} /> Save
									</button>
									<button type="button" onClick={() => setRenamePath(undefined)}>
										Cancel
									</button>
								</div>
							</form>
						) : null}
						{deletePath === session.path ? (
							<div className="wb-session-dialog" role="alertdialog" aria-label="Delete session confirmation">
								<p>Delete “{session.title?.trim() || session.id}”? Its transcript cannot be restored.</p>
								<div className="wb-actions">
									<button
										type="button"
										className="wb-danger"
										disabled={!live || busy}
										onClick={() =>
											void run(async () => {
												const result = await client.request("session.delete", { path: session.path });
												if (result.deleted) {
													onDelete(session.path);
													setDeletePath(undefined);
												}
											})
										}
									>
										Delete
									</button>
									<button type="button" onClick={() => setDeletePath(undefined)}>
										Cancel
									</button>
								</div>
							</div>
						) : null}
					</li>
				))}
			</ul>
		</section>
	);
}

export function WorkbenchPanel({ client, bridge }: { client: DesktopClient; bridge: WorkbenchBridge }): ReactNode {
	const snapshot = useDesktop(client, desktopSelectors.session);
	const sessions = useDesktop(client, desktopSelectors.sessions);
	const tabs = useDesktop(client, desktopSelectors.sessionTabs);
	const activePath = useDesktop(client, desktopSelectors.activeSessionPath);
	const graphs = useDesktop(client, desktopSelectors.graphs);
	const lastError = useDesktop(client, desktopSelectors.lastError);
	const [initialState] = useState(() => bridge.getState());
	const [view, setView] = useState<PanelView>(initialState.view ?? "chat");
	const [drafts, setDrafts] = useState<Record<string, string>>(initialState.drafts ?? {});
	const [attachments, setAttachments] = useState<Record<string, Attachment[]>>({});
	const [agentsOpen, setAgentsOpen] = useState(initialState.agentsOpen ?? true);
	const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
	const [graphKind, setGraphKind] = useState<GraphKind>("code");
	const [workspace, setWorkspace] = useState<WorkspaceDescriptor>();
	const [workspaceRootPath, setWorkspaceRootPath] = useState<string>();
	const [workspaceConnectionId, setWorkspaceConnectionId] = useState<string | null>(null);
	const [connectionId, setConnectionId] = useState<string | null>(null);
	const [readyConnectionId, setReadyConnectionId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [readingImages, setReadingImages] = useState(false);
	const activePathRef = useRef(activePath);
	activePathRef.current = activePath;
	const attachmentsRef = useRef(attachments);
	attachmentsRef.current = attachments;
	const readingImagesRef = useRef(false);
	const fileInput = useRef<HTMLInputElement>(null);
	// The extension supplies the actual window workspace; a selected session
	// is neither required to discover it nor allowed to replace it.
	const cwd = workspace?.rootPath ?? workspaceRootPath;
	const live = connectionId !== null && readyConnectionId === connectionId;
	const phase = live ? "live" : snapshot.phase === "live" ? "waiting" : snapshot.phase;
	const currentImages = activePath ? (attachments[activePath] ?? []) : [];
	const selectedAgent = snapshot.agents.find(agent => agent.id === selectedAgentId);
	const graphWorkspace = workspaceConnectionId === connectionId ? workspace : undefined;
	const currentGraph = graphWorkspace ? graphs.get(`${graphWorkspace.id}:${graphKind}`) : undefined;

	useEffect(
		() =>
			bridge.subscribe(message => {
				if (message.type === "view") setView(message.view);
				else if (message.type === "error") {
					setError(message.message);
					if (message.connectionId)
						setConnectionId(current => (current === message.connectionId ? null : current));
				} else if (message.type === "open") {
					setConnectionId(message.connectionId);
					setWorkspaceRootPath(message.rootPath);
					setWorkspace(current => (current?.rootPath === message.rootPath ? current : undefined));
					setError(null);
				} else if (message.type === "close") {
					setConnectionId(current => (current === message.connectionId ? null : current));
				}
			}),
		[bridge],
	);

	useEffect(() => {
		bridge.setState({ view, drafts, agentsOpen });
	}, [bridge, view, drafts, agentsOpen]);

	useEffect(() => {
		if (!connectionId) return;
		let disposed = false;
		// Readiness belongs to this authenticated transport, not the selected
		// session's snapshot (which may be empty or still loading).
		void client
			.request("runtime.hello", { protocol: DESKTOP_PROTOCOL_VERSION })
			.then(result => {
				if (disposed) return;
				if (result.protocol !== DESKTOP_PROTOCOL_VERSION) throw new Error("Incompatible desktop protocol");
				setReadyConnectionId(connectionId);
			})
			.catch(cause => {
				if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
			});
		return () => {
			disposed = true;
		};
	}, [client, connectionId]);

	useEffect(() => {
		if (!live) return;
		let disposed = false;
		void client.request("session.list", cwd ? { cwd } : {}).catch(cause => {
			if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
		});
		if (cwd)
			void client
				.request("workspace.open", { rootPath: cwd })
				.then(result => {
					if (!disposed) {
						setWorkspace(result.workspace);
						setWorkspaceConnectionId(connectionId);
					}
				})
				.catch(cause => {
					if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
				});
		return () => {
			disposed = true;
		};
	}, [client, live, cwd, connectionId]);

	useEffect(() => {
		if (view !== "graphs" || !live || !graphWorkspace) return;
		let disposed = false;
		void client.request("graph.snapshot", { workspaceId: graphWorkspace.id, kind: graphKind }).catch(cause => {
			if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
		});
		return () => {
			disposed = true;
		};
	}, [client, view, live, graphWorkspace, graphKind]);

	useEffect(() => {
		if (activePath && live)
			client.setSessionDraft(activePath, !!drafts[activePath]?.trim() || (attachments[activePath]?.length ?? 0) > 0);
	}, [client, activePath, live, drafts, attachments]);

	useEffect(() => {
		setSelectedAgentId(null);
	}, [activePath]);

	const removeDraft = useCallback((path: string): void => {
		setDrafts(current => {
			const next = { ...current };
			delete next[path];
			return next;
		});
		setAttachments(current => {
			const next = { ...current };
			delete next[path];
			return next;
		});
	}, []);

	const composerClient = useMemo<SessionClient>(
		() => ({
			subscribe: client.subscribe,
			getSnapshot: client.getSnapshot,
			sendPrompt: (text, images) => {
				const path = activePathRef.current;
				if (!path) {
					setError("Create or select a session before sending a prompt.");
					return;
				}
				const pending = attachmentsRef.current[path] ?? [];
				const content = [...pending.map(image => image.content), ...(images ?? [])];
				const frame = {
					t: "request",
					id: Number.MAX_SAFE_INTEGER,
					method: "prompt.send",
					params: { sessionPath: path, text, images: content },
				};
				if (new TextEncoder().encode(JSON.stringify(frame)).byteLength > 1024 * 1024) {
					setError("Prompt and images exceed the 1 MiB desktop limit. Remove an image or shorten the prompt.");
					// Composer clears after sending; restore the draft on the next microtask.
					queueMicrotask(() => setDrafts(current => ({ ...current, [path]: text })));
					return;
				}
				void client
					.request("prompt.send", { sessionPath: path, text, ...(content.length ? { images: content } : {}) })
					.then(() => {
						const sent = new Set(pending.map(image => image.id));
						setAttachments(current => ({
							...current,
							[path]: (current[path] ?? []).filter(image => !sent.has(image.id)),
						}));
					})
					.catch(cause => {
						setError(cause instanceof Error ? cause.message : String(cause));
						setDrafts(current => ({ ...current, [path]: current[path] ? `${text}\n${current[path]}` : text }));
					});
			},
			sendAbort: () => client.sendAbort(),
			sendUiResponse: (reqId, value) => client.sendUiResponse(reqId, value),
			sendAgentCmd: (cmd, agentId, text) => client.sendAgentCmd(cmd, agentId, text),
			fetchTranscript: (agentId, fromByte) => client.fetchTranscript(agentId, fromByte),
		}),
		[client],
	);

	const addImages = async (files: readonly File[]): Promise<void> => {
		const path = activePathRef.current;
		if (!path || readingImagesRef.current || !live || snapshot.readOnly || snapshot.uiRequest) return;
		readingImagesRef.current = true;
		setReadingImages(true);
		try {
			const images = await Promise.all(files.map(readImage));
			const next = [...(attachmentsRef.current[path] ?? []), ...images];
			if (next.reduce((total, image) => total + image.content.data.length, 0) > (MAX_IMAGE_BYTES * 4) / 3) {
				throw new Error("Combined images exceed 600 KiB. Remove an attachment or resize images first.");
			}
			// A tab closed while FileReader was active must not resurrect its draft.
			if (!client.getDesktopSnapshot().sessionTabs.some(tab => tab.path === path)) return;
			setAttachments(current => ({ ...current, [path]: next }));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			readingImagesRef.current = false;
			setReadingImages(false);
		}
	};

	const chooseImages = (event: ChangeEvent<HTMLInputElement>): void => {
		const files = Array.from(event.target.files ?? []);
		event.target.value = "";
		void addImages(files);
	};

	const openSourceLink = (event: MouseEvent<HTMLDivElement>): void => {
		const target = event.target;
		if (!(target instanceof Element)) return;
		const anchor = target.closest("a[href]");
		const href = anchor?.getAttribute("href");
		if (!href || href.startsWith("#") || /^(?:https?:|mailto:)/i.test(href)) return;
		// Only local source paths; the extension independently contains/symlink-checks.
		if (/^[a-z][a-z\d+.-]*:/i.test(href) && !/^file:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) return;
		event.preventDefault();
		const location = /^(.*?)(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?)$/.exec(href);
		bridge.openFile(
			location?.[1] ?? href,
			location ? Number(location[2] ?? location[4]) : undefined,
			location && (location[3] ?? location[5]) ? Number(location[3] ?? location[5]) : undefined,
		);
	};

	const usage = snapshot.state?.contextUsage;
	const contextPercent =
		usage?.percent ??
		(usage?.tokens != null && usage.contextWindow ? (usage.tokens / usage.contextWindow) * 100 : null);

	return (
		<div className="wb-panel" onClickCapture={openSourceLink}>
			<header className="wb-header">
				<div className="wb-brand">
					<Bot size={16} aria-hidden />
					<strong>Chudcode</strong>
					<span className={`wb-phase wb-phase-${phase}`} role="status">
						{live && snapshot.working ? "Working" : phase}
					</span>
				</div>
				<button
					type="button"
					className="wb-icon-button"
					onClick={() => bridge.openFolder()}
					aria-label="Open workspace folder"
					title={cwd ?? "Open Folder"}
				>
					<FolderOpen size={15} />
				</button>
			</header>
			<nav className="wb-view-tabs" aria-label="Chudcode views">
				{(Object.keys(VIEW_LABELS) as PanelView[]).map(item => {
					const Icon = VIEW_ICONS[item];
					return (
						<button
							type="button"
							key={item}
							title={VIEW_LABELS[item]}
							aria-label={VIEW_LABELS[item]}
							aria-current={view === item ? "page" : undefined}
							onClick={() => setView(item)}
						>
							<Icon size={14} aria-hidden />
							<span>{VIEW_LABELS[item]}</span>
						</button>
					);
				})}
			</nav>
			{phase === "connecting" || phase === "waiting" ? (
				<div className="wb-connection" role="status">
					Connecting to the local workspace service…
				</div>
			) : null}
			<Banners
				phase={phase === "connecting" || phase === "waiting" ? "live" : phase}
				endedReason={snapshot.endedReason}
				onRejoin={() => client.connect()}
				onNewLink={() => bridge.openFolder()}
			/>
			{error || lastError ? (
				<div className="wb-error" role="alert">
					<span>{error ?? lastError?.message}</span>
					{error ? (
						<button type="button" onClick={() => setError(null)} aria-label="Dismiss error">
							<X size={13} />
						</button>
					) : null}
				</div>
			) : null}
			{!cwd ? (
				<section className="wb-no-workspace surface-state" aria-label="Workspace required">
					<FolderOpen size={25} aria-hidden />
					<strong>Open a trusted folder to begin</strong>
					<p>
						Chudcode runs locally for this workspace. The workbench owns your files, terminal and source control.
					</p>
					<button type="button" className="wb-primary" onClick={() => bridge.openFolder()}>
						Open Folder
					</button>
					<small>If a service failed, use “Chudcode: Restart Service” in the Command Palette.</small>
				</section>
			) : null}
			{cwd ? (
				<fieldset disabled={!live} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
					<SessionTabs
						client={client}
						tabs={tabs}
						sessions={sessions}
						newSessionCwd={live ? cwd : undefined}
						onActivate={() => setView("chat")}
						onClose={removeDraft}
						onError={setError}
					/>
				</fieldset>
			) : null}
			<main
				className="wb-content"
				id="agent-session-panel"
				role="tabpanel"
				aria-labelledby={activePath ? sessionTabId(activePath) : undefined}
			>
				{view === "chat" ? (
					<div className="wb-chat">
						<div className="wb-session-meta" aria-label="Session model and usage">
							<span title={snapshot.state?.model?.name}>{snapshot.state?.model?.name ?? "Agent"}</span>
							{snapshot.state?.thinkingLevel ? <span>{snapshot.state.thinkingLevel}</span> : null}
							{contextPercent != null ? (
								<span title="Context window usage">{Math.round(contextPercent)}% context</span>
							) : null}
						</div>
						<div className="wb-transcript">
							<Transcript
								entries={snapshot.entries}
								stream={snapshot.stream}
								streamDone={snapshot.streamDone}
								activeTools={snapshot.activeTools}
								working={snapshot.working}
								phase={snapshot.phase}
								host={{
									hasAgent: id => snapshot.agents.some(agent => agent.id === id),
									openAgent: setSelectedAgentId,
								}}
							/>
						</div>
						<section className="wb-agents" aria-labelledby="agents-title">
							<button
								type="button"
								className="wb-agents-toggle"
								onClick={() => setAgentsOpen(current => !current)}
								aria-expanded={agentsOpen}
								aria-controls="wb-agents-list"
							>
								<ChevronDown size={13} className={agentsOpen ? "" : "is-collapsed"} aria-hidden />
								<h2 id="agents-title">Agents</h2>
								<span>{snapshot.agents.length}</span>
							</button>
							{agentsOpen ? (
								<div id="wb-agents-list">
									<AgentsPanel
										agents={snapshot.agents}
										progress={snapshot.progress}
										lifecycle={snapshot.lifecycle}
										selectedId={selectedAgentId}
										onSelect={setSelectedAgentId}
									/>
								</div>
							) : null}
						</section>
						<section
							className="wb-composer-dock"
							aria-label="Agent prompt composer"
							onPaste={event => {
								const files = Array.from(event.clipboardData.files).filter(file =>
									file.type.startsWith("image/"),
								);
								if (files.length && !snapshot.uiRequest) {
									event.preventDefault();
									void addImages(files);
								}
							}}
							onDragOver={event => {
								if (event.dataTransfer.types.includes("Files")) event.preventDefault();
							}}
							onDrop={event => {
								if (!event.dataTransfer.files.length || snapshot.uiRequest) return;
								event.preventDefault();
								void addImages(Array.from(event.dataTransfer.files));
							}}
						>
							{currentImages.length ? (
								<ul className="wb-attachments" aria-label="Attached images">
									{currentImages.map(image => (
										<li key={image.id}>
											<img
												src={`data:${image.content.mimeType};base64,${image.content.data}`}
												alt={image.name}
											/>
											<span title={image.name}>{image.name}</span>
											<button
												type="button"
												aria-label={`Remove ${image.name}`}
												onClick={() => {
													if (activePath)
														setAttachments(current => ({
															...current,
															[activePath]: (current[activePath] ?? []).filter(
																item => item.id !== image.id,
															),
														}));
												}}
											>
												<X size={12} />
											</button>
										</li>
									))}
								</ul>
							) : null}
							<Composer
								key={activePath ?? "no-session"}
								client={composerClient}
								snapshot={activePath ? snapshot : { ...snapshot, readOnly: true }}
								draft={activePath ? (drafts[activePath] ?? "") : ""}
								onDraftChange={value => {
									if (activePath) setDrafts(current => ({ ...current, [activePath]: value }));
								}}
							/>
							{!snapshot.uiRequest ? (
								<div className="wb-composer-footer">
									<input
										ref={fileInput}
										className="sr-only"
										type="file"
										accept="image/png,image/jpeg,image/webp,image/gif"
										multiple
										onChange={chooseImages}
										tabIndex={-1}
										aria-label="Choose image attachments"
									/>
									<button
										type="button"
										onClick={() => fileInput.current?.click()}
										disabled={!activePath || !live || snapshot.readOnly || readingImages}
										title="Attach images (600 KiB combined)"
										aria-label="Attach images"
									>
										<ImagePlus size={14} />
										{readingImages ? "Reading…" : "Image"}
									</button>
									{currentImages.length > 0 && activePath && !drafts[activePath]?.trim() ? (
										<button
											type="button"
											disabled={!live || snapshot.readOnly || readingImages}
											onClick={() => composerClient.sendPrompt("")}
										>
											Send images
										</button>
									) : null}
									<small>Enter to send · Shift+Enter for newline</small>
								</div>
							) : null}
						</section>
					</div>
				) : null}
				{view === "sessions" ? (
					<SessionsView
						client={client}
						sessions={sessions}
						activePath={activePath}
						cwd={cwd}
						live={live}
						onError={setError}
						onOpenChat={() => setView("chat")}
						onDelete={removeDraft}
					/>
				) : null}
				{view === "tasks" ? (
					<div className="wb-tasks">
						<UtilityRail
							client={client}
							snapshot={snapshot}
							sessions={sessions}
							route="tasks"
							onRouteChange={route =>
								setView(route === "sessions" ? "sessions" : route === "tasks" ? "tasks" : "settings")
							}
							onResetLayout={() => setAgentsOpen(true)}
						/>
					</div>
				) : null}
				{view === "graphs" ? (
					<section className="wb-graphs" aria-label="Workspace relationship graphs">
						<nav className="graph-kind-tabs" aria-label="Graph kind">
							{(["code", "git", "agent"] as const).map(kind => (
								<button
									type="button"
									key={kind}
									aria-pressed={graphKind === kind}
									onClick={() => setGraphKind(kind)}
								>
									{kind === "code" ? "Code" : kind === "git" ? "Git" : "Agents"}
								</button>
							))}
						</nav>
						{graphWorkspace && live && currentGraph ? (
							<GraphPanel
								client={client}
								workspaceId={graphWorkspace.id}
								kind={graphKind}
								onOpenSource={({ uri, line, column }) => bridge.openFile(uri, line, column)}
							/>
						) : (
							<div className="surface-state" role="status">
								{cwd
									? live
										? "Loading workspace graph…"
										: "Connect to the workspace service to load graphs."
									: "Open a trusted folder to explore its relationships."}
							</div>
						)}
					</section>
				) : null}
				{view === "settings" ? (
					<section className="wb-settings" aria-labelledby="settings-title">
						<h2 id="settings-title">Settings</h2>
						<label>
							<input
								type="checkbox"
								checked={agentsOpen}
								onChange={event => setAgentsOpen(event.target.checked)}
							/>{" "}
							Show agents below the transcript
						</label>
						<h3>Appearance and editor</h3>
						<p>
							This panel follows the active workbench color theme and font. Use workbench Settings for your
							editor, terminal, source control and keyboard shortcuts.
						</p>
						<h3>Local service</h3>
						<p>
							The extension owns the authenticated connection. No service credential is stored in this view. If
							the service fails, run “Chudcode: Restart Service” in the Command Palette.
						</p>
						<h3>Session drafts</h3>
						<p>
							Text drafts are restored with this view and kept separately for each session. Image attachments
							stay in memory while the view is open. Closing a dirty tab asks before discarding.
						</p>
						<button
							type="button"
							onClick={() => {
								setAgentsOpen(true);
								setView("chat");
							}}
						>
							Reset panel layout
						</button>
					</section>
				) : null}
			</main>
			{selectedAgent ? (
				<AgentDrawer
					key={selectedAgent.id}
					agent={selectedAgent}
					progress={snapshot.progress.get(selectedAgent.id)}
					client={client}
					readOnly={!live || snapshot.readOnly}
					host={{ hasAgent: id => snapshot.agents.some(agent => agent.id === id), openAgent: setSelectedAgentId }}
					onClose={() => setSelectedAgentId(null)}
				/>
			) : null}
			<footer className="wb-statusbar">
				<span title={cwd}>{cwd?.split(/[\\/]/).filter(Boolean).at(-1) ?? "No workspace"}</span>
				<span>
					{!live
						? "Service disconnected"
						: snapshot.readOnly
							? "Read only"
							: snapshot.working
								? "Agent running"
								: activePath
									? "Ready"
									: "Select a session"}
				</span>
			</footer>
			<Toasts notices={snapshot.notices} />
		</div>
	);
}
