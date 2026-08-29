/**
 * Drive the CloudCastle guild to the layout declared in `channels.ts`.
 *
 * Planning and applying are separate functions on purpose. `--dry-run` runs
 * `planProvision` and prints it; `--apply` runs `planProvision` and then feeds
 * that exact plan to `applyProvision`. There is no second code path that could
 * drift from what the dry run showed.
 *
 * Two safety properties are structural rather than aspirational:
 *
 *  1. `GuildRest` has no `delete`. The transport this module talks through
 *     physically cannot issue a DELETE, so no amount of future editing inside
 *     `applyProvision` can remove a channel, category, thread, or role.
 *  2. `assertNoDeletes` re-checks the plan at runtime against an allowlist of
 *     action kinds and their HTTP methods, and `applyProvision` calls it before
 *     the first request. MANAGE_CHANNELS unavoidably grants deletion in
 *     Discord's permission model -- there is no create-only bit -- so the
 *     "the bot never deletes a channel" invariant from HANDOFF.md has to live
 *     in code. Deleting the pre-migration surface stays owner-account browser
 *     work.
 *
 * Two things provisioning deliberately does NOT treat as drift:
 *
 *  - A channel the layout does not name. Session channels are created at
 *    runtime inside the sessions categories; they are never renamed,
 *    reparented, reordered, or reported. Only channels the layout names are
 *    ever touched.
 *  - A layout entry with `id: null` whose channel already exists under the
 *    target name. That is adopted rather than created again, which is what
 *    makes a second run empty even before the new id is written back into
 *    `channels.ts`.
 */

import { MAX_MESSAGE_CHARS } from "./bridge-protocol";
import {
	CATEGORIES_TO_CREATE,
	CATEGORY_IDS,
	CATEGORY_NAMES,
	CATEGORY_ORDER,
	type CategoryKey,
	type ChannelPlan,
	CREATED_CATEGORY_NAMES,
	GUILD_ID,
	KNOWN_THREAD_IDS,
	REQUIRED_PERMISSIONS,
	TARGET_LAYOUT,
} from "./channels";
import {
	type DiscordChannel,
	type DiscordMessage,
	type DiscordRestClient,
	GUILD_TEXT_CHANNEL,
	MAX_MESSAGE_PAGE,
} from "./discord-rest";

/**
 * One category in sidebar order. `id` is null for a category provisioning must
 * bring into existence -- either by adopting the live one already carrying the
 * name, or by creating it.
 */
export interface CategorySpec {
	readonly key: string;
	readonly id: string | null;
	readonly name: string;
}

/**
 * The declared layout `planProvision` drives toward. Production callers get the
 * guild's real layout from `channels.ts`; the parameter exists because the
 * planner is a pure function of a declared layout plus live state, and saying
 * so makes both halves reviewable in isolation.
 */
export interface LayoutSpec {
	readonly channels: readonly ChannelPlan[];
	readonly categories: readonly CategorySpec[];
	readonly threadIds: Readonly<Record<string, string>>;
}

export interface ApplyDependencies {
	readonly rest: DiscordRestClient;
}

export interface ProvisionDependencies extends ApplyDependencies {
	readonly guildId?: string;
	readonly layout?: LayoutSpec;
	/**
	 * Opt-in, one-time migration: repost each mapped thread's messages into its
	 * parent channel so meeting content is readable without opening a thread.
	 * Off by default because it writes into a human-authored channel, which the
	 * bot otherwise never does.
	 */
	readonly flattenThreads?: boolean;
}

export interface FieldChange<T> {
	readonly from: T;
	readonly to: T;
}

export interface CategoryChanges {
	readonly name?: FieldChange<string>;
	readonly position?: FieldChange<number>;
}

export interface ChannelChanges {
	readonly name?: FieldChange<string>;
	/** `toKey` is a category key, not an id: the category may be created in the same run. */
	readonly parent?: { readonly fromId: string | null; readonly toKey: CategoryKey | null };
	readonly position?: FieldChange<number>;
	readonly topic?: FieldChange<string>;
}

export type ProvisionAction =
	| { readonly kind: "create-category"; readonly key: string; readonly name: string; readonly position: number }
	| {
			readonly kind: "update-category";
			readonly key: string;
			readonly id: string;
			readonly changes: CategoryChanges;
	  }
	| {
			readonly kind: "create-channel";
			readonly key: string;
			readonly name: string;
			readonly channelType: 0 | 2;
			readonly parentKey: CategoryKey | null;
			readonly topic: string | null;
			readonly position: number;
	  }
	| { readonly kind: "update-channel"; readonly key: string; readonly id: string; readonly changes: ChannelChanges }
	/** `channelId` is null when the channel is created by an earlier action in the same plan. */
	| { readonly kind: "post-seed"; readonly key: string; readonly channelId: string | null; readonly body: string }
	| {
			readonly kind: "edit-seed";
			readonly key: string;
			readonly channelId: string;
			readonly messageId: string;
			readonly body: string;
	  }
	| {
			readonly kind: "flatten-thread";
			readonly key: string;
			readonly threadId: string;
			readonly threadName: string;
			/** The thread's parent channel: where the flattened copies land. */
			readonly channelId: string;
			readonly sourceMessageCount: number;
			/** Ready-to-send message bodies, each already within Discord's limit. */
			readonly posts: readonly string[];
	  };

export interface MissingPermission {
	readonly bit: number;
	readonly name: string;
	/** Why provisioning needs it, so the refusal explains itself. */
	readonly needed: string;
}

export interface PermissionPreflight {
	/** Guild-level mask: `@everyone` OR-ed with every role the bot member holds. */
	readonly effective: bigint;
	readonly administrator: boolean;
	readonly missing: readonly MissingPermission[];
	/** Permission integer to re-invite with, straight from `REQUIRED_PERMISSIONS`. */
	readonly reinvitePermissions: string;
}

export interface ProvisionPlan {
	readonly guildId: string;
	readonly botUserId: string;
	readonly botUsername: string;
	readonly permissions: PermissionPreflight;
	/** Live ids of the categories that already exist, for parent resolution at apply time. */
	readonly resolvedCategoryIds: Readonly<Record<string, string>>;
	readonly actions: readonly ProvisionAction[];
	/** Things a human should know that are not actions -- adoptions and unverifiable state. */
	readonly notes: readonly string[];
}

/**
 * One call `applyProvision` actually made. There is no destructive operation in
 * this union and none on `DiscordRestClient`, so a report is also the proof that
 * nothing was removed.
 */
export type ProvisionOperation = "createChannel" | "modifyChannel" | "createMessage" | "editMessage" | "pinMessage";

export interface AppliedRequest {
	readonly operation: ProvisionOperation;
	/** Guild id for a create, channel id otherwise. */
	readonly target: string;
	readonly kind: ProvisionAction["kind"];
	readonly key: string;
}

export interface ProvisionReport {
	readonly guildId: string;
	readonly createdCategoryIds: Readonly<Record<string, string>>;
	readonly createdChannelIds: Readonly<Record<string, string>>;
	/** Every call actually issued, in order. */
	readonly requests: readonly AppliedRequest[];
	/** Seed messages Discord refused to pin because MANAGE_MESSAGES is missing. */
	readonly unpinned: readonly string[];
}

export class StaleChannelMapError extends Error {
	readonly keys: readonly string[];
	constructor(guildId: string, problems: readonly string[], keys: readonly string[]) {
		super(
			`channels.ts does not match guild ${guildId}: ${problems.join("; ")}. ` +
				"Fix the map by hand; provision will not re-create a mapped channel or address a different one.",
		);
		this.keys = keys;
	}
}

export class PermissionPreflightError extends Error {
	readonly missing: readonly MissingPermission[];
	constructor(guildId: string, missing: readonly MissingPermission[]) {
		super(
			`provision cannot apply in guild ${guildId}: the bot is missing ` +
				`${missing.map(entry => `${entry.name} (bit ${entry.bit}, needed to ${entry.needed})`).join(", ")}. ` +
				`Re-invite the application with permissions=${REQUIRED_PERMISSIONS.toString()} and run again. ` +
				"planProvision still works read-only without them.",
		);
		this.missing = missing;
	}
}

/**
 * Thrown when the messages to be flattened come back with empty bodies. Same
 * cause and same fix as `EmptyExportContentError` in `condense.ts`: the
 * MESSAGE_CONTENT privileged intent is off, so Discord returns `""` for every
 * body. Reposting those would replace a thread of real discussion with a column
 * of empty headers.
 */
export class EmptyThreadContentError extends Error {
	readonly threadId: string;
	constructor(threadId: string, threadName: string, messageCount: number) {
		super(
			`thread ${threadId} ("${threadName}") has ${messageCount} message(s) and not one readable body, so there is ` +
				"nothing to flatten into the parent channel. That is the MESSAGE_CONTENT privileged intent being off: the " +
				"Discord API returns content: \"\" for every message until it is enabled. Enable MESSAGE_CONTENT under the " +
				"application's Bot settings and run --flatten-threads again. Refusing to repost empty messages.",
		);
		this.threadId = threadId;
	}
}

const CHANNEL_TYPE = { text: 0, voice: 2, category: 4 } as const;
const ADMINISTRATOR_BIT = 3n;
/** DEFAULT and REPLY. Every other type is a system event with no authored body. */
const CONVERSATIONAL_MESSAGE_TYPES: Readonly<Record<string, true>> = { "0": true, "19": true };
/** Enough for any channel this bot manages; hitting it is an error, never a silent stop. */
const MAX_MESSAGE_PAGES = 50;
/**
 * Marker the flattened copies carry so a second run recognises its own work.
 * The thread id is appended, which makes the guard exact rather than a name match.
 */
const FLATTEN_MARKER_PREFIX = "cc-flatten:";
const FLATTEN_NAME_LIMIT = 80;
/** Room for the ` (part 10/10)` suffix a chunked repost needs. */
const FLATTEN_PART_RESERVE = 20;

/**
 * The permissions provisioning mutates with. Checked as a guild-level mask;
 * a per-channel overwrite could still deny one channel, and Discord answers
 * that with a 403 that `applyProvision` surfaces unchanged.
 */
const MUTATING_PERMISSIONS: readonly MissingPermission[] = [
	{ bit: 4, name: "MANAGE_CHANNELS", needed: "rename, reparent, reorder, and create channels" },
	{ bit: 13, name: "MANAGE_MESSAGES", needed: "pin the seed message so it is found once and edited forever" },
	{ bit: 34, name: "MANAGE_THREADS", needed: "enumerate archived threads under meeting-transcripts" },
];

/**
 * Every action kind, mapped to the one HTTP method it is allowed to use.
 * `assertNoDeletes` rejects any kind that is not in here, which is what makes
 * adding a destructive action a loud failure instead of a quiet one.
 */
const ACTION_METHODS = {
	"create-category": "POST",
	"update-category": "PATCH",
	"create-channel": "POST",
	"update-channel": "PATCH",
	"post-seed": "POST",
	"edit-seed": "PATCH",
	"flatten-thread": "POST",
} as const satisfies Record<ProvisionAction["kind"], "POST" | "PATCH">;

/**
 * Seed bodies for the two channels that exist to explain the server. Keyed by
 * channel key, so a layout without those keys simply has no seed work.
 */
export const SEED_CONTENT: Readonly<Record<string, string>> = {
	howWeWork: `**How this team works**

Everything trackable lives in GitHub issues on \`Hunter-124/CloudCastle\`. Discord is where we talk about the work and where the bot reports it. Discord is not the system of record.

**Where things go**
- \`#que\` - task requests. Post it, then react :white_check_mark: to file it as an issue.
- \`#problems\` - something is broken. Same :white_check_mark: to file it.
- \`#git\` - every push, PR, and CI run, reported automatically.
- \`#priority-task-list\` - the live board. One message, edited in place, p0 to p3.
- \`#updates\` - daily digest of who did what and what went stale.
- \`#alerts\` - CI failures and production alerts that need someone now.
- \`#decisions\` - settled decisions, mirrored from \`docs/DECISIONS.md\`.
- \`#general\` - talk. Not tracked, not projected anywhere.
- \`#not-for-analysis\` - excluded from archival analysis and from any AI projection.

Live chudcode sessions get their own channel under the sessions category while they run, and move to the session archive when they finish. Meeting content is posted straight into its channel; nothing important is buried in a thread.

**How work gets tracked**
1. Say it in \`#que\` or \`#problems\`.
2. A human reacts :white_check_mark:. Nothing is filed without that.
3. The bot opens the issue with \`prio:*\` and \`area:*\` labels and links back to your message.
4. Progress shows up in \`#git\` and on the board. Nobody should have to ask what you pushed.

**Rules that matter**
- Priority is \`prio:p0\` through \`prio:p3\`. p0 means drop everything.
- The bot never deletes a channel, a thread, or a message. Reorganisation only renames and reparents.
- Anything you do not want read by tooling goes in \`#not-for-analysis\`.`,

	archiveNotice: `**The pre-reorganisation server archive**

Nothing was deleted to build this layout. Every message, thread, reaction, and attachment that existed before the reorganisation was exported first and committed to git. Channels were renamed and reparented, never removed. Thread content was copied into its parent channel, and the threads themselves were left in place.

**Where it lives**
\`docs/meeting, 8-27/discord-server-export/\` in the \`Hunter-124/CloudCastle\` repository.

**How to read it**
- \`INDEX.md\` - start here: every scope, its message count, and the file holding it.
- \`manifest.json\` - machine-readable index: scope ids, message ids, per-file SHA-256.
- \`<scope>-<id>.jsonl\` - one JSON object per message, oldest first, as the API returned it.
- \`<scope>-<id>.md\` - the same messages rendered for people.

**What is in it, and one thing that is not**
- Included: every readable scope, including the three \`#meeting-transcripts\` threads.
- Excluded from analysis: \`#not-for-analysis\`, deliberately and permanently.
- Message bodies in that export are empty. The MESSAGE_CONTENT privileged intent was off when it ran, so Discord returned \`""\` for every body. Scope ids, message ids, authors, timestamps, and hashes are correct; the bodies are not there. Enabling the intent and re-running the exporter is the fix.

If you cannot find something from the old server, it is in the export.`,
};

/**
 * The guild's real layout: the four mapped categories in sidebar order, then the
 * session categories that do not exist yet. Both halves become one ordered list
 * so provisioning has a single notion of "category".
 */
const DEFAULT_LAYOUT: LayoutSpec = {
	channels: TARGET_LAYOUT,
	categories: [
		...CATEGORY_ORDER.map(key => ({ key, id: CATEGORY_IDS[key], name: CATEGORY_NAMES[key] })),
		...CATEGORIES_TO_CREATE.map(key => ({ key, id: null, name: CREATED_CATEGORY_NAMES[key] })),
	],
	threadIds: KNOWN_THREAD_IDS,
};

interface LiveChannel {
	readonly id: string;
	readonly name: string;
	readonly type: number;
	readonly parentId: string | null;
	readonly position: number;
	readonly topic: string;
}

interface LiveThread {
	readonly id: string;
	readonly name: string;
	readonly parentId: string | null;
}

/** `channels.ts` reconciled against the live guild, by layout key. */
interface ResolvedGuild {
	readonly channelsByKey: ReadonlyMap<string, LiveChannel>;
	readonly categoriesByKey: ReadonlyMap<string, LiveChannel>;
	readonly threadsByKey: ReadonlyMap<string, LiveThread>;
	readonly notes: readonly string[];
}

interface SeedState {
	readonly messageId: string | null;
	/** False when the seed was found in channel history rather than among the pins. */
	readonly pinned: boolean;
	/** False when a bot-authored seed exists but its body came back empty. */
	readonly bodyReadable: boolean;
	readonly body: string;
}

interface ChannelMessage {
	readonly id: string;
	readonly authorId: string;
	readonly author: string;
	readonly authorIsBot: boolean;
	readonly type: number;
	readonly timestamp: string;
	readonly content: string;
}

/**
 * Read the guild, reconcile every mapped id, and compute the work needed to
 * reach the declared layout. Read-only: safe to run without any mutating
 * permission, which is the point -- the plan is reviewable before the re-invite.
 */
export async function planProvision(dependencies: ProvisionDependencies): Promise<ProvisionPlan> {
	const rest = dependencies.rest;
	const guildId = dependencies.guildId ?? GUILD_ID;
	const layout = dependencies.layout ?? DEFAULT_LAYOUT;

	const application = await rest.getApplication();
	const botUserId = application.bot?.id ?? "";
	if (!botUserId) throw new Error("GET /applications/@me did not return the bot user; cannot identify our own posts");

	const live = new Map<string, LiveChannel>();
	for (const channel of await rest.getGuildChannels(guildId)) live.set(channel.id, toLiveChannel(channel));

	const resolved = await resolveGuild(rest, guildId, layout, live);
	const permissions = await preflightPermissions(rest, guildId, botUserId);

	const actions: ProvisionAction[] = [];
	const notes: string[] = [...resolved.notes];
	const resolvedCategoryIds: Record<string, string> = {};

	planCategories(layout, resolved, actions, resolvedCategoryIds);
	planChannels(layout, resolved, actions);
	await planSeeds(rest, layout, resolved, botUserId, actions, notes);
	if (dependencies.flattenThreads) await planFlatten(rest, layout, resolved, botUserId, actions, notes);

	return {
		guildId,
		botUserId,
		botUsername: application.bot?.global_name || application.bot?.username || "",
		permissions,
		resolvedCategoryIds,
		actions,
		notes,
	};
}

/**
 * Reject any plan that could remove something. Called by `applyProvision`
 * before its first request; also worth calling directly on a plan that came
 * from anywhere less trusted than this module.
 */
export function assertNoDeletes(plan: ProvisionPlan): void {
	for (const action of plan.actions) {
		const method: string | undefined = ACTION_METHODS[action.kind];
		if (!method) {
			throw new Error(
				`provision plan contains action "${String(action.kind)}" for "${String(action.key)}", which is not a ` +
					"known non-destructive action. The bot must never delete a channel, thread, category, or role; " +
					"refusing to apply.",
			);
		}
		if (method !== "POST" && method !== "PATCH") {
			throw new Error(`provision action "${String(action.kind)}" resolves to method ${method}; refusing to apply.`);
		}
	}
}

/** Execute a plan. Refuses without the mutating permissions the plan measured. */
export async function applyProvision(plan: ProvisionPlan, dependencies: ApplyDependencies): Promise<ProvisionReport> {
	assertNoDeletes(plan);
	if (plan.permissions.missing.length > 0) throw new PermissionPreflightError(plan.guildId, plan.permissions.missing);

	const rest = dependencies.rest;
	const categoryIds: Record<string, string> = { ...plan.resolvedCategoryIds };
	const createdCategoryIds: Record<string, string> = {};
	const createdChannelIds: Record<string, string> = {};
	const requests: AppliedRequest[] = [];
	const unpinned: string[] = [];

	for (const action of plan.actions) {
		switch (action.kind) {
			case "create-category": {
				const created = await rest.createChannel(plan.guildId, {
					name: action.name,
					type: CHANNEL_TYPE.category,
					position: action.position,
				});
				const id = requireSnowflake(created.id, `created category ${action.key}`);
				categoryIds[action.key] = id;
				createdCategoryIds[action.key] = id;
				requests.push({ operation: "createChannel", target: plan.guildId, kind: action.kind, key: action.key });
				break;
			}
			case "update-category": {
				await rest.modifyChannel(action.id, {
					...(action.changes.name ? { name: action.changes.name.to } : {}),
					...(action.changes.position ? { position: action.changes.position.to } : {}),
				});
				requests.push({ operation: "modifyChannel", target: action.id, kind: action.kind, key: action.key });
				break;
			}
			case "create-channel": {
				const created = await rest.createChannel(plan.guildId, {
					name: action.name,
					type: action.channelType,
					position: action.position,
					parentId: action.parentKey ? resolveCategory(categoryIds, action.parentKey) : null,
					...(action.topic === null ? {} : { topic: action.topic }),
				});
				createdChannelIds[action.key] = requireSnowflake(created.id, `created channel ${action.key}`);
				requests.push({ operation: "createChannel", target: plan.guildId, kind: action.kind, key: action.key });
				break;
			}
			case "update-channel": {
				const changes = action.changes;
				await rest.modifyChannel(action.id, {
					...(changes.name ? { name: changes.name.to } : {}),
					...(changes.parent
						? { parentId: changes.parent.toKey ? resolveCategory(categoryIds, changes.parent.toKey) : null }
						: {}),
					...(changes.position ? { position: changes.position.to } : {}),
					...(changes.topic ? { topic: changes.topic.to } : {}),
				});
				requests.push({ operation: "modifyChannel", target: action.id, kind: action.kind, key: action.key });
				break;
			}
			case "post-seed": {
				const channelId = action.channelId ?? createdChannelIds[action.key];
				if (!channelId) throw new Error(`seed for ${action.key} has no channel: the create action did not run`);
				const posted = await rest.createMessage(channelId, { content: action.body });
				requests.push({ operation: "createMessage", target: channelId, kind: action.kind, key: action.key });
				// A pin makes the seed obvious to a human. It is no longer what
				// finds it next run -- `readSeedState` falls back to channel
				// history -- so a refused pin is reported, not fatal.
				const messageId = requireSnowflake(posted.id, `seed message for ${action.key}`);
				const pinned = await rest.pinMessage(channelId, messageId);
				requests.push({ operation: "pinMessage", target: channelId, kind: action.kind, key: action.key });
				if (!pinned) unpinned.push(`${action.key} (message ${messageId} in channel ${channelId})`);
				break;
			}
			case "edit-seed": {
				await rest.editMessage(action.channelId, action.messageId, { content: action.body });
				requests.push({
					operation: "editMessage",
					target: action.channelId,
					kind: action.kind,
					key: action.key,
				});
				break;
			}
			case "flatten-thread": {
				// Sequential, because Discord orders by receipt and the flattened
				// copies have to read in the same order as the thread did.
				for (const content of action.posts) {
					await rest.createMessage(action.channelId, { content });
					requests.push({
						operation: "createMessage",
						target: action.channelId,
						kind: action.kind,
						key: action.key,
					});
				}
				break;
			}
		}
	}

	return { guildId: plan.guildId, createdCategoryIds, createdChannelIds, requests, unpinned };
}

/** One line per action, for the CLI's dry-run diff. */
export function describeAction(action: ProvisionAction): string {
	switch (action.kind) {
		case "create-category":
			return `create-category  ${action.key.padEnd(20)} name "${action.name}", position ${action.position}`;
		case "update-category":
			return `update-category  ${action.key.padEnd(20)} ${describeCategoryChanges(action.changes)}`;
		case "create-channel": {
			const parent = action.parentKey ?? "(no category)";
			const topic = action.topic === null ? "" : `, topic "${truncate(action.topic, 60)}"`;
			return `create-channel   ${action.key.padEnd(20)} #${action.name} (${
				action.channelType === CHANNEL_TYPE.voice ? "voice" : "text"
			}) in ${parent} at position ${action.position}${topic}`;
		}
		case "update-channel":
			return `update-channel   ${action.key.padEnd(20)} ${describeChannelChanges(action.changes)}`;
		case "post-seed":
			return `post-seed        ${action.key.padEnd(20)} post ${action.body.length} chars and pin (channel ${
				action.channelId ?? "created by this plan"
			})`;
		case "edit-seed":
			return `edit-seed        ${action.key.padEnd(20)} edit pinned message ${action.messageId} to ${
				action.body.length
			} chars`;
		case "flatten-thread":
			return `flatten-thread   ${action.key.padEnd(20)} repost ${action.sourceMessageCount} message(s) from thread ${
				action.threadId
			} ("${truncate(action.threadName, 40)}") into channel ${action.channelId} as ${action.posts.length} post(s)`;
	}
}

// ---------------------------------------------------------------------------
// Reconciliation

/**
 * Match every id in the layout against the live guild. A mapped id that is
 * gone, or points at the wrong kind of channel, is a hard error naming the key:
 * re-creating it would orphan history and addressing something else would be
 * worse. A layout entry with no id is adopted from the live guild when exactly
 * one channel already carries the target name, so a second run does not create
 * a duplicate; two candidates is ambiguous and also a hard error.
 */
async function resolveGuild(
	rest: DiscordRestClient,
	guildId: string,
	layout: LayoutSpec,
	live: ReadonlyMap<string, LiveChannel>,
): Promise<ResolvedGuild> {
	const problems: string[] = [];
	const keys: string[] = [];
	const notes: string[] = [];
	const record = (key: string, problem: string): void => {
		keys.push(key);
		problems.push(`${key} ${problem}`);
	};

	const channelsByKey = new Map<string, LiveChannel>();
	for (const plan of layout.channels) {
		const desiredType = plan.type === "voice" ? CHANNEL_TYPE.voice : CHANNEL_TYPE.text;
		if (plan.id) {
			const channel = live.get(plan.id);
			if (!channel) record(`channel "${plan.key}"`, `maps ${plan.id}, which is not in the guild`);
			else if (channel.type === CHANNEL_TYPE.category)
				record(`channel "${plan.key}"`, `maps ${plan.id}, which is a category, not a channel`);
			else channelsByKey.set(plan.key, channel);
			continue;
		}
		const candidates = [...live.values()].filter(
			channel => channel.name === plan.name && channel.type === desiredType,
		);
		if (candidates.length > 1) {
			record(
				`channel "${plan.key}"`,
				`has no id and ${candidates.length} live channels are named "${plan.name}" (${candidates
					.map(channel => channel.id)
					.join(", ")}); pick one and put its id in CHANNEL_IDS`,
			);
			continue;
		}
		const adopted = candidates[0];
		if (adopted) {
			channelsByKey.set(plan.key, adopted);
			notes.push(
				`adopted existing #${adopted.name} (${adopted.id}) for layout entry "${plan.key}" instead of creating a ` +
					"second one; put that id in CHANNEL_IDS so the match stops depending on the name",
			);
		}
	}

	const categoriesByKey = new Map<string, LiveChannel>();
	for (const spec of layout.categories) {
		if (spec.id) {
			const channel = live.get(spec.id);
			if (!channel) record(`category "${spec.key}"`, `maps ${spec.id}, which is not in the guild`);
			else if (channel.type !== CHANNEL_TYPE.category)
				record(`category "${spec.key}"`, `maps ${spec.id}, which is channel type ${channel.type}, not a category`);
			else categoriesByKey.set(spec.key, channel);
			continue;
		}
		const candidates = [...live.values()].filter(
			channel => channel.type === CHANNEL_TYPE.category && channel.name === spec.name,
		);
		if (candidates.length > 1) {
			record(
				`category "${spec.key}"`,
				`has no id and ${candidates.length} live categories are named "${spec.name}" (${candidates
					.map(channel => channel.id)
					.join(", ")}); pick one and put its id in CATEGORY_IDS`,
			);
			continue;
		}
		const adopted = candidates[0];
		if (adopted) {
			categoriesByKey.set(spec.key, adopted);
			notes.push(
				`adopted existing category "${adopted.name}" (${adopted.id}) for "${spec.key}" instead of creating a ` +
					"second one; put that id in CATEGORY_IDS",
			);
		}
	}

	// Threads are not in GET /guilds/{id}/channels, so each is fetched directly.
	// A vanished thread breaks the archive's meeting-artifact mapping, which is
	// exactly the kind of silent drift this function exists to catch.
	const threadsByKey = new Map<string, LiveThread>();
	const fetched = await Promise.all(
		Object.entries(layout.threadIds).map(async ([key, id]) => {
			try {
				return { key, id, thread: await rest.getChannel(id) };
			} catch (error) {
				return { key, id, error };
			}
		}),
	);
	for (const entry of fetched) {
		if (!entry.thread) {
			const reason = entry.error instanceof Error ? entry.error.message : String(entry.error);
			record(`thread "${entry.key}"`, `maps ${entry.id}, which could not be read: ${reason}`);
			continue;
		}
		if (entry.thread.id !== entry.id) {
			record(`thread "${entry.key}"`, `maps ${entry.id}, which resolved to a different channel`);
			continue;
		}
		threadsByKey.set(entry.key, {
			id: entry.id,
			name: entry.thread.name ?? "",
			parentId: entry.thread.parent_id ?? null,
		});
	}

	if (problems.length > 0) throw new StaleChannelMapError(guildId, problems, keys);
	return { channelsByKey, categoriesByKey, threadsByKey, notes };
}

// ---------------------------------------------------------------------------
// Planning

function planCategories(
	layout: LayoutSpec,
	resolved: ResolvedGuild,
	actions: ProvisionAction[],
	resolvedCategoryIds: Record<string, string>,
): void {
	const existing: { key: string; name: string; channel: LiveChannel; desiredPosition: number }[] = [];
	layout.categories.forEach((spec, index) => {
		const channel = resolved.categoriesByKey.get(spec.key);
		if (!channel) {
			actions.push({ kind: "create-category", key: spec.key, name: spec.name, position: index });
			return;
		}
		resolvedCategoryIds[spec.key] = channel.id;
		existing.push({ key: spec.key, name: spec.name, channel, desiredPosition: index });
	});

	const outOfOrder = groupOutOfOrder(existing);
	for (const entry of existing) {
		const changes: CategoryChanges = {
			...(entry.channel.name === entry.name ? {} : { name: { from: entry.channel.name, to: entry.name } }),
			...(outOfOrder && entry.channel.position !== entry.desiredPosition
				? { position: { from: entry.channel.position, to: entry.desiredPosition } }
				: {}),
		};
		if (Object.keys(changes).length > 0)
			actions.push({ kind: "update-category", key: entry.key, id: entry.channel.id, changes });
	}
}

function planChannels(layout: LayoutSpec, resolved: ResolvedGuild, actions: ProvisionAction[]): void {
	const creates: ProvisionAction[] = [];
	const updates: ProvisionAction[] = [];

	for (const group of groupByCategory(layout.channels)) {
		// `undefined` means the destination category is created by this plan, so
		// every child moves. `null` means the guild root, which is a real value.
		const desiredParentId: string | null | undefined = group.categoryKey
			? resolved.categoriesByKey.get(group.categoryKey)?.id
			: null;

		// Only channels already sitting in the destination can be judged on
		// relative order; anything created or reparented is moving regardless
		// and carries its position in that same request. Channels the layout
		// does not name are never in this list, which is what makes a
		// runtime-created session channel invisible to reordering.
		const settled: { key: string; channel: LiveChannel; desiredPosition: number }[] = [];
		group.plans.forEach((plan, index) => {
			const channel = resolved.channelsByKey.get(plan.key);
			if (channel && (channel.parentId ?? null) === desiredParentId)
				settled.push({ key: plan.key, channel, desiredPosition: index });
		});
		const outOfOrder = groupOutOfOrder(settled);

		group.plans.forEach((plan, index) => {
			const channel = resolved.channelsByKey.get(plan.key);
			const isVoice = plan.type === "voice";
			if (!channel) {
				creates.push({
					kind: "create-channel",
					key: plan.key,
					name: plan.name,
					channelType: isVoice ? CHANNEL_TYPE.voice : CHANNEL_TYPE.text,
					parentKey: group.categoryKey,
					// Voice channels have no topic field; sending one is a 400.
					topic: isVoice ? null : plan.topic,
					position: index,
				});
				return;
			}
			const parentMoved = desiredParentId === undefined || (channel.parentId ?? null) !== desiredParentId;
			const changes: ChannelChanges = {
				...(channel.name === plan.name ? {} : { name: { from: channel.name, to: plan.name } }),
				...(parentMoved ? { parent: { fromId: channel.parentId, toKey: group.categoryKey } } : {}),
				...(parentMoved || (outOfOrder && channel.position !== index)
					? { position: { from: channel.position, to: index } }
					: {}),
				...(isVoice || channel.topic === plan.topic ? {} : { topic: { from: channel.topic, to: plan.topic } }),
			};
			if (Object.keys(changes).length > 0)
				updates.push({ kind: "update-channel", key: plan.key, id: channel.id, changes });
		});
	}

	// Categories must exist before a channel can be parented into one, and
	// creates before updates so a reorder lands after every sibling is present.
	actions.push(...creates, ...updates);
}

async function planSeeds(
	rest: DiscordRestClient,
	layout: LayoutSpec,
	resolved: ResolvedGuild,
	botUserId: string,
	actions: ProvisionAction[],
	notes: string[],
): Promise<void> {
	for (const plan of layout.channels) {
		const body = SEED_CONTENT[plan.key];
		if (body === undefined) continue;
		if (body.length > MAX_MESSAGE_CHARS)
			throw new Error(`seed content for ${plan.key} is ${body.length} chars, over Discord's ${MAX_MESSAGE_CHARS}`);

		const channel = resolved.channelsByKey.get(plan.key);
		if (!channel) {
			actions.push({ kind: "post-seed", key: plan.key, channelId: null, body });
			continue;
		}
		const seed = await readSeedState(rest, channel.id, botUserId);
		if (!seed.messageId) {
			actions.push({ kind: "post-seed", key: plan.key, channelId: channel.id, body });
			continue;
		}
		if (!seed.pinned) {
			notes.push(
				`#${plan.name}: seed message ${seed.messageId} exists but is not pinned, so it was matched from channel ` +
					"history instead. Discord refuses the pin while MANAGE_MESSAGES is missing; re-invite the bot and " +
					"pin it by hand, or rerun --apply once the permission is there.",
			);
		}
		if (seed.body === body) continue;
		if (!seed.bodyReadable) {
			// Editing blind every run would spam edits forever and reposting
			// would duplicate the seed, so do neither and say why.
			notes.push(
				`#${plan.name}: a bot-authored seed message (${seed.messageId}) exists but Discord returned an empty ` +
					"body for it, so it cannot be compared to the current seed text. That is the MESSAGE_CONTENT " +
					"privileged intent being off, not an empty message. Enable the intent to make seed drift visible.",
			);
			continue;
		}
		actions.push({ kind: "edit-seed", key: plan.key, channelId: channel.id, messageId: seed.messageId, body });
	}
}

/**
 * Copy each mapped thread's messages into its parent channel as ordinary
 * messages. The bot posts under its own identity, so a one-line header carries
 * the original thread, author, and timestamp -- that header is the only thing
 * preserving attribution, and it also carries the marker the next run uses to
 * recognise work it already did. The source thread is never touched.
 */
async function planFlatten(
	rest: DiscordRestClient,
	layout: LayoutSpec,
	resolved: ResolvedGuild,
	botUserId: string,
	actions: ProvisionAction[],
	notes: string[],
): Promise<void> {
	const alreadyFlattenedByChannel = new Map<string, ReadonlySet<string>>();

	for (const key of Object.keys(layout.threadIds).sort()) {
		const thread = resolved.threadsByKey.get(key);
		if (!thread) continue;
		if (!thread.parentId) {
			notes.push(`thread "${key}" (${thread.id}) has no parent channel, so there is nowhere to flatten it into`);
			continue;
		}

		let flattened = alreadyFlattenedByChannel.get(thread.parentId);
		if (!flattened) {
			flattened = await readFlattenedThreadIds(rest, thread.parentId, botUserId);
			alreadyFlattenedByChannel.set(thread.parentId, flattened);
		}
		if (flattened.has(thread.id)) {
			notes.push(`thread "${key}" (${thread.id}) is already flattened into channel ${thread.parentId}; skipped`);
			continue;
		}

		const messages = await readChannelMessages(rest, thread.id);
		// Other bots are content here: every archived meeting message was posted
		// by the note-taker bot. Only this bot's own messages are excluded, so a
		// flatten can never feed on its own output.
		const source = messages.filter(
			message => message.authorId !== botUserId && CONVERSATIONAL_MESSAGE_TYPES[String(message.type)],
		);
		if (source.length === 0) {
			notes.push(`thread "${key}" (${thread.id}) has no conversational messages to flatten`);
			continue;
		}
		if (source.every(message => message.content.trim().length === 0))
			throw new EmptyThreadContentError(thread.id, thread.name, source.length);

		const posts: string[] = [];
		for (const message of source) {
			if (message.content.trim().length === 0) {
				notes.push(
					`thread "${key}" message ${message.id} has an empty body and was not reposted; enable ` +
						"MESSAGE_CONTENT and rerun to include it",
				);
				continue;
			}
			posts.push(...flattenPosts(thread, message));
		}

		actions.push({
			kind: "flatten-thread",
			key,
			threadId: thread.id,
			threadName: thread.name,
			channelId: thread.parentId,
			sourceMessageCount: source.length,
			posts,
		});
	}
}

/** One flattened message, chunked if the original does not fit beside its header. */
function flattenPosts(thread: LiveThread, message: ChannelMessage): string[] {
	const header =
		`\`${FLATTEN_MARKER_PREFIX}${thread.id}\` **${message.author}** in thread ` +
		`*${truncate(thread.name, FLATTEN_NAME_LIMIT)}* at ${message.timestamp}`;
	const body = message.content.trimEnd();
	if (header.length + 1 + body.length <= MAX_MESSAGE_CHARS) return [`${header}\n${body}`];

	const budget = MAX_MESSAGE_CHARS - header.length - FLATTEN_PART_RESERVE - 1;
	if (budget < 64) throw new Error(`flatten header for thread ${thread.id} leaves no room for the message body`);
	const chunks: string[] = [];
	let remaining = body;
	while (remaining.length > budget) {
		let cut = remaining.lastIndexOf("\n", budget);
		if (cut < budget / 2) cut = remaining.lastIndexOf(" ", budget);
		if (cut < budget / 2) cut = budget;
		chunks.push(remaining.slice(0, cut));
		remaining = remaining.slice(cut).replace(/^[\n ]/, "");
	}
	chunks.push(remaining);
	return chunks.map((chunk, index) => `${header} (part ${index + 1}/${chunks.length})\n${chunk}`);
}

/** Thread ids this bot has already flattened into a channel, read from its own headers. */
async function readFlattenedThreadIds(
	rest: DiscordRestClient,
	channelId: string,
	botUserId: string,
): Promise<ReadonlySet<string>> {
	const flattened = new Set<string>();
	for (const message of await readChannelMessages(rest, channelId)) {
		if (message.authorId !== botUserId) continue;
		const marker = message.content.indexOf(FLATTEN_MARKER_PREFIX);
		if (marker < 0) continue;
		const id = message.content.slice(marker + FLATTEN_MARKER_PREFIX.length).match(/^\d+/);
		if (id) flattened.add(id[0]);
	}
	return flattened;
}

/** Every message in a channel or thread, oldest first. */
async function readChannelMessages(rest: DiscordRestClient, channelId: string): Promise<ChannelMessage[]> {
	const collected: ChannelMessage[] = [];
	let before: string | undefined;
	for (let page = 0; page < MAX_MESSAGE_PAGES; page++) {
		const batch = await rest.getMessages(channelId, {
			limit: MAX_MESSAGE_PAGE,
			...(before ? { before } : {}),
		});
		for (const raw of batch) collected.push(toChannelMessage(raw));
		if (batch.length < MAX_MESSAGE_PAGE) {
			return collected.sort((left, right) => compareSnowflakes(left.id, right.id));
		}
		before = collected[collected.length - 1]?.id;
		if (!before) break;
	}
	throw new Error(
		`channel ${channelId} has more than ${MAX_MESSAGE_PAGES * MAX_MESSAGE_PAGE} messages; refusing to guess at ` +
			"the rest, because a missed marker would repost content that is already there",
	);
}

/**
 * Whether this channel already holds the bot's seed message.
 *
 * A pin is checked first because it is the cheap answer, but existence must NOT
 * rest on it: `pinMessage` returns false when MANAGE_MESSAGES is missing, which
 * it is today, and a permanently unpinnable seed would read as absent and be
 * reposted on every single run. So the fallback is any bot-authored message in
 * the channel -- a seed channel is a bot-owned feed, so that is the seed.
 */
async function readSeedState(rest: DiscordRestClient, channelId: string, botUserId: string): Promise<SeedState> {
	const pinned = (await rest.getPinnedMessages(channelId)).filter(message => message.author?.id === botUserId);
	// Oldest wins: the seed is create-once, so a later bot message is something else.
	pinned.sort((left, right) => compareSnowflakes(left.id, right.id));
	const seed = pinned[0] ?? (await oldestBotMessage(rest, channelId, botUserId));
	if (!seed) return { messageId: null, pinned: false, bodyReadable: true, body: "" };
	return {
		messageId: seed.id,
		pinned: pinned.length > 0,
		bodyReadable: seed.content.length > 0,
		body: seed.content,
	};
}

async function oldestBotMessage(
	rest: DiscordRestClient,
	channelId: string,
	botUserId: string,
): Promise<DiscordMessage | undefined> {
	const mine = (await rest.getMessages(channelId, { limit: MAX_MESSAGE_PAGE })).filter(
		message => message.author?.id === botUserId,
	);
	mine.sort((left, right) => compareSnowflakes(left.id, right.id));
	return mine[0];
}

/**
 * Whether these channels are in the wrong relative order. Discord normalises
 * absolute `position` numbers server-side, so comparing a live position against
 * a declared one makes every run emit patches forever. Relative order among the
 * layout's own channels is the only meaningful thing, and the only thing
 * checked here.
 *
 * The answer covers the whole group rather than individual members: patching
 * only the mismatched ones can leave a kept member's untouched high position
 * behind the freshly assigned dense ones. The caller renumbers every member
 * whose position is not already its target, which lands the group on a dense
 * 0..n-1 sequence and converges in one run.
 */
function groupOutOfOrder(settled: readonly { key: string; channel: LiveChannel; desiredPosition: number }[]): boolean {
	const desired = [...settled].sort((left, right) => left.desiredPosition - right.desiredPosition);
	const current = [...settled].sort(
		(left, right) =>
			left.channel.position - right.channel.position || compareSnowflakes(left.channel.id, right.channel.id),
	);
	return desired.some((entry, index) => current[index]?.key !== entry.key);
}

function groupByCategory(
	channels: readonly ChannelPlan[],
): { categoryKey: CategoryKey | null; plans: ChannelPlan[] }[] {
	const groups = new Map<CategoryKey | null, ChannelPlan[]>();
	for (const plan of channels) {
		const bucket = groups.get(plan.category);
		if (bucket) bucket.push(plan);
		else groups.set(plan.category, [plan]);
	}
	return [...groups.entries()].map(([categoryKey, plans]) => ({
		categoryKey,
		plans: [...plans].sort((left, right) => left.position - right.position),
	}));
}

// ---------------------------------------------------------------------------
// Permissions

async function preflightPermissions(
	rest: DiscordRestClient,
	guildId: string,
	botUserId: string,
): Promise<PermissionPreflight> {
	const roles = await rest.getGuildRoles(guildId);
	const member = await rest.getGuildMember(guildId, botUserId);

	const rolePermissions = new Map(roles.map(role => [role.id, parseBigInt(role.permissions)]));
	// The @everyone role always carries the guild's own id.
	let effective = rolePermissions.get(guildId) ?? 0n;
	for (const roleId of member.roles) effective |= rolePermissions.get(roleId) ?? 0n;

	const administrator = ((effective >> ADMINISTRATOR_BIT) & 1n) === 1n;
	const missing = administrator
		? []
		: MUTATING_PERMISSIONS.filter(entry => ((effective >> BigInt(entry.bit)) & 1n) === 0n);
	return { effective, administrator, missing, reinvitePermissions: REQUIRED_PERMISSIONS.toString() };
}

// ---------------------------------------------------------------------------
// Category resolution and rendering

function resolveCategory(categoryIds: Readonly<Record<string, string>>, key: CategoryKey): string {
	const id = categoryIds[key];
	if (!id) throw new Error(`category ${key} has no id: its create-category action did not run`);
	return id;
}

function describeCategoryChanges(changes: CategoryChanges): string {
	const parts: string[] = [];
	if (changes.name) parts.push(`name "${changes.name.from}" -> "${changes.name.to}"`);
	if (changes.position) parts.push(`position ${changes.position.from} -> ${changes.position.to}`);
	return parts.join(", ");
}

function describeChannelChanges(changes: ChannelChanges): string {
	const parts: string[] = [];
	if (changes.name) parts.push(`name "${changes.name.from}" -> "${changes.name.to}"`);
	if (changes.parent)
		parts.push(`category ${changes.parent.fromId ?? "(none)"} -> ${changes.parent.toKey ?? "(none)"}`);
	if (changes.position) parts.push(`position ${changes.position.from} -> ${changes.position.to}`);
	if (changes.topic) parts.push(`topic "${truncate(changes.topic.from, 30)}" -> "${truncate(changes.topic.to, 40)}"`);
	return parts.join(", ");
}

function truncate(value: string, limit: number): string {
	return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
}

// ---------------------------------------------------------------------------
// Response parsing

function toLiveChannel(channel: DiscordChannel): LiveChannel {
	return {
		id: channel.id,
		name: channel.name ?? "",
		type: channel.type ?? GUILD_TEXT_CHANNEL,
		parentId: channel.parent_id ?? null,
		position: channel.position ?? 0,
		topic: channel.topic ?? "",
	};
}

function toChannelMessage(message: DiscordMessage): ChannelMessage {
	const parsed = new Date(message.timestamp);
	return {
		id: message.id,
		authorId: message.author?.id ?? "",
		author: message.author?.global_name || message.author?.username || message.author?.id || "",
		authorIsBot: message.author?.bot === true,
		type: message.type ?? 0,
		timestamp: Number.isNaN(parsed.getTime()) ? message.timestamp : parsed.toISOString(),
		content: message.content,
	};
}

function parseBigInt(value: string): bigint {
	return /^\d+$/.test(value) ? BigInt(value) : 0n;
}

function compareSnowflakes(left: string, right: string): number {
	const a = parseBigInt(left);
	const b = parseBigInt(right);
	return a < b ? -1 : a > b ? 1 : 0;
}

function requireSnowflake(value: string, label: string): string {
	if (!/^\d+$/.test(value)) throw new Error(`${label} did not come back with a snowflake id`);
	return value;
}
