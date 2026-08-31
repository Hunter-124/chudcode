import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentHeartbeat, CommandRecord } from "../src/bridge-protocol";
import { BUS_PROTOCOL_VERSION, decodeRecord, encodeRecord, MAX_MESSAGE_CHARS } from "../src/bridge-protocol";
import { Bus, createFileLedgerStore, MemoryLedgerStore } from "../src/bus";
import { CHANNEL_IDS } from "../src/channels";
import { DiscordApiError, DiscordRest, type FetchLike } from "../src/discord-rest";

/** Shaped like a real bot token so a leak in a message body is unmistakable. */
const TOKEN = "MTU0MjcxNDUzMTQwOTgyMTcyNg.GtEsTt.notARealTokenJustAFixtureValue00000000000";
const BASE_URL = "https://discord.test/api/v10";
const BUS_CHANNEL = "1550000000000000001";
const BOT_USER_ID = "1542714531409821726";

const HEARTBEAT: AgentHeartbeat = {
	kind: "agent.heartbeat",
	v: BUS_PROTOCOL_VERSION,
	id: "hb-1",
	host: "garrison-pc",
	projects: ["/home/garrison/CloudCastle"],
	chudcodeVersion: "0.1.0",
	sentAt: "2026-08-28T12:00:00.000Z",
	sessions: [],
};

const COMMAND: CommandRecord = {
	kind: "command",
	v: BUS_PROTOCOL_VERSION,
	id: "cmd-1",
	name: "tail",
	host: "garrison-pc",
	sessionId: "sess-1",
	cwd: null,
	prompt: null,
	model: null,
	lines: 20,
	channelId: null,
	requestedBy: "111111111111111111",
	replyChannelId: CHANNEL_IDS.sessions,
	issuedAt: "2026-08-28T12:00:05.000Z",
};

interface StoredMessage {
	id: string;
	channel_id: string;
	content: string;
	timestamp: string;
	author: { id: string };
}

/**
 * A channel that behaves like Discord's: append-only, newest-first pages,
 * `after` filtering by snowflake. Every test drives the real DiscordRest and
 * the real Bus against it, so the codec and the paging are exercised for real.
 */
class FakeDiscord {
	readonly messages: StoredMessage[] = [];
	readonly sleeps: number[] = [];
	readonly authorizations: string[] = [];
	requests = 0;
	/** Number of leading attempts to answer 429 before serving the request. */
	rateLimitAttempts = 0;
	retryAfterSeconds = 0.75;
	/** Body served with the next 429/4xx, letting a test simulate an API that echoes credentials. */
	errorBody: Record<string, unknown> | null = null;
	#nextId = 1_700_000_000_000;

	readonly fetch: FetchLike = async (url, init) => {
		this.requests += 1;
		const headers = init.headers as Record<string, string>;
		this.authorizations.push(headers.authorization ?? "");
		if (this.rateLimitAttempts > 0) {
			this.rateLimitAttempts -= 1;
			return new Response(JSON.stringify(this.errorBody ?? { retry_after: this.retryAfterSeconds, global: false }), {
				status: 429,
				headers: { "content-type": "application/json" },
			});
		}
		const target = new URL(url);
		const postMatch = target.pathname.match(/^\/api\/v10\/channels\/(\d+)\/messages$/);
		if (init.method === "POST" && postMatch?.[1]) {
			if (this.errorBody) {
				return new Response(JSON.stringify(this.errorBody), {
					status: 400,
					headers: { "content-type": "application/json" },
				});
			}
			const body: unknown = JSON.parse(String(init.body));
			const content = body !== null && typeof body === "object" && "content" in body ? String(body.content) : "";
			this.#nextId += 1;
			const messageId: string = String(this.#nextId);
			const message: StoredMessage = {
				id: messageId,
				channel_id: postMatch[1],
				content,
				timestamp: new Date().toISOString(),
				author: { id: BOT_USER_ID },
			};
			this.messages.push(message);
			return new Response(JSON.stringify(message), { status: 200, headers: { "content-type": "application/json" } });
		}
		if (init.method === "GET" && postMatch?.[1]) {
			const after = target.searchParams.get("after");
			const limit = Number(target.searchParams.get("limit") ?? "100");
			const inChannel = this.messages.filter(message => message.channel_id === postMatch[1]);
			// Discord returns the newest `limit` normally, but the OLDEST `limit`
			// after a cursor. The bus's paging correctness depends on that.
			const page = after
				? inChannel
						.filter(message => BigInt(message.id) > BigInt(after))
						.slice(0, limit)
						.reverse()
				: inChannel.slice(-limit).reverse();
			return new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } });
		}
		return new Response(JSON.stringify({ code: 0, message: "unexpected route" }), { status: 404 });
	};

	/** Drop a message into the channel that this bot did not write. */
	human(content: string, channelId = BUS_CHANNEL): void {
		this.#nextId += 1;
		const messageId: string = String(this.#nextId);
		this.messages.push({
			id: messageId,
			channel_id: channelId,
			content,
			timestamp: new Date().toISOString(),
			author: { id: "999999999999999999" },
		});
	}
}

function harness(overrides: { botUserId?: string; ledger?: MemoryLedgerStore; channelId?: string } = {}) {
	const api = new FakeDiscord();
	const rest = new DiscordRest({
		token: TOKEN,
		fetch: api.fetch,
		baseUrl: BASE_URL,
		sleep: async ms => {
			api.sleeps.push(ms);
		},
	});
	const ledger = overrides.ledger ?? new MemoryLedgerStore();
	const bus = new Bus({
		rest,
		channelId: overrides.channelId ?? BUS_CHANNEL,
		ledger,
		botUserId: overrides.botUserId,
	});
	return { api, rest, bus, ledger };
}

const savedBusChannel = process.env.CC_BUS_CHANNEL_ID;
afterEach(() => {
	if (savedBusChannel === undefined) delete process.env.CC_BUS_CHANNEL_ID;
	else process.env.CC_BUS_CHANNEL_ID = savedBusChannel;
});

describe("codec", () => {
	it("round-trips every record kind through the fenced encoding", () => {
		for (const record of [HEARTBEAT, COMMAND]) {
			const encoded = encodeRecord(record);
			expect(encoded.startsWith("```cc-bus\n")).toBe(true);
			expect(decodeRecord(encoded)).toEqual(record);
		}
	});

	it("refuses to encode a record that would exceed the Discord message limit", () => {
		const oversized: AgentHeartbeat = { ...HEARTBEAT, chudcodeVersion: "x".repeat(MAX_MESSAGE_CHARS) };
		expect(() => encodeRecord(oversized)).toThrow(/over the 2000 limit/);
	});

	it("rejects a foreign protocol version rather than handing a consumer a shape it cannot read", () => {
		const wrongVersion = `\`\`\`cc-bus\n${JSON.stringify({ ...HEARTBEAT, v: 99 })}\n\`\`\``;
		expect(decodeRecord(wrongVersion)).toBeNull();
	});
});

describe("Bus.poll", () => {
	it("returns records oldest-first with the newest id as the high-water mark", async () => {
		const { api, bus } = harness();
		await bus.ready();
		await bus.publish(HEARTBEAT);
		await bus.publish(COMMAND);

		const first = await bus.poll();
		expect(first.records.map(entry => entry.record.id)).toEqual(["hb-1", "cmd-1"]);
		expect(first.after).toBe(api.messages[api.messages.length - 1]?.id ?? "");

		const empty = await bus.poll({ after: first.after ?? undefined });
		expect(empty.records).toEqual([]);
		expect(empty.after).toBeNull();

		await bus.publish({ ...COMMAND, id: "cmd-2" });
		const second = await bus.poll({ after: first.after ?? undefined });
		expect(second.records.map(entry => entry.record.id)).toEqual(["cmd-2"]);
	});

	it("walks forward from a cursor across several pages without losing or repeating a record", async () => {
		const { bus } = harness();
		await bus.ready();
		await bus.publish({ ...COMMAND, id: "cmd-0" });
		let after = (await bus.poll({ limit: 2 })).after ?? undefined;
		for (let index = 1; index <= 6; index += 1) await bus.publish({ ...COMMAND, id: `cmd-${index}` });

		// A backlog three pages deep: every record must arrive exactly once, in
		// issue order. This is the property a cursor exists for.
		const seen: string[] = [];
		for (let page = 0; page < 6; page += 1) {
			const result = await bus.poll({ after, limit: 2 });
			if (result.records.length === 0) break;
			seen.push(...result.records.map(entry => entry.record.id));
			after = result.after ?? after;
		}
		expect(seen).toEqual(["cmd-1", "cmd-2", "cmd-3", "cmd-4", "cmd-5", "cmd-6"]);
	});

	it("skips human chatter and malformed fences without wedging, and still advances the mark", async () => {
		const { api, bus } = harness();
		await bus.ready();
		api.human("is this thing on?");
		api.human("```cc-bus\n{not json}\n```");
		api.human(`\`\`\`cc-bus\n${JSON.stringify({ kind: "nope", v: BUS_PROTOCOL_VERSION, id: "x" })}\n\`\`\``);
		await bus.publish(COMMAND);

		const result = await bus.poll();
		expect(result.records.map(entry => entry.record.id)).toEqual(["cmd-1"]);
		expect(result.scanned).toBe(4);
		expect(result.after).toBe(api.messages[3]?.id ?? "");
	});

	it("counts bot-authored messages that came back blank, so a lost intent is visible", async () => {
		const { api, bus } = harness({ botUserId: BOT_USER_ID });
		await bus.ready();
		await bus.publish(HEARTBEAT);
		const stored = api.messages[0];
		if (!stored) throw new Error("fixture message missing");
		stored.content = "";

		const result = await bus.poll();
		expect(result.records).toEqual([]);
		expect(result.blindBotMessages).toBe(1);
	});

	it("does not blame the intent for a human's empty message", async () => {
		const { api, bus } = harness({ botUserId: BOT_USER_ID });
		await bus.ready();
		api.human("");
		expect((await bus.poll()).blindBotMessages).toBe(0);
	});
});

describe("Bus channel selection", () => {
	it("falls back to #sessions and says so when no bus channel is configured", () => {
		delete process.env.CC_BUS_CHANNEL_ID;
		const { bus } = harness({ channelId: "" });
		expect(bus.channelId).toBe(CHANNEL_IDS.sessions);
		expect(bus.usingSessionsFallback).toBe(true);
	});

	it("prefers CC_BUS_CHANNEL_ID once provisioning has created the channel", () => {
		process.env.CC_BUS_CHANNEL_ID = BUS_CHANNEL;
		const { bus } = harness({ channelId: "" });
		expect(bus.channelId).toBe(BUS_CHANNEL);
		expect(bus.usingSessionsFallback).toBe(false);
	});
});

describe("Bus idempotency ledger", () => {
	it("remembers executed ids across a restart", async () => {
		const ledger = new MemoryLedgerStore();
		const first = harness({ ledger });
		await first.bus.ready();
		expect(first.bus.seen("cmd-1")).toBe(false);
		await first.bus.remember("cmd-1");
		expect(first.bus.seen("cmd-1")).toBe(true);

		const restarted = harness({ ledger });
		expect(restarted.bus.seen("cmd-1")).toBe(false); // not yet hydrated
		await restarted.bus.ready();
		expect(restarted.bus.seen("cmd-1")).toBe(true);
	});

	it("bounds the ledger and forgets the oldest ids first", async () => {
		const ledger = new MemoryLedgerStore();
		const api = new FakeDiscord();
		const bus = new Bus({
			rest: new DiscordRest({ token: TOKEN, fetch: api.fetch, baseUrl: BASE_URL }),
			channelId: BUS_CHANNEL,
			ledger,
			capacity: 3,
		});
		await bus.ready();
		for (const id of ["a", "b", "c", "d"]) await bus.remember(id);
		expect(bus.seen("a")).toBe(false);
		expect(["b", "c", "d"].every(id => bus.seen(id))).toBe(true);
		expect(ledger.ids).toEqual(["b", "c", "d"]);
	});

	it("round-trips through a real file store, owner-only, and shrugs off a corrupt one", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-bus-ledger-"));
		const ledgerPath = path.join(dir, "bus-ledger.json");
		const store = createFileLedgerStore(ledgerPath);
		try {
			await store.write(["cmd-1", "cmd-2"]);
			expect(await store.read()).toEqual(["cmd-1", "cmd-2"]);
			expect((await fs.stat(ledgerPath)).mode & 0o077).toBe(0);

			await fs.writeFile(ledgerPath, "{ this is not json");
			expect(await store.read()).toEqual([]);

			await fs.rm(ledgerPath);
			expect(await store.read()).toEqual([]);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("DiscordRest rate limiting", () => {
	it("honours retry_after and then completes the call", async () => {
		const { api, bus } = harness();
		await bus.ready();
		api.rateLimitAttempts = 2;
		api.retryAfterSeconds = 0.75;

		const messageId = await bus.publish(HEARTBEAT);
		expect(messageId).toBeTruthy();
		expect(api.sleeps).toEqual([750, 750]);
		expect(api.requests).toBe(3);
		expect(api.messages).toHaveLength(1);
	});

	it("refuses to sleep past the bound instead of hanging the daemon", async () => {
		const api = new FakeDiscord();
		api.rateLimitAttempts = 1;
		api.retryAfterSeconds = 120;
		const rest = new DiscordRest({
			token: TOKEN,
			fetch: api.fetch,
			baseUrl: BASE_URL,
			maxRetryWaitMs: 5_000,
			sleep: async ms => {
				api.sleeps.push(ms);
			},
		});
		await expect(rest.createMessage(BUS_CHANNEL, { content: "hi" })).rejects.toThrow(/rate limited for 120000ms/);
		expect(api.sleeps).toEqual([]);
	});

	it("gives up after the retry budget rather than looping forever", async () => {
		const api = new FakeDiscord();
		api.rateLimitAttempts = 99;
		api.retryAfterSeconds = 0.01;
		const rest = new DiscordRest({
			token: TOKEN,
			fetch: api.fetch,
			baseUrl: BASE_URL,
			maxRetries: 2,
			sleep: async ms => {
				api.sleeps.push(ms);
			},
		});
		await expect(rest.createMessage(BUS_CHANNEL, { content: "hi" })).rejects.toBeInstanceOf(DiscordApiError);
		expect(api.requests).toBe(3);
	});
});

describe("DiscordRest credential handling", () => {
	it("sends the bot auth scheme", async () => {
		const { api, bus } = harness();
		await bus.ready();
		await bus.publish(HEARTBEAT);
		expect(api.authorizations.every(value => value.startsWith("Bot "))).toBe(true);
	});

	it("scrubs the token out of an error the API echoes back, and out of poll results", async () => {
		const { api, bus, rest } = harness({ botUserId: BOT_USER_ID });
		await bus.ready();
		api.errorBody = { code: 50035, message: `Invalid Authorization header: Bot ${TOKEN}` };

		let raised: unknown;
		try {
			await rest.createMessage(BUS_CHANNEL, { content: "hi" });
		} catch (error) {
			raised = error;
		}
		expect(raised).toBeInstanceOf(DiscordApiError);
		const rendered = `${String(raised)}\n${(raised as Error).stack ?? ""}`;
		expect(rendered).not.toContain(TOKEN);
		expect(rendered).toContain("[REDACTED_TOKEN]");

		api.errorBody = null;
		await bus.publish(COMMAND);
		expect(JSON.stringify(await bus.poll())).not.toContain(TOKEN);
	});

	it("never puts the token in a request path or body", async () => {
		const api = new FakeDiscord();
		const urls: string[] = [];
		const rest = new DiscordRest({
			token: TOKEN,
			baseUrl: BASE_URL,
			fetch: async (url, init) => {
				urls.push(`${url} ${String(init.body ?? "")}`);
				return api.fetch(url, init);
			},
		});
		await rest.createMessage(BUS_CHANNEL, { content: encodeRecord(COMMAND) });
		await rest.getMessages(BUS_CHANNEL, { after: "1", limit: 50 });
		expect(urls.join("\n")).not.toContain(TOKEN);
	});
});
