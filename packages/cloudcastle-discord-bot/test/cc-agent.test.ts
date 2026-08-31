import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { CommandRecord, CommandResult, SessionSnapshot } from "../src/bridge-protocol";
import {
	ARCHIVED_SESSION_CHANNEL_PREFIX,
	BUS_PROTOCOL_VERSION,
	CHANNEL_RENAME_MIN_INTERVAL_MS,
	decodeRecord,
	encodeRecord,
	MAX_CHANNEL_NAME_CHARS,
	MAX_MESSAGE_CHARS,
	sessionChannelName,
} from "../src/bridge-protocol";
import { Bus, MemoryLedgerStore } from "../src/bus";
import {
	CcAgent,
	chunkLines,
	describeEvent,
	MAX_HEARTBEAT_SESSIONS,
	MAX_TASK_TITLE_CHARS,
	MemoryStateStore,
	missingChannelPermissionMessage,
	projectRootsFromEnv,
	type RpcAgentEvent,
	type RpcSessionHandle,
	type RpcSessionOptions,
	type RpcSessionState,
	sessionTitleFromPrompt,
	taskChannelIntro,
	TranscriptBuffer,
} from "../src/cc-agent";
import { CATEGORY_IDS, CREATED_CATEGORY_NAMES, REQUIRED_PERMISSIONS } from "../src/channels";
import {
	DiscordApiError,
	type CreateChannelOptions,
	type DiscordApplication,
	type DiscordChannel,
	type DiscordGuildMember,
	type DiscordMessage,
	type DiscordRestClient,
	type DiscordRole,
	type MessagePageOptions,
	type MessagePayload,
	type ModifyChannelOptions,
} from "../src/discord-rest";

const TOKEN = "MTU0MjcxNDUzMTQwOTgyMTcyNg.GtEsTt.notARealTokenJustAFixtureValue00000000000";
const HOST = "garrison-pc";
const OTHER_HOST = "hunter-desktop";
const GUILD = "1542474553320542278";
const BUS_CHANNEL = "1550000000000000001";
const LIVE_CATEGORY = "1560000000000000001";
const DONE_CATEGORY = "1560000000000000002";
const REQUESTER = "111111111111111111";
const MISSING_PERMISSIONS = new DiscordApiError(403, 50013, "POST", "/guilds/x/channels", "Missing Permissions");

class FakeRest implements DiscordRestClient {
	readonly posted: DiscordMessage[] = [];
	readonly edits: Array<{ channelId: string; messageId: string; payload: MessagePayload }> = [];
	readonly channels: DiscordChannel[] = [
		{ id: LIVE_CATEGORY, name: CREATED_CATEGORY_NAMES.liveSessions, type: 4 },
		{ id: DONE_CATEGORY, name: CREATED_CATEGORY_NAMES.doneSessions, type: 4 },
	];
	readonly created: Array<{ guildId: string; options: CreateChannelOptions }> = [];
	readonly modified: Array<{ channelId: string; options: ModifyChannelOptions }> = [];
	createFailure: Error | null = null;
	modifyFailure: Error | null = null;
	#next = 9_000_000_000_000;

	async createMessage(channelId: string, payload: MessagePayload): Promise<DiscordMessage> {
		const message: DiscordMessage = {
			id: String((this.#next += 1)),
			channel_id: channelId,
			content: payload.content ?? "",
			timestamp: new Date().toISOString(),
			author: { id: "bot" },
			embeds: payload.embeds,
		};
		this.posted.push(message);
		return message;
	}

	async editMessage(channelId: string, messageId: string, payload: MessagePayload): Promise<DiscordMessage> {
		this.edits.push({ channelId, messageId, payload });
		const existing = this.posted.find(message => message.id === messageId);
		if (!existing) throw new Error(`edit of unknown message ${messageId}`);
		return existing;
	}

	/**
	 * Matches Discord: `after` returns the *oldest* messages following that id,
	 * newest-first within the window. Getting this wrong hides paging bugs.
	 */
	async getMessages(channelId: string, options: MessagePageOptions = {}): Promise<DiscordMessage[]> {
		const limit = options.limit ?? 100;
		const inChannel = this.posted.filter(message => message.channel_id === channelId);
		if (options.after === undefined) return inChannel.slice(-limit).reverse();
		const after = BigInt(options.after);
		return inChannel
			.filter(message => BigInt(message.id) > after)
			.slice(0, limit)
			.reverse();
	}

	async createChannel(guildId: string, options: CreateChannelOptions): Promise<DiscordChannel> {
		if (this.createFailure) throw this.createFailure;
		this.created.push({ guildId, options });
		const channel: DiscordChannel = {
			id: String((this.#next += 1)),
			name: options.name,
			type: 0,
			guild_id: guildId,
			parent_id: options.parentId ?? null,
			topic: options.topic ?? null,
		};
		this.channels.push(channel);
		return channel;
	}

	async modifyChannel(channelId: string, options: ModifyChannelOptions): Promise<DiscordChannel> {
		if (this.modifyFailure) throw this.modifyFailure;
		this.modified.push({ channelId, options });
		const index = this.channels.findIndex(channel => channel.id === channelId);
		const updated: DiscordChannel = {
			...this.channels[index],
			id: channelId,
			name: options.name ?? this.channels[index]?.name,
			parent_id: options.parentId ?? this.channels[index]?.parent_id ?? null,
		};
		if (index >= 0) this.channels[index] = updated;
		return updated;
	}

	async getChannel(channelId: string): Promise<DiscordChannel> {
		const found = this.channels.find(channel => channel.id === channelId);
		if (!found) throw new Error(`unknown channel ${channelId}`);
		return found;
	}

	async getGuildChannels(): Promise<DiscordChannel[]> {
		return [...this.channels];
	}

	async addReaction(): Promise<void> {}

	readonly pinned: Array<{ channelId: string; messageId: string }> = [];

	async pinMessage(channelId: string, messageId: string): Promise<boolean> {
		this.pinned.push({ channelId, messageId });
		return true;
	}

	async getPinnedMessages(channelId: string): Promise<DiscordMessage[]> {
		const ids = new Set(this.pinned.filter(pin => pin.channelId === channelId).map(pin => pin.messageId));
		return this.posted.filter(message => ids.has(message.id));
	}

	async getApplication(): Promise<DiscordApplication> {
		return { id: "1542714531409821726", flags: 0 };
	}

	async getGuildRoles(): Promise<DiscordRole[]> {
		return [];
	}

	async getGuildMember(): Promise<DiscordGuildMember> {
		return { roles: [] };
	}

	messagesIn(channelId: string): DiscordMessage[] {
		return this.posted.filter(message => message.channel_id === channelId);
	}

	/** Every channel this bridge created, i.e. excluding the two seeded categories. */
	sessionChannels(): DiscordChannel[] {
		return this.channels.filter(channel => channel.type === 0);
	}

	busRecords() {
		return this.posted
			.filter(message => message.channel_id === BUS_CHANNEL)
			.map(message => decodeRecord(message.content))
			.filter(record => record !== null);
	}

	results(): CommandResult[] {
		return this.busRecords().filter((record): record is CommandResult => record.kind === "command.result");
	}
}

class StubRpc implements RpcSessionHandle {
	static readonly created: StubRpc[] = [];
	started = false;
	stopped = false;
	aborts = 0;
	streaming = false;
	readonly prompts: string[] = [];
	readonly followUps: string[] = [];
	#listeners: Array<(event: RpcAgentEvent) => void> = [];
	readonly sessionNames: string[] = [];
	#titleListeners: Array<(title: string) => void> = [];

	constructor(
		readonly options: RpcSessionOptions,
		readonly sessionId: string,
	) {}

	async start() {
		this.started = true;
	}

	onEvent(listener: (event: RpcAgentEvent) => void) {
		this.#listeners.push(listener);
		return () => {
			this.#listeners = this.#listeners.filter(candidate => candidate !== listener);
		};
	}

	onTitle(listener: (title: string) => void) {
		this.#titleListeners.push(listener);
		return () => {
			this.#titleListeners = this.#titleListeners.filter(candidate => candidate !== listener);
		};
	}

	emitTitle(title: string) {
		for (const listener of [...this.#titleListeners]) listener(title);
	}

	emit(event: RpcAgentEvent) {
		for (const listener of [...this.#listeners]) listener(event);
	}

	async prompt(message: string) {
		this.prompts.push(message);
	}

	async followUp(message: string) {
		this.followUps.push(message);
	}

	async setSessionName(title: string) {
		this.sessionNames.push(title);
	}

	async steer() {}

	async abort() {
		this.aborts += 1;
	}

	async stop() {
		this.stopped = true;
	}

	async getState(): Promise<RpcSessionState> {
		return { sessionId: this.sessionId, sessionFile: `/tmp/${this.sessionId}.jsonl`, isStreaming: this.streaming };
	}
}

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
	return {
		sessionId: "sess-a",
		host: HOST,
		sessionFile: "/home/garrison/.chudcode/agent/sessions/sess-a.jsonl",
		cwd: "/home/garrison/CloudCastle",
		project: "CloudCastle",
		title: "wire up the bridge",
		model: "claude-opus-5",
		status: "running",
		startedAt: "2026-08-28T11:00:00.000Z",
		updatedAt: "2026-08-28T11:30:00.000Z",
		messageCount: 12,
		costUsd: 0.42,
		tokensIn: 1_000,
		tokensOut: 500,
		lastTool: "edit",
		lastText: "patching cc-agent",
		originCommandId: "cmd-origin",
		requestedBy: REQUESTER,
		channelId: "1570000000000000001",
		...overrides,
	};
}

function command(overrides: Partial<CommandRecord> = {}): CommandRecord {
	return {
		kind: "command",
		v: BUS_PROTOCOL_VERSION,
		id: "cmd-1",
		name: "new",
		host: HOST,
		sessionId: null,
		cwd: null,
		prompt: null,
		model: null,
		lines: null,
		channelId: null,
		requestedBy: REQUESTER,
		replyChannelId: BUS_CHANNEL,
		issuedAt: "2026-08-28T12:00:00.000Z",
		...overrides,
	};
}

interface Rig {
	rest: FakeRest;
	bus: Bus;
	agent: CcAgent;
	store: MemoryStateStore;
	ledger: MemoryLedgerStore;
	clock: { value: Date };
	logs: string[];
	snapshots: SessionSnapshot[];
	nextSessionId: { value: string };
}

const NOW = new Date("2026-08-28T12:00:01.000Z");

interface RigOptions {
	store?: MemoryStateStore;
	ledger?: MemoryLedgerStore;
	bus?: Bus;
	rest?: FakeRest;
	projectRoots?: readonly string[];
	snapshots?: SessionSnapshot[];
	resolveCategoriesFromGuild?: boolean;
}

function rig(overrides: RigOptions = {}): Rig {
	const rest = overrides.rest ?? new FakeRest();
	const ledger = overrides.ledger ?? new MemoryLedgerStore();
	const bus = overrides.bus ?? new Bus({ rest, channelId: BUS_CHANNEL, ledger });
	const store = overrides.store ?? new MemoryStateStore();
	const clock = { value: NOW };
	const logs: string[] = [];
	const snapshots = overrides.snapshots ?? [];
	const nextSessionId = { value: "sess-started" };
	const categories = overrides.resolveCategoriesFromGuild
		? {}
		: { liveCategoryId: LIVE_CATEGORY, doneCategoryId: DONE_CATEGORY };
	const agent = new CcAgent({
		bus,
		rest,
		host: HOST,
		guildId: GUILD,
		applicationId: "1542714531409821726",
		...categories,
		projectRoots: overrides.projectRoots ?? ["/home/garrison"],
		chudcodeVersion: "18.0.8",
		stateStore: store,
		scan: async () => [...snapshots],
		// Deliberately not slice B's renderer: this suite defends the mirror
		// invariant, not the embed layout.
		renderEmbed: item => ({ title: item.title, status: item.status, count: item.messageCount }),
		hashEmbed: embed => JSON.stringify(embed),
		tail: async (item, limit) => Array.from({ length: limit }, (_, index) => `${item.sessionId} line ${index}`),
		rpc: async options => {
			const client = new StubRpc(options, nextSessionId.value);
			StubRpc.created.push(client);
			return client;
		},
		now: () => clock.value,
		transcriptFlushMs: 60_000,
		logger: message => logs.push(message),
	});
	return { rest, bus, agent, store, ledger, clock, logs, snapshots, nextSessionId };
}

beforeEach(() => {
	StubRpc.created.length = 0;
});

describe("heartbeat", () => {
	it("keeps the newest sessions, bounded, and leaves lastText alone when it fits", () => {
		const { agent } = rig();
		const heartbeat = agent.buildHeartbeat([
			snapshot({ sessionId: "old", updatedAt: "2026-08-28T09:00:00.000Z" }),
			snapshot({ sessionId: "new", updatedAt: "2026-08-28T11:59:00.000Z" }),
		]);
		expect(heartbeat.sessions.map(item => item.sessionId)).toEqual(["new", "old"]);
		expect(heartbeat.sessions[0]?.lastText).toBe("patching cc-agent");
		expect(encodeRecord(heartbeat).length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
	});

	it("drops lastText before it drops a session, and never exceeds the message limit", () => {
		const { agent } = rig();
		const crowded = Array.from({ length: 14 }, (_, index) =>
			snapshot({
				sessionId: `sess-${index}`,
				updatedAt: new Date(Date.parse("2026-08-28T10:00:00.000Z") + index * 60_000).toISOString(),
				lastText: "y".repeat(160),
			}),
		);
		const heartbeat = agent.buildHeartbeat(crowded);
		expect(encodeRecord(heartbeat).length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
		expect(heartbeat.sessions.length).toBeLessThanOrEqual(MAX_HEARTBEAT_SESSIONS);
		expect(heartbeat.sessions.every(item => item.lastText === null)).toBe(true);
		// Whatever survived must be the newest of the batch, not an arbitrary slice.
		expect(heartbeat.sessions[0]?.sessionId).toBe("sess-13");
	});

	it("sheds sessions entirely rather than throwing when one snapshot alone overflows", () => {
		const { agent } = rig();
		const heartbeat = agent.buildHeartbeat([snapshot({ cwd: "/x".repeat(2_000), lastText: null })]);
		expect(heartbeat.sessions).toEqual([]);
		expect(encodeRecord(heartbeat).length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
	});

	it("publishes onto the bus as a decodable record", async () => {
		const { agent, rest, snapshots } = rig();
		snapshots.push(snapshot());
		await agent.tick();
		const heartbeats = rest.busRecords().filter(record => record.kind === "agent.heartbeat");
		expect(heartbeats).toHaveLength(1);
		expect(heartbeats[0]?.host).toBe(HOST);
	});
});

describe("session channels", () => {
	it("creates one task channel with status and instructions, then edits the status forever", async () => {
		const store = new MemoryStateStore();
		const rest = new FakeRest();
		const first = rig({ store, rest, snapshots: [snapshot()] });

		await first.agent.tick();
		expect(rest.sessionChannels()).toHaveLength(1);
		const channelId = rest.sessionChannels()[0]?.id ?? "";
		expect(rest.messagesIn(channelId)).toHaveLength(2);
		expect(rest.edits).toHaveLength(0);
		const statusMessageId = rest.messagesIn(channelId)[0]?.id;

		// Unchanged snapshot: no API call at all.
		await first.agent.tick();
		expect(rest.sessionChannels()).toHaveLength(1);
		expect(rest.messagesIn(channelId)).toHaveLength(2);
		expect(rest.edits).toHaveLength(0);

		// Changed snapshot: the same status message is edited in place.
		first.snapshots[0] = snapshot({ messageCount: 20 });
		await first.agent.tick();
		expect(rest.messagesIn(channelId)).toHaveLength(2);
		expect(rest.edits).toHaveLength(1);
		expect(rest.edits[0]?.messageId).toBe(statusMessageId);

		// Restart against the same persisted state: no second channel, no second
		// status message.
		const restarted = rig({ store, rest, snapshots: [snapshot({ messageCount: 21 })] });
		await restarted.agent.tick();
		expect(rest.sessionChannels()).toHaveLength(1);
		expect(rest.messagesIn(channelId)).toHaveLength(2);
		expect(rest.edits).toHaveLength(2);
		expect(rest.edits[1]?.messageId).toBe(statusMessageId);
	});

	it("names the channel from the chudcode title and files it under the live category", async () => {
		const { agent, rest, snapshots } = rig();
		snapshots.push(snapshot({ title: "Fix the Windows installer DOA!! (urgent)" }));
		await agent.tick();
		expect(rest.created[0]?.options.name).toBe("task-fix-the-windows-installer-doa-urgent");
		expect(rest.created[0]?.options.parentId).toBe(LIVE_CATEGORY);
		expect(rest.created[0]?.guildId).toBe(GUILD);
	});

	it("falls back to the recorded live category id when none is configured", async () => {
		// Was "finds the categories by name". Provision has since created both
		// categories and their ids are recorded in channels.ts, so the name lookup
		// became unreachable and was removed. With nothing configured, the recorded
		// id is what a session channel must land under.
		const { agent, rest, snapshots } = rig({ resolveCategoriesFromGuild: true });
		snapshots.push(snapshot());
		await agent.tick();
		expect(rest.created[0]?.options.parentId).toBe(CATEGORY_IDS.liveSessions);
	});

	it("distinguishes two hosts that report the same session id", async () => {
		const { agent, rest, snapshots } = rig();
		snapshots.push(snapshot({ sessionId: "shared" }), snapshot({ sessionId: "shared", host: OTHER_HOST }));
		await agent.tick();
		expect(rest.sessionChannels()).toHaveLength(2);
	});

	it("turns a missing MANAGE_CHANNELS grant into an actionable re-invite message", async () => {
		const rest = new FakeRest();
		rest.createFailure = MISSING_PERMISSIONS;
		const { agent, logs } = rig({ rest, snapshots: [snapshot()] });
		await agent.tick();

		const logged = logs.join("\n");
		expect(logged).toContain("MANAGE_CHANNELS");
		expect(logged).toContain(`permissions=${REQUIRED_PERMISSIONS}`);
		expect(logged).toContain("oauth2/authorize");
		// The mirror failure must not stop the heartbeat: the host stays visible.
		expect(rest.busRecords().filter(record => record.kind === "agent.heartbeat")).toHaveLength(1);
	});

	it("keeps mirroring the other sessions when one of them cannot be mirrored", async () => {
		const rest = new FakeRest();
		const { agent, snapshots } = rig({ rest, snapshots: [snapshot({ sessionId: "a" }), snapshot({ sessionId: "b" })] });
		let calls = 0;
		const realCreate = rest.createChannel.bind(rest);
		rest.createChannel = async (guildId, options) => {
			calls += 1;
			if (calls === 1) throw new Error("transient");
			return realCreate(guildId, options);
		};
		await agent.tick();
		expect(snapshots).toHaveLength(2);
		expect(rest.sessionChannels()).toHaveLength(1);
	});

	it("recovers its channels from the guild when the state file is gone", async () => {
		const rest = new FakeRest();
		const first = rig({ rest, snapshots: [snapshot()] });
		await first.agent.tick();
		const channelId = rest.sessionChannels()[0]?.id;
		const statusMessageId = rest.messagesIn(channelId ?? "")[0]?.id;
		expect(rest.created[0]?.options.topic).toContain(`chudcode session sess-a on ${HOST}`);

		// The state file is gone: without recovery this reposts a rival channel.
		const recovered = rig({ rest, snapshots: [snapshot({ messageCount: 99 })] });
		await recovered.agent.tick();

		expect(rest.sessionChannels()).toHaveLength(1);
		expect(rest.messagesIn(channelId ?? "")).toHaveLength(2);
		expect(rest.edits.map(edit => edit.messageId)).toEqual([statusMessageId]);
		expect(recovered.logs.join("\n")).toContain("recovered 1 session channel");
	});

	it("does not adopt another machine's session channels", async () => {
		const rest = new FakeRest();
		const theirs = rig({ rest, snapshots: [snapshot({ sessionId: "sess-theirs", host: OTHER_HOST })] });
		await theirs.agent.tick();
		expect(rest.sessionChannels()).toHaveLength(1);

		// A fresh agent on THIS host must leave that channel alone, and make its
		// own for its own session.
		const mine = rig({ rest, snapshots: [snapshot({ sessionId: "sess-mine" })] });
		await mine.agent.tick();
		expect(rest.sessionChannels()).toHaveLength(2);
		expect(mine.logs.join("\n")).not.toContain("recovered");
	});
});

describe("channel renaming", () => {
	it("names the channel on creation, then debounces retitles to the latest", async () => {
		// A channel only exists once the session has a title, so creation already
		// carries the first one. Creation is not a rename against Discord's cap, so
		// the next retitle is still free -- two mutations, one of which Discord does
		// not count, which is why the ten-minute cap test below still holds.
		const rigged = rig({ snapshots: [snapshot({ title: "first guess" })] });
		await rigged.agent.tick();
		expect(rigged.rest.created[0]?.options.name).toBe("task-first-guess");
		expect(rigged.rest.modified).toHaveLength(0);

		rigged.clock.value = new Date(NOW.getTime() + 30_000);
		rigged.snapshots[0] = snapshot({ title: "second guess" });
		await rigged.agent.tick();
		expect(rigged.rest.modified.map(call => call.options.name)).toEqual(["task-second-guess"]);

		// Now the window is armed, so a further retitle inside it is collapsed.
		rigged.clock.value = new Date(NOW.getTime() + 60_000);
		rigged.snapshots[0] = snapshot({ title: "third and best guess" });
		await rigged.agent.tick();
		expect(rigged.rest.modified).toHaveLength(1);

		// Past the window, exactly one more rename, straight to the latest title --
		// never a walk through the intermediate ones, which is what burns the cap.
		// The window runs from the rename at NOW+30s, not from NOW.
		rigged.clock.value = new Date(NOW.getTime() + 30_000 + CHANNEL_RENAME_MIN_INTERVAL_MS + 1_000);
		await rigged.agent.tick();
		expect(rigged.rest.modified.map(call => call.options.name)).toEqual([
			"task-second-guess",
			"task-third-and-best-guess",
		]);
	});

	it("keeps every ten-minute window inside Discord's two-rename cap", async () => {
		const rigged = rig({ snapshots: [snapshot({ title: null })] });
		await rigged.agent.tick();
		const renameTimes: number[] = [];
		for (let minute = 0; minute <= 30; minute += 1) {
			rigged.clock.value = new Date(NOW.getTime() + minute * 60_000);
			rigged.snapshots[0] = snapshot({ title: `title revision ${minute}` });
			const before = rigged.rest.modified.length;
			await rigged.agent.tick();
			if (rigged.rest.modified.length > before) renameTimes.push(minute * 60_000);
		}
		for (const at of renameTimes) {
			const inWindow = renameTimes.filter(other => other > at - 600_000 && other <= at);
			expect(inWindow.length).toBeLessThanOrEqual(2);
		}
		expect(renameTimes.length).toBeGreaterThan(1);
	});

	it("does not rename when the title still slugifies to the same name", async () => {
		const rigged = rig({ snapshots: [snapshot({ title: "Ship it" })] });
		await rigged.agent.tick();
		rigged.clock.value = new Date(NOW.getTime() + CHANNEL_RENAME_MIN_INTERVAL_MS + 1_000);
		rigged.snapshots[0] = snapshot({ title: "  ship---IT!!  " });
		await rigged.agent.tick();
		expect(rigged.rest.modified).toHaveLength(0);
	});

	it("archives a finished session once: prefix, category move, then never again", async () => {
		const rigged = rig({ snapshots: [snapshot({ title: "ship it" })] });
		await rigged.agent.tick();
		rigged.clock.value = new Date(NOW.getTime() + CHANNEL_RENAME_MIN_INTERVAL_MS + 1_000);
		rigged.snapshots[0] = snapshot({ title: "ship it", status: "complete" });
		await rigged.agent.tick();

		expect(rigged.rest.modified).toHaveLength(1);
		expect(rigged.rest.modified[0]?.options.name).toBe("done-ship-it");
		expect(rigged.rest.modified[0]?.options.parentId).toBe(DONE_CATEGORY);

		// A late title change on a finished session must not spend a rename.
		rigged.clock.value = new Date(NOW.getTime() + 10 * CHANNEL_RENAME_MIN_INTERVAL_MS);
		rigged.snapshots[0] = snapshot({ title: "renamed after the fact", status: "complete" });
		await rigged.agent.tick();
		expect(rigged.rest.modified).toHaveLength(1);
	});

	it("never deletes a session channel", async () => {
		const rigged = rig({ snapshots: [snapshot({ status: "complete" })] });
		await rigged.agent.tick();
		expect(rigged.rest.sessionChannels()).toHaveLength(1);
		expect(Object.keys(rigged.rest)).not.toContain("deleteChannel");
	});

	it("treats an interrupted turn as live, not finished", async () => {
		const rigged = rig({ snapshots: [snapshot({ title: "ship it" })] });
		await rigged.agent.tick();
		rigged.clock.value = new Date(NOW.getTime() + CHANNEL_RENAME_MIN_INTERVAL_MS + 1_000);
		rigged.snapshots[0] = snapshot({ title: "ship it", status: "interrupted" });
		await rigged.agent.tick();
		expect(rigged.rest.modified).toHaveLength(0);
	});
});

/**
 * The first live run on a real developer store tried to create twenty-five
 * channels, all for sessions that had finished days earlier. A channel per
 * historical session is noise and it spends the channel-create rate limit before
 * reaching anything anyone is actually watching.
 */
describe("which sessions earn a task channel", () => {
	it("never mirrors an ordinary local chudcode session", async () => {
		const rigged = rig({
			snapshots: [
				snapshot({
					originCommandId: null,
					requestedBy: null,
					channelId: null,
					status: "running",
				}),
			],
		});
		await rigged.agent.tick();
		expect(rigged.rest.sessionChannels()).toHaveLength(0);
		const heartbeat = rigged.rest.busRecords().find(record => record.kind === "agent.heartbeat");
		expect(heartbeat?.kind === "agent.heartbeat" ? heartbeat.sessions : []).toEqual([]);
	});

	it("mirrors a Discord-started task regardless of its current status", async () => {
		const rigged = rig({ snapshots: [snapshot({ status: "complete" })] });
		await rigged.agent.tick();
		expect(rigged.rest.sessionChannels()).toHaveLength(1);
	});

	it("keeps mirroring after the JSONL scan loses the in-memory origin marker", async () => {
		const rigged = rig({ snapshots: [snapshot({ status: "running" })] });
		await rigged.agent.tick();
		expect(rigged.rest.sessionChannels()).toHaveLength(1);

		rigged.snapshots[0] = snapshot({
			originCommandId: null,
			requestedBy: null,
			channelId: null,
			status: "complete",
		});
		rigged.rest.modified.length = 0;
		await rigged.agent.tick();
		expect(rigged.rest.sessionChannels()).toHaveLength(1);
		expect(rigged.rest.modified.length).toBeGreaterThan(0);
	});

	it("heartbeats only Discord task channels, not unrelated local sessions", async () => {
		const rigged = rig({
			snapshots: [
				snapshot({ sessionId: "local", originCommandId: null, requestedBy: null, channelId: null }),
				snapshot({ sessionId: "task" }),
			],
		});
		await rigged.agent.tick();
		const heartbeat = rigged.rest.busRecords().find(record => record.kind === "agent.heartbeat");
		expect(heartbeat?.kind === "agent.heartbeat" ? heartbeat.sessions.map(item => item.sessionId) : []).toEqual(["task"]);
	});
});

describe("the channel-name sanitiser", () => {
	it("produces predictable, Discord-stable names", () => {
		expect(sessionChannelName("Fix the Windows installer DOA!! (urgent)", "x")).toBe(
			"task-fix-the-windows-installer-doa-urgent",
		);
		expect(sessionChannelName("🚀 ship it — now", "x")).toBe("task-ship-it-now");
		expect(sessionChannelName("MiXeD CaSe", "x")).toBe("task-mixed-case");
	});

	it("falls back to the session id when there is no usable title", () => {
		expect(sessionChannelName(null, "1f9d2a6b9c0d4e5f")).toBe("task-1f9d2a6b9c0d");
		expect(sessionChannelName("", "1f9d2a6b9c0d4e5f")).toBe("task-1f9d2a6b9c0d");
		expect(sessionChannelName("   ", "1f9d2a6b9c0d4e5f")).toBe("task-1f9d2a6b9c0d");
		expect(sessionChannelName("!!! ??? ***", "1f9d2a6b9c0d4e5f")).toBe("task-1f9d2a6b9c0d");
		expect(sessionChannelName("日本語だけ", "1f9d2a6b9c0d4e5f")).toBe("task-1f9d2a6b9c0d");
	});

	it("fits inside Discord's channel-name ceiling and never ends on a separator", () => {
		const long = sessionChannelName("word ".repeat(60), "x");
		expect(long.length).toBeLessThanOrEqual(MAX_CHANNEL_NAME_CHARS);
		expect(long.endsWith("-")).toBe(false);
		expect(long.startsWith("task-")).toBe(true);
	});

	it("is stable and Discord-safe, so the same title never provokes a second rename", () => {
		for (const title of ["Fix the Windows installer DOA!! (urgent)", "🚀 ship it — now", "word ".repeat(60)]) {
			const name = sessionChannelName(title, "x");
			expect(sessionChannelName(title, "x")).toBe(name);
			// Discord rewrites anything outside this set, which would make the
			// stored name disagree with the live one and rename on every tick.
			expect(name).toMatch(/^[a-z0-9-]+$/);
		}
	});
});

describe("command routing", () => {
	it("ignores a command addressed to another host", async () => {
		const { agent, bus, rest } = rig();
		await bus.ready();
		await bus.publish(command({ id: "cmd-elsewhere", host: OTHER_HOST, cwd: "/home/garrison", prompt: "go" }));
		expect(await agent.pollCommands()).toBe(0);
		expect(StubRpc.created).toHaveLength(0);
		expect(rest.results()).toEqual([]);
	});

	it("executes a replayed command exactly once", async () => {
		const store = new MemoryStateStore();
		const ledger = new MemoryLedgerStore();
		const rest = new FakeRest();
		const bus = new Bus({ rest, channelId: BUS_CHANNEL, ledger });
		const first = rig({ store, ledger, bus, rest, projectRoots: [os.tmpdir()] });
		await bus.ready();
		await bus.publish(command({ id: "cmd-replay", cwd: os.tmpdir(), prompt: "do the thing" }));

		expect(await first.agent.pollCommands()).toBe(1);
		expect(StubRpc.created).toHaveLength(1);

		// The crash: the cursor never made it to disk, so the page is re-read.
		store.state = { ...store.state, cursor: null };
		const replayed = rig({ store, ledger, bus, rest, projectRoots: [os.tmpdir()] });
		expect(await replayed.agent.pollCommands()).toBe(0);
		expect(StubRpc.created).toHaveLength(1);
		expect(rest.results().filter(result => result.outcome === "accepted")).toHaveLength(1);
		expect(rest.sessionChannels()).toHaveLength(1);
	});

	it("remembers a command id before running it, so a crash cannot double-start", async () => {
		const { agent, bus, ledger } = rig({ projectRoots: [os.tmpdir()] });
		await bus.ready();
		await bus.publish(command({ id: "cmd-order", cwd: os.tmpdir(), prompt: "go" }));
		await agent.pollCommands();
		expect(ledger.ids).toContain("cmd-order");
	});

	it("skips a command that has been sitting on the bus since before the agent booted", async () => {
		const { agent, bus, logs } = rig({ projectRoots: [os.tmpdir()] });
		await bus.ready();
		await bus.publish(
			command({ id: "cmd-ancient", cwd: os.tmpdir(), prompt: "go", issuedAt: "2026-08-28T09:00:00.000Z" }),
		);
		expect(await agent.pollCommands()).toBe(0);
		expect(StubRpc.created).toHaveLength(0);
		expect(logs.join("\n")).toContain("cmd-ancient");
	});

	it("is not derailed by a human typing in the bus channel", async () => {
		const { agent, bus, rest } = rig({ projectRoots: [os.tmpdir()] });
		await bus.ready();
		await rest.createMessage(BUS_CHANNEL, { content: "morning all" });
		await bus.publish(command({ id: "cmd-after-chatter", cwd: os.tmpdir(), prompt: "go" }));
		expect(await agent.pollCommands()).toBe(1);
	});
});

describe("/new authorisation", () => {
	let root: string;
	let inside: string;
	let outside: string;

	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cc-roots-")));
		inside = path.join(root, "CloudCastle");
		outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cc-outside-")));
		await fs.mkdir(inside);
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(outside, { recursive: true, force: true });
	});

	it("creates the channel, starts the session, and reports the channel back", async () => {
		const { agent, bus, rest } = rig({ projectRoots: [root] });
		await bus.ready();
		await bus.publish(command({ id: "cmd-ok", cwd: inside, prompt: "refactor the bus" }));
		await agent.pollCommands();
		expect(StubRpc.created[0]?.sessionNames).toEqual(["refactor the bus"]);
		expect(rest.sessionChannels()[0]?.name).toBe("task-refactor-the-bus");

		expect(StubRpc.created).toHaveLength(1);
		expect(StubRpc.created[0]?.options.cwd).toBe(inside);
		expect(StubRpc.created[0]?.started).toBe(true);
		expect(StubRpc.created[0]?.prompts).toEqual(["refactor the bus"]);

		const [result] = rest.results();
		expect(result?.outcome).toBe("accepted");
		expect(result?.channelId).toBe(rest.sessionChannels()[0]?.id);
	});

	it("renames a new channel to the title emitted by the chudcode session", async () => {
		const { agent, bus, rest } = rig({ projectRoots: [root] });
		await bus.ready();
		await bus.publish(command({ id: "cmd-title", cwd: inside, prompt: "refactor the bus" }));
		await agent.pollCommands();

		StubRpc.created[0]?.emitTitle("Refactor the Discord bus transport");
		await agent.drain();

		expect(rest.modified.map(call => call.options.name)).toContain("task-refactor-the-discord-bus-transport");
	});

	it("refuses a cwd outside every allowlisted root", async () => {
		const { agent, bus, rest } = rig({ projectRoots: [root] });
		await bus.ready();
		await bus.publish(command({ id: "cmd-escape", cwd: outside, prompt: "rm -rf" }));
		await agent.pollCommands();

		expect(StubRpc.created).toHaveLength(0);
		expect(rest.sessionChannels()).toHaveLength(0);
		const [result] = rest.results();
		expect(result?.outcome).toBe("rejected");
		expect(result?.detail).toContain("outside the project roots");
	});

	it("refuses a symlink inside the root that points out of it", async () => {
		const escape = path.join(root, "escape");
		await fs.symlink(outside, escape);
		const { agent, bus, rest } = rig({ projectRoots: [root] });
		await bus.ready();
		await bus.publish(command({ id: "cmd-symlink", cwd: escape, prompt: "sneak out" }));
		await agent.pollCommands();

		expect(StubRpc.created).toHaveLength(0);
		expect(rest.results()[0]?.outcome).toBe("rejected");
	});

	it("refuses a cwd that does not exist", async () => {
		const { agent, bus, rest } = rig({ projectRoots: [root] });
		await bus.ready();
		await bus.publish(command({ id: "cmd-missing", cwd: path.join(root, "nope"), prompt: "go" }));
		await agent.pollCommands();
		expect(rest.results()[0]?.detail).toContain("does not exist");
	});

	it("refuses a new session with no prompt", async () => {
		const { agent, bus, rest } = rig({ projectRoots: [root] });
		await bus.ready();
		await bus.publish(command({ id: "cmd-noprompt", cwd: inside, prompt: "   " }));
		await agent.pollCommands();
		expect(StubRpc.created).toHaveLength(0);
		expect(rest.results()[0]?.detail).toContain("needs a prompt");
	});

	it("stops the session and reports the fix when the channel cannot be created", async () => {
		const rest = new FakeRest();
		rest.createFailure = MISSING_PERMISSIONS;
		const { agent, bus } = rig({ rest, projectRoots: [root] });
		await bus.ready();
		await bus.publish(command({ id: "cmd-noperm", cwd: inside, prompt: "go" }));
		await agent.pollCommands();

		expect(StubRpc.created[0]?.stopped).toBe(true);
		const [result] = rest.results();
		expect(result?.outcome).toBe("failed");
		expect(result?.detail).toContain("MANAGE_CHANNELS");
		expect(result?.detail).toContain(`permissions=${REQUIRED_PERMISSIONS}`);
	});

	it("streams into a channel the gateway already made when the command carries one", async () => {
		const { agent, bus, rest } = rig({ projectRoots: [root] });
		await bus.ready();
		await bus.publish(
			command({ id: "cmd-adopt", name: "start", cwd: inside, prompt: "go", channelId: "1570000000000000001" }),
		);
		await agent.pollCommands();
		expect(rest.created).toHaveLength(0);
		expect(rest.messagesIn("1570000000000000001")).toHaveLength(1);
		expect(rest.results()[0]?.channelId).toBe("1570000000000000001");
	});

	it("mirrors the started session once, and the later scan edits that same status message", async () => {
		const rigged = rig({ projectRoots: [root] });
		rigged.nextSessionId.value = "sess-fromdiscord";
		await rigged.bus.ready();
		await rigged.bus.publish(command({ id: "cmd-mirror", cwd: inside, prompt: "build it" }));
		await rigged.agent.pollCommands();
		expect(rigged.rest.sessionChannels()).toHaveLength(1);

		rigged.snapshots.push(snapshot({ sessionId: "sess-fromdiscord", cwd: inside, messageCount: 3 }));
		await rigged.agent.tick();
		expect(rigged.rest.sessionChannels()).toHaveLength(1);
		expect(rigged.rest.edits).toHaveLength(1);
	});
});

describe("steering a running session", () => {
	let root: string;

	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cc-steer-")));
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	async function started() {
		const rigged = rig({ projectRoots: [root] });
		rigged.nextSessionId.value = "sess-live";
		await rigged.bus.ready();
		await rigged.bus.publish(command({ id: "cmd-start", cwd: root, prompt: "begin" }));
		await rigged.agent.pollCommands();
		const client = StubRpc.created[0];
		const channelId = rigged.rest.sessionChannels()[0]?.id;
		if (!client || !channelId) throw new Error("the start command did not produce a session channel");
		return { ...rigged, client, channelId };
	}

	it("prompts an idle session and follows up on a streaming one", async () => {
		const live = await started();
		await live.bus.publish(command({ id: "cmd-say-1", name: "say", sessionId: "sess-live", prompt: "also fix the docs" }));
		await live.agent.pollCommands();
		expect(live.client.prompts).toEqual(["begin", "also fix the docs"]);

		live.client.streaming = true;
		await live.bus.publish(command({ id: "cmd-say-2", name: "say", sessionId: "sess-live", prompt: "and the tests" }));
		await live.agent.pollCommands();
		expect(live.client.followUps).toEqual(["and the tests"]);
	});

	it("rejects a say for a session this agent does not own", async () => {
		const { agent, bus, rest } = rig({ projectRoots: [root] });
		await bus.ready();
		await bus.publish(command({ id: "cmd-say-orphan", name: "say", sessionId: "sess-elsewhere", prompt: "hello" }));
		await agent.pollCommands();
		const [result] = rest.results();
		expect(result?.outcome).toBe("rejected");
		expect(result?.detail).toContain("no longer running");
	});

	it("interrupts without ending the session, and stop ends it", async () => {
		const live = await started();
		await live.bus.publish(command({ id: "cmd-int", name: "interrupt", sessionId: "sess-live" }));
		await live.agent.pollCommands();
		expect(live.client.aborts).toBe(1);
		expect(live.client.stopped).toBe(false);

		await live.bus.publish(command({ id: "cmd-stop", name: "stop", sessionId: "sess-live" }));
		await live.agent.pollCommands();
		expect(live.client.stopped).toBe(true);

		// The session is gone; a further say must be refused, not silently dropped.
		await live.bus.publish(command({ id: "cmd-say-dead", name: "say", sessionId: "sess-live", prompt: "hi" }));
		await live.agent.pollCommands();
		expect(live.rest.results().at(-1)?.outcome).toBe("rejected");
	});

	it("batches streamed events into one channel message per window", async () => {
		const live = await started();
		const before = live.rest.messagesIn(live.channelId).length;
		live.client.emit({ type: "tool_execution_start", toolName: "read", intent: "Reading bus" });
		live.client.emit({ type: "tool_execution_start", toolName: "edit", intent: "Patching" });
		live.client.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
		live.client.emit({ type: "turn_start" });
		await live.agent.drain();

		const posted = live.rest.messagesIn(live.channelId).slice(before);
		expect(posted).toHaveLength(1);
		expect(posted[0]?.content).toContain("Reading bus");
		expect(posted[0]?.content).toContain("Patching");
		expect(posted[0]?.content).toContain("done");
		expect(posted[0]?.content).not.toContain("turn_start");
	});

	it("publishes done when the agent finishes its turn", async () => {
		const live = await started();
		live.client.emit({ type: "agent_end" });
		await live.agent.drain();
		expect(live.rest.results().map(result => result.outcome)).toEqual(["accepted", "done"]);
		expect(live.client.stopped).toBe(true);
	});

	it("aborts in-flight sessions and reports an empty host on shutdown", async () => {
		const live = await started();
		await live.agent.shutdown("SIGTERM");
		expect(live.client.aborts).toBe(1);
		expect(live.client.stopped).toBe(true);
		const heartbeats = live.rest.busRecords().filter(record => record.kind === "agent.heartbeat");
		expect(heartbeats.at(-1)?.sessions).toEqual([]);
		expect(live.rest.results().at(-1)?.detail).toContain("SIGTERM");
		expect(live.rest.messagesIn(live.channelId).at(-1)?.content).toContain("shut down");
	});
});

describe("tail", () => {
	it("posts the rendered tail into the session's channel", async () => {
		const { agent, bus, rest, snapshots } = rig();
		snapshots.push(snapshot({ sessionId: "sess-tail" }));
		await agent.tick();
		const channelId = rest.sessionChannels()[0]?.id ?? "";
		const before = rest.messagesIn(channelId).length;

		await bus.ready();
		await bus.publish(command({ id: "cmd-tail", name: "tail", sessionId: "sess-tail", lines: 3 }));
		await agent.pollCommands();

		const posted = rest.messagesIn(channelId).slice(before);
		expect(posted).toHaveLength(1);
		expect(posted[0]?.content.split("\n")).toHaveLength(3);
		expect(rest.results().at(-1)?.outcome).toBe("done");
	});

	it("rejects a tail for a session this host has never seen", async () => {
		const { agent, bus, rest } = rig();
		await bus.ready();
		await bus.publish(command({ id: "cmd-tail-miss", name: "tail", sessionId: "ghost", lines: 3 }));
		await agent.pollCommands();
		expect(rest.results()[0]?.detail).toContain("no longer available");
	});
});

describe("pure helpers", () => {
	it("renders only the events a human would care about", () => {
		expect(describeEvent({ type: "tool_execution_start", toolName: "bash", intent: "Running tests" })).toBe(
			"**Working on**\nRunning tests",
		);
		expect(describeEvent({ type: "tool_execution_end", toolName: "bash", isError: true })).toContain("Needs attention");
		expect(describeEvent({ type: "tool_execution_end", toolName: "bash" })).toBeNull();
		expect(
			describeEvent({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
		).toBeNull();
		expect(describeEvent({ type: "turn_end" })).toBeNull();
	});

	it("creates short readable task titles and channel instructions", () => {
		const title = sessionTitleFromPrompt("# Fix the Discord bridge interaction because the current channel names are impossible to scan quickly");
		expect(title.startsWith("Fix the Discord bridge")).toBe(true);
		expect([...title].length).toBeLessThanOrEqual(MAX_TASK_TITLE_CHARS);
		const intro = taskChannelIntro(snapshot({ title, lastText: "Make task progress easy to follow." }));
		expect(intro).toContain("Reply normally in this channel");
		expect(intro).toContain("/task transcript");
		expect(intro).not.toContain("sessionId");
	});

	it("retries a failed transcript flush instead of losing the update", async () => {
		let attempts = 0;
		const posted: string[] = [];
		const errors: unknown[] = [];
		const buffer = new TranscriptBuffer(
			async text => {
				attempts += 1;
				if (attempts === 1) throw new Error("Discord unavailable");
				posted.push(text);
			},
			60_000,
			error => errors.push(error),
		);
		buffer.push("Readable progress");
		await buffer.drain();
		expect(posted).toEqual([]);
		expect(errors).toHaveLength(1);
		await buffer.drain();
		expect(posted).toEqual(["Readable progress"]);
	});

	it("packs lines up to the limit and splits a line that is too long on its own", () => {
		expect(chunkLines(["aaa", "bbb"], 100)).toEqual(["aaa\nbbb"]);
		expect(chunkLines(["aaaa", "bbbb"], 5)).toEqual(["aaaa", "bbbb"]);
		expect(chunkLines(["x".repeat(12)], 5)).toEqual(["xxxxx", "xxxxx", "xx"]);
	});

	it("defaults the project allowlist to the home directory, never the filesystem root", () => {
		expect(projectRootsFromEnv(undefined)).toEqual([os.homedir()]);
		expect(projectRootsFromEnv("  ")).toEqual([os.homedir()]);
		expect(projectRootsFromEnv("/a:/b/")).toEqual([path.resolve("/a"), path.resolve("/b")]);
	});

	it("names the permission and the exact re-invite in the missing-grant message", () => {
		const withApp = missingChannelPermissionMessage("creating a channel", "1542714531409821726");
		expect(withApp).toContain("MANAGE_CHANNELS");
		expect(withApp).toContain(`permissions=${REQUIRED_PERMISSIONS}`);
		expect(withApp).toContain("client_id=1542714531409821726");
		expect(missingChannelPermissionMessage("creating a channel", null)).toContain(`permissions=${REQUIRED_PERMISSIONS}`);
	});
});

describe("secrets", () => {
	it("keeps the bot token out of every published record and every log line", async () => {
		const rigged = rig({ projectRoots: [os.tmpdir()] });
		await rigged.bus.ready();
		// Nothing cc-agent touches carries the token: it lives inside DiscordRest,
		// which scrubs its own errors. This is the composition check.
		rigged.rest.createFailure = new DiscordApiError(403, 50013, "POST", "/guilds/x/channels", "Missing Permissions");
		rigged.snapshots.push(snapshot());
		await rigged.agent.tick();
		await rigged.bus.publish(command({ id: "cmd-secret", cwd: "/definitely/not/allowed", prompt: "go" }));
		await rigged.agent.pollCommands();

		const everything = `${JSON.stringify(rigged.rest.posted)}\n${rigged.logs.join("\n")}`;
		expect(everything).not.toContain(TOKEN);
		expect(everything.length).toBeGreaterThan(0);
	});
});
