#!/usr/bin/env bun
/**
 * cc-agent: one per developer machine, REST only, no gateway connection.
 *
 * It does three things on a timer. It scans the local chudcode session
 * directory and mirrors what it finds into Discord -- one text channel per
 * session, whose first message is a status embed edited in place forever and
 * whose remaining messages are the running transcript. It heartbeats what it
 * can see onto the bus so the single cc-gateway can answer `/session list` and
 * populate autocomplete. And it executes the bus commands addressed to its own
 * hostname.
 *
 * A channel per session, not a thread per session: a thread hides its content
 * behind a click and a collapsed list, which is the complaint that killed the
 * thread layout. A channel shows up in the sidebar and reads like a log.
 *
 * Three invariants are load-bearing and everything else bends around them:
 *
 *   Create once, edit forever. A restart must reuse the channel and the status
 *   message it already owns, never make a second pair, so mirror state is
 *   persisted under the agent state dir keyed by (host, sessionId) and written
 *   through the moment a channel is created.
 *
 *   Execute at most once. A command id is remembered *before* it runs, not
 *   after. A crash mid-start therefore loses the command; the alternative is
 *   spawning two agents in someone's repo from one Discord click, which is
 *   strictly worse and much harder to notice.
 *
 *   Rename rarely. Discord allows two channel renames per ten minutes and
 *   answers the third with a 429. chudcode retitles a session as it learns what
 *   the work is, so renames are debounced to the latest known title rather than
 *   applied per title change, and stop entirely once a session is finished.
 *
 * Nothing here opens a gateway socket, and nothing here needs the
 * MESSAGE_CONTENT intent: every bus record the agent reads was written by the
 * same bot, which Discord exempts from content blanking.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import {
	type AgentHeartbeat,
	ARCHIVED_SESSION_CHANNEL_PREFIX,
	BUS_PROTOCOL_VERSION,
	CHANNEL_RENAME_MIN_INTERVAL_MS,
	COMMAND_POLL_INTERVAL_MS,
	type CommandOutcome,
	type CommandRecord,
	type CommandResult,
	encodeRecord,
	HEARTBEAT_INTERVAL_MS,
	MAX_MESSAGE_CHARS,
	SESSION_CHANNEL_PREFIX,
	type SessionMirrorState,
	type SessionSnapshot,
	type SessionStatus,
	sessionChannelName,
} from "./bridge-protocol";
import { agentStateDir, Bus, writeStateFile } from "./bus";
import { CATEGORY_IDS, GUILD_ID, inviteUrl, REQUIRED_PERMISSIONS } from "./channels";
import {
	DiscordApiError,
	type DiscordChannel,
	DiscordRest,
	type DiscordRestClient,
	MISSING_PERMISSIONS_CODE,
	messageContentIntentEnabled,
} from "./discord-rest";
import { embedHash, renderSessionEmbed, renderTail } from "./session-render";
import { type ScanOptions, scanSessions } from "./session-scan";

/** A heartbeat carries a working set, not an archive. Older sessions stay reachable as channels. */
export const MAX_HEARTBEAT_SESSIONS = 10;

/**
 * How long a graceful shutdown gets before the process exits regardless.
 *
 * Comfortably under systemd's `TimeoutStopSec=30`, so the deadline fires and the
 * process exits 0 rather than being SIGKILLed and reported as a failure.
 */
export const SHUTDOWN_DEADLINE_MS = 8_000;

/**
 * Mirror-state key. Session ids are unique per machine, not globally, so the
 * host is part of the identity; NUL cannot appear in either half, so the join is
 * unambiguous. Three call sites must agree on this exactly or a restart mirrors
 * a session twice.
 */
export function mirrorKey(host: string, sessionId: string): string {
	return `${host}\u0000${sessionId}`;
}

/**
 * Give an RPC session a useful persisted title before its first token.
 *
 * Interactive mode has a background tiny-model title worker. An RPC host can
 * finish a short turn and stop the child before that worker returns, leaving the
 * session file and Discord channel on an opaque UUID forever. The first prompt
 * is already the user's description of the work, so its first non-empty line is
 * the deterministic provisional title; a later explicit title change still
 * flows through onTitle().
 */
export const MAX_TASK_TITLE_CHARS = 72;

export function sessionTitleFromPrompt(prompt: string): string {
	const first = prompt
		.split(/\r?\n/)
		.map(line => line.trim())
		.find(Boolean);
	const collapsed = (first ?? "New chudcode session")
		.replace(/^#{1,6}\s+/, "")
		.replace(/\s+/g, " ")
		.trim();
	const codePoints = [...collapsed];
	return codePoints.length <= MAX_TASK_TITLE_CHARS
		? collapsed
		: `${codePoints
				.slice(0, MAX_TASK_TITLE_CHARS - 1)
				.join("")
				.replace(/\s+$/g, "")}…`;
}
/** Leaves room under the 2000-char ceiling for Discord's own framing. */
const MAX_TRANSCRIPT_CHARS = 1_800;
const MAX_RESULT_DETAIL_CHARS = 800;
const DEFAULT_TRANSCRIPT_FLUSH_MS = 5_000;
/** A command older than this is audit history. Replaying it on a cold start would be a surprise, not a service. */
const DEFAULT_MAX_COMMAND_AGE_MS = 10 * 60_000;
const TASK_NOT_RUNNING_MESSAGE = "This task is no longer running. Start a new task if you want to continue the work.";

/** Statuses after which a session never changes again, so its channel is frozen and archived. */
const TERMINAL_STATUS: Readonly<Partial<Record<SessionStatus, true>>> = { complete: true, aborted: true, error: true };

/** Bun's `Timer`, Node's `Timeout`, the DOM's number. Named once so the fields below stay readable. */
type TimerHandle = ReturnType<typeof setTimeout>;

export type ScanSessions = (options?: ScanOptions) => Promise<SessionSnapshot[]>;
export type RenderSessionEmbed = (snapshot: SessionSnapshot) => Record<string, unknown>;
export type EmbedHash = (embed: Record<string, unknown>) => string;
export type RenderTail = (snapshot: SessionSnapshot, limit: number) => Promise<string[]>;

// ---------------------------------------------------------------------------
// The RpcClient seam
// ---------------------------------------------------------------------------

/** The structural slice of `AgentEvent` the transcript renderer reads. */
export interface RpcAgentEvent {
	readonly type: string;
	readonly toolName?: string;
	readonly intent?: string;
	readonly isError?: boolean;
	readonly message?: unknown;
}

export interface RpcSessionState {
	readonly sessionId: string;
	readonly sessionFile?: string;
	readonly isStreaming: boolean;
}

/** Exactly what cc-agent drives on a session. Narrow on purpose: this is the whole test seam. */
export interface RpcSessionHandle {
	start(): Promise<void>;
	onEvent(listener: (event: RpcAgentEvent) => void): () => void;
	onTitle(listener: (title: string) => void): () => void;
	prompt(message: string): Promise<void>;
	followUp(message: string): Promise<void>;
	setSessionName(title: string): Promise<void>;
	steer(message: string): Promise<void>;
	abort(): Promise<void>;
	stop(): Promise<void>;
	getState(): Promise<RpcSessionState>;
}

export interface RpcSessionOptions {
	cwd: string;
	model?: string;
	cliPath?: string;
	env?: Record<string, string>;
}

export type RpcSessionFactory = (options: RpcSessionOptions) => Promise<RpcSessionHandle>;

/**
 * Production wiring. Resolve both the runtime and the CLI entry point
 * absolutely: systemd intentionally gives services a small PATH, and the RPC
 * client's default `["bun", "dist/cli.js"]` assumes both a shell-like PATH and
 * a cwd containing a built `dist/`. Neither is true for cc-agent.
 */
export const defaultRpcSessionFactory: RpcSessionFactory = async options => {
	const rpcClientModule = fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client"));
	const cliPath =
		options.cliPath ?? process.env.CC_AGENT_CLI_PATH ?? path.resolve(path.dirname(rpcClientModule), "../../cli.ts");
	const client = new RpcClient({
		cwd: options.cwd,
		model: options.model,
		cliPath,
		command: [process.execPath, cliPath],
		env: { ...options.env, PI_RPC_EMIT_TITLE: "1" },
	});
	return {
		start: () => client.start(),
		onTitle: listener =>
			client.onExtensionUiRequest(request => {
				if (request.method === "setTitle") listener(request.title);
			}),
		// AgentEvent is a closed union; RpcAgentEvent is the open structural read
		// of it. Inference cannot unify the two, and there is nothing to validate:
		// the value came from our own child process.
		onEvent: listener => client.onEvent(event => listener(event as unknown as RpcAgentEvent)),
		prompt: async message => {
			await client.prompt(message);
		},
		followUp: message => client.followUp(message),
		steer: message => client.steer(message),
		setSessionName: title => client.setSessionName(title),
		abort: () => client.abort(),
		stop: () => client.stop(),
		getState: async () => {
			const state = await client.getState();
			return { sessionId: state.sessionId, sessionFile: state.sessionFile, isStreaming: state.isStreaming };
		},
	};
};

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------

/**
 * `SessionMirrorState` plus the name the channel actually carries. Discord will
 * happily accept a rename to the name it already has and spend one of the two
 * allowed renames doing it, so the applied name is worth remembering.
 */
export interface MirrorRecord extends SessionMirrorState {
	readonly channelName: string;
	/** Only Discord-started work belongs in the task UI. */
	readonly createdFromDiscord: boolean;
}

export interface AgentState {
	/** Newest bus message id already scanned. */
	readonly cursor: string | null;
	/** Keyed by `host\0sessionId`. */
	readonly mirrors: Readonly<Record<string, MirrorRecord>>;
}

export interface AgentStateStore {
	read(): Promise<AgentState>;
	write(state: AgentState): Promise<void>;
}

export const EMPTY_AGENT_STATE: AgentState = { cursor: null, mirrors: {} };

export function createFileStateStore(filePath: string): AgentStateStore {
	return {
		async read() {
			let raw: string;
			try {
				raw = await fs.readFile(filePath, "utf8");
			} catch {
				return EMPTY_AGENT_STATE;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				// Losing mirror state costs one duplicate channel per live session.
				// Refusing to start costs the whole bridge.
				return EMPTY_AGENT_STATE;
			}
			if (parsed === null || typeof parsed !== "object") return EMPTY_AGENT_STATE;
			const cursor = "cursor" in parsed && typeof parsed.cursor === "string" ? parsed.cursor : null;
			const stored =
				"mirrors" in parsed && parsed.mirrors !== null && typeof parsed.mirrors === "object" ? parsed.mirrors : {};
			const mirrors: Record<string, MirrorRecord> = {};
			for (const [key, value] of Object.entries(stored)) {
				const record = parseMirrorRecord(value);
				if (record) mirrors[key] = record;
			}
			return { cursor, mirrors };
		},
		async write(state) {
			await writeStateFile(filePath, `${JSON.stringify({ version: 3, ...state }, null, 2)}\n`);
		},
	};
}

function parseMirrorRecord(value: unknown): MirrorRecord | null {
	if (value === null || typeof value !== "object") return null;
	if (!("sessionId" in value) || typeof value.sessionId !== "string") return null;
	if (!("host" in value) || typeof value.host !== "string") return null;
	if (!("channelId" in value) || typeof value.channelId !== "string") return null;
	if (!("statusMessageId" in value) || typeof value.statusMessageId !== "string") return null;
	return {
		sessionId: value.sessionId,
		host: value.host,
		channelId: value.channelId,
		statusMessageId: value.statusMessageId,
		channelName: "channelName" in value && typeof value.channelName === "string" ? value.channelName : "",
		createdFromDiscord:
			"createdFromDiscord" in value && typeof value.createdFromDiscord === "boolean"
				? value.createdFromDiscord
				: false,
		renderHash: "renderHash" in value && typeof value.renderHash === "string" ? value.renderHash : "",
		lastTitle: "lastTitle" in value && typeof value.lastTitle === "string" ? value.lastTitle : null,
		lastRenamedAt: "lastRenamedAt" in value && typeof value.lastRenamedAt === "string" ? value.lastRenamedAt : null,
		lastPostedAt: "lastPostedAt" in value && typeof value.lastPostedAt === "string" ? value.lastPostedAt : "",
	};
}

export class MemoryStateStore implements AgentStateStore {
	state: AgentState = EMPTY_AGENT_STATE;
	writes = 0;

	async read() {
		return structuredClone(this.state);
	}

	async write(state: AgentState) {
		this.writes += 1;
		this.state = structuredClone(state);
	}
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export interface CcAgentOptions {
	bus: Bus;
	rest: DiscordRestClient;
	host?: string;
	guildId?: string;
	/** Category new session channels are created under. Resolved from the guild when omitted. */
	liveCategoryId?: string | null;
	/** Category finished session channels are moved to. Resolved from the guild when omitted. */
	doneCategoryId?: string | null;
	/** Included in the re-invite hint when the bot is missing MANAGE_CHANNELS. */
	applicationId?: string;
	/** Absolute directories a `new`/`start` may run in. Defaults to `CC_AGENT_PROJECT_ROOTS`, then $HOME. */
	projectRoots?: readonly string[];
	chudcodeVersion?: string;
	stateStore?: AgentStateStore;
	scan?: ScanSessions;
	renderEmbed?: RenderSessionEmbed;
	hashEmbed?: EmbedHash;
	tail?: RenderTail;
	rpc?: RpcSessionFactory;
	now?: () => Date;
	transcriptFlushMs?: number;
	maxCommandAgeMs?: number;
	logger?: (message: string) => void;
}

interface RunningSession {
	readonly sessionId: string;
	readonly command: CommandRecord;
	readonly client: RpcSessionHandle;
	readonly transcript: TranscriptBuffer;
	readonly channelId: string;
	readonly snapshot: SessionSnapshot;
	unsubscribe: () => void;
}

interface SessionCategories {
	readonly live: string | null;
	readonly done: string | null;
}

export class CcAgent {
	readonly host: string;
	readonly projectRoots: readonly string[];

	readonly #bus: Bus;
	readonly #rest: DiscordRestClient;
	readonly #guildId: string;
	readonly #applicationId: string | null;
	readonly #chudcodeVersion: string;
	readonly #store: AgentStateStore;
	readonly #scan: ScanSessions;
	readonly #renderEmbed: RenderSessionEmbed;
	readonly #hashEmbed: EmbedHash;
	readonly #tail: RenderTail;
	readonly #rpc: RpcSessionFactory;
	readonly #now: () => Date;
	readonly #transcriptFlushMs: number;
	readonly #maxCommandAgeMs: number;
	readonly #log: (message: string) => void;

	readonly #sessions = new Map<string, RunningSession>();
	readonly #inFlight = new Set<Promise<void>>();
	#configuredCategories: SessionCategories | null;
	#categories: Promise<SessionCategories> | undefined;
	#state: AgentState = EMPTY_AGENT_STATE;
	#loaded: Promise<void> | undefined;
	#sequence = 0;
	#timers: TimerHandle[] = [];
	#signalHandlers: Array<{ signal: NodeJS.Signals; handler: () => void }> = [];
	#stopping: Promise<void> | undefined;

	constructor(options: CcAgentOptions) {
		this.host = options.host ?? os.hostname();
		this.projectRoots = options.projectRoots ?? projectRootsFromEnv();
		this.#bus = options.bus;
		this.#rest = options.rest;
		this.#guildId = options.guildId ?? GUILD_ID;
		this.#applicationId = options.applicationId ?? null;
		this.#chudcodeVersion = options.chudcodeVersion ?? "unknown";
		this.#store = options.stateStore ?? createFileStateStore(path.join(agentStateDir(), "agent-state.json"));
		this.#scan = options.scan ?? scanSessions;
		this.#renderEmbed = options.renderEmbed ?? renderSessionEmbed;
		this.#hashEmbed = options.hashEmbed ?? embedHash;
		this.#tail = options.tail ?? renderTail;
		this.#rpc = options.rpc ?? defaultRpcSessionFactory;
		this.#now = options.now ?? (() => new Date());
		this.#transcriptFlushMs = options.transcriptFlushMs ?? DEFAULT_TRANSCRIPT_FLUSH_MS;
		this.#maxCommandAgeMs = options.maxCommandAgeMs ?? DEFAULT_MAX_COMMAND_AGE_MS;
		this.#log = options.logger ?? (message => process.stderr.write(`[cc-agent] ${message}\n`));
		this.#configuredCategories =
			options.liveCategoryId === undefined && options.doneCategoryId === undefined
				? null
				: { live: options.liveCategoryId ?? null, done: options.doneCategoryId ?? null };
	}

	async ready(): Promise<void> {
		this.#loaded ??= (async () => {
			await this.#bus.ready();
			this.#state = await this.#store.read();
			if (Object.keys(this.#state.mirrors).length === 0) await this.#recoverMirrors();
			if (this.#bus.usingSessionsFallback) {
				this.#log(
					`no CC_BUS_CHANNEL_ID set; sharing #sessions (${this.#bus.channelId}) until provisioning creates the bus channel`,
				);
			}
		})();
		return this.#loaded;
	}

	/** One scan feeding both the mirror and the heartbeat, so the two never disagree. */
	async tick(): Promise<readonly SessionSnapshot[]> {
		await this.ready();
		const snapshots = await this.#scan({ host: this.host });
		await this.mirror(this.mirrorable(snapshots));
		await this.publishHeartbeat(snapshots);
		return snapshots;
	}

	/**
	 * Only work started through Discord belongs in Discord.
	 *
	 * The old age/title heuristic mirrored every recent local chudcode session
	 * and filled the guild with channels that had one technical status card and
	 * no transcript. A persisted Discord-origin bit is the actual boundary.
	 */
	mirrorable(snapshots: readonly SessionSnapshot[]): readonly SessionSnapshot[] {
		return snapshots.filter(snapshot => {
			const existing = this.#state.mirrors[mirrorKey(snapshot.host, snapshot.sessionId)];
			if (existing) return existing.createdFromDiscord;
			return snapshot.originCommandId !== null;
		});
	}

	async publishHeartbeat(snapshots: readonly SessionSnapshot[]): Promise<AgentHeartbeat> {
		await this.ready();
		const heartbeat = this.buildHeartbeat(snapshots);
		await this.#bus.publish(heartbeat);
		return heartbeat;
	}

	/**
	 * Shrinks until it fits rather than throwing: an agent that goes silent
	 * because one session had a chatty last message is an agent that looks
	 * offline. `lastText` goes first because the session channel already has it.
	 */
	buildHeartbeat(snapshots: readonly SessionSnapshot[]): AgentHeartbeat {
		const idTimestamp = this.#now().getTime().toString(36);
		this.#sequence += 1;
		const base = {
			kind: "agent.heartbeat",
			v: BUS_PROTOCOL_VERSION,
			id: `hb-${this.host}-${idTimestamp}-${this.#sequence.toString(36)}`,
			host: this.host,
			projects: this.projectRoots,
			chudcodeVersion: this.#chudcodeVersion,
			sentAt: this.#now().toISOString(),
		} as const;
		let sessions = snapshots
			.map(snapshot => {
				if (snapshot.channelId) return snapshot;
				const record = this.#state.mirrors[mirrorKey(snapshot.host, snapshot.sessionId)];
				return record?.createdFromDiscord ? { ...snapshot, channelId: record.channelId } : snapshot;
			})
			.filter(snapshot => snapshot.channelId !== null)
			.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
			.slice(0, MAX_HEARTBEAT_SESSIONS);
		let strippedText = false;
		for (;;) {
			const heartbeat: AgentHeartbeat = { ...base, sessions };
			try {
				encodeRecord(heartbeat);
				return heartbeat;
			} catch {
				if (!strippedText) {
					sessions = sessions.map(snapshot => ({ ...snapshot, lastText: null }));
					strippedText = true;
					continue;
				}
				if (sessions.length === 0) {
					throw new Error(`heartbeat for ${this.host} cannot be encoded under ${MAX_MESSAGE_CHARS} chars`);
				}
				sessions = sessions.slice(0, -1);
			}
		}
	}

	async mirror(snapshots: readonly SessionSnapshot[]): Promise<void> {
		await this.ready();
		for (const snapshot of snapshots) {
			try {
				await this.#mirrorOne(snapshot);
			} catch (error) {
				// One unmirrorable session must not stop the others, and the next
				// tick retries it.
				this.#log(`could not mirror ${snapshot.sessionId}: ${describeError(error)}`);
			}
		}
	}

	async pollCommands(): Promise<number> {
		await this.ready();
		const page = await this.#bus.poll({ after: this.#state.cursor ?? undefined });
		if (page.blindBotMessages > 0) {
			this.#log(
				`${page.blindBotMessages} bot-authored bus message(s) came back with empty content: the app can no longer read its own records, so commands are being dropped. Check the MESSAGE_CONTENT intent.`,
			);
		}
		if (page.after && page.after !== this.#state.cursor) {
			this.#state = { ...this.#state, cursor: page.after };
			await this.#store.write(this.#state);
		}

		let executed = 0;
		for (const entry of page.records) {
			const command = entry.record;
			if (command.kind !== "command" || command.host !== this.host) continue;
			if (this.#bus.seen(command.id)) continue;
			const age = this.#now().getTime() - Date.parse(command.issuedAt);
			if (Number.isFinite(age) && age > this.#maxCommandAgeMs) {
				this.#log(`ignoring ${command.name} ${command.id}: issued ${Math.round(age / 1000)}s ago`);
				continue;
			}
			// Remembered before it runs, so a crash loses the command instead of
			// duplicating its effect on the next poll.
			await this.#bus.remember(command.id);
			executed += 1;
			await this.#execute(command);
		}
		return executed;
	}

	/** Resolves once every transcript flush and session-completion callback has settled. */
	async drain(): Promise<void> {
		for (;;) {
			const pending = [
				...this.#inFlight,
				...[...this.#sessions.values()].map(session => session.transcript.drain()),
			];
			if (pending.length === 0) return;
			await Promise.allSettled(pending);
			if (this.#inFlight.size === 0) return;
		}
	}

	/** Daemon entry: timers plus signal handling. Tests drive `tick`/`pollCommands` directly. */
	async start(): Promise<void> {
		// Signals first, before any await. The first tick creates and edits channels
		// and can take seconds against a real guild; registering afterwards leaves a
		// window where SIGTERM hits the default disposition and the process dies
		// having skipped shutdown entirely.
		for (const signal of ["SIGINT", "SIGTERM"] as const) {
			const handler = () => {
				// A second signal now hits the default disposition, which is the right
				// escape hatch for "stop now".
				process.removeAllListeners(signal);
				this.#signalHandlers = [];

				// Exit is guaranteed by a deadline, not by shutdown finishing.
				// `shutdown` awaits every in-flight tick and then a bus publish,
				// none of which is bounded, so a slow tick or a rate-limited POST
				// left the process alive indefinitely with `process.exit(0)`
				// unreachable. Best-effort cleanup, hard bound, always exit.
				//
				// The timer is deliberately NOT unref'd. `shutdown` clears the two
				// intervals, so once they are gone an unref'd timer leaves nothing
				// holding the event loop open: it drains, and Bun exits
				// 128+SIGTERM=143 before either branch of the race resolves --
				// which systemd reports as `code=exited, status=143` and calls the
				// unit failed. Holding a ref keeps the process alive precisely long
				// enough to exit 0 on purpose.
				const deadline = new Promise<void>(resolve => {
					setTimeout(() => {
						this.#log(`shutdown did not finish within ${SHUTDOWN_DEADLINE_MS}ms; exiting anyway`);
						resolve();
					}, SHUTDOWN_DEADLINE_MS);
				});
				void Promise.race([
					this.shutdown(signal).catch(error => this.#log(`shutdown failed: ${describeError(error)}`)),
					deadline,
				]).then(() => process.exit(0));
			};
			process.on(signal, handler);
			this.#signalHandlers.push({ signal, handler });
		}
		await this.ready();
		await this.tick();
		this.#timers = [
			setInterval(() => {
				this.#track(this.tick());
			}, HEARTBEAT_INTERVAL_MS),
			setInterval(() => {
				this.#track(this.pollCommands());
			}, COMMAND_POLL_INTERVAL_MS),
		];
	}

	/**
	 * Abort what is in flight, say so in each session channel, then publish an
	 * empty heartbeat so `/session list` reports this host as carrying nothing
	 * rather than leaving stale sessions to age out over the staleness window.
	 */
	async shutdown(reason: string): Promise<void> {
		this.#stopping ??= (async () => {
			for (const timer of this.#timers) clearInterval(timer);
			this.#timers = [];
			for (const { signal, handler } of this.#signalHandlers) process.off(signal, handler);
			this.#signalHandlers = [];

			for (const session of [...this.#sessions.values()]) {
				session.unsubscribe();
				try {
					await session.client.abort();
					await session.client.stop();
				} catch (error) {
					this.#log(`could not stop ${session.sessionId}: ${describeError(error)}`);
				}
				session.transcript.push(`🛑 agent on ${this.host} shut down (${reason})`);
				await session.transcript.drain();
				await this.#publishResult(session.command, "failed", `agent on ${this.host} shut down (${reason})`, {
					sessionId: session.sessionId,
					channelId: session.channelId,
				});
			}
			this.#sessions.clear();
			await Promise.allSettled(this.#inFlight);
			await this.#bus.publish(this.buildHeartbeat([]));
		})();
		return this.#stopping;
	}

	// -- mirroring -----------------------------------------------------------

	async #mirrorOne(snapshot: SessionSnapshot): Promise<MirrorRecord> {
		const key = mirrorKey(snapshot.host, snapshot.sessionId);
		const embed = this.#renderEmbed(snapshot);
		const hash = this.#hashEmbed(embed);
		const existing = this.#state.mirrors[key];
		if (!existing) return this.#createSessionChannel(key, snapshot, embed, hash);

		let record = existing;
		if (record.renderHash !== hash) {
			await this.#rest.editMessage(record.channelId, record.statusMessageId, { embeds: [embed] });
			record = { ...record, renderHash: hash, lastPostedAt: this.#now().toISOString() };
			await this.#persist(key, record);
		}
		return this.#renameIfDue(key, snapshot, record);
	}

	async #createSessionChannel(
		key: string,
		snapshot: SessionSnapshot,
		embed: Record<string, unknown>,
		hash: string,
	): Promise<MirrorRecord> {
		const categories = await this.#resolveCategories();
		const name = sessionChannelName(snapshot.title, snapshot.sessionId);
		let channelId: string;
		try {
			const channel = await this.#rest.createChannel(this.#guildId, {
				name,
				parentId: categories.live,
				topic: sessionTopic(snapshot),
			});
			channelId = channel.id;
		} catch (error) {
			if (error instanceof DiscordApiError && error.code === MISSING_PERMISSIONS_CODE) {
				throw new Error(
					missingChannelPermissionMessage(`creating a channel for ${snapshot.sessionId}`, this.#applicationId),
				);
			}
			throw error;
		}
		const status = await this.#rest.createMessage(channelId, { embeds: [embed] });
		if (snapshot.originCommandId) {
			await this.#rest.createMessage(channelId, { content: taskChannelIntro(snapshot) });
		}
		const now = this.#now().toISOString();
		const record: MirrorRecord = {
			sessionId: snapshot.sessionId,
			host: snapshot.host,
			channelId,
			statusMessageId: status.id,
			channelName: name,
			createdFromDiscord: snapshot.originCommandId !== null,
			renderHash: hash,
			lastTitle: snapshot.title,
			// Creating a channel does not spend a rename, so the first real title is
			// free. Renames at t+0 and t+6min keep every 10-minute window at two.
			lastRenamedAt: null,
			lastPostedAt: now,
		};
		// Written through, not batched: the window between creating the channel
		// and recording it is exactly the window in which a crash duplicates it.
		await this.#persist(key, record);
		return record;
	}

	/**
	 * Rebuilds the mirror map from the guild when the state file is gone.
	 * The channel topic carries the session id and host, so Discord is its own
	 * backup: without this, one lost state file silently reposts a second
	 * channel for every live session, which is precisely what create-once
	 * exists to prevent.
	 */
	async #recoverMirrors(): Promise<void> {
		let channels: DiscordChannel[];
		try {
			channels = await this.#rest.getGuildChannels(this.#guildId);
		} catch (error) {
			this.#log(`could not scan the guild for existing session channels: ${describeError(error)}`);
			return;
		}
		const now = this.#now().toISOString();
		const mirrors: Record<string, MirrorRecord> = {};
		for (const channel of channels) {
			const origin = parseSessionTopic(channel.topic);
			if (!origin || origin.host !== this.host) continue;
			let statusMessageId: string;
			try {
				// `after: "0"` is every message in the channel, oldest first: the
				// status embed is by construction the first one posted.
				const [oldest] = await this.#rest.getMessages(channel.id, { after: "0", limit: 1 });
				if (!oldest) continue;
				statusMessageId = oldest.id;
			} catch (error) {
				this.#log(`could not recover the status message in ${channel.name ?? channel.id}: ${describeError(error)}`);
				continue;
			}
			mirrors[mirrorKey(this.host, origin.sessionId)] = {
				sessionId: origin.sessionId,
				host: this.host,
				channelId: channel.id,
				statusMessageId,
				channelName: channel.name ?? "",
				createdFromDiscord:
					(channel.name ?? "").startsWith(SESSION_CHANNEL_PREFIX) ||
					(channel.name ?? "").startsWith(ARCHIVED_SESSION_CHANNEL_PREFIX),
				// Unknown, so the next tick edits once and resyncs. One redundant
				// edit beats trusting a hash nobody wrote down.
				renderHash: "",
				lastTitle: null,
				// The agent that made this channel may have renamed it seconds ago.
				// Start a fresh window rather than risk being the third rename.
				lastRenamedAt: now,
				lastPostedAt: now,
			};
		}
		const recovered = Object.keys(mirrors).length;
		if (recovered === 0) return;
		this.#state = { ...this.#state, mirrors };
		await this.#store.write(this.#state);
		this.#log(`recovered ${recovered} session channel(s) from the guild after starting with no mirror state`);
	}

	/**
	 * Two renames per ten minutes, enforced by Discord with a 429 that looks like
	 * a transient blip. Debouncing to the latest known title means a burst of
	 * retitles costs one rename, and a finished session's channel is frozen after
	 * its single move into the archive category.
	 */
	async #renameIfDue(key: string, snapshot: SessionSnapshot, record: MirrorRecord): Promise<MirrorRecord> {
		if (record.channelName.startsWith(ARCHIVED_SESSION_CHANNEL_PREFIX)) return record;
		const terminal = TERMINAL_STATUS[snapshot.status] === true;
		const live = sessionChannelName(snapshot.title, snapshot.sessionId);
		const desired = terminal
			? `${ARCHIVED_SESSION_CHANNEL_PREFIX}${live.slice(SESSION_CHANNEL_PREFIX.length)}`
			: live;
		if (desired === record.channelName) return record;

		const sinceLast = record.lastRenamedAt
			? this.#now().getTime() - Date.parse(record.lastRenamedAt)
			: Number.POSITIVE_INFINITY;
		if (sinceLast < CHANNEL_RENAME_MIN_INTERVAL_MS) return record;

		const categories = await this.#resolveCategories();
		try {
			await this.#rest.modifyChannel(record.channelId, {
				name: desired,
				...(terminal && categories.done ? { parentId: categories.done } : {}),
			});
		} catch (error) {
			if (error instanceof DiscordApiError && error.code === MISSING_PERMISSIONS_CODE) {
				throw new Error(missingChannelPermissionMessage(`renaming ${record.channelName}`, this.#applicationId));
			}
			throw error;
		}
		const renamed: MirrorRecord = {
			...record,
			channelName: desired,
			lastTitle: snapshot.title,
			lastRenamedAt: this.#now().toISOString(),
		};
		await this.#persist(key, renamed);
		return renamed;
	}

	async #persist(key: string, record: MirrorRecord): Promise<void> {
		this.#state = { ...this.#state, mirrors: { ...this.#state.mirrors, [key]: record } };
		await this.#store.write(this.#state);
	}

	/**
	 * Where session channels are parented.
	 *
	 * `CC_LIVE_CATEGORY_ID` / `CC_DONE_CATEGORY_ID` win, then the ids recorded in
	 * channels.ts. There used to be a third step -- look the categories up by
	 * name -- because provision creates them and their ids were unknown at author
	 * time. They exist now and their ids are recorded, so that step became
	 * unreachable and is gone rather than left as a path nothing can exercise.
	 * A rename in Discord no longer strands new session channels at the top level.
	 */
	async #resolveCategories(): Promise<SessionCategories> {
		if (this.#configuredCategories) return this.#configuredCategories;
		this.#categories ??= Promise.resolve({
			live: process.env.CC_LIVE_CATEGORY_ID?.trim() || CATEGORY_IDS.liveSessions,
			done: process.env.CC_DONE_CATEGORY_ID?.trim() || CATEGORY_IDS.doneSessions,
		});
		return this.#categories;
	}

	// -- command execution ---------------------------------------------------

	async #execute(command: CommandRecord): Promise<void> {
		try {
			switch (command.name) {
				case "new":
				case "start":
					await this.#executeNew(command);
					return;
				case "say":
					await this.#executeSay(command);
					return;
				case "interrupt":
				case "stop":
					await this.#executeLifecycle(command);
					return;
				case "tail":
					await this.#executeTail(command);
					return;
				default:
					await this.#publishResult(command, "rejected", `unknown command ${String(command.name)}`, {});
			}
		} catch (error) {
			await this.#publishResult(command, "failed", describeError(error), { sessionId: command.sessionId });
		}
	}

	async #executeNew(command: CommandRecord): Promise<void> {
		const prompt = command.prompt?.trim();
		if (!prompt) {
			await this.#publishResult(command, "rejected", "a new session needs a prompt", {});
			return;
		}
		if (!command.cwd) {
			await this.#publishResult(command, "rejected", "a new session needs a project directory", {});
			return;
		}
		const allowed = await this.#resolveAllowedCwd(command.cwd);
		if (!allowed.ok) {
			await this.#publishResult(command, "rejected", allowed.reason, {});
			return;
		}

		const client = await this.#rpc({ cwd: allowed.cwd, model: command.model ?? undefined });
		await client.start();
		const initialTitle = sessionTitleFromPrompt(prompt);
		await client.setSessionName(initialTitle);
		const state = await client.getState();
		const sessionId = state.sessionId;

		// The channel exists before the first token, so the transcript has a home
		// and the scan loop adopts this channel instead of creating a rival.
		const now = this.#now().toISOString();
		const initialSnapshot: SessionSnapshot = {
			sessionId,
			host: this.host,
			sessionFile: state.sessionFile ?? "",
			cwd: allowed.cwd,
			// The scan corrects this to the repo-relative label on the next tick.
			project: path.basename(allowed.cwd),
			title: initialTitle,
			model: command.model,
			status: "running",
			startedAt: now,
			updatedAt: now,
			messageCount: 0,
			costUsd: null,
			tokensIn: null,
			tokensOut: null,
			lastTool: null,
			lastText: prompt.slice(0, 160),
			originCommandId: command.id,
			requestedBy: command.requestedBy,
			channelId: command.channelId,
		};
		let mirror: MirrorRecord;
		try {
			mirror = await this.#adoptChannel(command, initialSnapshot);
		} catch (error) {
			await client.stop();
			await this.#publishResult(command, "failed", describeError(error), { sessionId });
			return;
		}

		await this.#publishResult(command, "accepted", "Task channel ready.", {
			sessionId,
			channelId: mirror.channelId,
		});

		const transcript = new TranscriptBuffer(
			text => this.#rest.createMessage(mirror.channelId, { content: text }).then(() => undefined),
			this.#transcriptFlushMs,
			error => this.#log(`transcript flush failed for ${sessionId}: ${describeError(error)}`),
		);
		const session: RunningSession = {
			sessionId,
			command,
			client,
			transcript,
			snapshot: initialSnapshot,
			channelId: mirror.channelId,
			unsubscribe: () => {},
		};
		this.#sessions.set(sessionId, session);
		const unsubscribeEvent = client.onEvent(event => {
			const line = describeEvent(event);
			if (line) transcript.push(line);
			if (event.type === "agent_end") this.#track(this.#finish(session, "done", "Task finished."));
		});

		// Title generation happens inside chudcode after the prompt starts. RPC
		// suppresses UI title events by default, so the production factory opts
		// in and this listener makes the Discord channel follow the title the
		// session itself chose. Serialising the callbacks matters: two title
		// updates can otherwise both observe lastRenamedAt=null and spend both
		// rename slots at once.
		const key = mirrorKey(this.host, sessionId);
		let titleQueue = Promise.resolve();
		const unsubscribeTitle = client.onTitle(title => {
			const clean = title.trim();
			if (!clean) return;
			titleQueue = titleQueue.then(async () => {
				mirror = await this.#renameIfDue(
					key,
					{ ...initialSnapshot, title: clean, updatedAt: this.#now().toISOString() },
					mirror,
				);
			});
			this.#track(titleQueue);
		});
		session.unsubscribe = () => {
			unsubscribeEvent();
			unsubscribeTitle();
		};

		transcript.push(`**Task started by <@${command.requestedBy}>**\n${prompt.slice(0, 600)}`);
		await client.prompt(prompt);
	}

	/** `new` creates the channel; `start` streams into one the gateway already has. */
	async #adoptChannel(command: CommandRecord, snapshot: SessionSnapshot): Promise<MirrorRecord> {
		const key = mirrorKey(snapshot.host, snapshot.sessionId);
		const existing = this.#state.mirrors[key];
		if (existing) return existing;
		const embed = this.#renderEmbed(snapshot);
		const hash = this.#hashEmbed(embed);
		if (!command.channelId) return this.#createSessionChannel(key, snapshot, embed, hash);
		const status = await this.#rest.createMessage(command.channelId, { embeds: [embed] });
		const now = this.#now().toISOString();
		const record: MirrorRecord = {
			sessionId: snapshot.sessionId,
			host: snapshot.host,
			channelId: command.channelId,
			statusMessageId: status.id,
			channelName: sessionChannelName(snapshot.title, snapshot.sessionId),
			createdFromDiscord: true,
			renderHash: hash,
			lastTitle: snapshot.title,
			lastRenamedAt: null,
			lastPostedAt: now,
		};
		await this.#persist(key, record);
		return record;
	}

	async #executeSay(command: CommandRecord): Promise<void> {
		const message = command.prompt?.trim();
		if (!message) {
			await this.#publishResult(command, "rejected", "Add the direction you want the task to follow.", {
				sessionId: command.sessionId,
			});
			return;
		}
		const session = command.sessionId ? this.#sessions.get(command.sessionId) : undefined;
		if (!session) {
			await this.#publishResult(command, "rejected", TASK_NOT_RUNNING_MESSAGE, {
				sessionId: command.sessionId,
			});
			return;
		}
		// A turn already in flight takes a follow-up, which queues; prompt would be
		// rejected by the session as a concurrent turn.
		const state = await session.client.getState();
		if (state.isStreaming) await session.client.followUp(message);
		else await session.client.prompt(message);
		session.transcript.push(`**New direction from <@${command.requestedBy}>**\n${message.slice(0, 600)}`);
		await this.#publishResult(
			command,
			"accepted",
			state.isStreaming ? "Direction queued for the current task." : "Direction sent to the task.",
			{
				sessionId: session.sessionId,
				channelId: session.channelId,
			},
		);
	}

	async #executeLifecycle(command: CommandRecord): Promise<void> {
		const session = command.sessionId ? this.#sessions.get(command.sessionId) : undefined;
		if (!session) {
			await this.#publishResult(command, "rejected", TASK_NOT_RUNNING_MESSAGE, {
				sessionId: command.sessionId,
			});
			return;
		}
		if (command.name === "interrupt") {
			await session.client.abort();
			try {
				await this.#mirrorOne({
					...session.snapshot,
					status: "interrupted",
					updatedAt: this.#now().toISOString(),
					lastText: "Current work paused by a teammate.",
					channelId: session.channelId,
				});
			} catch (error) {
				this.#log(`could not update the paused task status for ${session.sessionId}: ${describeError(error)}`);
			}
			session.transcript.push(`**Current work paused by <@${command.requestedBy}>**`);
			await this.#publishResult(command, "done", "Current work paused. The task channel remains available.", {
				sessionId: session.sessionId,
				channelId: session.channelId,
			});
			return;
		}
		session.unsubscribe();
		await session.client.stop();
		this.#sessions.delete(session.sessionId);
		session.transcript.push(`**Task stopped by <@${command.requestedBy}>**`);
		try {
			await this.#mirrorOne({
				...session.snapshot,
				status: "aborted",
				updatedAt: this.#now().toISOString(),
				lastText: "Task stopped by a teammate.",
				channelId: session.channelId,
			});
		} catch (error) {
			this.#log(`could not archive the stopped task ${session.sessionId}: ${describeError(error)}`);
		}
		await session.transcript.drain();
		await this.#publishResult(command, "done", "Task stopped.", {
			sessionId: session.sessionId,
			channelId: session.channelId,
		});
	}

	async #executeTail(command: CommandRecord): Promise<void> {
		if (!command.sessionId) {
			await this.#publishResult(command, "rejected", "Choose a task before requesting its transcript.", {});
			return;
		}
		const snapshots = await this.#scan({ host: this.host });
		const snapshot = snapshots.find(candidate => candidate.sessionId === command.sessionId);
		if (!snapshot) {
			await this.#publishResult(command, "rejected", "That task is no longer available on this machine.", {
				sessionId: command.sessionId,
			});
			return;
		}
		const mirror = await this.#mirrorOne(snapshot);
		const lines = await this.#tail(snapshot, Math.min(Math.max(command.lines ?? 5, 1), 25));
		if (lines.length === 0) {
			await this.#publishResult(command, "done", "No conversation has been recorded for this task yet.", {
				sessionId: snapshot.sessionId,
				channelId: mirror.channelId,
			});
			return;
		}
		for (const chunk of chunkLines(lines, MAX_TRANSCRIPT_CHARS)) {
			await this.#rest.createMessage(mirror.channelId, { content: chunk });
		}
		await this.#publishResult(command, "done", `Posted ${lines.length} transcript section(s).`, {
			sessionId: snapshot.sessionId,
			channelId: mirror.channelId,
		});
	}

	async #finish(session: RunningSession, outcome: CommandOutcome, detail: string): Promise<void> {
		if (!this.#sessions.has(session.sessionId)) return;
		this.#sessions.delete(session.sessionId);
		session.transcript.push(
			"**Task finished**\nThe agent completed the requested work. The latest summary is above.",
		);
		session.unsubscribe();
		await session.transcript.drain();
		try {
			await session.client.stop();
		} catch (error) {
			this.#log(`could not stop ${session.sessionId}: ${describeError(error)}`);
		}
		await this.#publishResult(session.command, outcome, detail, {
			sessionId: session.sessionId,
			channelId: session.channelId,
		});
	}

	// -- helpers -------------------------------------------------------------

	async #resolveAllowedCwd(candidate: string): Promise<{ ok: true; cwd: string } | { ok: false; reason: string }> {
		let resolved: string;
		try {
			// realpath, not resolve: a symlink inside an allowlisted root that points
			// at /etc must not smuggle the agent out of the allowlist.
			resolved = await fs.realpath(path.resolve(candidate));
		} catch {
			return { ok: false, reason: `${candidate} does not exist on ${this.host}` };
		}
		if (!(await fs.stat(resolved)).isDirectory()) return { ok: false, reason: `${candidate} is not a directory` };
		for (const root of this.projectRoots) {
			let resolvedRoot: string;
			try {
				resolvedRoot = await fs.realpath(path.resolve(root));
			} catch {
				continue;
			}
			const relative = path.relative(resolvedRoot, resolved);
			if (
				relative === "" ||
				(!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
			) {
				return { ok: true, cwd: resolved };
			}
		}
		return {
			ok: false,
			reason: `${candidate} is outside the project roots allowed on ${this.host} (${this.projectRoots.join(", ")})`,
		};
	}

	async #publishResult(
		command: CommandRecord,
		outcome: CommandOutcome,
		detail: string,
		target: { sessionId?: string | null; channelId?: string | null },
	): Promise<void> {
		const resultIdPrefix = `${command.id}:${outcome}:`;
		this.#sequence += 1;
		const result: CommandResult = {
			kind: "command.result",
			v: BUS_PROTOCOL_VERSION,
			id: `${resultIdPrefix}${this.#sequence.toString(36)}`,
			commandId: command.id,
			host: this.host,
			outcome,
			detail: detail.slice(0, MAX_RESULT_DETAIL_CHARS),
			sessionId: target.sessionId ?? null,
			channelId: target.channelId ?? null,
			completedAt: this.#now().toISOString(),
		};
		try {
			await this.#bus.publish(result);
		} catch (error) {
			this.#log(`could not publish ${outcome} for ${command.id}: ${describeError(error)}`);
		}
	}

	#track(work: Promise<unknown>): void {
		const tracked = work.then(
			() => undefined,
			error => {
				this.#log(describeError(error));
			},
		);
		this.#inFlight.add(tracked);
		void tracked.finally(() => this.#inFlight.delete(tracked));
	}
}

// ---------------------------------------------------------------------------
// Transcript batching
// ---------------------------------------------------------------------------

/**
 * Coalesces agent events into at most one channel message per window. An
 * unbatched stream would burn the channel's rate limit inside one turn.
 */
export class TranscriptBuffer {
	#lines: string[] = [];
	#timer: TimerHandle | undefined;
	#queue: Promise<void> = Promise.resolve();

	constructor(
		private readonly flush: (text: string) => Promise<void>,
		private readonly delayMs: number,
		private readonly onError: (error: unknown) => void,
	) {}

	push(line: string): void {
		if (line.length === 0) return;
		this.#lines.push(line);
		this.#schedule();
	}

	#schedule(): void {
		if (this.#timer) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.drain();
		}, this.delayMs);
		this.#timer.unref?.();
	}

	drain(): Promise<void> {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		this.#queue = this.#queue.then(async () => {
			const pending = this.#lines;
			if (pending.length === 0) return;
			this.#lines = [];
			const chunks = chunkLines(pending, MAX_TRANSCRIPT_CHARS);
			let next = 0;
			try {
				for (; next < chunks.length; next += 1) await this.flush(chunks[next]);
			} catch (error) {
				// Session JSONL remains authoritative, but the live channel must not
				// silently lose an update because one Discord request failed.
				this.#lines = [...chunks.slice(next), ...this.#lines];
				this.onError(error);
				this.#schedule();
			}
		});
		return this.#queue;
	}
}

export function chunkLines(lines: readonly string[], limit: number): string[] {
	const chunks: string[] = [];
	let current = "";
	for (const line of lines) {
		for (let rest = line; rest.length > 0;) {
			const piece = rest.slice(0, limit);
			rest = rest.slice(limit);
			if (current.length > 0 && current.length + 1 + piece.length > limit) {
				chunks.push(current);
				current = "";
			}
			current = current.length > 0 ? `${current}\n${piece}` : piece;
		}
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

/** Null for events a human reading a session channel would not care about. */
export function describeEvent(event: RpcAgentEvent): string | null {
	switch (event.type) {
		case "tool_execution_start": {
			const intent = event.intent?.trim();
			return intent ? `**Working on**\n${intent}` : null;
		}
		case "tool_execution_end":
			return event.isError
				? "**Needs attention**\nA work step failed. The agent will report whether it can continue."
				: null;
		case "message_end": {
			const text = assistantText(event.message);
			return text ? `**Agent update**\n${text}` : null;
		}
		default:
			return null;
	}
}

function assistantText(message: unknown): string | null {
	if (message === null || typeof message !== "object") return null;
	if (!("role" in message) || message.role !== "assistant") return null;
	if (!("content" in message) || !Array.isArray(message.content)) return null;
	const parts: string[] = [];
	for (const part of message.content) {
		if (part === null || typeof part !== "object") continue;
		if (!("type" in part) || part.type !== "text") continue;
		if ("text" in part && typeof part.text === "string") parts.push(part.text);
	}
	const text = parts.join("").trim();
	return text.length > 0 ? text : null;
}

/**
 * The channel topic doubles as the recovery record for {@link CcAgent}, so the
 * writer and the reader live next to each other and cannot drift. Session id
 * and host come first and are whitespace-free; the free-form project label goes
 * last where it cannot confuse the parse.
 */
export function sessionTopic(snapshot: SessionSnapshot): string {
	return `chudcode session ${snapshot.sessionId} on ${snapshot.host} · ${snapshot.project}`;
}

export function taskChannelIntro(snapshot: SessionSnapshot): string {
	const requester = snapshot.requestedBy ? `<@${snapshot.requestedBy}>` : "A teammate";
	const goal = snapshot.lastText?.trim() || snapshot.title?.trim() || "No goal was recorded.";
	return `**Task controls**
${requester} started this task.

**Goal**
${goal.slice(0, 800)}

Reply normally in this channel to change direction while the task is working.
Use \`/task status\`, \`/task transcript\`, \`/task pause\`, or \`/task stop\` for explicit controls.`;
}

const SESSION_TOPIC_PATTERN = /^chudcode session (\S+) on (\S+)(?: |$)/;

export function parseSessionTopic(topic: string | null | undefined): { sessionId: string; host: string } | null {
	const match = topic?.match(SESSION_TOPIC_PATTERN);
	return match?.[1] && match[2] ? { sessionId: match[1], host: match[2] } : null;
}

export function projectRootsFromEnv(value: string | undefined = process.env.CC_AGENT_PROJECT_ROOTS): readonly string[] {
	const configured = (value ?? "")
		.split(":")
		.map(part => part.trim())
		.filter(part => part.length > 0);
	// Defaulting to $HOME rather than "/" is the point: a command from Discord
	// must not be able to run an agent anywhere on the filesystem.
	return (configured.length > 0 ? configured : [os.homedir()]).map(root => path.resolve(root));
}

/** "Missing Permissions" on its own has sent people hunting for the wrong setting. Name the fix. */
export function missingChannelPermissionMessage(action: string, applicationId: string | null): string {
	const base = `${action} needs MANAGE_CHANNELS, which this bot was not invited with. Re-invite it with permissions=${REQUIRED_PERMISSIONS.toString()}`;
	return applicationId ? `${base}: ${inviteUrl(applicationId)}` : `${base}.`;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Daemon entry
// ---------------------------------------------------------------------------

/** Reported in the heartbeat so `/session list` can show which machines are behind. */
async function installedChudcodeVersion(): Promise<string> {
	// The package hides package.json behind an exports map, so resolve a module it
	// does export and walk up to the manifest beside it.
	//
	// `import.meta.resolve`, not `createRequire(...).resolve`: coding-agent's
	// export map declares only the `types` and `import` conditions, so CommonJS
	// resolution finds no `require` entry and throws "Cannot find module" even
	// though the ESM import at the top of this file resolves the same specifier
	// perfectly. That mismatch crashed the daemon on startup, before it published
	// a single heartbeat.
	let dir: string;
	try {
		dir = path.dirname(fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client")));
	} catch {
		// A version string is telemetry, not a precondition. Never let it stop the
		// agent from starting.
		return "unknown";
	}
	for (let depth = 0; depth < 8; depth += 1) {
		try {
			const parsed: unknown = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
			if (
				parsed !== null &&
				typeof parsed === "object" &&
				"version" in parsed &&
				typeof parsed.version === "string"
			) {
				return parsed.version;
			}
		} catch {
			// Keep walking; only the package root carries a manifest.
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return "unknown";
}

export async function main(): Promise<void> {
	const rest = new DiscordRest();
	const application = await rest.getApplication();
	if (!messageContentIntentEnabled(application)) {
		process.stderr.write(
			"[cc-agent] MESSAGE_CONTENT intent is off. The bus still works -- Discord exempts a bot from blanking its own messages -- but no human message in any channel is readable by this app.\n",
		);
	}
	const bus = new Bus({ rest, botUserId: application.bot?.id ?? application.id });
	const agent = new CcAgent({
		bus,
		rest,
		applicationId: application.id,
		chudcodeVersion: await installedChudcodeVersion(),
	});
	process.stderr.write(`[cc-agent] ${agent.host} on bus ${bus.channelId}, roots ${agent.projectRoots.join(", ")}\n`);
	await agent.start();
}

if (import.meta.main) await main();
