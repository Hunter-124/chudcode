import type { ActiveTool, Notice, SessionSnapshot } from "@oh-my-pi/collab-web/session-client";
import type {
	AgentEvent,
	AssistantMessage,
	CollabUiRequest,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "@oh-my-pi/pi-wire";
import type {
	DesktopEvent,
	DesktopMethod,
	DesktopRequestMap,
	DesktopSessionInfo,
	DesktopSessionTab,
	DocumentSnapshot,
	DocumentUri,
	FileChange,
	GitSnapshot,
	GraphSnapshot,
	LspDiagnostic,
	TerminalId,
	WorkspaceDescriptor,
	WorkspaceEntry,
	WorkspaceId,
} from "../protocol";

const MAX_NOTICES = 50;
const MAX_WORKSPACE_CHANGES = 1_000;

export const MAX_TERMINAL_OUTPUT_BYTES = 1024 * 1024;
export const MAX_TERMINAL_OUTPUT_CHUNKS = 1024;

export interface TerminalOutputChunk {
	readonly sequence: number;
	readonly data: Uint8Array;
}

export class TerminalDataDecodeError extends Error {
	readonly code = "INVALID_TERMINAL_DATA_BASE64";

	constructor(
		readonly terminalId: TerminalId,
		message: string,
	) {
		super(`Invalid terminal data for ${terminalId}: ${message}`);
		this.name = "TerminalDataDecodeError";
	}
}

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodeTerminalDataBase64(terminalId: TerminalId, dataBase64: string): Uint8Array {
	if (typeof dataBase64 !== "string" || !BASE64_PATTERN.test(dataBase64)) {
		throw new TerminalDataDecodeError(terminalId, "payload is not valid base64");
	}
	let binary: string;
	try {
		binary = atob(dataBase64);
	} catch (error) {
		throw new TerminalDataDecodeError(
			terminalId,
			error instanceof Error ? error.message : "payload could not be decoded",
		);
	}
	const data = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) data[index] = binary.charCodeAt(index);
	return data;
}

function appendTerminalOutput(
	current: TerminalSnapshot | undefined,
	data: Uint8Array,
): Pick<TerminalSnapshot, "chunks" | "byteLength" | "nextSequence"> {
	const sequence = current?.nextSequence ?? 0;
	let chunks: readonly TerminalOutputChunk[] = [...(current?.chunks ?? []), { sequence, data }];
	let byteLength = (current?.byteLength ?? 0) + data.byteLength;
	let firstRetained = 0;
	while (
		firstRetained < chunks.length &&
		(chunks.length - firstRetained > MAX_TERMINAL_OUTPUT_CHUNKS ||
			byteLength - chunks[firstRetained]!.data.byteLength >= MAX_TERMINAL_OUTPUT_BYTES)
	) {
		byteLength -= chunks[firstRetained]!.data.byteLength;
		firstRetained += 1;
	}
	if (firstRetained > 0) chunks = chunks.slice(firstRetained);
	if (byteLength > MAX_TERMINAL_OUTPUT_BYTES) {
		const excess = byteLength - MAX_TERMINAL_OUTPUT_BYTES;
		const first = chunks[0]!;
		chunks = [{ sequence: first.sequence, data: first.data.slice(excess) }, ...chunks.slice(1)];
		byteLength = MAX_TERMINAL_OUTPUT_BYTES;
	}
	return { chunks, byteLength, nextSequence: sequence + 1 };
}

const EMPTY_TERMINAL_OUTPUT = {
	chunks: [] as readonly TerminalOutputChunk[],
	byteLength: 0,
	nextSequence: 0,
};

export interface TerminalSnapshot {
	id: TerminalId;
	readonly chunks: readonly TerminalOutputChunk[];
	readonly byteLength: number;
	readonly nextSequence: number;
	closed: boolean;
	exitCode?: number | null;
	signal?: string;
}

export interface DesktopStoreSnapshot {
	revision: number;
	/** Active-session projection consumed by the shared collab surfaces. */
	session: SessionSnapshot;
	activeSessionPath: string | null;
	sessionTabs: readonly DesktopSessionTab[];
	sessionSnapshots: ReadonlyMap<string, SessionSnapshot>;
	sessions: readonly DesktopSessionInfo[];
	workspaces: ReadonlyMap<WorkspaceId, WorkspaceDescriptor>;
	workspaceEntries: ReadonlyMap<WorkspaceId, readonly WorkspaceEntry[]>;
	workspaceChanges: ReadonlyMap<WorkspaceId, readonly FileChange[]>;
	documents: ReadonlyMap<DocumentUri, DocumentSnapshot>;
	git: ReadonlyMap<WorkspaceId, GitSnapshot>;
	terminals: ReadonlyMap<TerminalId, TerminalSnapshot>;
	diagnostics: ReadonlyMap<WorkspaceId, readonly LspDiagnostic[]>;
	graphs: ReadonlyMap<string, GraphSnapshot>;
	lastError: { code: string; message: string } | null;
}

function initialSession(): SessionSnapshot {
	return {
		phase: "connecting",
		endedReason: null,
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

function graphKey(workspaceId: WorkspaceId, kind: "code" | "git" | "agent"): string {
	return `${workspaceId}:${kind}`;
}

/** Immutable external store for both collab presentation state and IDE state. */
export class DesktopStore {
	readonly #listeners = new Set<() => void>();
	readonly #uiRequestQueues = new Map<string, CollabUiRequest[]>();
	readonly #localDraftDirty = new Map<string, boolean>();
	#noticeSequence = 0;
	#connectionPhase: SessionSnapshot["phase"] = "connecting";
	#connectionEndedReason: string | null = null;
	#snapshot: DesktopStoreSnapshot = {
		revision: 0,
		session: initialSession(),
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
	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	getSnapshot = (): DesktopStoreSnapshot => this.#snapshot;

	setConnectionPhase(phase: SessionSnapshot["phase"], endedReason: string | null = null): void {
		if (this.#connectionPhase === phase && this.#connectionEndedReason === endedReason) return;
		this.#connectionPhase = phase;
		this.#connectionEndedReason = endedReason;
		const sessionSnapshots = new Map<string, SessionSnapshot>();
		for (const [path, session] of this.#snapshot.sessionSnapshots) {
			sessionSnapshots.set(path, { ...session, phase, endedReason });
		}
		const session = this.#activeSessionSnapshot(this.#snapshot.activeSessionPath, sessionSnapshots);
		this.#snapshot = { ...this.#snapshot, session, sessionSnapshots };
		this.#commit();
	}

	pushNotice(level: Notice["level"], message: string, sessionPath = this.#snapshot.activeSessionPath): void {
		if (sessionPath) this.#appendNotice(sessionPath, level, message);
		else {
			const notice: Notice = { id: ++this.#noticeSequence, level, message, at: Date.now() };
			const notices = [...this.#snapshot.session.notices, notice];
			if (notices.length > MAX_NOTICES) notices.splice(0, notices.length - MAX_NOTICES);
			this.#snapshot = { ...this.#snapshot, session: { ...this.#snapshot.session, notices } };
		}
		this.#commit();
	}

	acknowledgeUiRequest(sessionPath: string, reqId: number): void {
		const session = this.#snapshot.sessionSnapshots.get(sessionPath);
		if (session?.uiRequest?.reqId !== reqId) return;
		this.#showNextUiRequest(sessionPath);
		this.#commit();
	}

	setSessionDraftDirty(sessionPath: string, dirty: boolean): void {
		this.#localDraftDirty.set(sessionPath, dirty);
		const index = this.#snapshot.sessionTabs.findIndex(tab => tab.path === sessionPath);
		if (index < 0 || this.#snapshot.sessionTabs[index]?.draftDirty === dirty) return;
		const sessionTabs = this.#snapshot.sessionTabs.map(tab =>
			tab.path === sessionPath ? { ...tab, draftDirty: dirty } : tab,
		);
		this.#snapshot = { ...this.#snapshot, sessionTabs };
		this.#commit();
	}

	applyEvent(frame: DesktopEvent): void {
		switch (frame.t) {
			case "welcome": {
				const currentSession = this.#sessionFor(frame.sessionPath);
				this.#uiRequestQueues.delete(frame.sessionPath);
				if (this.#snapshot.activeSessionPath === null) {
					this.#snapshot = { ...this.#snapshot, activeSessionPath: frame.sessionPath };
				}
				this.#snapshot = { ...this.#snapshot, lastError: null };
				this.#replaceSessionAt(frame.sessionPath, {
					...initialSession(),
					phase: frame.entryCount === 0 ? "live" : "waiting",
					header: frame.header,
					state: frame.state,
					agents: [...frame.agents],
					working: frame.state.isStreaming,
					notices: currentSession.notices,
				});
				break;
			}
			case "snapshot-chunk": {
				const session = this.#sessionFor(frame.sessionPath);
				this.#replaceSessionAt(frame.sessionPath, {
					...session,
					entries: [...session.entries, ...frame.entries],
					phase: frame.final ? "live" : session.phase,
				});
				break;
			}
			case "entry": {
				const session = this.#sessionFor(frame.sessionPath);
				const clearStream =
					session.streamDone && frame.entry.type === "message" && frame.entry.message.role === "assistant";
				this.#replaceSessionAt(frame.sessionPath, {
					...session,
					entries: [...session.entries, frame.entry],
					stream: clearStream ? null : session.stream,
					streamDone: clearStream ? false : session.streamDone,
				});
				break;
			}
			case "agent-event":
				this.#applyAgentEvent(frame.sessionPath, frame.event);
				break;
			case "state": {
				const session = this.#sessionFor(frame.sessionPath);
				const idle = !frame.state.isStreaming;
				this.#replaceSessionAt(frame.sessionPath, {
					...session,
					state: frame.state,
					working: frame.state.isStreaming,
					activeTools: idle ? new Map() : session.activeTools,
					stream: idle && session.streamDone ? null : session.stream,
					streamDone: idle && session.streamDone ? false : session.streamDone,
				});
				break;
			}
			case "bus": {
				const session = this.#sessionFor(frame.sessionPath);
				if (frame.channel === "task:subagent:progress") {
					const payload = frame.data as SubagentProgressPayload;
					this.#replaceSessionAt(frame.sessionPath, {
						...session,
						progress: new Map(session.progress).set(payload.progress.id, payload),
					});
				} else if (frame.channel === "task:subagent:lifecycle") {
					const payload = frame.data as SubagentLifecyclePayload;
					this.#replaceSessionAt(frame.sessionPath, {
						...session,
						lifecycle: new Map(session.lifecycle).set(payload.id, payload),
					});
				}
				break;
			}
			case "agents":
				this.#replaceSessionAt(frame.sessionPath, {
					...this.#sessionFor(frame.sessionPath),
					agents: [...frame.agents],
				});
				break;
			case "ui-request": {
				const session = this.#sessionFor(frame.sessionPath);
				if (session.uiRequest) {
					const queue = this.#uiRequestQueues.get(frame.sessionPath) ?? [];
					this.#uiRequestQueues.set(frame.sessionPath, [...queue, frame.request]);
				} else {
					this.#replaceSessionAt(frame.sessionPath, { ...session, uiRequest: frame.request });
				}
				break;
			}
			case "ui-request-end": {
				const session = this.#sessionFor(frame.sessionPath);
				if (session.uiRequest?.reqId === frame.reqId) this.#showNextUiRequest(frame.sessionPath);
				else {
					const queue = this.#uiRequestQueues.get(frame.sessionPath) ?? [];
					this.#uiRequestQueues.set(
						frame.sessionPath,
						queue.filter(request => request.reqId !== frame.reqId),
					);
				}
				break;
			}
			case "sessions":
				this.#snapshot = { ...this.#snapshot, sessions: [...frame.sessions] };
				break;
			case "session-tabs":
				this.#applySessionTabs(frame.tabs);
				break;
			case "workspace-change":
				this.#applyWorkspaceChanges(frame.workspaceId, frame.changes);
				break;
			case "document":
				this.#snapshot = {
					...this.#snapshot,
					documents: new Map(this.#snapshot.documents).set(frame.document.uri, frame.document),
				};
				break;
			case "git":
				this.#snapshot = {
					...this.#snapshot,
					git: new Map(this.#snapshot.git).set(frame.workspaceId, frame.snapshot),
				};
				break;
			case "terminal-data": {
				const data = decodeTerminalDataBase64(frame.terminalId, frame.dataBase64);
				if (data.byteLength === 0) break;
				const current = this.#snapshot.terminals.get(frame.terminalId);
				const terminal: TerminalSnapshot = {
					id: frame.terminalId,
					...appendTerminalOutput(current, data),
					closed: current?.closed ?? false,
					exitCode: current?.exitCode,
					signal: current?.signal,
				};
				this.#snapshot = {
					...this.#snapshot,
					terminals: new Map(this.#snapshot.terminals).set(frame.terminalId, terminal),
				};
				break;
			}
			case "terminal-exit": {
				const current = this.#snapshot.terminals.get(frame.terminalId);
				this.#snapshot = {
					...this.#snapshot,
					terminals: new Map(this.#snapshot.terminals).set(frame.terminalId, {
						id: frame.terminalId,
						...(current ?? EMPTY_TERMINAL_OUTPUT),
						closed: true,
						exitCode: frame.exitCode,
						signal: frame.signal,
					}),
				};
				break;
			}
			case "diagnostics":
				this.#snapshot = {
					...this.#snapshot,
					diagnostics: new Map(this.#snapshot.diagnostics).set(frame.workspaceId, [...frame.diagnostics]),
				};
				break;
			case "graph":
				this.#snapshot = {
					...this.#snapshot,
					graphs: new Map(this.#snapshot.graphs).set(graphKey(frame.workspaceId, frame.kind), frame.graph),
				};
				break;
			case "error":
				this.#snapshot = { ...this.#snapshot, lastError: { code: frame.code, message: frame.message } };
				if (frame.sessionPath) this.#appendNotice(frame.sessionPath, "error", frame.message);
				else if (this.#snapshot.activeSessionPath) {
					this.#appendNotice(this.#snapshot.activeSessionPath, "error", frame.message);
				}
				break;
		}
		this.#commit();
	}

	applyResponse<M extends DesktopMethod>(
		method: M,
		params: DesktopRequestMap[M]["params"],
		result: DesktopRequestMap[M]["result"],
	): void {
		switch (method) {
			case "session.list":
				this.#snapshot = {
					...this.#snapshot,
					sessions: [...(result as DesktopRequestMap["session.list"]["result"]).sessions],
				};
				break;
			case "session.select": {
				const path = (params as DesktopRequestMap["session.select"]["params"]).path;
				const selected = result as DesktopRequestMap["session.select"]["result"];
				this.#snapshot = { ...this.#snapshot, activeSessionPath: path };
				this.#replaceSessionAt(path, {
					...this.#sessionFor(path),
					phase: "live",
					header: selected.header,
					entries: [...selected.entries],
					stream: null,
					streamDone: false,
					activeTools: new Map(),
				});
				break;
			}
			case "session.new":
			case "session.rename":
			case "session.pin":
				this.#upsertSession(
					(result as DesktopRequestMap["session.new" | "session.rename" | "session.pin"]["result"]).session,
				);
				break;
			case "session.fork": {
				const forked = result as DesktopRequestMap["session.fork"]["result"];
				if (!forked.cancelled) this.#upsertSession(forked.session);
				break;
			}
			case "session.tabs":
			case "session.activate":
			case "session.tab.close":
				this.#applySessionTabs(
					(result as DesktopRequestMap["session.tabs" | "session.activate" | "session.tab.close"]["result"]).tabs,
				);
				break;
			case "session.tab.draft": {
				const draftParams = params as DesktopRequestMap["session.tab.draft"]["params"];
				const draftTabs = (result as DesktopRequestMap["session.tab.draft"]["result"]).tabs;
				if (draftTabs.find(tab => tab.path === draftParams.path)?.draftDirty === draftParams.dirty) {
					this.#localDraftDirty.delete(draftParams.path);
				}
				this.#applySessionTabs(draftTabs);
				break;
			}
			case "session.delete": {
				if ((result as DesktopRequestMap["session.delete"]["result"]).deleted) {
					const path = (params as DesktopRequestMap["session.delete"]["params"]).path;
					const sessionSnapshots = new Map(this.#snapshot.sessionSnapshots);
					sessionSnapshots.delete(path);
					this.#uiRequestQueues.delete(path);
					this.#snapshot = {
						...this.#snapshot,
						sessionSnapshots,
						sessions: this.#snapshot.sessions.filter(item => item.path !== path),
					};
					if (this.#snapshot.sessionTabs.some(tab => tab.path === path)) {
						this.#applySessionTabs(this.#snapshot.sessionTabs.filter(tab => tab.path !== path));
					}
				}
				break;
			}
			case "workspace.open": {
				const workspace = (result as DesktopRequestMap["workspace.open"]["result"]).workspace;
				this.#snapshot = {
					...this.#snapshot,
					workspaces: new Map(this.#snapshot.workspaces).set(workspace.id, workspace),
				};
				break;
			}
			case "workspace.list": {
				const listParams = params as DesktopRequestMap["workspace.list"]["params"];
				const listed = (result as DesktopRequestMap["workspace.list"]["result"]).entries;
				let entries: readonly WorkspaceEntry[] = [...listed];
				if (listParams.uri) {
					const entriesByUri = new Map(
						(this.#snapshot.workspaceEntries.get(listParams.workspaceId) ?? []).map(entry => [entry.uri, entry]),
					);
					for (const entry of listed) entriesByUri.set(entry.uri, entry);
					entries = [...entriesByUri.values()];
				}
				this.#snapshot = {
					...this.#snapshot,
					workspaceEntries: new Map(this.#snapshot.workspaceEntries).set(listParams.workspaceId, entries),
				};
				break;
			}
			case "workspace.read": {
				const document = (result as DesktopRequestMap["workspace.read"]["result"]).document;
				this.#snapshot = {
					...this.#snapshot,
					documents: new Map(this.#snapshot.documents).set(document.uri, document),
				};
				break;
			}
			case "workspace.write": {
				const writeParams = params as DesktopRequestMap["workspace.write"]["params"];
				const current = this.#snapshot.documents.get(writeParams.uri);
				if (current) {
					const stamp = (result as DesktopRequestMap["workspace.write"]["result"]).stamp;
					this.#snapshot = {
						...this.#snapshot,
						documents: new Map(this.#snapshot.documents).set(writeParams.uri, {
							...current,
							text: writeParams.text,
							stamp,
							dirty: false,
							conflict: false,
						}),
					};
				}
				break;
			}
			case "workspace.stat":
			case "workspace.create":
			case "workspace.rename":
			case "workspace.copy": {
				const entry = (
					result as DesktopRequestMap[
						| "workspace.stat"
						| "workspace.create"
						| "workspace.rename"
						| "workspace.copy"]["result"]
				).entry;
				const workspaceId = (
					params as DesktopRequestMap[
						| "workspace.stat"
						| "workspace.create"
						| "workspace.rename"
						| "workspace.copy"]["params"]
				).workspaceId;
				this.#mergeWorkspaceEntry(workspaceId, entry);
				break;
			}
			case "workspace.remove": {
				if ((result as DesktopRequestMap["workspace.remove"]["result"]).removed) {
					const removeParams = params as DesktopRequestMap["workspace.remove"]["params"];
					const entries = this.#snapshot.workspaceEntries.get(removeParams.workspaceId) ?? [];
					const documents = new Map(this.#snapshot.documents);
					documents.delete(removeParams.uri);
					this.#snapshot = {
						...this.#snapshot,
						workspaceEntries: new Map(this.#snapshot.workspaceEntries).set(
							removeParams.workspaceId,
							entries.filter(entry => entry.uri !== removeParams.uri),
						),
						documents,
					};
				}
				break;
			}
			case "git.init":
			case "git.fetch":
			case "git.pull":
			case "git.push":
			case "git.branch.create":
			case "git.hunk":
			case "git.snapshot":
			case "git.stage":
			case "git.unstage":
			case "git.checkout": {
				const workspaceId = (
					params as DesktopRequestMap[
						| "git.init"
						| "git.fetch"
						| "git.pull"
						| "git.push"
						| "git.branch.create"
						| "git.hunk"
						| "git.snapshot"
						| "git.stage"
						| "git.unstage"
						| "git.checkout"]["params"]
				).workspaceId;
				const snapshot = (
					result as DesktopRequestMap[
						| "git.init"
						| "git.fetch"
						| "git.pull"
						| "git.push"
						| "git.branch.create"
						| "git.hunk"
						| "git.snapshot"
						| "git.stage"
						| "git.unstage"
						| "git.checkout"]["result"]
				).snapshot;
				this.#snapshot = { ...this.#snapshot, git: new Map(this.#snapshot.git).set(workspaceId, snapshot) };
				break;
			}
			case "git.commit": {
				const workspaceId = (params as DesktopRequestMap["git.commit"]["params"]).workspaceId;
				const snapshot = (result as DesktopRequestMap["git.commit"]["result"]).snapshot;
				this.#snapshot = { ...this.#snapshot, git: new Map(this.#snapshot.git).set(workspaceId, snapshot) };
				break;
			}
			case "terminal.create": {
				const terminalId = (result as DesktopRequestMap["terminal.create"]["result"]).terminalId;
				this.#snapshot = {
					...this.#snapshot,
					terminals: new Map(this.#snapshot.terminals).set(terminalId, {
						id: terminalId,
						...EMPTY_TERMINAL_OUTPUT,
						closed: false,
					}),
				};
				break;
			}
			case "terminal.close": {
				const terminalId = (params as DesktopRequestMap["terminal.close"]["params"]).terminalId;
				const current = this.#snapshot.terminals.get(terminalId);
				if (current) {
					this.#snapshot = {
						...this.#snapshot,
						terminals: new Map(this.#snapshot.terminals).set(terminalId, { ...current, closed: true }),
					};
				}
				break;
			}
			case "graph.snapshot": {
				const graphParams = params as DesktopRequestMap["graph.snapshot"]["params"];
				const graph = (result as DesktopRequestMap["graph.snapshot"]["result"]).graph;
				this.#snapshot = {
					...this.#snapshot,
					graphs: new Map(this.#snapshot.graphs).set(graphKey(graphParams.workspaceId, graphParams.kind), graph),
				};
				break;
			}
			default:
				return;
		}
		this.#commit();
	}

	#applyAgentEvent(sessionPath: string, event: AgentEvent): void {
		const session = this.#sessionFor(sessionPath);
		switch (event.type) {
			case "message_start":
			case "message_update":
				if (event.message.role === "assistant") {
					this.#replaceSessionAt(sessionPath, {
						...session,
						stream: event.message as AssistantMessage,
						streamDone: false,
					});
				}
				break;
			case "message_end":
				if (event.message.role === "assistant") {
					this.#replaceSessionAt(sessionPath, {
						...session,
						stream: event.message as AssistantMessage,
						streamDone: true,
					});
				}
				break;
			case "tool_execution_start": {
				const tool: ActiveTool = {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					intent: event.intent,
					startedAt: Date.now(),
				};
				this.#replaceSessionAt(sessionPath, {
					...session,
					activeTools: new Map(session.activeTools).set(event.toolCallId, tool),
				});
				break;
			}
			case "tool_execution_update": {
				const existing = session.activeTools.get(event.toolCallId);
				const tool: ActiveTool = existing
					? { ...existing, partialResult: event.partialResult }
					: {
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							args: event.args,
							partialResult: event.partialResult,
							startedAt: Date.now(),
						};
				this.#replaceSessionAt(sessionPath, {
					...session,
					activeTools: new Map(session.activeTools).set(event.toolCallId, tool),
				});
				break;
			}
			case "tool_execution_end": {
				const activeTools = new Map(session.activeTools);
				activeTools.delete(event.toolCallId);
				this.#replaceSessionAt(sessionPath, { ...session, activeTools });
				break;
			}
			case "agent_start":
				this.#replaceSessionAt(sessionPath, { ...session, working: true });
				break;
			case "agent_end":
				this.#replaceSessionAt(sessionPath, { ...session, working: false });
				break;
			case "notice":
				this.#appendNotice(sessionPath, event.level, event.message);
				break;
			case "auto_retry_start":
				this.#appendNotice(
					sessionPath,
					"info",
					`retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`,
				);
				break;
			case "auto_retry_end":
				if (!event.success) this.#appendNotice(sessionPath, "error", event.finalError ?? "retry failed");
				break;
			case "auto_compaction_start":
				this.#appendNotice(sessionPath, "info", `compacting context (${event.reason})`);
				break;
			case "auto_compaction_end":
				if (!event.skipped) {
					this.#appendNotice(
						sessionPath,
						"info",
						event.aborted
							? "compaction aborted"
							: event.errorMessage
								? `compaction failed: ${event.errorMessage}`
								: "context compacted",
					);
				}
				break;
			default:
				break;
		}
	}

	#applyWorkspaceChanges(workspaceId: WorkspaceId, changes: readonly FileChange[]): void {
		const previous = this.#snapshot.workspaceChanges.get(workspaceId) ?? [];
		const combined = [...previous, ...changes];
		const retained = combined.length > MAX_WORKSPACE_CHANGES ? combined.slice(-MAX_WORKSPACE_CHANGES) : combined;
		const documents = new Map(this.#snapshot.documents);
		for (const change of changes) {
			if (change.kind === "deleted") documents.delete(change.uri);
			if (change.kind === "renamed" && change.oldUri) {
				const oldDocument = documents.get(change.oldUri);
				documents.delete(change.oldUri);
				if (oldDocument)
					documents.set(change.uri, { ...oldDocument, uri: change.uri, stamp: change.stamp ?? oldDocument.stamp });
			}
		}
		this.#snapshot = {
			...this.#snapshot,
			workspaceChanges: new Map(this.#snapshot.workspaceChanges).set(workspaceId, retained),
			documents,
		};
	}

	#mergeWorkspaceEntry(workspaceId: WorkspaceId, entry: WorkspaceEntry): void {
		const entries = this.#snapshot.workspaceEntries.get(workspaceId) ?? [];
		const index = entries.findIndex(item => item.uri === entry.uri);
		const next = index < 0 ? [...entries, entry] : entries.map(item => (item.uri === entry.uri ? entry : item));
		this.#snapshot = {
			...this.#snapshot,
			workspaceEntries: new Map(this.#snapshot.workspaceEntries).set(workspaceId, next),
		};
	}

	#upsertSession(session: DesktopSessionInfo): void {
		const exists = this.#snapshot.sessions.some(item => item.path === session.path);
		this.#snapshot = {
			...this.#snapshot,
			sessions: exists
				? this.#snapshot.sessions.map(item => (item.path === session.path ? session : item))
				: [...this.#snapshot.sessions, session],
		};
	}

	#applySessionTabs(tabs: readonly DesktopSessionTab[]): void {
		const sessionTabs = tabs.map(tab => ({
			...tab,
			draftDirty: this.#localDraftDirty.get(tab.path) ?? tab.draftDirty,
		}));
		const openPaths = new Set(sessionTabs.map(tab => tab.path));
		const sessionSnapshots = new Map<string, SessionSnapshot>();
		for (const tab of sessionTabs) {
			sessionSnapshots.set(tab.path, this.#snapshot.sessionSnapshots.get(tab.path) ?? this.#newSession());
		}
		for (const path of this.#uiRequestQueues.keys()) {
			if (!openPaths.has(path)) this.#uiRequestQueues.delete(path);
		}
		for (const path of this.#localDraftDirty.keys()) {
			if (!openPaths.has(path)) this.#localDraftDirty.delete(path);
		}
		const activeSessionPath = sessionTabs.find(tab => tab.active)?.path ?? null;
		const session = this.#activeSessionSnapshot(activeSessionPath, sessionSnapshots);
		this.#snapshot = {
			...this.#snapshot,
			session,
			activeSessionPath,
			sessionTabs,
			sessionSnapshots,
		};
	}

	#showNextUiRequest(sessionPath: string): void {
		const [next, ...rest] = this.#uiRequestQueues.get(sessionPath) ?? [];
		if (rest.length > 0) this.#uiRequestQueues.set(sessionPath, rest);
		else this.#uiRequestQueues.delete(sessionPath);
		this.#replaceSessionAt(sessionPath, { ...this.#sessionFor(sessionPath), uiRequest: next ?? null });
	}

	#appendNotice(sessionPath: string, level: Notice["level"], message: string): void {
		const notice: Notice = { id: ++this.#noticeSequence, level, message, at: Date.now() };
		const session = this.#sessionFor(sessionPath);
		const notices = [...session.notices, notice];
		if (notices.length > MAX_NOTICES) notices.splice(0, notices.length - MAX_NOTICES);
		this.#replaceSessionAt(sessionPath, { ...session, notices });
	}

	#activeSessionSnapshot(
		activeSessionPath: string | null,
		sessionSnapshots: ReadonlyMap<string, SessionSnapshot>,
	): SessionSnapshot {
		const activeSession = activeSessionPath === null ? undefined : sessionSnapshots.get(activeSessionPath);
		return activeSession ?? this.#newSession();
	}

	#newSession(): SessionSnapshot {
		return {
			...initialSession(),
			phase: this.#connectionPhase,
			endedReason: this.#connectionEndedReason,
		};
	}

	#sessionFor(sessionPath: string): SessionSnapshot {
		return this.#snapshot.sessionSnapshots.get(sessionPath) ?? this.#newSession();
	}

	#replaceSessionAt(sessionPath: string, session: SessionSnapshot): void {
		const sessionSnapshots = new Map(this.#snapshot.sessionSnapshots).set(sessionPath, session);
		this.#snapshot = {
			...this.#snapshot,
			session: this.#snapshot.activeSessionPath === sessionPath ? session : this.#snapshot.session,
			sessionSnapshots,
		};
	}

	#commit(): void {
		this.#snapshot = { ...this.#snapshot, revision: this.#snapshot.revision + 1 };
		for (const listener of this.#listeners) listener();
	}
}

export const desktopStoreGraphKey = graphKey;
