import { describe, expect, test } from "bun:test";
import { MAX_MESSAGE_CHARS } from "../src/bridge-protocol";
import {
	CATEGORIES_TO_CREATE,
	CATEGORY_IDS,
	CATEGORY_NAMES,
	CATEGORY_ORDER,
	type CategoryKey,
	CREATED_CATEGORY_NAMES,
	CHANNEL_IDS,
	type ChannelPlan,
	KNOWN_THREAD_IDS,
	REQUIRED_PERMISSIONS,
	TARGET_LAYOUT,
} from "../src/channels";
import {
	applyProvision,
	assertNoDeletes,
	EmptyThreadContentError,
	type LayoutSpec,
	PermissionPreflightError,
	planProvision,
	type ProvisionAction,
	type ProvisionPlan,
	SEED_CONTENT,
	StaleChannelMapError,
} from "../src/provision";
import { runProvisionCli } from "../src/provision-cli";
import { type DiscordMessage, type DiscordRestClient } from "../src/discord-rest";

const GUILD = "900000000000000001";
const BOT = "900000000000000002";
const HUMAN = "900000000000000003";
const NOTE_TAKER = "900000000000000004";
const MANAGE_CHANNELS = 1n << 4n;
const MANAGE_MESSAGES = 1n << 13n;
const MANAGE_THREADS = 1n << 34n;
const ALL_MUTATING = MANAGE_CHANNELS | MANAGE_MESSAGES | MANAGE_THREADS;

interface FakeChannel {
	id: string;
	name: string;
	type: number;
	parent_id: string | null;
	position: number;
	topic?: string;
}

interface FakeMessage {
	id: string;
	content: string;
	authorId: string;
	channelId?: string;
	authorName?: string;
	authorIsBot?: boolean;
	type?: number;
	timestamp?: string;
	pinned?: boolean;
	embedCount?: number;
}

interface FakeThread {
	id: string;
	name: string;
	parent_id: string | null;
}

/** Calls that change the guild. A dry run must make none of them. */
const WRITE_OPERATIONS: Readonly<Record<string, true>> = {
	createMessage: true,
	editMessage: true,
	createChannel: true,
	modifyChannel: true,
	pinMessage: true,
	addReaction: true,
};

interface FakeGuild {
	rest: DiscordRestClient;
	channels: Map<string, FakeChannel>;
	messages: Map<string, FakeMessage[]>;
	/** Every client method called, in order. */
	calls: string[];
	writes: () => string[];
}

/**
 * An in-memory guild behind the real `DiscordRestClient`. It mutates on write
 * calls, which is what lets a plan be applied and then re-planned to prove
 * idempotency, and it throws on anything provisioning should never call.
 */
function fakeGuild(options: {
	channels: FakeChannel[];
	permissions?: bigint;
	messages?: Record<string, FakeMessage[]>;
	threads?: FakeThread[];
	/** Simulates the live guild: no MANAGE_MESSAGES, so Discord refuses every pin. */
	refusePins?: boolean;
}): FakeGuild {
	const channels = new Map(options.channels.map(channel => [channel.id, { ...channel }]));
	const messages = new Map(
		Object.entries(options.messages ?? {}).map(([id, list]) => [id, list.map(message => ({ ...message }))]),
	);
	const threads = new Map((options.threads ?? []).map(thread => [thread.id, thread]));
	const calls: string[] = [];
	const permissions = options.permissions ?? ALL_MUTATING;
	let nextId = 950000000000000000n;

	const asApiMessage = (message: FakeMessage): DiscordMessage => ({
		id: message.id,
		channel_id: message.channelId ?? "",
		content: message.content,
		type: message.type ?? 0,
		timestamp: message.timestamp ?? "2026-08-27T20:00:00.000000+00:00",
		author: {
			id: message.authorId,
			username: (message.authorName ?? "someone").toLowerCase(),
			global_name: message.authorName ?? "Someone",
			bot: message.authorIsBot ?? message.authorId === BOT,
		},
		embeds: Array.from({ length: message.embedCount ?? 0 }, () => ({})),
	});
	const requireChannel = (channelId: string): FakeChannel => {
		const found = channels.get(channelId);
		if (!found) throw new Error(`Unknown Channel (${channelId})`);
		return found;
	};

	const rest: DiscordRestClient = {
		async getApplication() {
			calls.push("getApplication");
			return { id: "1542714531409821726", flags: 0, bot: { id: BOT, username: "cloudcastledevbot" } };
		},
		async getGuildRoles(guildId) {
			calls.push("getGuildRoles");
			return [{ id: guildId, name: "@everyone", permissions: permissions.toString() }];
		},
		async getGuildMember() {
			calls.push("getGuildMember");
			return { roles: [] };
		},
		async getGuildChannels() {
			calls.push("getGuildChannels");
			return [...channels.values()].map(channel => ({ ...channel }));
		},
		async getChannel(channelId) {
			calls.push(`getChannel:${channelId}`);
			const thread = threads.get(channelId);
			if (thread) return { ...thread, type: 11 };
			return { ...requireChannel(channelId) };
		},
		async getMessages(channelId, pageOptions = {}) {
			calls.push(`getMessages:${channelId}`);
			const newestFirst = [...(messages.get(channelId) ?? [])].sort((left, right) =>
				BigInt(left.id) < BigInt(right.id) ? 1 : -1,
			);
			const before = pageOptions.before;
			const page = before ? newestFirst.filter(message => BigInt(message.id) < BigInt(before)) : newestFirst;
			return page.slice(0, pageOptions.limit ?? 100).map(asApiMessage);
		},
		async getPinnedMessages(channelId) {
			calls.push(`getPinnedMessages:${channelId}`);
			return (messages.get(channelId) ?? []).filter(message => message.pinned).map(asApiMessage);
		},
		async createChannel(_guildId, createOptions) {
			calls.push("createChannel");
			const created: FakeChannel = {
				id: (nextId++).toString(),
				name: createOptions.name,
				type: createOptions.type ?? 0,
				parent_id: createOptions.parentId ?? null,
				position: createOptions.position ?? 0,
				...(createOptions.topic === undefined ? {} : { topic: createOptions.topic }),
			};
			channels.set(created.id, created);
			return { ...created };
		},
		async modifyChannel(channelId, modifyOptions) {
			calls.push(`modifyChannel:${channelId}`);
			const found = requireChannel(channelId);
			if (modifyOptions.name !== undefined) found.name = modifyOptions.name;
			if (modifyOptions.topic !== undefined) found.topic = modifyOptions.topic;
			if (modifyOptions.position !== undefined) found.position = modifyOptions.position;
			if (modifyOptions.parentId !== undefined) found.parent_id = modifyOptions.parentId;
			return { ...found };
		},
		async createMessage(channelId, payload) {
			calls.push(`createMessage:${channelId}`);
			const created: FakeMessage = {
				id: (nextId++).toString(),
				channelId,
				content: payload.content ?? "",
				authorId: BOT,
				authorName: "cloudcastledevbot",
				authorIsBot: true,
				pinned: false,
			};
			messages.set(channelId, [...(messages.get(channelId) ?? []), created]);
			return asApiMessage(created);
		},
		async editMessage(channelId, messageId, payload) {
			calls.push(`editMessage:${channelId}`);
			const message = (messages.get(channelId) ?? []).find(entry => entry.id === messageId);
			if (!message) throw new Error(`Unknown Message (${messageId})`);
			message.content = payload.content ?? "";
			return asApiMessage(message);
		},
		async pinMessage(channelId, messageId) {
			calls.push(`pinMessage:${channelId}`);
			if (options.refusePins) return false;
			const message = (messages.get(channelId) ?? []).find(entry => entry.id === messageId);
			if (!message) throw new Error(`Unknown Message (${messageId})`);
			message.pinned = true;
			return true;
		},
		async addReaction() {
			throw new Error("provision must never react to a message");
		},
	};
	return {
		rest,
		channels,
		messages,
		calls,
		writes: () => calls.filter(call => WRITE_OPERATIONS[call.split(":")[0] ?? ""] === true),
	};
}

function channelPlan(overrides: Partial<ChannelPlan> & { key: string }): ChannelPlan {
	return {
		id: null,
		name: overrides.key,
		category: null,
		role: "feed",
		type: "text",
		topic: `topic for ${overrides.key}`,
		position: 0,
		...overrides,
	};
}

/**
 * A small layout that still exercises every shape provision handles: a mapped
 * category, one that has to be created, a reparent, a rename, a channel to
 * create, and both seed channels.
 */
function smallLayout(overrides: Partial<LayoutSpec> = {}): LayoutSpec {
	return {
		channels: [
			channelPlan({ key: "howWeWork", name: "how-we-work", position: 0 }),
			channelPlan({ key: "git", id: "100", name: "git", category: "devFeed", position: 0 }),
			channelPlan({ key: "updates", id: "101", name: "updates", category: "devFeed", position: 1 }),
			channelPlan({ key: "archiveNotice", name: "archive-notice", category: "archive", position: 0 }),
		],
		categories: [
			{ key: "devFeed", id: "200", name: "dev feed" },
			{ key: "archive", id: null, name: "archive" },
		],
		threadIds: { equityStructure: "300" },
		...overrides,
	};
}

function baseChannels(): FakeChannel[] {
	return [
		{ id: "200", name: "chudcode", type: 4, parent_id: null, position: 0 },
		{ id: "100", name: "git", type: 0, parent_id: "200", position: 0, topic: "topic for git" },
		{ id: "101", name: "updates", type: 0, parent_id: null, position: 3, topic: "" },
	];
}

/** The error a call rejected with; fails the test if it resolved instead. */
async function rejection(call: Promise<unknown>): Promise<Error> {
	try {
		await call;
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
	throw new Error("expected the call to reject, but it resolved");
}

const KNOWN_THREAD: FakeThread = { id: "300", name: "Equity Structure", parent_id: "100" };

/**
 * The real `channels.ts` layout materialised in its finished state, including
 * pinned seeds. Used by the CLI tests, which drive the production layout rather
 * than an injected one and so need a guild that satisfies it.
 */
function productionGuild(options: { permissions?: bigint } = {}): FakeGuild {
	let synthetic = 990000000000000000n;
	const channels: FakeChannel[] = [
		...CATEGORY_ORDER.map((key, index) => ({
			id: CATEGORY_IDS[key],
			name: CATEGORY_NAMES[key],
			type: 4,
			parent_id: null,
			position: index,
		})),
		// The session categories now carry recorded ids, so a finished guild must
		// present those exact ids: provision hard-errors on a mapped id that is not
		// in the guild rather than re-creating it, which is the behaviour that
		// caught this fixture when the ids were added.
		...CATEGORIES_TO_CREATE.map((key, index) => ({
			id: CATEGORY_IDS[key],
			name: CREATED_CATEGORY_NAMES[key],
			type: 4,
			parent_id: null,
			position: CATEGORY_ORDER.length + index,
		})),
	];
	const messages: Record<string, FakeMessage[]> = {};
	for (const plan of TARGET_LAYOUT) {
		const id = plan.id ?? (synthetic++).toString();
		channels.push({
			id,
			name: plan.name,
			type: plan.type === "voice" ? 2 : 0,
			parent_id: plan.category ? CATEGORY_IDS[plan.category] : null,
			position: plan.position,
			...(plan.type === "voice" ? {} : { topic: plan.topic }),
		});
		const seed = SEED_CONTENT[plan.key];
		if (seed) messages[id] = [{ id: (synthetic++).toString(), content: seed, authorId: BOT, pinned: true }];
	}
	return fakeGuild({
		channels,
		messages,
		threads: Object.values(KNOWN_THREAD_IDS).map(id => ({
			id,
			name: `thread ${id}`,
			parent_id: CHANNEL_IDS.meetingTranscripts,
		})),
		...(options.permissions === undefined ? {} : { permissions: options.permissions }),
	});
}

describe("channels.ts contract", () => {
	test("every mapped channel id appears in TARGET_LAYOUT so nothing is orphaned", () => {
		const laidOut = new Set(TARGET_LAYOUT.map(plan => plan.id).filter((id): id is string => id !== null));
		for (const [key, id] of Object.entries(CHANNEL_IDS)) {
			expect(laidOut.has(id), `CHANNEL_IDS.${key} (${id}) is not in TARGET_LAYOUT`).toBe(true);
		}
		// CATEGORY_IDS holds two kinds of category now: the laid-out ones, whose
		// name comes from CATEGORY_NAMES and whose order comes from CATEGORY_ORDER,
		// and the two session categories provision created, named by
		// CREATED_CATEGORY_NAMES and deliberately absent from the sidebar order.
		// The invariant is that every mapped category is named by exactly one of
		// those sources -- neither both nor neither.
		for (const key of Object.keys(CATEGORY_IDS)) {
			const laidOutName = (CATEGORY_NAMES as Record<string, string | undefined>)[key];
			const createdName = (CREATED_CATEGORY_NAMES as Record<string, string | undefined>)[key];
			const inOrder = (CATEGORY_ORDER as readonly string[]).includes(key);
			const isCreated = (CATEGORIES_TO_CREATE as readonly string[]).includes(key);
			expect(inOrder === isCreated, `CATEGORY_IDS.${key} must be laid out or created, not both`).toBe(
				false,
			);
			expect(laidOutName ?? createdName, `CATEGORY_IDS.${key} has no name`).toBeTruthy();
			if (inOrder) expect(laidOutName).toBeTruthy();
			if (isCreated) expect(createdName).toBeTruthy();
		}
		for (const key of CATEGORY_ORDER) expect(CATEGORY_NAMES[key]).toBeTruthy();
	});

	test("seed bodies fit in one Discord message and say where the archive is", () => {
		for (const [key, body] of Object.entries(SEED_CONTENT)) {
			expect(body.length, `${key} seed is ${body.length} chars`).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
			expect(body.length).toBeGreaterThan(200);
		}
		expect(SEED_CONTENT["archiveNotice"]).toContain("docs/meeting, 8-27/discord-server-export/");
		expect(SEED_CONTENT["archiveNotice"]).toContain("Nothing was deleted");
		expect(SEED_CONTENT["archiveNotice"]).toContain("MESSAGE_CONTENT");
	});
});

describe("planProvision reconciliation", () => {
	test("a mapped channel id that is gone is a hard error naming the key", async () => {
		const guild = fakeGuild({
			channels: baseChannels().filter(channel => channel.id !== "101"),
			threads: [KNOWN_THREAD],
		});
		const failure = await rejection(planProvision({ rest: guild.rest, guildId: GUILD, layout: smallLayout() }));
		expect(failure).toBeInstanceOf(StaleChannelMapError);
		expect(failure.message).toContain('channel "updates" maps 101, which is not in the guild');
		expect((failure as StaleChannelMapError).keys).toEqual(['channel "updates"']);
		expect(guild.writes()).toEqual([]);
	});

	test("a mapped category id that is not a category is a hard error", async () => {
		const channels = baseChannels();
		const category = channels.find(channel => channel.id === "200");
		if (category) category.type = 0;
		const guild = fakeGuild({ channels, threads: [KNOWN_THREAD] });
		const failure = await rejection(planProvision({ rest: guild.rest, guildId: GUILD, layout: smallLayout() }));
		expect(failure).toBeInstanceOf(StaleChannelMapError);
		expect(failure.message).toContain('category "devFeed" maps 200, which is channel type 0, not a category');
	});

	test("a mapped thread that cannot be read is a hard error", async () => {
		const guild = fakeGuild({ channels: baseChannels(), threads: [] });
		const failure = await rejection(planProvision({ rest: guild.rest, guildId: GUILD, layout: smallLayout() }));
		expect(failure).toBeInstanceOf(StaleChannelMapError);
		expect(failure.message).toContain('thread "equityStructure" maps 300, which could not be read');
	});

	test("an unmapped layout entry adopts the one live channel with that name", async () => {
		const channels = baseChannels();
		channels.push({ id: "150", name: "how-we-work", type: 0, parent_id: null, position: 1, topic: "" });
		const guild = fakeGuild({ channels, threads: [KNOWN_THREAD] });
		const plan = await planProvision({ rest: guild.rest, guildId: GUILD, layout: smallLayout() });

		expect(plan.actions.map(action => `${action.kind}:${action.key}`)).not.toContain("create-channel:howWeWork");
		expect(plan.actions).toContainEqual({
			kind: "update-channel",
			key: "howWeWork",
			id: "150",
			changes: { topic: { from: "", to: "topic for howWeWork" } },
		});
		expect(plan.notes.join("\n")).toContain("adopted existing #how-we-work (150)");
	});

	test("two live channels with the target name are ambiguous, not a coin flip", async () => {
		const channels = baseChannels();
		channels.push({ id: "150", name: "how-we-work", type: 0, parent_id: null, position: 1 });
		channels.push({ id: "151", name: "how-we-work", type: 0, parent_id: "200", position: 9 });
		const guild = fakeGuild({ channels, threads: [KNOWN_THREAD] });
		const failure = await rejection(planProvision({ rest: guild.rest, guildId: GUILD, layout: smallLayout() }));
		expect(failure).toBeInstanceOf(StaleChannelMapError);
		expect(failure.message).toContain('2 live channels are named "how-we-work" (150, 151)');
	});
});

describe("planProvision then applyProvision", () => {
	test("creates, renames, reparents, seeds, and is empty on a second run", async () => {
		const guild = fakeGuild({ channels: baseChannels(), threads: [KNOWN_THREAD] });
		const layout = smallLayout();
		const first = await planProvision({ rest: guild.rest, guildId: GUILD, layout });

		expect(first.permissions.missing).toEqual([]);
		expect(first.actions.map(action => `${action.kind}:${action.key}`)).toEqual([
			"create-category:archive",
			"update-category:devFeed",
			"create-channel:howWeWork",
			"create-channel:archiveNotice",
			"update-channel:updates",
			"post-seed:howWeWork",
			"post-seed:archiveNotice",
		]);

		const report = await applyProvision(first, { rest: guild.rest });
		expect(report.requests.map(request => request.operation)).toEqual([
			"createChannel",
			"modifyChannel",
			"createChannel",
			"createChannel",
			"modifyChannel",
			"createMessage",
			"pinMessage",
			"createMessage",
			"pinMessage",
		]);
		expect(Object.keys(report.createdCategoryIds)).toEqual(["archive"]);
		expect(Object.keys(report.createdChannelIds)).toEqual(["howWeWork", "archiveNotice"]);

		expect(guild.channels.get("200")?.name).toBe("dev feed");
		expect(guild.channels.get("101")?.parent_id).toBe("200");
		const seeded = report.createdChannelIds["howWeWork"] ?? "";
		expect(guild.messages.get(seeded)?.[0]).toMatchObject({ content: SEED_CONTENT["howWeWork"], pinned: true });

		// The same unchanged layout, re-planned against the mutated guild. The
		// created channels are adopted by name, so nothing is created twice.
		const second = await planProvision({ rest: guild.rest, guildId: GUILD, layout });
		expect(second.actions).toEqual([]);
		expect(second.notes.every(note => note.startsWith("adopted existing"))).toBe(true);
		expect(await applyProvision(second, { rest: guild.rest })).toMatchObject({ requests: [] });
	});

	test("no request in a full run is a deletion", async () => {
		const guild = fakeGuild({ channels: baseChannels(), threads: [KNOWN_THREAD] });
		const plan = await planProvision({ rest: guild.rest, guildId: GUILD, layout: smallLayout() });
		const report = await applyProvision(plan, { rest: guild.rest });
		expect(report.requests.length).toBeGreaterThan(0);
		for (const request of report.requests)
			expect(["createChannel", "modifyChannel", "createMessage", "editMessage", "pinMessage"]).toContain(
				request.operation,
			);
	});

	test("an out-of-order category is renumbered and converges", async () => {
		const channels = baseChannels();
		channels.push({ id: "201", name: "archive", type: 4, parent_id: null, position: 0 });
		const category = channels.find(channel => channel.id === "200");
		if (category) category.position = 7;
		const guild = fakeGuild({ channels, threads: [KNOWN_THREAD] });
		const layout = smallLayout({
			categories: [
				{ key: "devFeed", id: "200", name: "dev feed" },
				{ key: "archive", id: "201", name: "archive" },
			],
		});

		const plan = await planProvision({ rest: guild.rest, guildId: GUILD, layout });
		expect(
			plan.actions.filter(action => action.kind === "update-category").map(action => action.key),
		).toEqual(["devFeed", "archive"]);

		await applyProvision(plan, { rest: guild.rest });
		expect(guild.channels.get("200")?.position).toBe(0);
		expect(guild.channels.get("201")?.position).toBe(1);
		expect((await planProvision({ rest: guild.rest, guildId: GUILD, layout })).actions).toEqual([]);
	});

	test("channels the layout does not name are left alone, even inside a managed category", async () => {
		const channels = baseChannels();
		// Two runtime-created session channels inside a category provision manages.
		channels.push({ id: "700", name: "sess-7f3a-hunter", type: 0, parent_id: "200", position: 5, topic: "live" });
		channels.push({ id: "701", name: "sess-91bc-hunter", type: 0, parent_id: "200", position: 6, topic: "live" });
		const guild = fakeGuild({ channels, threads: [KNOWN_THREAD] });
		const layout = smallLayout();

		const plan = await planProvision({ rest: guild.rest, guildId: GUILD, layout });
		const touched = plan.actions.flatMap(action => ("id" in action && action.id ? [action.id] : []));
		expect(touched).not.toContain("700");
		expect(touched).not.toContain("701");
		expect(plan.notes.join("\n")).not.toContain("sess-");

		await applyProvision(plan, { rest: guild.rest });
		expect(guild.channels.get("700")).toMatchObject({ name: "sess-7f3a-hunter", parent_id: "200", position: 5 });
		expect(guild.channels.get("701")).toMatchObject({ name: "sess-91bc-hunter", parent_id: "200", position: 6 });
		// Their presence must not make the layout look permanently out of date.
		expect((await planProvision({ rest: guild.rest, guildId: GUILD, layout })).actions).toEqual([]);
	});

	test("session categories are created once, then adopted, and their runtime channels stay untouched", async () => {
		const guild = fakeGuild({
			channels: [
				{ id: "200", name: "dev feed", type: 4, parent_id: null, position: 0 },
				{ id: "100", name: "git", type: 0, parent_id: "200", position: 0, topic: "topic for git" },
			],
			threads: [KNOWN_THREAD],
		});
		const layout = smallLayout({
			channels: [channelPlan({ key: "git", id: "100", name: "git", category: "devFeed", position: 0 })],
			categories: [
				{ key: "devFeed", id: "200", name: "dev feed" },
				{ key: "liveSessions", id: null, name: "live sessions" },
				{ key: "doneSessions", id: null, name: "finished sessions" },
			],
		});

		const first = await planProvision({ rest: guild.rest, guildId: GUILD, layout });
		expect(first.actions.map(action => `${action.kind}:${action.key}`)).toEqual([
			"create-category:liveSessions",
			"create-category:doneSessions",
		]);
		const report = await applyProvision(first, { rest: guild.rest });
		const liveSessions = report.createdCategoryIds["liveSessions"] ?? "";
		expect(guild.channels.get(liveSessions)).toMatchObject({ name: "live sessions", type: 4, position: 1 });

		// The bot opens one channel per chudcode session at run time. Those are
		// not in the layout and must never be treated as drift.
		guild.channels.set("700", {
			id: "700",
			name: "sess-7f3a-hunter",
			type: 0,
			parent_id: liveSessions,
			position: 0,
			topic: "live chudcode session 7f3a on hunter-desktop",
		});

		const second = await planProvision({ rest: guild.rest, guildId: GUILD, layout });
		expect(second.actions).toEqual([]);
		await applyProvision(second, { rest: guild.rest });
		expect(guild.channels.get("700")).toMatchObject({
			name: "sess-7f3a-hunter",
			parent_id: liveSessions,
			position: 0,
		});
	});
});

describe("assertNoDeletes", () => {
	function planWithActions(actions: readonly ProvisionAction[]): ProvisionPlan {
		return {
			guildId: GUILD,
			botUserId: BOT,
			botUsername: "cloudcastledevbot",
			permissions: {
				effective: ALL_MUTATING,
				administrator: false,
				missing: [],
				reinvitePermissions: REQUIRED_PERMISSIONS.toString(),
			},
			resolvedCategoryIds: {},
			actions,
			notes: [],
		};
	}

	test("rejects a plan carrying a delete action", () => {
		// Not constructible through ProvisionAction; the cast is the point. The
		// runtime guard is what stops a future kind from slipping through.
		const plan = planWithActions([{ kind: "delete-channel", key: "chat", id: "100" } as unknown as ProvisionAction]);
		expect(() => assertNoDeletes(plan)).toThrow(/delete-channel.*chat.*never delete/s);
	});

	test("accepts every kind the planner can actually produce", async () => {
		const guild = fakeGuild({ channels: baseChannels(), threads: [KNOWN_THREAD] });
		const plan = await planProvision({ rest: guild.rest, guildId: GUILD, layout: smallLayout() });
		expect(() => assertNoDeletes(plan)).not.toThrow();
	});

	test("applyProvision refuses a delete-bearing plan before issuing any request", async () => {
		const guild = fakeGuild({ channels: baseChannels(), threads: [KNOWN_THREAD] });
		const plan = await planProvision({ rest: guild.rest, guildId: GUILD, layout: smallLayout() });
		const tampered: ProvisionPlan = {
			...plan,
			actions: [...plan.actions, { kind: "delete-category", key: "archive" } as unknown as ProvisionAction],
		};
		guild.calls.length = 0;
		await expect(applyProvision(tampered, { rest: guild.rest })).rejects.toThrow(/delete-category/);
		expect(guild.writes()).toEqual([]);
	});
});

describe("permission preflight", () => {
	test("planProvision succeeds read-only and names the missing bits and the re-invite integer", async () => {
		const guild = fakeGuild({ channels: baseChannels(), threads: [KNOWN_THREAD], permissions: 1n << 11n });
		const plan = await planProvision({ rest: guild.rest, guildId: GUILD, layout: smallLayout() });

		expect(plan.permissions.missing.map(entry => entry.bit)).toEqual([4, 13, 34]);
		expect(plan.permissions.missing.map(entry => entry.name)).toEqual([
			"MANAGE_CHANNELS",
			"MANAGE_MESSAGES",
			"MANAGE_THREADS",
		]);
		expect(plan.permissions.reinvitePermissions).toBe(REQUIRED_PERMISSIONS.toString());
		expect(plan.actions.length).toBeGreaterThan(0);

		guild.calls.length = 0;
		const failure = await rejection(applyProvision(plan, { rest: guild.rest }));
		expect(failure).toBeInstanceOf(PermissionPreflightError);
		expect(failure.message).toContain("MANAGE_CHANNELS (bit 4");
		expect(failure.message).toContain(`permissions=${REQUIRED_PERMISSIONS}`);
		expect(guild.writes()).toEqual([]);
	});

	test("ADMINISTRATOR satisfies the preflight", async () => {
		const guild = fakeGuild({ channels: baseChannels(), threads: [KNOWN_THREAD], permissions: 1n << 3n });
		const plan = await planProvision({ rest: guild.rest, guildId: GUILD, layout: smallLayout() });
		expect(plan.permissions.administrator).toBe(true);
		expect(plan.permissions.missing).toEqual([]);
	});

	test("only the missing bits are reported", async () => {
		const guild = fakeGuild({
			channels: baseChannels(),
			threads: [KNOWN_THREAD],
			permissions: MANAGE_CHANNELS | MANAGE_THREADS,
		});
		const plan = await planProvision({ rest: guild.rest, guildId: GUILD, layout: smallLayout() });
		expect(plan.permissions.missing.map(entry => entry.name)).toEqual(["MANAGE_MESSAGES"]);
	});
});

describe("seed content", () => {
	const seedLayout = (): LayoutSpec =>
		smallLayout({
			channels: [
				channelPlan({ key: "howWeWork", id: "400", name: "how-we-work", position: 0 }),
				channelPlan({ key: "git", id: "100", name: "git", category: "devFeed", position: 0 }),
			],
			categories: [{ key: "devFeed", id: "200", name: "dev feed" }],
		});

	// The category already carries its target name so these tests isolate seeding.
	const seedChannels = (): FakeChannel[] => [
		{ id: "200", name: "dev feed", type: 4, parent_id: null, position: 0 },
		{ id: "100", name: "git", type: 0, parent_id: "200", position: 0, topic: "topic for git" },
		{ id: "400", name: "how-we-work", type: 0, parent_id: null, position: 0, topic: "topic for howWeWork" },
	];

	test("an existing bot-authored pin is edited, never reposted", async () => {
		const guild = fakeGuild({
			channels: seedChannels(),
			threads: [KNOWN_THREAD],
			messages: { "400": [{ id: "500", content: "an older draft of how we work", authorId: BOT, pinned: true }] },
		});
		const plan = await planProvision({ rest: guild.rest, guildId: GUILD, layout: seedLayout() });
		expect(plan.actions).toEqual([
			{
				kind: "edit-seed",
				key: "howWeWork",
				channelId: "400",
				messageId: "500",
				body: SEED_CONTENT["howWeWork"] ?? "",
			},
		]);

		const report = await applyProvision(plan, { rest: guild.rest });
		expect(report.requests).toEqual([
			{ operation: "editMessage", target: "400", kind: "edit-seed", key: "howWeWork" },
		]);
		expect(guild.messages.get("400")?.length).toBe(1);
		expect(guild.messages.get("400")?.[0]?.content).toBe(SEED_CONTENT["howWeWork"]);
	});

	test("a matching pin produces no action", async () => {
		const guild = fakeGuild({
			channels: seedChannels(),
			threads: [KNOWN_THREAD],
			messages: { "400": [{ id: "500", content: SEED_CONTENT["howWeWork"] ?? "", authorId: BOT, pinned: true }] },
		});
		expect((await planProvision({ rest: guild.rest, guildId: GUILD, layout: seedLayout() })).actions).toEqual([]);
	});

	test("a human pin is not mistaken for the seed", async () => {
		const guild = fakeGuild({
			channels: seedChannels(),
			threads: [KNOWN_THREAD],
			messages: { "400": [{ id: "500", content: "pinned by a person", authorId: HUMAN, pinned: true }] },
		});
		const plan = await planProvision({ rest: guild.rest, guildId: GUILD, layout: seedLayout() });
		expect(plan.actions).toEqual([
			{ kind: "post-seed", key: "howWeWork", channelId: "400", body: SEED_CONTENT["howWeWork"] ?? "" },
		]);
	});

	test("an unreadable pin body is reported as the missing intent, not edited blindly", async () => {
		const guild = fakeGuild({
			channels: seedChannels(),
			threads: [KNOWN_THREAD],
			messages: { "400": [{ id: "500", content: "", authorId: BOT, pinned: true }] },
		});
		const plan = await planProvision({ rest: guild.rest, guildId: GUILD, layout: seedLayout() });
		expect(plan.actions).toEqual([]);
		expect(plan.notes).toHaveLength(1);
		expect(plan.notes[0]).toContain("MESSAGE_CONTENT");
		expect(plan.notes[0]).toContain("500");
	});

	test("a refused pin does not make the seed look absent on the next run", async () => {
		// The live bot has no MANAGE_MESSAGES, so every pin comes back 403/50013.
		// If seed existence rested on "is pinned", every run would repost the seed.
		const guild = fakeGuild({
			channels: seedChannels(),
			threads: [KNOWN_THREAD],
			refusePins: true,
		});
		const layout = seedLayout();

		const first = await planProvision({ rest: guild.rest, guildId: GUILD, layout });
		expect(first.actions.map(action => action.kind)).toEqual(["post-seed"]);
		const report = await applyProvision(first, { rest: guild.rest });
		expect(report.unpinned).toHaveLength(1);
		expect(report.unpinned[0]).toContain("howWeWork");
		expect(guild.messages.get("400")?.[0]?.pinned).toBeFalsy();

		const second = await planProvision({ rest: guild.rest, guildId: GUILD, layout });
		expect(second.actions).toEqual([]);
		expect(second.notes.join("\n")).toContain("is not pinned");
		const secondReport = await applyProvision(second, { rest: guild.rest });
		expect(secondReport.requests).toEqual([]);
		// One seed message, not two.
		expect(guild.messages.get("400")?.length).toBe(1);
	});
});

describe("flatten threads", () => {
	const THREAD: FakeThread = { id: "300", name: "Equity Structure & Funding Strategy", parent_id: "600" };

	const flattenLayout = (): LayoutSpec =>
		smallLayout({
			channels: [channelPlan({ key: "meetingTranscripts", id: "600", name: "meeting-transcripts", position: 0 })],
			categories: [],
			threadIds: { equityStructure: "300" },
		});

	const flattenChannels = (): FakeChannel[] => [
		{ id: "600", name: "meeting-transcripts", type: 0, parent_id: null, position: 0, topic: "topic for meetingTranscripts" },
	];

	const threadMessages = (): FakeMessage[] => [
		{ id: "310", content: "", authorId: NOTE_TAKER, authorIsBot: true, type: 4 },
		{
			id: "311",
			content: "Equity split has to be settled before the LLC filing.",
			authorId: NOTE_TAKER,
			authorName: "DiscMeet - Note Taker",
			authorIsBot: true,
			timestamp: "2026-08-27T20:14:03.622000+00:00",
		},
		{
			id: "312",
			content: "Agreed. 60/40 with a four-year vest.",
			authorId: HUMAN,
			authorName: "Hunter",
			authorIsBot: false,
			timestamp: "2026-08-27T20:15:41.100000+00:00",
		},
	];

	test("reposts thread content into the parent channel with attribution intact", async () => {
		const guild = fakeGuild({
			channels: flattenChannels(),
			threads: [THREAD],
			messages: { "300": threadMessages() },
		});
		const plan = await planProvision({
			rest: guild.rest,
			guildId: GUILD,
			layout: flattenLayout(),
			flattenThreads: true,
		});

		const flatten = plan.actions.filter(action => action.kind === "flatten-thread");
		expect(flatten).toHaveLength(1);
		const action = flatten[0];
		if (action?.kind !== "flatten-thread") throw new Error("expected a flatten-thread action");
		expect(action.channelId).toBe("600");
		// The system message (type 4) is not conversational content.
		expect(action.sourceMessageCount).toBe(2);
		expect(action.posts).toHaveLength(2);
		expect(action.posts[0]).toBe(
			"`cc-flatten:300` **DiscMeet - Note Taker** in thread *Equity Structure & Funding Strategy* at " +
				"2026-08-27T20:14:03.622Z\nEquity split has to be settled before the LLC filing.",
		);
		expect(action.posts[1]).toContain("**Hunter**");
		expect(action.posts[1]).toContain("2026-08-27T20:15:41.100Z");
		expect(action.posts[1]).toContain("Agreed. 60/40 with a four-year vest.");

		await applyProvision(plan, { rest: guild.rest });
		expect(guild.messages.get("600")?.map(message => message.content)).toEqual([...action.posts]);
		// The source thread is untouched.
		expect(guild.messages.get("300")?.length).toBe(3);
	});

	test("keeps an embed-only contribution when the thread also has readable text", async () => {
		const guild = fakeGuild({
			channels: flattenChannels(),
			threads: [THREAD],
			messages: {
				"300": [
					...threadMessages(),
					{
						id: "313",
						content: "",
						authorId: NOTE_TAKER,
						authorName: "DiscMeet - Note Taker",
						authorIsBot: true,
						embedCount: 1,
					},
				],
			},
		});
		const plan = await planProvision({
			rest: guild.rest,
			guildId: GUILD,
			layout: flattenLayout(),
			flattenThreads: true,
		});
		const action = plan.actions.find(entry => entry.kind === "flatten-thread");
		if (action?.kind !== "flatten-thread") throw new Error("expected a flatten-thread action");

		expect(action.sourceMessageCount).toBe(3);
		expect(action.posts).toHaveLength(3);
		expect(action.posts[2]).toContain("**DiscMeet - Note Taker**");
		expect(plan.notes.join("\n")).toContain("1 embed(s); reposted as a reference to the original");
	});

	test("a second run recognises its own headers and reposts nothing", async () => {
		const guild = fakeGuild({
			channels: flattenChannels(),
			threads: [THREAD],
			messages: { "300": threadMessages() },
		});
		const layout = flattenLayout();
		const first = await planProvision({ rest: guild.rest, guildId: GUILD, layout, flattenThreads: true });
		await applyProvision(first, { rest: guild.rest });

		const second = await planProvision({ rest: guild.rest, guildId: GUILD, layout, flattenThreads: true });
		expect(second.actions).toEqual([]);
		expect(second.notes.join("\n")).toContain("already flattened into channel 600");
		expect(guild.messages.get("600")?.length).toBe(2);
	});

	test("flattening is off unless asked for", async () => {
		const guild = fakeGuild({
			channels: flattenChannels(),
			threads: [THREAD],
			messages: { "300": threadMessages() },
		});
		const plan = await planProvision({ rest: guild.rest, guildId: GUILD, layout: flattenLayout() });
		expect(plan.actions).toEqual([]);
		expect(guild.calls.some(call => call.startsWith("getMessages:300"))).toBe(false);
	});

	test("empty source bodies refuse instead of reposting blank headers", async () => {
		const guild = fakeGuild({
			channels: flattenChannels(),
			threads: [THREAD],
			messages: {
				"300": threadMessages().map(message => ({ ...message, content: "" })),
			},
		});
		const failure = await rejection(
			planProvision({ rest: guild.rest, guildId: GUILD, layout: flattenLayout(), flattenThreads: true }),
		);
		expect(failure).toBeInstanceOf(EmptyThreadContentError);
		expect(failure.message).toContain("MESSAGE_CONTENT");
		expect(failure.message).toContain("Refusing to repost empty messages");
		expect(guild.writes()).toEqual([]);
	});

	test("a message longer than one Discord post is chunked, keeping the marker on every part", async () => {
		const long = "word ".repeat(900).trim();
		const guild = fakeGuild({
			channels: flattenChannels(),
			threads: [THREAD],
			messages: {
				"300": [{ id: "311", content: long, authorId: HUMAN, authorName: "Hunter", authorIsBot: false }],
			},
		});
		const plan = await planProvision({
			rest: guild.rest,
			guildId: GUILD,
			layout: flattenLayout(),
			flattenThreads: true,
		});
		const action = plan.actions.find(entry => entry.kind === "flatten-thread");
		if (action?.kind !== "flatten-thread") throw new Error("expected a flatten-thread action");
		expect(action.posts.length).toBeGreaterThan(1);
		for (const post of action.posts) {
			expect(post.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
			expect(post).toContain("`cc-flatten:300`");
			expect(post).toContain("(part ");
		}
		const rejoined = action.posts.map(post => post.split("\n").slice(1).join("\n")).join(" ");
		expect(rejoined).toBe(long);
	});
});

describe("runProvisionCli", () => {
	test("bad arguments exit 1 without touching the guild", async () => {
		expect(await runProvisionCli(["--nope"])).toBe(1);
		expect(await runProvisionCli([])).toBe(1);
		expect(await runProvisionCli(["--token-file", "/dev/null", "--dry-run", "--apply"])).toBe(1);
	});

	test("a dry run against a guild that already matches exits 0 and issues only reads", async () => {
		const guild = productionGuild();
		expect(await runProvisionCli(["--token-file", "/dev/null", "--guild", GUILD], { rest: guild.rest })).toBe(0);
		expect(guild.writes()).toEqual([]);
	});

	test("a dry run blocked on a permission exits 2 and still mutates nothing", async () => {
		const guild = productionGuild({ permissions: 0n });
		const code = await runProvisionCli(["--token-file", "/dev/null", "--guild", GUILD, "--dry-run"], {
			rest: guild.rest,
		});
		expect(code).toBe(2);
		expect(guild.writes()).toEqual([]);
	});

	test("a stale id exits 1", async () => {
		const guild = fakeGuild({ channels: [], threads: [] });
		expect(await runProvisionCli(["--token-file", "/dev/null", "--guild", GUILD], { rest: guild.rest })).toBe(1);
	});
});
