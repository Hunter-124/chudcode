/**
 * The single typed channel map for the CloudCastle guild.
 *
 * Every id here is a live snowflake observed on 2026-08-28 against guild
 * 1542474553320542278. `provision.ts` revalidates each one before it touches
 * anything, and refuses to run if a mapped id has disappeared -- a stale id must
 * fail loudly rather than silently address the wrong channel.
 *
 * Naming rule that shapes this file: the names cc-track depends on
 * (`git`, `updates`, `milestones`, `priority-task-list`, `que`, `problems`,
 * `sessions`) are deliberately NOT renamed. cc-track addresses channels by id,
 * but its runbook, config table and doctor output all name them, and renaming
 * them would buy cosmetics at the cost of doc drift across two repositories.
 * Reorganisation happens at the category level, where it is free.
 */

export const GUILD_ID = "1542474553320542278";

/** Channels that already exist. Ids are load-bearing; do not edit casually. */
export const CHANNEL_IDS = {
	milestones: "1542614939540263073",
	updates: "1542626782639824916",
	meetingVoice: "1542474554012864575",
	notForAnalysis: "1543035560631996558",
	chat: "1542626296012472360",
	documents: "1542626326362460200",
	meetingTranscripts: "1542474554012864574",
	que: "1542626072405868664",
	problems: "1542614440602771476",
	priorityTaskList: "1542614871772893244",
	git: "1542615109686263899",
	sessions: "1542631105608556574",
} as const;

export type ChannelKey = keyof typeof CHANNEL_IDS;

/** Categories that already exist, with the name each should end up carrying. */
export const CATEGORY_IDS = {
	team: "1542474554012864572", // was "talk"
	intake: "1542614463784558744", // was "task planning & delegation"
	devFeed: "1542625972111806574", // was "chudcode"
	archive: "1542629926941761536", // was "WIP" (empty)
} as const;

export type CategoryKey = keyof typeof CATEGORY_IDS;

/**
 * Categories `provision` must create; they have no id yet.
 *
 * These two hold one channel per chudcode session, created at run time by the
 * bot rather than by provisioning. Threads were tried for this and rejected --
 * a thread hides its content behind a click, which is exactly why the
 * thread-per-transcript layout got thrown out. So provisioning must treat a
 * channel it does not recognise inside these two categories as expected, never
 * as drift to be renamed, reparented, or reported.
 */
export const CATEGORIES_TO_CREATE = ["liveSessions", "doneSessions"] as const;

export type CreatedCategoryKey = (typeof CATEGORIES_TO_CREATE)[number];

export const CREATED_CATEGORY_NAMES: Readonly<Record<CreatedCategoryKey, string>> = {
	liveSessions: "live sessions",
	doneSessions: "finished sessions",
};

/**
 * Threads under `meeting-transcripts`. Kept because the archive exporter maps
 * them to the numbered meeting artifacts and must keep doing so, even though
 * `provision --flatten-threads` republishes their content into the channel
 * itself. Flattening copies; it never deletes the source.
 */
export const KNOWN_THREAD_IDS = {
	equityStructure: "1542493184423239750",
	simplifyAdminConsole: "1542489253051895889",
	testOfAudioSetup: "1542475506270871612",
} as const;

/** Who may write where. The bot must never post into an intake channel body. */
export type ChannelRole =
	/** Bot-authored feed. Humans can read and react; the bot owns the content. */
	| "feed"
	/** Humans author; the bot reads and may only reply to its own intake acks. */
	| "intake"
	/** Humans author; the bot never writes at all. */
	| "human"
	/** Bot-authored, one message edited forever. */
	| "board";

export interface ChannelPlan {
	readonly key: string;
	/** Existing id, or null when `provision` must create the channel. */
	readonly id: string | null;
	readonly name: string;
	readonly category: CategoryKey | null;
	readonly role: ChannelRole;
	readonly type: "text" | "voice";
	/** Rendered into the channel topic so the purpose is legible in Discord. */
	readonly topic: string;
	readonly position: number;
}

/**
 * The target layout. `provision.ts` drives the guild toward exactly this and
 * nothing else: it creates a channel whose `id` is null, renames and reparents
 * the rest, sets topics, and orders them by `position`.
 *
 * It never deletes. Deletion of the pre-migration surface stays owner-account
 * browser work per the handoff's cutover gate, and the bot is not granted a
 * permission set that would let it delete a channel even by accident.
 */
export const TARGET_LAYOUT: readonly ChannelPlan[] = [
	// ---- start here: the two things a new teammate needs -------------------
	{
		key: "howWeWork",
		id: null,
		name: "how-we-work",
		category: null,
		role: "feed",
		type: "text",
		topic: "How this team works: workflow, tracking, and where to put things. Start here.",
		position: 0,
	},
	{
		key: "milestones",
		id: CHANNEL_IDS.milestones,
		name: "milestones",
		category: null,
		role: "feed",
		type: "text",
		topic: "Shipped milestones and releases. Written by cc-track from GitHub.",
		position: 1,
	},

	// ---- dev feed: everything the bot reports ------------------------------
	{
		key: "git",
		id: CHANNEL_IDS.git,
		name: "git",
		category: "devFeed",
		role: "feed",
		type: "text",
		topic: "Push / PR / CI firehose from GitHub. Nobody should have to ask what you pushed.",
		position: 0,
	},
	{
		key: "priorityTaskList",
		id: CHANNEL_IDS.priorityTaskList,
		name: "priority-task-list",
		category: "devFeed",
		role: "board",
		type: "text",
		topic: "The live task board: one message, edited in place, grouped p0 to p3. Never a repost.",
		position: 1,
	},
	{
		key: "sessions",
		id: CHANNEL_IDS.sessions,
		name: "sessions",
		category: "devFeed",
		role: "feed",
		type: "text",
		topic: "Live chudcode sessions across the team. One message per session, edited as it runs; thread carries the detail.",
		position: 2,
	},
	{
		key: "updates",
		id: CHANNEL_IDS.updates,
		name: "updates",
		category: "devFeed",
		role: "feed",
		type: "text",
		topic: "Daily digest: who did what, what is stale, what needs an owner.",
		position: 3,
	},
	{
		key: "alerts",
		id: null,
		name: "alerts",
		category: "devFeed",
		role: "feed",
		type: "text",
		topic: "CI failures and production alerts that need someone now.",
		position: 4,
	},

	// ---- intake: humans ask, a human approves, the bot files ---------------
	{
		key: "que",
		id: CHANNEL_IDS.que,
		name: "que",
		category: "intake",
		role: "intake",
		type: "text",
		topic: "Task requests. React with white_check_mark to file it as a GitHub issue, or start the message with !task.",
		position: 0,
	},
	{
		key: "problems",
		id: CHANNEL_IDS.problems,
		name: "problems",
		category: "intake",
		role: "intake",
		type: "text",
		topic: "Something is broken. React with white_check_mark to file it as a GitHub issue.",
		position: 1,
	},

	// ---- team: humans talking ---------------------------------------------
	{
		key: "chat",
		id: CHANNEL_IDS.chat,
		name: "general",
		category: "team",
		role: "human",
		type: "text",
		topic: "General team chat. Not tracked, not projected anywhere.",
		position: 0,
	},
	{
		key: "decisions",
		id: null,
		name: "decisions",
		category: "team",
		role: "feed",
		type: "text",
		topic: "Settled product and business decisions, mirrored from docs/DECISIONS.md.",
		position: 1,
	},
	{
		key: "documents",
		id: CHANNEL_IDS.documents,
		name: "docs",
		category: "team",
		role: "human",
		type: "text",
		topic: "Documents and references worth keeping findable.",
		position: 2,
	},
	{
		key: "meetingTranscripts",
		id: CHANNEL_IDS.meetingTranscripts,
		name: "meeting-transcripts",
		category: "team",
		role: "human",
		type: "text",
		topic: "Meeting transcripts and their threads. Archived to git under docs/meeting, 8-27/.",
		position: 3,
	},
	{
		key: "notForAnalysis",
		id: CHANNEL_IDS.notForAnalysis,
		name: "not-for-analysis",
		category: "team",
		role: "human",
		type: "text",
		topic: "Explicitly excluded from archival analysis and from any AI projection.",
		position: 4,
	},
	{
		key: "meetingVoice",
		id: CHANNEL_IDS.meetingVoice,
		name: "meeting",
		category: "team",
		role: "human",
		type: "voice",
		topic: "",
		position: 5,
	},

	// ---- archive: a pointer, not a copy -----------------------------------
	{
		key: "archiveNotice",
		id: null,
		name: "archive-notice",
		category: "archive",
		role: "feed",
		type: "text",
		topic: "Where the pre-reorganisation server archive lives, and how to read it.",
		position: 0,
	},
];

export const CATEGORY_NAMES: Readonly<Record<CategoryKey, string>> = {
	devFeed: "dev feed",
	intake: "intake",
	team: "team",
	archive: "archive",
};

/** Ordering of the categories themselves in the sidebar. */
export const CATEGORY_ORDER: readonly CategoryKey[] = ["devFeed", "intake", "team", "archive"];

export function planFor(key: string): ChannelPlan {
	const plan = TARGET_LAYOUT.find(entry => entry.key === key);
	if (!plan) throw new Error(`no channel plan named ${key}`);
	return plan;
}

/**
 * Permission integer the bot needs for the whole bridge, and the bits
 * deliberately withheld. Kept next to the channel map because `doctor` reports
 * the delta and the invite URL is generated from exactly this number.
 *
 * MANAGE_CHANNELS is required to reorganise the guild and unavoidably implies
 * channel deletion in Discord's model -- there is no create-only bit. The
 * handoff's "the bot must never receive channel deletion power" invariant is
 * therefore enforced in code instead: see `assertNoDeletes` in provision.ts.
 */
export const REQUIRED_PERMISSIONS = [
	4, // MANAGE_CHANNELS   - reorganise the layout
	6, // ADD_REACTIONS     - acknowledge intake
	10, // VIEW_CHANNEL
	11, // SEND_MESSAGES
	13, // MANAGE_MESSAGES  - pin the board
	14, // EMBED_LINKS
	15, // ATTACH_FILES
	16, // READ_MESSAGE_HISTORY
	31, // USE_APPLICATION_COMMANDS
	34, // MANAGE_THREADS   - enumerate archived private threads for the archive
	35, // CREATE_PUBLIC_THREADS
	38, // SEND_MESSAGES_IN_THREADS
].reduce((mask, bit) => mask | (1n << BigInt(bit)), 0n);

export const WITHHELD_PERMISSIONS: Readonly<Record<string, string>> = {
	ADMINISTRATOR: "never; the bridge has no use for it",
	MANAGE_GUILD: "never; the bridge does not configure the server",
	MANAGE_ROLES: "never; role changes stay human",
	KICK_MEMBERS: "never",
	BAN_MEMBERS: "never",
	MANAGE_WEBHOOKS: "not needed; the bot posts under its own identity",
};

export function inviteUrl(applicationId: string): string {
	const params = new URLSearchParams({
		client_id: applicationId,
		scope: "bot applications.commands",
		permissions: REQUIRED_PERMISSIONS.toString(),
		guild_id: GUILD_ID,
		disable_guild_select: "true",
	});
	return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
}
