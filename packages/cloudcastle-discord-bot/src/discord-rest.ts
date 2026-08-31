/**
 * The slice of the Discord REST API the session bridge needs, under the bot
 * token.
 *
 * discord.js's REST is deliberately not used here: cc-agent runs as a bare
 * per-machine daemon with no gateway connection, and every call has to be
 * redirectable to an injected transport so the test suite never touches the
 * network. The surface is small enough that owning it costs less than bending
 * a client built around a gateway session.
 *
 * The token is read from an owner-only file, never from an environment
 * variable, and never appears in a log line, an error message, or a thrown
 * stack: `#scrub` strips it from anything on its way out.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const DISCORD_API_BASE = "https://discord.com/api/v10";

/** Where the devbot token lives on a provisioned machine; `CC_DISCORD_TOKEN_FILE` overrides it. */
export const DEFAULT_TOKEN_FILE = path.join(os.homedir(), ".config", "cloudcastle", "devbot", "discord-token");

/** Discord's ceiling for one `GET /channels/{id}/messages` page. */
export const MAX_MESSAGE_PAGE = 100;

/** Discord truncates past this; we truncate first so the stored name matches the live one. */
export const CHANNEL_NAME_LIMIT = 100;
export const GUILD_TEXT_CHANNEL = 0;

/**
 * Discord's JSON error code for a missing permission. Every channel create,
 * rename and move in this bridge returns it until the bot is re-invited with
 * MANAGE_CHANNELS, so callers name the fix rather than retrying blindly.
 */
export const MISSING_PERMISSIONS_CODE = 50013;

/**
 * `GET /applications/@me` flag for the privileged message-content intent. Zero
 * here means the bot reads `""` for every message it did not author itself.
 */
export const GATEWAY_MESSAGE_CONTENT_FLAG = 1 << 18;
export const GATEWAY_MESSAGE_CONTENT_LIMITED_FLAG = 1 << 19;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface DiscordUser {
	readonly id: string;
	readonly username?: string;
	/**
	 * The display name Discord actually shows. Attribution survives a repost only
	 * through the header the bot writes, and "Hunter" is the name a teammate
	 * recognises where "1488hunter" is not.
	 */
	readonly global_name?: string | null;
	readonly bot?: boolean;
}

export interface DiscordMessage {
	readonly id: string;
	readonly channel_id: string;
	/** Empty for messages this bot did not author while the message-content intent is off. */
	readonly content: string;
	readonly timestamp: string;
	readonly author?: DiscordUser;
	readonly embeds?: readonly Record<string, unknown>[];
	/**
	 * Discord message type. 0 DEFAULT and 19 REPLY are conversation; the rest are
	 * system events. The archived threads carry types 1, 4 and 18, so anything
	 * republishing a thread must filter on this or it reposts
	 * "X added Y to the thread" as if it were someone's contribution.
	 */
	readonly type?: number;
	/**
	 * Present because a message can carry all of its content here and none in
	 * `content` -- DiscMeet posts each meeting transcript as a lone .md file.
	 * Anything republishing a message must look here before calling it empty.
	 */
	readonly attachments?: readonly {
		readonly id: string;
		readonly filename: string;
		readonly url: string;
		readonly size?: number;
		readonly content_type?: string;
	}[];
}

export interface DiscordChannel {
	readonly id: string;
	readonly name?: string;
	readonly type?: number;
	readonly guild_id?: string;
	readonly parent_id?: string | null;
	readonly topic?: string | null;
	readonly position?: number;
}

export interface DiscordApplication {
	readonly id: string;
	readonly name?: string;
	readonly flags?: number;
	readonly bot?: DiscordUser;
}

export interface DiscordRole {
	readonly id: string;
	readonly name: string;
	readonly permissions: string;
	readonly managed?: boolean;
}

export interface DiscordGuildMember {
	readonly user?: DiscordUser;
	readonly nick?: string | null;
	readonly roles: readonly string[];
}

export interface MessagePayload {
	content?: string;
	embeds?: readonly Record<string, unknown>[];
	/**
	 * Defaults to suppressing every mention. A mirrored transcript is machine
	 * generated, so an `@everyone` that happens to appear in a diff must not
	 * page the guild.
	 */
	allowed_mentions?: { parse: readonly string[] };
	flags?: number;
}

export interface CreateChannelOptions {
	name: string;
	/** Category to nest under. */
	parentId?: string | null;
	topic?: string;
	/** Discord channel type; 0 is a guild text channel. */
	type?: number;
	/** Sort position within the category. */
	position?: number;
}

export interface ModifyChannelOptions {
	name?: string;
	parentId?: string | null;
	topic?: string;
	position?: number;
}

export interface MessagePageOptions {
	after?: string;
	before?: string;
	limit?: number;
}

/**
 * Everything the bridge calls. Implemented by {@link DiscordRest}, stubbed
 * wholesale in tests. There is deliberately no delete: never deleting a channel
 * or a message is an invariant of this system, and the cheapest way to keep an
 * invariant is to make it unreachable.
 */
export interface DiscordRestClient {
	createMessage(channelId: string, payload: MessagePayload): Promise<DiscordMessage>;
	editMessage(channelId: string, messageId: string, payload: MessagePayload): Promise<DiscordMessage>;
	getMessages(channelId: string, options?: MessagePageOptions): Promise<DiscordMessage[]>;
	createChannel(guildId: string, options: CreateChannelOptions): Promise<DiscordChannel>;
	/**
	 * Renaming is rate limited to two per ten minutes per channel and Discord
	 * enforces it with a 429, so callers debounce before they get here.
	 */
	modifyChannel(channelId: string, options: ModifyChannelOptions): Promise<DiscordChannel>;
	getChannel(channelId: string): Promise<DiscordChannel>;
	getGuildChannels(guildId: string): Promise<DiscordChannel[]>;
	addReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
	/** False when Discord refused for want of MANAGE_MESSAGES; see the implementation. */
	pinMessage(channelId: string, messageId: string): Promise<boolean>;
	getPinnedMessages(channelId: string): Promise<DiscordMessage[]>;
	getApplication(): Promise<DiscordApplication>;
	getGuildRoles(guildId: string): Promise<DiscordRole[]>;
	getGuildMember(guildId: string, userId: string): Promise<DiscordGuildMember>;
}

export class DiscordApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: number | null,
		readonly method: string,
		readonly route: string,
		detail: string,
	) {
		super(`${method} ${route} -> ${status}${code === null ? "" : ` (code ${code})`}: ${detail}`);
		this.name = "DiscordApiError";
	}
}

export interface DiscordRestOptions {
	/** Pre-resolved token. Tests pass this; production passes `tokenFile` instead. */
	token?: string;
	/** Owner-only file holding the token. Defaults to `CC_DISCORD_TOKEN_FILE` then {@link DEFAULT_TOKEN_FILE}. */
	tokenFile?: string;
	fetch?: FetchLike;
	baseUrl?: string;
	/** Attempts after the first. */
	maxRetries?: number;
	/** A `retry_after` longer than this is a wall, not a hiccup: fail loudly instead of sleeping on it. */
	maxRetryWaitMs?: number;
	sleep?: (ms: number) => Promise<void>;
	userAgent?: string;
}

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_MAX_RETRY_WAIT_MS = 60_000;
const MAX_BACKOFF_MS = 8_000;
const NO_MENTIONS = { parse: [] as readonly string[] };

export class DiscordRest implements DiscordRestClient {
	readonly #fetch: FetchLike;
	readonly #baseUrl: string;
	readonly #maxRetries: number;
	readonly #maxRetryWaitMs: number;
	readonly #sleep: (ms: number) => Promise<void>;
	readonly #userAgent: string;
	readonly #tokenFile: string | undefined;
	#token: string | undefined;
	#tokenLoad: Promise<string> | undefined;

	constructor(options: DiscordRestOptions = {}) {
		this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
		this.#baseUrl = (options.baseUrl ?? DISCORD_API_BASE).replace(/\/+$/, "");
		this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
		this.#maxRetryWaitMs = options.maxRetryWaitMs ?? DEFAULT_MAX_RETRY_WAIT_MS;
		this.#sleep = options.sleep ?? timerSleep;
		this.#userAgent = options.userAgent ?? "CloudCastleSessionBridge (https://cloudcastle.dev, 0.1.0)";
		this.#token = options.token;
		this.#tokenFile = options.tokenFile;
	}

	async createMessage(channelId: string, payload: MessagePayload): Promise<DiscordMessage> {
		return this.#request<DiscordMessage>("POST", `/channels/${channelId}/messages`, {
			body: payload.allowed_mentions ? payload : { ...payload, allowed_mentions: NO_MENTIONS },
		});
	}

	async editMessage(channelId: string, messageId: string, payload: MessagePayload): Promise<DiscordMessage> {
		return this.#request<DiscordMessage>("PATCH", `/channels/${channelId}/messages/${messageId}`, {
			body: payload.allowed_mentions ? payload : { ...payload, allowed_mentions: NO_MENTIONS },
		});
	}

	/** Discord answers newest-first; the ordering is preserved here and normalised by the bus. */
	async getMessages(channelId: string, options: MessagePageOptions = {}): Promise<DiscordMessage[]> {
		const query = new URLSearchParams();
		query.set("limit", String(Math.min(Math.max(options.limit ?? MAX_MESSAGE_PAGE, 1), MAX_MESSAGE_PAGE)));
		if (options.after) query.set("after", options.after);
		if (options.before) query.set("before", options.before);
		const page = await this.#request<unknown>("GET", `/channels/${channelId}/messages`, { query });
		return Array.isArray(page) ? (page as DiscordMessage[]) : [];
	}

	async createChannel(guildId: string, options: CreateChannelOptions): Promise<DiscordChannel> {
		return this.#request<DiscordChannel>("POST", `/guilds/${guildId}/channels`, {
			body: {
				name: options.name.slice(0, CHANNEL_NAME_LIMIT),
				type: options.type ?? GUILD_TEXT_CHANNEL,
				parent_id: options.parentId ?? null,
				topic: options.topic?.slice(0, 1024),
				position: options.position,
			},
		});
	}

	async modifyChannel(channelId: string, options: ModifyChannelOptions): Promise<DiscordChannel> {
		const body: Record<string, unknown> = {};
		if (options.name !== undefined) body.name = options.name.slice(0, CHANNEL_NAME_LIMIT);
		if (options.parentId !== undefined) body.parent_id = options.parentId;
		if (options.topic !== undefined) body.topic = options.topic.slice(0, 1024);
		if (options.position !== undefined) body.position = options.position;
		return this.#request<DiscordChannel>("PATCH", `/channels/${channelId}`, { body });
	}

	async getChannel(channelId: string): Promise<DiscordChannel> {
		return this.#request<DiscordChannel>("GET", `/channels/${channelId}`);
	}

	async getGuildChannels(guildId: string): Promise<DiscordChannel[]> {
		const channels = await this.#request<unknown>("GET", `/guilds/${guildId}/channels`);
		return Array.isArray(channels) ? (channels as DiscordChannel[]) : [];
	}

	async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
		const route = `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`;
		await this.#request<void>("PUT", route);
	}

	/**
	 * Pin a message, reporting refusal rather than raising it.
	 *
	 * Pinning needs MANAGE_MESSAGES, which this bot does not hold today, so the
	 * live answer is 403/50013. An unpinned seed message is cosmetic; killing a
	 * provision run or a board update over it is not. Callers MUST NOT use
	 * "is pinned" as an existence check without a fallback, because a refused pin
	 * makes that check read empty forever and post a duplicate every run.
	 */
	async pinMessage(channelId: string, messageId: string): Promise<boolean> {
		try {
			await this.#request<void>("PUT", `/channels/${channelId}/pins/${messageId}`);
			return true;
		} catch (error) {
			if (error instanceof DiscordApiError && error.code === MISSING_PERMISSIONS_CODE) {
				return false;
			}
			throw error;
		}
	}

	async getPinnedMessages(channelId: string): Promise<DiscordMessage[]> {
		const pins = await this.#request<unknown>("GET", `/channels/${channelId}/pins`);
		return Array.isArray(pins) ? (pins as DiscordMessage[]) : [];
	}

	async getApplication(): Promise<DiscordApplication> {
		return this.#request<DiscordApplication>("GET", "/applications/@me");
	}

	async getGuildRoles(guildId: string): Promise<DiscordRole[]> {
		const roles = await this.#request<unknown>("GET", `/guilds/${guildId}/roles`);
		return Array.isArray(roles) ? (roles as DiscordRole[]) : [];
	}

	async getGuildMember(guildId: string, userId: string): Promise<DiscordGuildMember> {
		return this.#request<DiscordGuildMember>("GET", `/guilds/${guildId}/members/${userId}`);
	}

	async #request<T>(
		method: string,
		route: string,
		init: { body?: unknown; query?: URLSearchParams } = {},
	): Promise<T> {
		const token = await this.#resolveToken();
		const query = init.query?.toString();
		const url = `${this.#baseUrl}${route}${query ? `?${query}` : ""}`;
		const headers: Record<string, string> = {
			authorization: `Bot ${token}`,
			"user-agent": this.#userAgent,
		};
		if (init.body !== undefined) headers["content-type"] = "application/json";

		let lastError: Error | undefined;
		for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
			let response: Response;
			try {
				response = await this.#fetch(url, {
					method,
					headers,
					body: init.body === undefined ? undefined : JSON.stringify(init.body),
				});
			} catch (error) {
				// Transport failures are the one class worth blind retries: nothing
				// reached Discord, so replaying the call cannot double-post.
				lastError = new Error(this.#scrub(error instanceof Error ? error.message : String(error)));
				if (attempt === this.#maxRetries) break;
				await this.#sleep(Math.min(250 * 2 ** attempt, MAX_BACKOFF_MS));
				continue;
			}

			if (response.status === 429) {
				const waitMs = await retryAfterMs(response);
				if (waitMs > this.#maxRetryWaitMs || attempt === this.#maxRetries) {
					throw new DiscordApiError(429, null, method, route, `rate limited for ${Math.round(waitMs)}ms`);
				}
				await this.#sleep(waitMs);
				continue;
			}

			if (response.status >= 500 && attempt < this.#maxRetries) {
				await this.#sleep(Math.min(250 * 2 ** attempt, MAX_BACKOFF_MS));
				continue;
			}

			const text = await response.text();
			if (response.status >= 400) {
				const parsed = safeJson(text);
				const code = typeof parsed?.code === "number" ? parsed.code : null;
				const detail = typeof parsed?.message === "string" ? parsed.message : text.slice(0, 400) || "no body";
				throw new DiscordApiError(response.status, code, method, route, this.#scrub(detail));
			}
			if (response.status === 204 || text.length === 0) return undefined as T;
			return JSON.parse(text) as T;
		}
		throw new DiscordApiError(0, null, method, route, lastError?.message ?? "transport failed");
	}

	async #resolveToken(): Promise<string> {
		if (this.#token) return this.#token;
		this.#tokenLoad ??= readOwnerOnlyFile(
			this.#tokenFile ?? process.env.CC_DISCORD_TOKEN_FILE ?? DEFAULT_TOKEN_FILE,
			"Discord bot token",
		).then(value => {
			this.#token = value;
			return value;
		});
		return this.#tokenLoad;
	}

	/** Last line of defence: nothing carrying the token escapes as a message. */
	#scrub(text: string): string {
		return this.#token ? text.split(this.#token).join("[REDACTED_TOKEN]") : text;
	}
}

/**
 * Same contract as `archive.ts`: a credential readable by group or other is a
 * credential to rotate, not one to use.
 */
export async function readOwnerOnlyFile(filePath: string, label: string): Promise<string> {
	const resolved = path.resolve(filePath);
	const stat = await fs.stat(resolved);
	if (!stat.isFile()) throw new Error(`${label} file must be a regular file`);
	if ((stat.mode & 0o077) !== 0) throw new Error(`${label} file must not be accessible by group or other users`);
	const value = (await fs.readFile(resolved, "utf8")).trim();
	if (!value) throw new Error(`${label} file is empty`);
	return value;
}

/** True when the bot can read `content` on messages it did not author. */
export function messageContentIntentEnabled(application: DiscordApplication): boolean {
	const flags = application.flags ?? 0;
	return (flags & (GATEWAY_MESSAGE_CONTENT_FLAG | GATEWAY_MESSAGE_CONTENT_LIMITED_FLAG)) !== 0;
}

function timerSleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/** Discord reports seconds as a float in the body and, less precisely, in the header. */
async function retryAfterMs(response: Response): Promise<number> {
	const body = safeJson(await response.text());
	if (typeof body?.retry_after === "number" && Number.isFinite(body.retry_after)) {
		return Math.max(0, body.retry_after * 1000);
	}
	const header = Number(response.headers.get("retry-after"));
	return Number.isFinite(header) ? Math.max(0, header * 1000) : 1000;
}

function safeJson(text: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(text);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}
