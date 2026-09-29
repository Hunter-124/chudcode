import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { SessionEntry as StoredSessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type {
	AgentSnapshot,
	BusChannel,
	CollabUiRequest,
	CollabUiRequestDraft,
	CollabUiResponseValue,
	SessionState,
	SessionEntry as WireSessionEntry,
} from "@oh-my-pi/pi-wire";
import {
	DESKTOP_PROTOCOL_VERSION,
	type DesktopEvent,
	type DesktopFrame,
	type DesktopRequest,
	type DesktopResponse,
	type DesktopSessionInfo,
	type DesktopSessionTab,
} from "./protocol";
import {
	type DesktopAgentSession,
	type SessionForkResult,
	SessionService,
	SessionServiceError,
	toWireAgentEvent,
	toWireSessionEntry,
	toWireSessionSnapshot,
} from "./session-service";

const STATE_DEBOUNCE_MS = 100;
const AGENTS_DEBOUNCE_MS = 100;
const STREAMING_STATE_INTERVAL_MS = 2_000;
const SNAPSHOT_CHUNK_BYTES = 512 * 1024;
const MAX_OPEN_SESSIONS = 12;
const STATE_TRIGGER_EVENTS: Record<string, true> = {
	agent_start: true,
	agent_end: true,
	message_end: true,
	tool_execution_end: true,
	thinking_level_changed: true,
	model_changed: true,
	advisor_cost_changed: true,
	auto_compaction_end: true,
};
const BUS_CHANNELS = ["task:subagent:lifecycle", "task:subagent:progress"] as const satisfies readonly BusChannel[];
const TRANSCRIPT_READ_CAP = 4 * 1024 * 1024;
const TRANSCRIPT_ENTRY_TOO_LARGE_ERROR = `transcript entry exceeds transcript fetch cap (${TRANSCRIPT_READ_CAP} bytes)`;

export interface DesktopFrameSink {
	send(frame: DesktopFrame): boolean;
	close(code?: number, reason?: string): void;
}

interface RegistryRef {
	id: string;
	displayName: string;
	kind: "main" | "sub" | "advisor";
	parentId?: string;
	status: "running" | "idle" | "parked" | "aborted";
	sessionFile?: string | null;
	createdAt: number;
	lastActivity: number;
}

export interface DesktopAgentRegistry {
	list(): RegistryRef[];
	onChange(listener: () => void): () => void;
}

export interface DesktopAgentCommandOutcome {
	accepted: boolean;
	message?: string;
	task?: Promise<void>;
}

export interface DesktopAgentControl {
	command(cmd: "chat" | "kill" | "revive", agentId: string, text?: string): DesktopAgentCommandOutcome;
	transcript(agentId: string, fromByte: number): Promise<{ text: string; newSize: number; error?: string }>;
}

class ChudDesktopAgentControl implements DesktopAgentControl {
	command(cmd: "chat" | "kill" | "revive", agentId: string, text?: string): DesktopAgentCommandOutcome {
		const registry = AgentRegistry.global();
		if (registry.get(agentId)?.kind === "advisor") {
			return { accepted: false, message: `agent ${agentId}: advisor transcripts are read-only` };
		}
		switch (cmd) {
			case "chat": {
				const trimmed = text?.trim();
				if (!trimmed) return { accepted: false, message: `agent ${agentId}: empty chat message` };
				const task = AgentLifecycleManager.global()
					.ensureLive(agentId)
					.then(async session => {
						await session.prompt(trimmed, { streamingBehavior: "steer" });
					});
				return { accepted: true, task };
			}
			case "kill": {
				const ref = registry.get(agentId);
				if (!ref) return { accepted: false, message: `agent ${agentId}: not found` };
				const task = (async () => {
					if (ref.status === "running" && ref.session) await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
					await AgentLifecycleManager.global().release(agentId, ref, { tombstone: true });
				})();
				return { accepted: true, task };
			}
			case "revive":
				return {
					accepted: true,
					task: AgentLifecycleManager.global()
						.ensureLive(agentId)
						.then(() => undefined),
				};
		}
	}

	async transcript(agentId: string, fromByte: number): Promise<{ text: string; newSize: number; error?: string }> {
		if (!Number.isSafeInteger(fromByte) || fromByte < 0) {
			return { text: "", newSize: 0, error: "fromByte must be a non-negative safe integer" };
		}
		const file = AgentRegistry.global().get(agentId)?.sessionFile;
		if (!file) return { text: "", newSize: fromByte, error: "no transcript available" };
		try {
			const stat = await fs.stat(file);
			if (stat.size <= fromByte) return { text: "", newSize: stat.size };
			const want = Math.min(stat.size - fromByte, TRANSCRIPT_READ_CAP);
			const handle = await fs.open(file, "r");
			let bytesRead: number;
			const buffer = Buffer.allocUnsafe(want);
			try {
				({ bytesRead } = await handle.read(buffer, 0, want, fromByte));
			} finally {
				await handle.close();
			}
			let slice = buffer.subarray(0, bytesRead);
			const reachedEof = fromByte + bytesRead >= stat.size;
			if (!reachedEof) {
				const lastNewline = slice.lastIndexOf(0x0a);
				if (lastNewline < 0) return { text: "", newSize: fromByte, error: TRANSCRIPT_ENTRY_TOO_LARGE_ERROR };
				slice = slice.subarray(0, lastNewline + 1);
			}
			return {
				text: slice.toString("utf8"),
				newSize: reachedEof ? stat.size : fromByte + slice.byteLength,
			};
		} catch (error) {
			return { text: "", newSize: fromByte, error: error instanceof Error ? error.message : String(error) };
		}
	}
}

interface PendingUiRequest {
	request: CollabUiRequest;
	settle(value: CollabUiResponseValue): void;
}

export interface DesktopSessionResources {
	session: DesktopAgentSession;
	eventBus?: EventBus;
	registry?: DesktopAgentRegistry;
	sessionService?: SessionService;
	agentControl?: DesktopAgentControl;
	closeables?: Array<{ close(): void | Promise<void> } | { dispose(): void | Promise<void> }>;
	initialize?(uiContext: ExtensionUIContext): Promise<void>;
}

export interface DesktopSessionFactoryRequest {
	cwd: string;
	sessionPath?: string;
}

export interface DesktopRuntimeOptions extends DesktopSessionResources {
	sessionFactory?: (request: DesktopSessionFactoryRequest) => Promise<DesktopSessionResources>;
	snapshotChunkBytes?: number;
	maxOpenSessions?: number;
}

export interface CreateDesktopRuntimeOptions {
	cwd: string;
}

interface ManagedSession {
	path: string;
	session: DesktopAgentSession;
	service: SessionService;
	eventBus?: EventBus;
	registry: DesktopAgentRegistry;
	agentControl: DesktopAgentControl;
	closeables: NonNullable<DesktopSessionResources["closeables"]>;
	pendingUi: Map<number, PendingUiRequest>;
	busUnsubscribers: Array<() => void>;
	unsubscribeSession?: () => void;
	unsubscribeRegistry?: () => void;
	previousEntryTap?: (entry: StoredSessionEntry) => void;
	entryTap?: (entry: StoredSessionEntry) => void;
	stateTimer?: Timer;
	agentsTimer?: Timer;
	streamingTimer?: Timer;
	unread: number;
	draftDirty: boolean;
}

/** Direct desktop host for a bounded set of independent SDK AgentSessions. */
export class DesktopRuntime {
	readonly #sessionFactory?: DesktopRuntimeOptions["sessionFactory"];
	readonly #snapshotChunkBytes: number;
	readonly #maxOpenSessions: number;
	readonly #clients = new Set<DesktopFrameSink>();
	readonly #managed = new Map<string, ManagedSession>();
	readonly #reportedWireOmissions = new WeakMap<DesktopFrameSink, Set<string>>();
	readonly #opening = new Map<string, Promise<ManagedSession>>();
	#activePath: string;
	#uiSequence = 0;
	#pendingCreations = 0;
	#disposed = false;

	constructor(options: DesktopRuntimeOptions) {
		this.#sessionFactory = options.sessionFactory;
		this.#snapshotChunkBytes = options.snapshotChunkBytes ?? SNAPSHOT_CHUNK_BYTES;
		this.#maxOpenSessions = options.maxOpenSessions ?? MAX_OPEN_SESSIONS;
		const initial = this.#createManaged(options);
		this.#activePath = initial.path;
		this.#managed.set(initial.path, initial);
		this.#installTaps(initial);
	}

	get session(): DesktopAgentSession {
		return this.#requireActive().session;
	}

	get sessions(): SessionService {
		return this.#requireActive().service;
	}

	attach(client: DesktopFrameSink): void {
		if (this.#disposed) {
			client.close(1012, "runtime stopped");
			return;
		}
		this.#clients.add(client);
		for (const managed of this.#managed.values()) this.#sendSnapshot(client, managed);
		client.send({ t: "session-tabs", tabs: this.#tabs() });
		for (const managed of this.#managed.values()) {
			for (const pending of managed.pendingUi.values()) {
				client.send({ t: "ui-request", sessionPath: managed.path, request: pending.request });
			}
		}
	}

	detach(client: DesktopFrameSink): void {
		this.#clients.delete(client);
		if (this.#clients.size === 0) {
			for (const managed of this.#managed.values()) this.#settleAllUiRequests(managed);
		}
	}

	broadcast(frame: DesktopEvent): void {
		if (this.#disposed) return;
		for (const client of this.#clients) client.send(frame);
	}

	async handleRequest(request: DesktopRequest): Promise<DesktopResponse> {
		try {
			switch (request.method) {
				case "runtime.hello": {
					if (request.params.protocol !== DESKTOP_PROTOCOL_VERSION) {
						return this.#error(
							request,
							"PROTOCOL_MISMATCH",
							`Desktop protocol v${DESKTOP_PROTOCOL_VERSION} required`,
						);
					}
					return {
						t: "response",
						id: request.id,
						method: "runtime.hello",
						result: { protocol: DESKTOP_PROTOCOL_VERSION, product: "Chudcode" },
					};
				}
				case "prompt.send": {
					const managed = this.#requireManaged(request.params.sessionPath);
					const prompt = managed.service.sendPrompt(request.params.text, request.params.images);
					this.#broadcastTabs();
					void prompt.then(
						() => this.#afterPrompt(managed),
						error => {
							this.#emitSession(managed, {
								t: "error",
								sessionPath: managed.path,
								code: "PROMPT_FAILED",
								message: error instanceof Error ? error.message : String(error),
							});
							this.#afterPrompt(managed);
						},
					);
					return { t: "response", id: request.id, method: "prompt.send", result: { accepted: true } };
				}
				case "run.abort": {
					const managed = this.#requireManaged(request.params.sessionPath);
					const accepted = await managed.service.abort();
					this.#broadcastTabs();
					return { t: "response", id: request.id, method: "run.abort", result: { accepted } };
				}
				case "ui.respond": {
					const managed = this.#requireManaged(request.params.sessionPath);
					const accepted = this.#respondUi(managed, request.params.reqId, request.params.value);
					return { t: "response", id: request.id, method: "ui.respond", result: { accepted } };
				}
				case "agent.command": {
					const managed = this.#requireManaged(request.params.sessionPath);
					const { task, ...result } = managed.agentControl.command(
						request.params.cmd,
						request.params.agentId,
						request.params.text,
					);
					void task?.catch(error => {
						this.#emitSession(managed, {
							t: "error",
							sessionPath: managed.path,
							code: "AGENT_COMMAND_FAILED",
							message: `agent ${request.params.agentId}: ${error instanceof Error ? error.message : String(error)}`,
						});
					});
					return { t: "response", id: request.id, method: "agent.command", result };
				}
				case "agent.transcript": {
					const managed = this.#requireManaged(request.params.sessionPath);
					const result = await managed.agentControl.transcript(request.params.agentId, request.params.fromByte);
					return { t: "response", id: request.id, method: "agent.transcript", result };
				}
				case "session.list": {
					const sessions = await this.#catalogService().list(request.params.cwd);
					return { t: "response", id: request.id, method: "session.list", result: { sessions } };
				}
				case "session.select": {
					const managed = await this.#activate(request.params.path);
					const snapshot = toWireSessionSnapshot(managed.session.sessionManager.snapshotForReplication());
					this.#reportWireOmissions(managed, snapshot.omissions);
					await this.#broadcastSessions();
					return {
						t: "response",
						id: request.id,
						method: "session.select",
						result: { header: snapshot.header, entries: snapshot.entries },
					};
				}
				case "session.new": {
					const { managed, info } = await this.#newSession(request.params.cwd);
					this.#setActive(managed, true);
					await this.#broadcastSessions();
					return { t: "response", id: request.id, method: "session.new", result: { session: info } };
				}
				case "session.fork": {
					const result = await this.#forkSession(request.params.path, request.params.entryId);
					await this.#broadcastSessions();
					return { t: "response", id: request.id, method: "session.fork", result };
				}
				case "session.rename": {
					const managed = this.#managed.get(this.#key(request.params.path));
					const session = await (managed?.service ?? this.#catalogService()).rename(
						request.params.path,
						request.params.title,
					);
					this.#broadcastTabs();
					await this.#broadcastSessions();
					return { t: "response", id: request.id, method: "session.rename", result: { session } };
				}
				case "session.delete": {
					const managed = this.#managed.get(this.#key(request.params.path));
					if (managed && (managed.service.running || managed.draftDirty)) {
						return { t: "response", id: request.id, method: "session.delete", result: { deleted: false } };
					}
					const service = managed?.service ?? this.#catalogService();
					if (managed) await this.#closeManaged(managed, false);
					const deleted = await service.deleteStored(request.params.path);
					if (this.#clients.size > 0) this.broadcast({ t: "sessions", sessions: await service.list() });
					return { t: "response", id: request.id, method: "session.delete", result: { deleted } };
				}
				case "session.pin": {
					const session = await this.#catalogService().pin(request.params.path, request.params.pinned);
					await this.#broadcastSessions();
					return { t: "response", id: request.id, method: "session.pin", result: { session } };
				}
				case "session.tabs":
					return { t: "response", id: request.id, method: "session.tabs", result: { tabs: this.#tabs() } };
				case "session.activate": {
					await this.#activate(request.params.path);
					return { t: "response", id: request.id, method: "session.activate", result: { tabs: this.#tabs() } };
				}
				case "session.tab.close": {
					const managed = this.#managed.get(this.#key(request.params.path));
					if (!managed) {
						return {
							t: "response",
							id: request.id,
							method: "session.tab.close",
							result: { closed: false, tabs: this.#tabs() },
						};
					}
					if (!request.params.force && managed.service.running) {
						return {
							t: "response",
							id: request.id,
							method: "session.tab.close",
							result: { closed: false, blockedReason: "running", tabs: this.#tabs() },
						};
					}
					if (!request.params.force && managed.draftDirty) {
						return {
							t: "response",
							id: request.id,
							method: "session.tab.close",
							result: { closed: false, blockedReason: "dirty-draft", tabs: this.#tabs() },
						};
					}
					await this.#closeManaged(managed, Boolean(request.params.force));
					return {
						t: "response",
						id: request.id,
						method: "session.tab.close",
						result: { closed: true, tabs: this.#tabs() },
					};
				}
				case "session.tab.draft": {
					const managed = this.#requireManaged(request.params.path);
					managed.draftDirty = request.params.dirty;
					this.#broadcastTabs();
					return { t: "response", id: request.id, method: "session.tab.draft", result: { tabs: this.#tabs() } };
				}
				default:
					return this.#error(
						request,
						"METHOD_NOT_SUPPORTED",
						`Method ${request.method} is not handled by the desktop runtime`,
					);
			}
		} catch (error) {
			return this.#error(request, this.#errorCode(error), error instanceof Error ? error.message : String(error));
		}
	}

	createUiContext(sessionPath = this.#activePath): ExtensionUIContext {
		const managed = this.#requireManaged(sessionPath);
		return {
			timeoutStartsOnPresentation: true,
			select: async (title, options, dialogOptions) =>
				await this.#requestUi(
					managed,
					{
						kind: "select",
						title,
						options: options.map(option =>
							typeof option === "string" ? option : { label: option.label, description: option.description },
						),
					},
					dialogOptions?.signal,
				),
			confirm: async (title, message, dialogOptions) => {
				const value = await this.#requestUi(
					managed,
					{ kind: "select", title: `${title}\n${message}`, options: ["Yes", "No"], initialIndex: 1 },
					dialogOptions?.signal,
				);
				return value === "Yes";
			},
			input: async (title, placeholder, dialogOptions) =>
				await this.#requestUi(
					managed,
					{ kind: "editor", title: placeholder ? `${title}\n${placeholder}` : title },
					dialogOptions?.signal,
				),
			editor: async (title, prefill, dialogOptions) =>
				await this.#requestUi(managed, { kind: "editor", title, prefill }, dialogOptions?.signal),
			notify: (message, type = "info") => {
				if (type === "error") {
					this.#emitSession(managed, { t: "error", sessionPath: managed.path, code: "UI_NOTIFICATION", message });
				}
			},
			onTerminalInput: () => () => {},
			setStatus: () => {},
			setWorkingMessage: () => {},
			setWidget: () => {},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: () => {},
			custom: async () => undefined as never,
			setEditorText: () => {},
			pasteToEditor: () => {},
			getEditorText: () => "",
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			get theme() {
				return theme;
			},
			getAllThemes: async () => [],
			getTheme: async () => undefined,
			setTheme: async () => ({ success: false, error: "Theme switching is unavailable on the browser surface" }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		};
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		const failures: unknown[] = [];
		for (const managed of [...this.#managed.values()]) {
			try {
				await this.#teardownManaged(managed);
			} catch (error) {
				failures.push(error);
			}
		}
		this.#managed.clear();
		for (const client of this.#clients) {
			try {
				client.close(1001, "desktop runtime stopped");
			} catch (error) {
				failures.push(error);
			}
		}
		this.#clients.clear();
		if (failures.length > 0) throw new AggregateError(failures, "Desktop runtime teardown failed");
	}

	#createManaged(resources: DesktopSessionResources): ManagedSession {
		const sessionPath = resources.session.sessionManager.getSessionFile();
		if (!sessionPath) throw new SessionServiceError("SESSION_NOT_PERSISTED", "Session has no persisted path");
		return {
			path: this.#key(sessionPath),
			session: resources.session,
			service: resources.sessionService ?? new SessionService(resources.session),
			eventBus: resources.eventBus,
			registry: resources.registry ?? AgentRegistry.global(),
			agentControl: resources.agentControl ?? new ChudDesktopAgentControl(),
			closeables: resources.closeables ?? [],
			pendingUi: new Map(),
			busUnsubscribers: [],
			unread: 0,
			draftDirty: false,
		};
	}

	async #registerResources(resources: DesktopSessionResources, expectedPath?: string): Promise<ManagedSession> {
		if (this.#disposed) {
			await this.#disposeUnmanaged(resources);
			throw new SessionServiceError("RUNTIME_STOPPED", "Desktop runtime is stopped");
		}
		const managed = this.#createManaged(resources);
		if (expectedPath && managed.path !== this.#key(expectedPath)) {
			await this.#teardownManaged(managed);
			throw new SessionServiceError("SESSION_PATH_MISMATCH", `Loaded session path did not match ${expectedPath}`);
		}
		if (this.#managed.has(managed.path)) {
			await this.#teardownManaged(managed);
			return this.#requireManaged(managed.path);
		}
		this.#managed.set(managed.path, managed);
		this.#installTaps(managed);
		try {
			await resources.initialize?.(this.createUiContext(managed.path));
		} catch (error) {
			this.#managed.delete(managed.path);
			await this.#teardownManaged(managed).catch(() => undefined);
			throw error;
		}
		return managed;
	}

	async #open(sessionPath: string): Promise<ManagedSession> {
		const key = this.#key(sessionPath);
		const existing = this.#managed.get(key);
		if (existing) return existing;
		const opening = this.#opening.get(key);
		if (opening) return await opening;
		this.#assertCapacity();
		if (!this.#sessionFactory) {
			throw new SessionServiceError("SESSION_FACTORY_UNAVAILABLE", "This runtime cannot open another live session");
		}
		const load = (async () => {
			const stored = (await this.#catalogService().list()).find(candidate => this.#key(candidate.path) === key);
			if (!stored) throw new SessionServiceError("SESSION_NOT_FOUND", "Session was not found");
			const resources = await this.#sessionFactory?.({ cwd: stored.cwd, sessionPath: stored.path });
			if (!resources) {
				throw new SessionServiceError(
					"SESSION_FACTORY_UNAVAILABLE",
					"This runtime cannot open another live session",
				);
			}
			return await this.#registerResources(resources, stored.path);
		})();
		this.#opening.set(key, load);
		try {
			return await load;
		} finally {
			if (this.#opening.get(key) === load) this.#opening.delete(key);
		}
	}

	async #activate(sessionPath: string): Promise<ManagedSession> {
		const managed = await this.#open(sessionPath);
		this.#setActive(managed, true);
		return managed;
	}

	async #newSession(cwd: string): Promise<{ managed: ManagedSession; info: DesktopSessionInfo }> {
		this.#assertCapacity();
		if (!this.#sessionFactory) {
			throw new SessionServiceError(
				"SESSION_FACTORY_UNAVAILABLE",
				"This runtime cannot create another live session",
			);
		}
		this.#pendingCreations += 1;
		try {
			const resources = await this.#sessionFactory({ cwd: path.resolve(cwd) });
			const service = resources.sessionService ?? new SessionService(resources.session);
			resources.sessionService = service;
			let info: DesktopSessionInfo;
			try {
				info = await service.materializeActive();
			} catch (error) {
				await this.#disposeUnmanaged(resources).catch(() => undefined);
				throw error;
			}
			const managed = await this.#registerResources(resources, info.path);
			return { managed, info };
		} finally {
			this.#pendingCreations -= 1;
		}
	}

	async #forkSession(sessionPath: string, entryId?: string) {
		this.#assertCapacity();
		if (!this.#sessionFactory) {
			throw new SessionServiceError("SESSION_FACTORY_UNAVAILABLE", "This runtime cannot fork another live session");
		}
		this.#pendingCreations += 1;
		try {
			const key = this.#key(sessionPath);
			const stored = (await this.#catalogService().list()).find(candidate => this.#key(candidate.path) === key);
			if (!stored) throw new SessionServiceError("SESSION_NOT_FOUND", "Session was not found");
			const resources = await this.#sessionFactory({ cwd: stored.cwd, sessionPath: stored.path });
			const service = resources.sessionService ?? new SessionService(resources.session);
			resources.sessionService = service;
			let result: SessionForkResult;
			try {
				result = await service.fork(stored.path, entryId);
			} catch (error) {
				await this.#disposeUnmanaged(resources).catch(() => undefined);
				throw error;
			}
			if (result.cancelled) {
				await this.#disposeUnmanaged(resources);
				return result;
			}
			const managed = await this.#registerResources(resources, result.session.path);
			this.#setActive(managed, true);
			return result;
		} finally {
			this.#pendingCreations -= 1;
		}
	}

	#setActive(managed: ManagedSession, sendSnapshot: boolean): void {
		this.#activePath = managed.path;
		managed.unread = 0;
		if (sendSnapshot) this.#broadcastSnapshot(managed);
		this.#broadcastTabs();
	}

	#installTaps(managed: ManagedSession): void {
		managed.unsubscribeSession = managed.session.subscribe(event => {
			const converted = toWireAgentEvent(event);
			if (converted.value) {
				this.#emitSession(managed, { t: "agent-event", sessionPath: managed.path, event: converted.value });
			}
			this.#reportWireOmissions(managed, converted.omissions);
			this.#onAgentEvent(managed, event);
		});
		managed.previousEntryTap = managed.session.sessionManager.onEntryAppended;
		managed.entryTap = entry => {
			try {
				managed.previousEntryTap?.(entry);
			} finally {
				const converted = toWireSessionEntry(entry);
				if (converted.value)
					this.#emitSession(managed, { t: "entry", sessionPath: managed.path, entry: converted.value });
				this.#reportWireOmissions(managed, converted.omissions);
				this.#scheduleState(managed);
			}
		};
		managed.session.sessionManager.onEntryAppended = managed.entryTap;
		if (managed.eventBus) {
			for (const channel of BUS_CHANNELS) {
				managed.busUnsubscribers.push(
					managed.eventBus.on(channel, data =>
						this.#emitSession(managed, { t: "bus", sessionPath: managed.path, channel, data }),
					),
				);
			}
		}
		managed.unsubscribeRegistry = managed.registry.onChange(() => this.#scheduleAgents(managed));
	}

	#onAgentEvent(managed: ManagedSession, event: AgentSessionEvent): void {
		if (!STATE_TRIGGER_EVENTS[event.type]) return;
		this.#scheduleState(managed);
		this.#broadcastTabs();
		if (event.type === "agent_start" && !managed.streamingTimer) {
			managed.streamingTimer = setInterval(() => this.#scheduleState(managed), STREAMING_STATE_INTERVAL_MS);
		} else if (event.type === "agent_end" && managed.streamingTimer) {
			clearInterval(managed.streamingTimer);
			managed.streamingTimer = undefined;
		}
	}

	#afterPrompt(managed: ManagedSession): void {
		this.#scheduleState(managed);
		this.#broadcastTabs();
	}

	#scheduleState(managed: ManagedSession): void {
		if (this.#disposed || managed.stateTimer) return;
		managed.stateTimer = setTimeout(() => {
			managed.stateTimer = undefined;
			if (!this.#managed.has(managed.path)) return;
			this.#emitSession(managed, { t: "state", sessionPath: managed.path, state: this.#state(managed) });
		}, STATE_DEBOUNCE_MS);
	}

	#scheduleAgents(managed: ManagedSession): void {
		if (this.#disposed || managed.agentsTimer) return;
		managed.agentsTimer = setTimeout(() => {
			managed.agentsTimer = undefined;
			if (!this.#managed.has(managed.path)) return;
			this.#emitSession(managed, { t: "agents", sessionPath: managed.path, agents: this.#agents(managed) });
		}, AGENTS_DEBOUNCE_MS);
	}

	#state(managed: ManagedSession): SessionState {
		const model = managed.session.model;
		const breakdown = managed.session.getContextBreakdown?.({ contextWindow: model?.contextWindow ?? undefined });
		const usedTokens = breakdown?.usedTokens ?? null;
		const contextWindow = breakdown?.contextWindow ?? model?.contextWindow ?? null;
		return {
			isStreaming: managed.session.isStreaming,
			isAborting: managed.session.isAborting,
			queuedMessageCount: managed.session.queuedMessageCount,
			sessionName: managed.session.sessionName,
			cwd: managed.session.sessionManager.getCwd(),
			model: model
				? { id: model.id, name: model.name, provider: model.provider, contextWindow: model.contextWindow }
				: undefined,
			thinkingLevel: managed.session.thinkingLevel,
			contextUsage: {
				tokens: usedTokens,
				contextWindow,
				percent:
					usedTokens !== null && contextWindow !== null && contextWindow > 0
						? (usedTokens / contextWindow) * 100
						: null,
			},
			participants: [{ name: "Desktop", role: "host" }],
		};
	}

	#agents(managed: ManagedSession): AgentSnapshot[] {
		return managed.registry
			.list()
			.filter((ref): ref is RegistryRef & { kind: "main" | "sub" } => ref.kind !== "advisor")
			.map(ref => ({
				id: ref.id,
				displayName: ref.displayName,
				kind: ref.kind,
				parentId: ref.parentId,
				status: ref.status,
				hasSessionFile: Boolean(ref.sessionFile),
				createdAt: ref.createdAt,
				lastActivity: ref.lastActivity,
			}));
	}

	#sendSnapshot(client: DesktopFrameSink, managed: ManagedSession): void {
		const snapshot = toWireSessionSnapshot(managed.session.sessionManager.snapshotForReplication());
		client.send({
			t: "welcome",
			sessionPath: managed.path,
			protocol: DESKTOP_PROTOCOL_VERSION,
			header: snapshot.header,
			state: this.#state(managed),
			agents: this.#agents(managed),
			entryCount: snapshot.entries.length,
		});
		this.#sendSnapshotChunks(client, managed.path, snapshot.entries);
		this.#reportWireOmissions(managed, snapshot.omissions, client);
	}

	#sendSnapshotChunks(client: DesktopFrameSink, sessionPath: string, entries: WireSessionEntry[]): void {
		if (entries.length === 0) {
			client.send({ t: "snapshot-chunk", sessionPath, entries: [], final: true });
			return;
		}
		let index = 0;
		while (index < entries.length) {
			const batch: WireSessionEntry[] = [];
			let bytes = 0;
			while (index < entries.length) {
				const entry = entries[index];
				if (!entry) break;
				const entryBytes = Buffer.byteLength(JSON.stringify(entry));
				if (batch.length > 0 && bytes + entryBytes > this.#snapshotChunkBytes) break;
				batch.push(entry);
				bytes += entryBytes;
				index += 1;
			}
			client.send({ t: "snapshot-chunk", sessionPath, entries: batch, final: index >= entries.length });
		}
	}

	#reportWireOmissions(managed: ManagedSession, omissions: string[], client?: DesktopFrameSink): void {
		const clients = client ? [client] : this.#clients;
		for (const target of clients) {
			let reported = this.#reportedWireOmissions.get(target);
			if (!reported) {
				reported = new Set<string>();
				this.#reportedWireOmissions.set(target, reported);
			}
			for (const omission of omissions) {
				const key = `${managed.path}:${omission}`;
				if (reported.has(key)) continue;
				reported.add(key);
				target.send({
					t: "agent-event",
					sessionPath: managed.path,
					event: {
						type: "notice",
						level: "warning",
						message: `Browser omitted unsupported ${omission}.`,
						source: "desktop",
					},
				});
			}
		}
	}

	#emitSession(managed: ManagedSession, frame: DesktopEvent): void {
		if (this.#disposed || !this.#managed.has(managed.path)) return;
		if (managed.path !== this.#activePath) managed.unread += 1;
		this.broadcast(frame);
		if (managed.path !== this.#activePath) this.#broadcastTabs();
	}

	#broadcastSnapshot(managed: ManagedSession): void {
		for (const client of this.#clients) this.#sendSnapshot(client, managed);
	}

	async #broadcastSessions(): Promise<void> {
		if (this.#clients.size === 0 || this.#managed.size === 0) return;
		this.broadcast({ t: "sessions", sessions: await this.#catalogService().list() });
	}

	#tabs(): DesktopSessionTab[] {
		return [...this.#managed.values()].map(managed => ({
			path: managed.path,
			title:
				managed.session.sessionName ??
				managed.session.sessionManager.getSessionName() ??
				path.basename(managed.path, path.extname(managed.path)),
			cwd: managed.session.sessionManager.getCwd(),
			active: managed.path === this.#activePath,
			running: managed.service.running,
			unread: managed.unread,
			draftDirty: managed.draftDirty,
		}));
	}

	#broadcastTabs(): void {
		this.broadcast({ t: "session-tabs", tabs: this.#tabs() });
	}

	#requestUi(
		managed: ManagedSession,
		request: CollabUiRequestDraft,
		signal?: AbortSignal,
	): Promise<CollabUiResponseValue> {
		if (this.#disposed || this.#clients.size === 0 || signal?.aborted) return Promise.resolve(undefined);
		const reqId = ++this.#uiSequence;
		const fullRequest: CollabUiRequest = { ...request, reqId };
		const { promise, resolve } = Promise.withResolvers<CollabUiResponseValue>();
		let settled = false;
		const settle = (value: CollabUiResponseValue): void => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			managed.pendingUi.delete(reqId);
			this.#emitSession(managed, { t: "ui-request-end", sessionPath: managed.path, reqId });
			resolve(value);
		};
		const onAbort = (): void => settle(undefined);
		signal?.addEventListener("abort", onAbort, { once: true });
		managed.pendingUi.set(reqId, { request: fullRequest, settle });
		this.#emitSession(managed, { t: "ui-request", sessionPath: managed.path, request: fullRequest });
		return promise;
	}

	#respondUi(managed: ManagedSession, reqId: number, value: CollabUiResponseValue): boolean {
		const pending = managed.pendingUi.get(reqId);
		if (!pending) return false;
		pending.settle(value);
		return true;
	}

	#settleAllUiRequests(managed: ManagedSession): void {
		for (const pending of [...managed.pendingUi.values()]) pending.settle(undefined);
	}

	async #closeManaged(managed: ManagedSession, force: boolean): Promise<void> {
		if (force && managed.service.running) await managed.service.abort();
		await this.#teardownManaged(managed);
		this.#managed.delete(managed.path);
		if (this.#activePath === managed.path) {
			const replacement = this.#managed.values().next().value as ManagedSession | undefined;
			this.#activePath = replacement?.path ?? "";
			if (replacement) {
				replacement.unread = 0;
				this.#broadcastSnapshot(replacement);
			}
		}
		this.#broadcastTabs();
	}

	async #teardownManaged(managed: ManagedSession): Promise<void> {
		clearTimeout(managed.stateTimer);
		clearTimeout(managed.agentsTimer);
		clearInterval(managed.streamingTimer);
		managed.unsubscribeSession?.();
		managed.unsubscribeRegistry?.();
		for (const unsubscribe of managed.busUnsubscribers) unsubscribe();
		managed.busUnsubscribers.length = 0;
		if (managed.session.sessionManager.onEntryAppended === managed.entryTap) {
			managed.session.sessionManager.onEntryAppended = managed.previousEntryTap;
		}
		this.#settleAllUiRequests(managed);
		const failures: unknown[] = [];
		try {
			await managed.session.sessionManager.flush();
		} catch (error) {
			failures.push(error);
		}
		for (const closeable of managed.closeables) {
			try {
				if ("dispose" in closeable) await closeable.dispose();
				else await closeable.close();
			} catch (error) {
				failures.push(error);
			}
		}
		try {
			await managed.session.dispose();
		} catch (error) {
			failures.push(error);
		}
		if (failures.length > 0) throw new AggregateError(failures, `Failed to close session ${managed.path}`);
	}

	async #disposeUnmanaged(resources: DesktopSessionResources): Promise<void> {
		const failures: unknown[] = [];
		try {
			await resources.session.sessionManager.flush();
		} catch (error) {
			failures.push(error);
		}
		for (const closeable of resources.closeables ?? []) {
			try {
				if ("dispose" in closeable) await closeable.dispose();
				else await closeable.close();
			} catch (error) {
				failures.push(error);
			}
		}
		try {
			await resources.session.dispose();
		} catch (error) {
			failures.push(error);
		}
		if (failures.length > 0) throw new AggregateError(failures, "Failed to dispose unopened session");
	}

	#assertCapacity(): void {
		if (this.#managed.size + this.#opening.size + this.#pendingCreations < this.#maxOpenSessions) return;
		throw new SessionServiceError(
			"MAX_OPEN_SESSIONS",
			`At most ${this.#maxOpenSessions} live sessions can be open; close a finished tab and try again`,
		);
	}

	#catalogService(): SessionService {
		const active = this.#managed.get(this.#activePath) ?? this.#managed.values().next().value;
		if (!active) throw new SessionServiceError("NO_OPEN_SESSION", "Open a session before using the session catalog");
		return active.service;
	}

	#requireActive(): ManagedSession {
		const managed = this.#managed.get(this.#activePath);
		if (!managed) throw new SessionServiceError("NO_ACTIVE_SESSION", "No desktop session is active");
		return managed;
	}

	#requireManaged(sessionPath: string): ManagedSession {
		const managed = this.#managed.get(this.#key(sessionPath));
		if (!managed) throw new SessionServiceError("SESSION_NOT_OPEN", `Session ${sessionPath} is not open`);
		return managed;
	}

	#key(sessionPath: string): string {
		return path.resolve(sessionPath);
	}

	#error(request: DesktopRequest, code: string, message: string): DesktopResponse {
		return { t: "response", id: request.id, method: request.method, error: { code, message } } as DesktopResponse;
	}

	#errorCode(error: unknown): string {
		if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
			return error.code;
		}
		return "RUNTIME_ERROR";
	}
}

export async function createDesktopRuntime(options: CreateDesktopRuntimeOptions): Promise<DesktopRuntime> {
	const createResources = async (request: DesktopSessionFactoryRequest): Promise<DesktopSessionResources> => {
		const sessionManager = request.sessionPath
			? await SessionManager.open(request.sessionPath)
			: SessionManager.create(request.cwd);
		const created = await createAgentSession({
			cwd: request.cwd,
			sessionManager,
			hasUI: true,
			interactivePrompts: true,
		});
		return {
			session: created.session,
			eventBus: created.eventBus,
			initialize: async uiContext => {
				const sessionPath = path.resolve(
					created.session.sessionManager.getSessionFile() ?? request.sessionPath ?? "",
				);
				created.setToolUIContext(uiContext, true);
				await initializeExtensions(created.session, {
					mode: "rpc",
					uiContext,
					reportSendError: (action, error) => {
						runtime.broadcast({
							t: "error",
							sessionPath,
							code: action.toUpperCase(),
							message: error.message,
						});
					},
					reportRuntimeError: error => {
						runtime.broadcast({ t: "error", sessionPath, code: "EXTENSION_ERROR", message: error.error });
					},
				});
				if (created.startBackgroundModelDiscovery) {
					void created.startBackgroundModelDiscovery().catch(error => {
						runtime.broadcast({
							t: "error",
							sessionPath,
							code: "MODEL_DISCOVERY_FAILED",
							message: error instanceof Error ? error.message : String(error),
						});
					});
				}
			},
		};
	};

	const initial = await createResources({ cwd: path.resolve(options.cwd) });
	await initial.session.sessionManager.ensureOnDisk();
	await initial.session.sessionManager.flush();
	const runtime = new DesktopRuntime({ ...initial, sessionFactory: createResources });
	try {
		await initial.initialize?.(runtime.createUiContext());
	} catch (error) {
		await runtime.dispose().catch(() => undefined);
		throw error;
	}
	return runtime;
}
