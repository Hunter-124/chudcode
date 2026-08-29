/**
 * The wire contract between the three moving parts of the session bridge.
 *
 *   cc-agent   (one per developer machine, REST only, no gateway)
 *              watches ~/.chudcode/agent/sessions, mirrors what it sees into
 *              #sessions, and executes commands addressed to its own host.
 *
 *   cc-gateway (exactly one instance, holds the gateway connection)
 *              owns slash-command registration and interaction acks, and
 *              publishes commands onto the bus. It never touches a session.
 *
 *   the bus    a Discord text channel used as an append-only command log.
 *
 * Why a Discord channel is the transport, and not a socket: every developer
 * machine already has outbound HTTPS to discord.com and a bot token, and none
 * of them has a stable inbound address. A channel gives ordering, durability,
 * retention and an audit trail for free, and "start a session on Garrison's PC
 * from my phone" works with no tunnel, no port, and no VPN. The cost is latency
 * bounded by the agent's poll interval, which is seconds -- irrelevant for
 * starting a coding session.
 *
 * Every record is a single fenced JSON block in a single message. Records are
 * addressed by `id`; a consumer that has already acted on an id must ignore a
 * replay, because bus reads are at-least-once.
 */

export const BUS_PROTOCOL_VERSION = 1;

/** Fence marker so a human reading the channel sees what it is. */
export const BUS_FENCE = "cc-bus";

// ---------------------------------------------------------------------------
// Session state, as mirrored into #sessions
// ---------------------------------------------------------------------------

/**
 * Derived, never stored by chudcode itself: session-listing.ts computes status
 * from the tail entry at read time, so the agent recomputes it on every scan.
 */
export type SessionStatus =
	| "running" // an assistant turn is in flight
	| "idle" // session open, waiting on a human
	| "complete" // ended cleanly
	| "interrupted" // user interrupted the turn
	| "aborted"
	| "error"
	| "unknown";

export interface SessionSnapshot {
	/** chudcode session id (from the JSONL header). Stable for the session's life. */
	readonly sessionId: string;
	/** Host that owns this session. Two machines can hold the same session id only if a file is copied; host disambiguates. */
	readonly host: string;
	/** Absolute path of the session JSONL on `host`. */
	readonly sessionFile: string;
	readonly cwd: string;
	/** Repo-relative label for `cwd`, or the basename when it is not in a repo. */
	readonly project: string;
	readonly title: string | null;
	/** Model id from the most recent `model_change` / message entry. */
	readonly model: string | null;
	readonly status: SessionStatus;
	readonly startedAt: string;
	readonly updatedAt: string;
	readonly messageCount: number;
	/** Cumulative cost in USD when the session records usage, else null. */
	readonly costUsd: number | null;
	readonly tokensIn: number | null;
	readonly tokensOut: number | null;
	/** Most recent tool the agent invoked, for a one-line "what is it doing". */
	readonly lastTool: string | null;
	/** First ~160 chars of the newest assistant text, whitespace-collapsed. */
	readonly lastText: string | null;
	/** Set when this session was started from Discord, so results can be routed back. */
	readonly originCommandId: string | null;
	/** Discord user id that started it, when known. */
	readonly requestedBy: string | null;
	/**
	 * The session's own Discord text channel, once one exists.
	 *
	 * One channel per session, named from `title`. Threads were tried and
	 * rejected: a thread hides its content behind a click and a collapsed list,
	 * which is exactly the complaint that killed the thread-per-transcript
	 * layout. A channel shows up in the sidebar and reads like a log.
	 */
	readonly channelId: string | null;
}

/** What the agent remembers so it edits rather than reposts. */
export interface SessionMirrorState {
	readonly sessionId: string;
	readonly host: string;
	/** The session's dedicated channel. */
	readonly channelId: string;
	/** First message in that channel: the status embed, edited in place forever. */
	readonly statusMessageId: string;
	/** Hash of the last rendered embed, so an unchanged snapshot costs no API call. */
	readonly renderHash: string;
	/** Last title the channel was named after, to avoid a no-op rename. */
	readonly lastTitle: string | null;
	/** When the channel was last renamed, to honour Discord's 2-per-10-minutes cap. */
	readonly lastRenamedAt: string | null;
	readonly lastPostedAt: string;
}

/**
 * Discord rate-limits a channel rename to 2 per 10 minutes, and answers the
 * third with a 429 that is easy to mistake for a transient blip. chudcode
 * retitles a session as it learns what the work is, so renames must be
 * debounced to the latest known title rather than applied per change.
 */
export const CHANNEL_RENAME_MIN_INTERVAL_MS = 360_000;

/** Discord's channel-name ceiling. Names are prefixed, so the budget is smaller. */
export const MAX_CHANNEL_NAME_CHARS = 100;
export const SESSION_CHANNEL_PREFIX = "s-";
/** Finished sessions are renamed with this prefix so live ones sort first. */
export const ARCHIVED_SESSION_CHANNEL_PREFIX = "z-";

/**
 * Discord accepts mixed case and silently rewrites it, which makes a stored
 * name disagree with the live one and provokes an endless rename loop. Doing the
 * transformation here means the name we ask for is the name we get back.
 */
export function sessionChannelName(title: string | null, sessionId: string): string {
	const slug = (title ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-|-$/g, "");
	const budget = MAX_CHANNEL_NAME_CHARS - SESSION_CHANNEL_PREFIX.length;
	if (slug.length === 0) return `${SESSION_CHANNEL_PREFIX}${sessionId.slice(0, 12)}`;
	return `${SESSION_CHANNEL_PREFIX}${slug.slice(0, budget).replace(/-$/, "")}`;
}

// ---------------------------------------------------------------------------
// Bus records
// ---------------------------------------------------------------------------

/** Announced on agent start and refreshed on a timer; drives `/session` host autocomplete. */
export interface AgentHeartbeat {
	readonly kind: "agent.heartbeat";
	readonly v: number;
	readonly id: string;
	readonly host: string;
	/** Repos this agent can start a session in, as absolute paths. */
	readonly projects: readonly string[];
	readonly chudcodeVersion: string;
	readonly sentAt: string;
	/** Sessions currently known to this agent, newest first, bounded. */
	readonly sessions: readonly SessionSnapshot[];
}

export type CommandName =
	/**
	 * Create a session channel and start a chudcode session streaming into it.
	 * Surfaced to humans as `/new`, which is the name the team actually asked
	 * for; `start` is kept as the wire name's sibling for a session started
	 * against an existing channel.
	 */
	| "new"
	/** Start a session and stream it into an already-created channel. */
	| "start"
	/** Send another turn into a running session. */
	| "say"
	/** Interrupt the in-flight turn without killing the session. */
	| "interrupt"
	/** End the session process. */
	| "stop"
	/** Repost the last N turns of a session into its channel. */
	| "tail";

export interface CommandRecord {
	readonly kind: "command";
	readonly v: number;
	readonly id: string;
	readonly name: CommandName;
	/** Hostname the command is addressed to. An agent ignores anything else. */
	readonly host: string;
	/** Required for say/interrupt/stop/tail. */
	readonly sessionId: string | null;
	/** Required for new/start: absolute path on `host`. */
	readonly cwd: string | null;
	/** Prompt text for new/start/say. */
	readonly prompt: string | null;
	/** Model override; null means the agent's default. */
	readonly model: string | null;
	readonly lines: number | null;
	/**
	 * Target session channel. Null for `new`, where the agent creates the
	 * channel and reports the id back on the `CommandResult`.
	 */
	readonly channelId: string | null;
	/** Discord user id that issued it, for attribution and authorisation. */
	readonly requestedBy: string;
	/** Channel the gateway is holding its deferred reply in. */
	readonly replyChannelId: string;
	readonly issuedAt: string;
}

export type CommandOutcome = "accepted" | "rejected" | "done" | "failed";

export interface CommandResult {
	readonly kind: "command.result";
	readonly v: number;
	readonly id: string;
	/** `CommandRecord.id` this answers. */
	readonly commandId: string;
	readonly host: string;
	readonly outcome: CommandOutcome;
	/** Human-readable, safe to show in Discord. Never carries a credential. */
	readonly detail: string;
	readonly sessionId: string | null;
	/** Channel the agent created for a `new` command, so the reply can link it. */
	readonly channelId: string | null;
	readonly completedAt: string;
}

export type BusRecord = AgentHeartbeat | CommandRecord | CommandResult;

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

/**
 * Discord's hard per-message ceiling. A record that does not fit is a bug in the
 * producer -- snapshots are bounded before they get here -- so encoding throws
 * rather than silently truncating a control message.
 */
export const MAX_MESSAGE_CHARS = 2000;

export function encodeRecord(record: BusRecord): string {
	const body = JSON.stringify(record);
	const framed = "```" + BUS_FENCE + "\n" + body + "\n```";
	if (framed.length > MAX_MESSAGE_CHARS) {
		throw new Error(
			`bus record ${record.kind}/${record.id} encodes to ${framed.length} chars, over the ${MAX_MESSAGE_CHARS} limit`,
		);
	}
	return framed;
}

/**
 * Returns null for anything that is not one of our records -- a human talking in
 * the bus channel must never crash a consumer.
 */
export function decodeRecord(content: string): BusRecord | null {
	const match = content.match(/^```cc-bus\n([\s\S]*?)\n```$/);
	if (!match?.[1]) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(match[1]);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const candidate = parsed as { kind?: unknown; v?: unknown; id?: unknown };
	if (typeof candidate.id !== "string" || candidate.v !== BUS_PROTOCOL_VERSION) return null;
	if (
		candidate.kind !== "agent.heartbeat" &&
		candidate.kind !== "command" &&
		candidate.kind !== "command.result"
	) {
		return null;
	}
	return parsed as BusRecord;
}

/** Heartbeats older than this mean the host is presumed offline. */
export const AGENT_STALE_AFTER_MS = 150_000;
export const HEARTBEAT_INTERVAL_MS = 60_000;
/** How often an agent looks for commands addressed to it. */
export const COMMAND_POLL_INTERVAL_MS = 4_000;
