/**
 * The single typed source of truth for the CloudCastle guild and its channel
 * snowflakes.
 *
 * Every id here previously lived as a bare literal in a HANDOFF table, which is
 * how a channel gets retyped wrong and a report lands in the wrong room. Nothing
 * in this package may re-declare a snowflake: import `CHANNELS` instead.
 *
 * Values are from `docs/19-development-tracking-bridge.md` §4 (channel map) and
 * §14 (secrets). The `board` key is the `priority-task-list` channel; it is named
 * `board` because that is the ledger key the CloudCastle side uses.
 */

export const GUILD_ID = "1542474553320542278";

/** Which credential lane a channel belongs to: A is webhook-only egress, B needs a bot token. */
export type ChannelLane = "A" | "B";

export interface ChannelDescriptor {
	/** The channel name as it reads in the Discord sidebar. */
	readonly label: string;
	readonly id: string;
	readonly lane: ChannelLane;
	/**
	 * The `DISCORD_WEBHOOK_*` environment variable carrying this channel's
	 * incoming-webhook URL, or `null` for the Lane-B intake channels, which are
	 * read-only to `cc-track` and therefore have no webhook provisioned.
	 */
	readonly webhookEnv: string | null;
}

export const CHANNELS = {
	git: { label: "git", id: "1542615109686263899", lane: "A", webhookEnv: "DISCORD_WEBHOOK_GIT" },
	updates: { label: "updates", id: "1542626782639824916", lane: "A", webhookEnv: "DISCORD_WEBHOOK_UPDATES" },
	milestones: { label: "milestones", id: "1542614939540263073", lane: "A", webhookEnv: "DISCORD_WEBHOOK_MILESTONES" },
	board: { label: "priority-task-list", id: "1542614871772893244", lane: "A", webhookEnv: "DISCORD_WEBHOOK_BOARD" },
	que: { label: "que", id: "1542626072405868664", lane: "B", webhookEnv: null },
	problems: { label: "problems", id: "1542614440602771476", lane: "B", webhookEnv: null },
	sessions: { label: "sessions", id: "1542631105608556574", lane: "A", webhookEnv: "DISCORD_WEBHOOK_SESSIONS" },
} as const satisfies Record<string, ChannelDescriptor>;

export type ChannelName = keyof typeof CHANNELS;

export const CHANNEL_NAMES = Object.keys(CHANNELS) as readonly ChannelName[];

export function isChannelName(value: string): value is ChannelName {
	return Object.hasOwn(CHANNELS, value);
}


/**
 * The `DISCORD_WEBHOOK_*` variable that carries this channel's webhook URL, or
 * `null` when the channel is intake-only and has no egress credential.
 */
export function webhookEnvVar(name: ChannelName): string | null {
	return CHANNELS[name].webhookEnv;
}

/** Permalink to a message, so a report can point back at what produced it. */
export function messageLink(channel: ChannelName | (string & {}), messageId: string): string {
	const id = isChannelName(channel) ? CHANNELS[channel].id : channel;
	return `https://discord.com/channels/${GUILD_ID}/${id}/${messageId}`;
}
