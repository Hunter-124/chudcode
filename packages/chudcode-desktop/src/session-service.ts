import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import type {
	SessionEntry as StoredSessionEntry,
	SessionHeader as StoredSessionHeader,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { SessionInfo, SessionStatus } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { loadPinnedSessionIds, toggleSessionPin } from "@oh-my-pi/pi-coding-agent/session/session-pins";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type {
	AssistantContent,
	AgentEvent as WireAgentEvent,
	WireMessage,
	SessionEntry as WireSessionEntry,
	SessionHeader as WireSessionHeader,
} from "@oh-my-pi/pi-wire";
import type { DesktopSessionInfo } from "./protocol";

export interface DesktopSessionManager {
	onEntryAppended?: (entry: StoredSessionEntry) => void;
	snapshotForReplication(): { header: StoredSessionHeader; entries: StoredSessionEntry[] };
	getSessionFile(): string | undefined;
	getSessionId(): string;
	getSessionName(): string | undefined;
	getCwd(): string;
	ensureOnDisk(): Promise<void>;
	flush(): Promise<void>;
}

export interface DesktopAgentSession {
	readonly sessionManager: DesktopSessionManager;
	readonly isStreaming: boolean;
	readonly isAborting: boolean;
	readonly queuedMessageCount: number;
	readonly sessionName: string | undefined;
	readonly model: Model | undefined;
	readonly thinkingLevel: string | undefined;
	prompt(
		text: string,
		options?: { images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" },
	): Promise<boolean>;
	abort(options?: { goalReason?: "interrupted" | "internal"; reason?: string }): Promise<void>;
	subscribe(listener: (event: AgentSessionEvent) => void | Promise<void>): () => void;
	switchSession(path: string): Promise<boolean>;
	newSession(options?: { drop?: boolean }): Promise<boolean>;
	moveSession(cwd: string): Promise<void>;
	fork(): Promise<boolean>;
	branch(entryId: string): Promise<{ selectedText: string; selectedImages: ImageContent[]; cancelled: boolean }>;
	setSessionName(name: string, source: "auto" | "user"): Promise<boolean>;
	getContextBreakdown?(options?: {
		contextWindow?: number;
	}): { usedTokens?: number; contextWindow?: number } | undefined;
	dispose(): Promise<void>;
}

interface RenameManager {
	setSessionName(name: string, source: "auto" | "user"): Promise<boolean>;
	close(): Promise<void>;
}

export interface SessionCatalog {
	list(cwd?: string): Promise<SessionInfo[]>;
	openForRename(session: SessionInfo): Promise<RenameManager>;
	delete(path: string): Promise<void>;
	loadPins(): Promise<Set<string>>;
	togglePin(id: string): Promise<boolean>;
}

export interface SessionForkResult {
	session: DesktopSessionInfo;
	selectedText?: string;
	selectedImages?: ImageContent[];
	cancelled?: boolean;
}

export interface SessionServiceOptions {
	catalog?: SessionCatalog;
}

export interface WireSessionSnapshot {
	header: WireSessionHeader;
	entries: WireSessionEntry[];
	/** Rich variants deliberately omitted because the browser wire cannot render them. */
	omissions: string[];
}

export interface WireConversion<T> {
	value?: T;
	omissions: string[];
}

function toWireTextImageContent(
	content: string | Array<{ type: "text"; text: string } | ImageContent>,
): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return content.map(block =>
		block.type === "text"
			? { type: "text", text: block.text }
			: { type: "image", data: block.data, mimeType: block.mimeType },
	);
}

function toWireMessage(message: AgentMessage): WireConversion<WireMessage> {
	const rawRole: string = message.role;
	switch (message.role) {
		case "user":
			return {
				value: {
					role: "user",
					content: toWireTextImageContent(message.content),
					synthetic: message.synthetic,
					timestamp: message.timestamp,
				},
				omissions: [],
			};
		case "developer":
			return {
				value: {
					role: "developer",
					content: toWireTextImageContent(message.content),
					timestamp: message.timestamp,
				},
				omissions: [],
			};
		case "assistant": {
			const content: AssistantContent[] = [];
			const omissions: string[] = [];
			for (const block of message.content) {
				const rawType: string = block.type;
				switch (block.type) {
					case "text":
						content.push({ type: "text", text: block.text });
						break;
					case "thinking":
						content.push({ type: "thinking", thinking: block.thinking });
						break;
					case "redactedThinking":
						content.push({ type: "redactedThinking", data: block.data });
						break;
					case "toolCall":
						content.push({
							type: "toolCall",
							id: block.id,
							name: block.name,
							arguments: block.arguments,
							intent: block.intent,
						});
						break;
					case "fallback":
					case "anthropicServerTool":
					case "image":
						omissions.push(`assistant content type "${block.type}"`);
						break;
					default:
						omissions.push(`assistant content type "${rawType}"`);
						break;
				}
			}
			return {
				value: {
					role: "assistant",
					content,
					model: message.model,
					usage: {
						input: message.usage.input,
						output: message.usage.output,
						cacheRead: message.usage.cacheRead,
						cacheWrite: message.usage.cacheWrite,
						totalTokens: message.usage.totalTokens,
						cost: { total: message.usage.cost.total },
					},
					stopReason: message.stopReason,
					errorMessage: message.errorMessage,
					timestamp: message.timestamp,
				},
				omissions,
			};
		}
		case "toolResult":
			return {
				value: {
					role: "toolResult",
					toolCallId: message.toolCallId,
					toolName: message.toolName,
					content: toWireTextImageContent(message.content),
					details: message.details,
					isError: message.isError,
					timestamp: message.timestamp,
				},
				omissions: [],
			};
		case "bashExecution":
		case "pythonExecution":
		case "custom":
		case "hookMessage":
		case "branchSummary":
		case "compactionSummary":
		case "fileMention":
			return { omissions: [`message role "${message.role}"`] };
		default:
			return { omissions: [`message role "${rawRole}"`] };
	}
}

export function toWireSessionEntry(entry: StoredSessionEntry): WireConversion<WireSessionEntry> {
	const rawType: string = entry.type;
	switch (entry.type) {
		case "message": {
			const converted = toWireMessage(entry.message);
			return converted.value
				? {
						value: {
							type: "message",
							id: entry.id,
							parentId: entry.parentId,
							timestamp: entry.timestamp,
							message: converted.value,
						},
						omissions: converted.omissions,
					}
				: {
						omissions: converted.omissions.map(reason => `session entry "message" with unsupported ${reason}`),
					};
		}
		case "custom_message":
			return {
				value: {
					type: "custom_message",
					id: entry.id,
					parentId: entry.parentId,
					timestamp: entry.timestamp,
					customType: entry.customType,
					content: toWireTextImageContent(entry.content),
					details: entry.details,
					display: entry.display,
				},
				omissions: [],
			};
		case "compaction":
			return {
				value: {
					type: "compaction",
					id: entry.id,
					parentId: entry.parentId,
					timestamp: entry.timestamp,
					summary: entry.summary,
					shortSummary: entry.shortSummary,
					firstKeptEntryId: entry.firstKeptEntryId,
					tokensBefore: entry.tokensBefore,
				},
				omissions: [],
			};
		case "branch_summary":
			return {
				value: {
					type: "branch_summary",
					id: entry.id,
					parentId: entry.parentId,
					timestamp: entry.timestamp,
					fromId: entry.fromId,
					summary: entry.summary,
				},
				omissions: [],
			};
		case "model_change":
			return {
				value: {
					type: "model_change",
					id: entry.id,
					parentId: entry.parentId,
					timestamp: entry.timestamp,
					model: entry.model,
					role: entry.role,
				},
				omissions: [],
			};
		case "thinking_level_change":
			return {
				value: {
					type: "thinking_level_change",
					id: entry.id,
					parentId: entry.parentId,
					timestamp: entry.timestamp,
					thinkingLevel: entry.thinkingLevel,
				},
				omissions: [],
			};
		case "service_tier_change":
		case "custom":
		case "label":
		case "title_change":
		case "ttsr_injection":
		case "session_init":
		case "mode_change":
		case "credential_pin":
		case "reset_boundary":
			return { omissions: [`session entry type "${entry.type}"`] };
		default:
			return { omissions: [`session entry type "${rawType}"`] };
	}
}

export function toWireSessionSnapshot(snapshot: {
	header: StoredSessionHeader;
	entries: StoredSessionEntry[];
}): WireSessionSnapshot {
	const entries: WireSessionEntry[] = [];
	const omissions: string[] = [];
	for (const entry of snapshot.entries) {
		const converted = toWireSessionEntry(entry);
		if (converted.value) entries.push(converted.value);
		omissions.push(...converted.omissions);
	}
	return {
		header: {
			type: "session",
			id: snapshot.header.id,
			title: snapshot.header.title,
			timestamp: snapshot.header.timestamp,
			cwd: snapshot.header.cwd,
		},
		entries,
		omissions,
	};
}

export function toWireAgentEvent(event: AgentSessionEvent): WireConversion<WireAgentEvent> {
	const rawType: string = event.type;
	switch (event.type) {
		case "agent_start":
			return { value: { type: "agent_start" }, omissions: [] };
		case "agent_end":
			return { value: { type: "agent_end" }, omissions: [] };
		case "turn_start":
			return { value: { type: "turn_start" }, omissions: [] };
		case "turn_end":
			return { value: { type: "turn_end" }, omissions: [] };
		case "message_start":
		case "message_update":
		case "message_end": {
			const converted = toWireMessage(event.message);
			return converted.value
				? { value: { type: event.type, message: converted.value }, omissions: converted.omissions }
				: {
						omissions: converted.omissions.map(
							reason => `agent event "${event.type}" with unsupported ${reason}`,
						),
					};
		}
		case "tool_execution_start":
			return {
				value: {
					type: "tool_execution_start",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					intent: event.intent,
				},
				omissions: [],
			};
		case "tool_execution_update":
			return {
				value: {
					type: "tool_execution_update",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					partialResult: event.partialResult,
				},
				omissions: [],
			};
		case "tool_execution_end":
			return {
				value: {
					type: "tool_execution_end",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					result: event.result,
					isError: event.isError,
				},
				omissions: [],
			};
		case "notice":
			return {
				value: {
					type: "notice",
					level: event.level,
					message: event.message,
					source: event.source,
				},
				omissions: [],
			};
		case "auto_compaction_start":
			return {
				value: {
					type: "auto_compaction_start",
					reason: event.reason,
					action: event.action,
				},
				omissions: [],
			};
		case "auto_compaction_end":
			return {
				value: {
					type: "auto_compaction_end",
					aborted: event.aborted,
					willRetry: event.willRetry,
					errorMessage: event.errorMessage,
					skipped: event.skipped,
				},
				omissions: [],
			};
		case "auto_retry_start":
			return {
				value: {
					type: "auto_retry_start",
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					errorMessage: event.errorMessage,
				},
				omissions: [],
			};
		case "auto_retry_end":
			return {
				value: {
					type: "auto_retry_end",
					success: event.success,
					attempt: event.attempt,
					finalError: event.finalError,
				},
				omissions: [],
			};
		case "thinking_level_changed":
			return {
				value: {
					type: "thinking_level_changed",
					thinkingLevel: event.thinkingLevel,
				},
				omissions: [],
			};
		case "retry_fallback_applied":
		case "retry_fallback_succeeded":
		case "model_changed":
		case "advisor_cost_changed":
		case "ttsr_triggered":
		case "todo_reminder":
		case "todo_auto_clear":
		case "irc_message":
		case "goal_updated":
			return { omissions: [`agent event type "${rawType}"`] };
		default:
			return { omissions: [`agent event type "${rawType}"`] };
	}
}

export class SessionServiceError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "SessionServiceError";
		this.code = code;
	}
}

const defaultCatalog: SessionCatalog = {
	list: async cwd => (cwd === undefined ? await SessionManager.listAll() : await SessionManager.list(cwd)),
	openForRename: async session =>
		await SessionManager.open(session.path, undefined, new FileSessionStorage(), {
			initialCwd: session.cwd,
			suppressBreadcrumb: true,
		}),
	delete: async sessionPath => {
		await new FileSessionStorage().deleteSessionWithArtifacts(sessionPath);
	},
	loadPins: async () => await loadPinnedSessionIds(),
	togglePin: async id => await toggleSessionPin(id),
};

function normalizeSessionTitle(title: string): string {
	const cleanTitle = title.trim();
	if (!cleanTitle) throw new SessionServiceError("INVALID_TITLE", "Session title cannot be empty");
	return cleanTitle;
}

/** Persisted-session operations with no live AgentSession or lifetime-bound resources. */
export class SessionCatalogService {
	readonly #catalog: SessionCatalog;

	constructor(catalog: SessionCatalog = defaultCatalog) {
		this.#catalog = catalog;
	}

	async list(cwd?: string): Promise<DesktopSessionInfo[]> {
		const [sessions, pins] = await Promise.all([this.#catalog.list(cwd), this.#catalog.loadPins()]);
		return sessions.map(session => this.#toDesktopInfo(session, pins.has(session.id)));
	}

	async rename(sessionPath: string, title: string): Promise<DesktopSessionInfo> {
		const cleanTitle = normalizeSessionTitle(title);
		const stored = await this.requireSession(sessionPath);
		const manager = await this.#catalog.openForRename(stored);
		try {
			const renamed = await manager.setSessionName(cleanTitle, "user");
			if (!renamed) throw new SessionServiceError("INVALID_TITLE", "Session title was rejected");
		} finally {
			await manager.close();
		}
		return await this.requireDesktopInfo(stored.path);
	}

	async pin(sessionPath: string, pinned: boolean): Promise<DesktopSessionInfo> {
		const stored = await this.requireSession(sessionPath);
		const pins = await this.#catalog.loadPins();
		if (pins.has(stored.id) !== pinned) {
			const actual = await this.#catalog.togglePin(stored.id);
			if (actual !== pinned) throw new SessionServiceError("PIN_WRITE_FAILED", "Session pin state did not persist");
		}
		const refreshed = await this.requireSession(stored.path);
		return this.#toDesktopInfo(refreshed, pinned);
	}

	async deleteStored(sessionPath: string): Promise<boolean> {
		const stored = await this.requireSession(sessionPath);
		await this.#catalog.delete(stored.path);
		return true;
	}

	async requireDesktopInfo(sessionPath: string, cwd?: string): Promise<DesktopSessionInfo> {
		const stored = await this.requireSession(sessionPath, cwd);
		const pins = await this.#catalog.loadPins();
		return this.#toDesktopInfo(stored, pins.has(stored.id));
	}

	async requireSession(sessionPath: string, cwd?: string): Promise<SessionInfo> {
		const requested = path.resolve(sessionPath);
		const sessions = await this.#catalog.list(cwd);
		const stored = sessions.find(candidate => path.resolve(candidate.path) === requested);
		if (!stored) throw new SessionServiceError("SESSION_NOT_FOUND", "Session was not found");
		return stored;
	}

	#toDesktopInfo(session: SessionInfo, pinned: boolean): DesktopSessionInfo {
		return {
			id: session.id,
			path: session.path,
			cwd: session.cwd,
			title: session.title,
			parentSessionPath: session.parentSessionPath,
			createdMs: session.created.getTime(),
			modifiedMs: session.modified.getTime(),
			messageCount: session.messageCount,
			size: session.size,
			status: this.#status(session.status),
			pinned,
		};
	}

	#status(status: SessionStatus | undefined): DesktopSessionInfo["status"] {
		switch (status) {
			case "complete":
				return "completed";
			case "error":
				return "failed";
			case "interrupted":
			case "aborted":
				return "interrupted";
			case "pending":
				return "active";
			default:
				return undefined;
		}
	}
}

/** Live-session protocol verbs backed by AgentSession and the shared persisted catalog. */
export class SessionService {
	readonly #session: DesktopAgentSession;
	readonly catalog: SessionCatalogService;
	#promptInFlight = 0;

	constructor(session: DesktopAgentSession, options: SessionServiceOptions = {}) {
		this.#session = session;
		this.catalog = new SessionCatalogService(options.catalog);
	}

	get running(): boolean {
		return (
			this.#promptInFlight > 0 ||
			this.#session.isStreaming ||
			this.#session.isAborting ||
			this.#session.queuedMessageCount > 0
		);
	}

	sendPrompt(text: string, images?: ImageContent[]): Promise<boolean> {
		this.#promptInFlight += 1;
		let prompt: Promise<boolean>;
		try {
			prompt = this.#session.prompt(text, {
				images,
				streamingBehavior: this.#session.isStreaming ? "steer" : undefined,
			});
		} catch (error) {
			this.#promptInFlight -= 1;
			throw error;
		}
		void prompt.then(
			() => {
				this.#promptInFlight -= 1;
			},
			() => {
				this.#promptInFlight -= 1;
			},
		);
		return prompt;
	}

	async abort(): Promise<boolean> {
		const accepted = this.running;
		await this.#session.abort({ reason: USER_INTERRUPT_LABEL });
		return accepted;
	}

	async select(sessionPath: string): Promise<WireSessionSnapshot> {
		const stored = await this.catalog.requireSession(sessionPath);
		const switched = await this.#session.switchSession(stored.path);
		if (!switched) throw new SessionServiceError("SESSION_CANCELLED", "Session selection was cancelled");
		return toWireSessionSnapshot(this.#session.sessionManager.snapshotForReplication());
	}

	async newSession(cwd: string): Promise<DesktopSessionInfo> {
		const resolvedCwd = path.resolve(cwd);
		const created = await this.#session.newSession();
		if (!created) throw new SessionServiceError("SESSION_CANCELLED", "Creating a session was cancelled");
		if (path.resolve(this.#session.sessionManager.getCwd()) !== resolvedCwd)
			await this.#session.moveSession(resolvedCwd);
		await this.#materializeActiveSession();
		return await this.#activeInfo(resolvedCwd);
	}

	async fork(sessionPath: string, entryId?: string): Promise<SessionForkResult> {
		if (this.#session.isStreaming)
			throw new SessionServiceError("SESSION_BUSY", "Wait for the active run to finish before forking");
		const stored = await this.catalog.requireSession(sessionPath);
		const activePath = this.#session.sessionManager.getSessionFile();
		if (!activePath || path.resolve(activePath) !== path.resolve(stored.path)) {
			const switched = await this.#session.switchSession(stored.path);
			if (!switched) throw new SessionServiceError("SESSION_CANCELLED", "Session selection was cancelled");
		}
		if (entryId) {
			const branched = await this.#session.branch(entryId);
			if (!branched.cancelled) await this.#materializeActiveSession();
			return {
				session: await this.#activeInfo(),
				selectedText: branched.selectedText,
				selectedImages: branched.selectedImages,
				cancelled: branched.cancelled,
			};
		}
		const forked = await this.#session.fork();
		if (!forked) throw new SessionServiceError("SESSION_NOT_PERSISTED", "Session fork failed");
		await this.#materializeActiveSession();
		return { session: await this.#activeInfo() };
	}

	async rename(sessionPath: string, title: string): Promise<DesktopSessionInfo> {
		const activePath = this.#session.sessionManager.getSessionFile();
		if (!activePath || path.resolve(activePath) !== path.resolve(sessionPath)) {
			return await this.catalog.rename(sessionPath, title);
		}
		const cleanTitle = normalizeSessionTitle(title);
		const stored = await this.catalog.requireSession(sessionPath);
		const renamed = await this.#session.setSessionName(cleanTitle, "user");
		if (!renamed) throw new SessionServiceError("INVALID_TITLE", "Session title was rejected");
		return await this.catalog.requireDesktopInfo(stored.path);
	}

	async materializeActive(): Promise<DesktopSessionInfo> {
		await this.#materializeActiveSession();
		return await this.#activeInfo();
	}

	async #materializeActiveSession(): Promise<void> {
		await this.#session.sessionManager.ensureOnDisk();
		await this.#session.sessionManager.flush();
	}

	async #activeInfo(cwd?: string): Promise<DesktopSessionInfo> {
		const activePath = this.#session.sessionManager.getSessionFile();
		if (!activePath) throw new SessionServiceError("SESSION_NOT_PERSISTED", "Active session has no persisted path");
		return await this.catalog.requireDesktopInfo(activePath, cwd);
	}
}
