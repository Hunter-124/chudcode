import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionEntry as StoredSessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
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
} from "./protocol";
import {
	type DesktopAgentSession,
	SessionService,
	toWireAgentEvent,
	toWireSessionEntry,
	toWireSessionSnapshot,
} from "./session-service";

const STATE_DEBOUNCE_MS = 100;
const AGENTS_DEBOUNCE_MS = 100;
const STREAMING_STATE_INTERVAL_MS = 2_000;
const SNAPSHOT_CHUNK_BYTES = 512 * 1024;
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

interface PendingUiRequest {
	request: CollabUiRequest;
	settle(value: CollabUiResponseValue): void;
}

export interface DesktopRuntimeOptions {
	session: DesktopAgentSession;
	eventBus?: EventBus;
	registry?: DesktopAgentRegistry;
	sessionService?: SessionService;
	snapshotChunkBytes?: number;
	closeables?: Array<{ close(): void | Promise<void> } | { dispose(): void | Promise<void> }>;
}

export interface CreateDesktopRuntimeOptions {
	cwd: string;
}

/**
 * Direct desktop host for one SDK AgentSession. It mirrors the collaboration
 * host's taps, but sends plain local protocol frames to authenticated loopback
 * sockets rather than relay-encrypted frames.
 */
export class DesktopRuntime {
	readonly session: DesktopAgentSession;
	readonly sessions: SessionService;
	readonly #eventBus?: EventBus;
	readonly #registry: DesktopAgentRegistry;
	readonly #snapshotChunkBytes: number;
	readonly #closeables: DesktopRuntimeOptions["closeables"];
	readonly #clients = new Set<DesktopFrameSink>();
	readonly #pendingUi = new Map<number, PendingUiRequest>();
	readonly #busUnsubscribers: Array<() => void> = [];
	#unsubscribeSession?: () => void;
	#unsubscribeRegistry?: () => void;
	#previousEntryTap?: (entry: StoredSessionEntry) => void;
	#entryTap?: (entry: StoredSessionEntry) => void;
	#stateTimer?: Timer;
	#agentsTimer?: Timer;
	#streamingTimer?: Timer;
	#uiSequence = 0;
	readonly #reportedWireOmissions = new WeakMap<DesktopFrameSink, Set<string>>();
	#disposed = false;

	constructor(options: DesktopRuntimeOptions) {
		this.session = options.session;
		this.sessions = options.sessionService ?? new SessionService(options.session);
		this.#eventBus = options.eventBus;
		this.#registry = options.registry ?? AgentRegistry.global();
		this.#snapshotChunkBytes = options.snapshotChunkBytes ?? SNAPSHOT_CHUNK_BYTES;
		this.#closeables = options.closeables;
		this.#installTaps();
	}

	attach(client: DesktopFrameSink): void {
		if (this.#disposed) {
			client.close(1012, "runtime stopped");
			return;
		}
		this.#clients.add(client);
		this.#sendSnapshot(client);
		for (const pending of this.#pendingUi.values()) client.send({ t: "ui-request", request: pending.request });
	}

	detach(client: DesktopFrameSink): void {
		this.#clients.delete(client);
		if (this.#clients.size === 0) this.#settleAllUiRequests();
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
					void this.sessions.sendPrompt(request.params.text, request.params.images).catch(error => {
						this.broadcast({
							t: "error",
							code: "PROMPT_FAILED",
							message: error instanceof Error ? error.message : String(error),
						});
					});
					return { t: "response", id: request.id, method: "prompt.send", result: { accepted: true } };
				}
				case "run.abort": {
					const accepted = await this.sessions.abort();
					return { t: "response", id: request.id, method: "run.abort", result: { accepted } };
				}
				case "ui.respond": {
					const accepted = this.respondUi(request.params.reqId, request.params.value);
					return { t: "response", id: request.id, method: "ui.respond", result: { accepted } };
				}
				case "session.list": {
					const sessions = await this.sessions.list(request.params.cwd);
					return { t: "response", id: request.id, method: "session.list", result: { sessions } };
				}
				case "session.select": {
					const { omissions, ...selected } = await this.sessions.select(request.params.path);
					this.#reportWireOmissions(omissions);
					this.#scheduleState();
					await this.#broadcastSessions();
					return { t: "response", id: request.id, method: "session.select", result: selected };
				}
				case "session.new": {
					const session = await this.sessions.newSession(request.params.cwd);
					this.#broadcastSnapshot();
					await this.#broadcastSessions();
					return { t: "response", id: request.id, method: "session.new", result: { session } };
				}
				case "session.fork": {
					const result = await this.sessions.fork(request.params.path, request.params.entryId);
					if (!result.cancelled) this.#broadcastSnapshot();
					await this.#broadcastSessions();
					return { t: "response", id: request.id, method: "session.fork", result };
				}
				case "session.rename": {
					const session = await this.sessions.rename(request.params.path, request.params.title);
					this.#scheduleState();
					await this.#broadcastSessions();
					return { t: "response", id: request.id, method: "session.rename", result: { session } };
				}
				case "session.delete": {
					const deleted = await this.sessions.delete(request.params.path);
					if (deleted.activeChanged) this.#broadcastSnapshot();
					await this.#broadcastSessions();
					return { t: "response", id: request.id, method: "session.delete", result: { deleted: deleted.deleted } };
				}
				case "session.pin": {
					const session = await this.sessions.pin(request.params.path, request.params.pinned);
					await this.#broadcastSessions();
					return { t: "response", id: request.id, method: "session.pin", result: { session } };
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

	/** UI context installed through createAgentSession's authoritative setToolUIContext seam. */
	createUiContext(): ExtensionUIContext {
		return {
			timeoutStartsOnPresentation: true,
			select: async (title, options, dialogOptions) => {
				const request: CollabUiRequestDraft = {
					kind: "select",
					title,
					options: options.map(option =>
						typeof option === "string" ? option : { label: option.label, description: option.description },
					),
				};
				return await this.#requestUi(request, dialogOptions?.signal);
			},
			confirm: async (title, message, dialogOptions) => {
				const value = await this.#requestUi(
					{ kind: "select", title: `${title}\n${message}`, options: ["Yes", "No"], initialIndex: 1 },
					dialogOptions?.signal,
				);
				return value === "Yes";
			},
			input: async (title, placeholder, dialogOptions) =>
				await this.#requestUi(
					{ kind: "editor", title: placeholder ? `${title}\n${placeholder}` : title },
					dialogOptions?.signal,
				),
			editor: async (title, prefill, dialogOptions) =>
				await this.#requestUi({ kind: "editor", title, prefill }, dialogOptions?.signal),
			notify: (message, type = "info") => {
				if (type === "error") this.broadcast({ t: "error", code: "UI_NOTIFICATION", message });
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

	respondUi(reqId: number, value: CollabUiResponseValue): boolean {
		const pending = this.#pendingUi.get(reqId);
		if (!pending) return false;
		pending.settle(value);
		return true;
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		clearTimeout(this.#stateTimer);
		clearTimeout(this.#agentsTimer);
		clearInterval(this.#streamingTimer);
		this.#stateTimer = undefined;
		this.#agentsTimer = undefined;
		this.#streamingTimer = undefined;
		this.#unsubscribeSession?.();
		this.#unsubscribeRegistry?.();
		for (const unsubscribe of this.#busUnsubscribers) unsubscribe();
		this.#busUnsubscribers.length = 0;
		if (this.session.sessionManager.onEntryAppended === this.#entryTap) {
			this.session.sessionManager.onEntryAppended = this.#previousEntryTap;
		}
		const failures: unknown[] = [];
		this.#settleAllUiRequests();
		for (const client of this.#clients) {
			try {
				client.close(1001, "desktop runtime stopped");
			} catch (error) {
				failures.push(error);
			}
		}
		this.#clients.clear();
		for (const closeable of this.#closeables ?? []) {
			try {
				if ("dispose" in closeable) await closeable.dispose();
				else await closeable.close();
			} catch (error) {
				failures.push(error);
			}
		}
		try {
			await this.session.dispose();
		} catch (error) {
			failures.push(error);
		}
		if (failures.length > 0) throw new AggregateError(failures, "Desktop runtime teardown failed");
	}

	#installTaps(): void {
		this.#unsubscribeSession = this.session.subscribe(event => {
			const converted = toWireAgentEvent(event);
			if (converted.value) this.broadcast({ t: "agent-event", event: converted.value });
			this.#reportWireOmissions(converted.omissions);
			this.#onAgentEvent(event);
		});
		this.#previousEntryTap = this.session.sessionManager.onEntryAppended;
		this.#entryTap = entry => {
			try {
				this.#previousEntryTap?.(entry);
			} finally {
				const converted = toWireSessionEntry(entry);
				if (converted.value) this.broadcast({ t: "entry", entry: converted.value });
				this.#reportWireOmissions(converted.omissions);
				this.#scheduleState();
			}
		};
		this.session.sessionManager.onEntryAppended = this.#entryTap;
		if (this.#eventBus) {
			for (const channel of BUS_CHANNELS) {
				this.#busUnsubscribers.push(
					this.#eventBus.on(channel, data => this.broadcast({ t: "bus", channel, data })),
				);
			}
		}
		this.#unsubscribeRegistry = this.#registry.onChange(() => this.#scheduleAgents());
	}

	#onAgentEvent(event: AgentSessionEvent): void {
		if (!STATE_TRIGGER_EVENTS[event.type]) return;
		this.#scheduleState();
		if (event.type === "agent_start" && !this.#streamingTimer) {
			this.#streamingTimer = setInterval(() => this.#scheduleState(), STREAMING_STATE_INTERVAL_MS);
		} else if (event.type === "agent_end" && this.#streamingTimer) {
			clearInterval(this.#streamingTimer);
			this.#streamingTimer = undefined;
		}
	}

	#scheduleState(): void {
		if (this.#disposed || this.#stateTimer) return;
		this.#stateTimer = setTimeout(() => {
			this.#stateTimer = undefined;
			this.broadcast({ t: "state", state: this.#state() });
		}, STATE_DEBOUNCE_MS);
	}

	#scheduleAgents(): void {
		if (this.#disposed || this.#agentsTimer) return;
		this.#agentsTimer = setTimeout(() => {
			this.#agentsTimer = undefined;
			this.broadcast({ t: "agents", agents: this.#agents() });
		}, AGENTS_DEBOUNCE_MS);
	}

	#state(): SessionState {
		const model = this.session.model;
		const breakdown = this.session.getContextBreakdown?.({ contextWindow: model?.contextWindow ?? undefined });
		const usedTokens = breakdown?.usedTokens ?? null;
		const contextWindow = breakdown?.contextWindow ?? model?.contextWindow ?? null;
		return {
			isStreaming: this.session.isStreaming,
			isAborting: this.session.isAborting,
			queuedMessageCount: this.session.queuedMessageCount,
			sessionName: this.session.sessionName,
			cwd: this.session.sessionManager.getCwd(),
			model: model
				? {
						id: model.id,
						name: model.name,
						provider: model.provider,
						contextWindow: model.contextWindow,
					}
				: undefined,
			thinkingLevel: this.session.thinkingLevel,
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

	#agents(): AgentSnapshot[] {
		return this.#registry
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

	#sendSnapshot(client: DesktopFrameSink): void {
		const snapshot = toWireSessionSnapshot(this.session.sessionManager.snapshotForReplication());
		client.send({
			t: "welcome",
			protocol: DESKTOP_PROTOCOL_VERSION,
			header: snapshot.header,
			state: this.#state(),
			agents: this.#agents(),
			entryCount: snapshot.entries.length,
		});
		this.#sendSnapshotChunks(client, snapshot.entries);
		this.#reportWireOmissions(snapshot.omissions, client);
	}

	#sendSnapshotChunks(client: DesktopFrameSink, entries: WireSessionEntry[]): void {
		if (entries.length === 0) {
			client.send({ t: "snapshot-chunk", entries: [], final: true });
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
			client.send({ t: "snapshot-chunk", entries: batch, final: index >= entries.length });
		}
	}

	#reportWireOmissions(omissions: string[], client?: DesktopFrameSink): void {
		const clients = client ? [client] : this.#clients;
		for (const target of clients) {
			let reported = this.#reportedWireOmissions.get(target);
			if (!reported) {
				reported = new Set<string>();
				this.#reportedWireOmissions.set(target, reported);
			}
			for (const omission of omissions) {
				if (reported.has(omission)) continue;
				reported.add(omission);
				target.send({
					t: "agent-event",
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

	#broadcastSnapshot(): void {
		for (const client of this.#clients) this.#sendSnapshot(client);
	}

	async #broadcastSessions(): Promise<void> {
		if (this.#clients.size === 0) return;
		this.broadcast({ t: "sessions", sessions: await this.sessions.list() });
	}

	#requestUi(request: CollabUiRequestDraft, signal?: AbortSignal): Promise<CollabUiResponseValue> {
		if (this.#disposed || this.#clients.size === 0 || signal?.aborted) return Promise.resolve(undefined);
		const reqId = ++this.#uiSequence;
		const fullRequest: CollabUiRequest = { ...request, reqId };
		const { promise, resolve } = Promise.withResolvers<CollabUiResponseValue>();
		let settled = false;
		const settle = (value: CollabUiResponseValue): void => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			this.#pendingUi.delete(reqId);
			this.broadcast({ t: "ui-request-end", reqId });
			resolve(value);
		};
		const onAbort = (): void => settle(undefined);
		signal?.addEventListener("abort", onAbort, { once: true });
		this.#pendingUi.set(reqId, { request: fullRequest, settle });
		this.broadcast({ t: "ui-request", request: fullRequest });
		return promise;
	}

	#settleAllUiRequests(): void {
		for (const pending of [...this.#pendingUi.values()]) pending.settle(undefined);
	}

	#error(request: DesktopRequest, code: string, message: string): DesktopResponse {
		return { t: "response", id: request.id, method: request.method, error: { code, message } } as DesktopResponse;
	}

	#errorCode(error: unknown): string {
		if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string")
			return error.code;
		return "RUNTIME_ERROR";
	}
}

export async function createDesktopRuntime(options: CreateDesktopRuntimeOptions): Promise<DesktopRuntime> {
	const created = await createAgentSession({
		cwd: options.cwd,
		hasUI: true,
		interactivePrompts: true,
	});
	const runtime = new DesktopRuntime({ session: created.session, eventBus: created.eventBus });
	const uiContext = runtime.createUiContext();
	created.setToolUIContext(uiContext, true);
	try {
		await initializeExtensions(created.session, {
			mode: "rpc",
			uiContext,
			reportSendError: (action, error) => {
				runtime.broadcast({ t: "error", code: action.toUpperCase(), message: error.message });
			},
			reportRuntimeError: error => {
				runtime.broadcast({ t: "error", code: "EXTENSION_ERROR", message: error.error });
			},
		});
	} catch (error) {
		await runtime.dispose().catch(() => undefined);
		throw error;
	}
	if (created.startBackgroundModelDiscovery) {
		void created.startBackgroundModelDiscovery().catch(error => {
			runtime.broadcast({
				t: "error",
				code: "MODEL_DISCOVERY_FAILED",
				message: error instanceof Error ? error.message : String(error),
			});
		});
	}
	return runtime;
}
