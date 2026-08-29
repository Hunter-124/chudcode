/**
 * The bus: a Discord text channel used as an append-only command log.
 *
 * Reads are at-least-once by construction -- a consumer that crashes between
 * acting on a record and persisting its high-water mark will see that record
 * again -- so every consumer pairs `poll` with the idempotency ledger here.
 * The ledger is written through on each `remember`, because the failure this
 * exists to prevent is a restart re-running someone's `/session start`.
 *
 * Anything in the channel that is not a valid record is skipped and still
 * advances the mark: a human saying "is this thing on" must neither wedge a
 * consumer nor be re-read forever.
 *
 * A note on the missing MESSAGE_CONTENT intent. Discord blanks `content` for
 * apps without it, except on messages the app itself authored. Every bus
 * record is bot-authored, so the bus works today; `blindBotMessages` in the
 * poll result is the tripwire for the day that stops being true.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type BusRecord, decodeRecord, encodeRecord } from "./bridge-protocol";
import { CHANNEL_IDS } from "./channels";
import type { DiscordRestClient } from "./discord-rest";

/** Ledger entries kept before the oldest are dropped. Commands are rare; this is months of them. */
export const LEDGER_CAPACITY = 4_000;

export interface BusEntry {
	readonly messageId: string;
	readonly record: BusRecord;
}

export interface BusPollResult {
	/** Oldest-first, so a consumer replaying a page applies records in issue order. */
	readonly records: readonly BusEntry[];
	/** Newest message id observed, record or not. Feed it back as `after`. Null when the page was empty. */
	readonly after: string | null;
	readonly scanned: number;
	/** Bot-authored messages that came back with empty content: the bus has gone blind. */
	readonly blindBotMessages: number;
}

/** Persistence seam for the ledger, so tests never touch a disk. */
export interface LedgerStore {
	read(): Promise<readonly string[]>;
	write(ids: readonly string[]): Promise<void>;
}

export interface BusOptions {
	rest: DiscordRestClient;
	/** Overrides `CC_BUS_CHANNEL_ID`. */
	channelId?: string;
	ledger?: LedgerStore;
	/** Enables the empty-content tripwire. Resolve it once from `getApplication()`. */
	botUserId?: string;
	capacity?: number;
}

export class Bus {
	readonly channelId: string;
	/**
	 * True when neither an explicit id nor `CC_BUS_CHANNEL_ID` was supplied and
	 * the bus is sharing #sessions. Provisioning has not run yet; records will
	 * interleave with the session mirror. Correct, but worth saying out loud.
	 */
	readonly usingSessionsFallback: boolean;

	readonly #rest: DiscordRestClient;
	readonly #ledger: LedgerStore;
	readonly #botUserId: string | undefined;
	readonly #capacity: number;
	readonly #seen = new Set<string>();
	#order: string[] = [];
	#hydrated: Promise<void> | undefined;

	constructor(options: BusOptions) {
		const fromEnv = process.env.CC_BUS_CHANNEL_ID?.trim();
		const configured = options.channelId?.trim() || (fromEnv && fromEnv.length > 0 ? fromEnv : undefined);
		this.channelId = configured ?? CHANNEL_IDS.sessions;
		this.usingSessionsFallback = configured === undefined;
		this.#rest = options.rest;
		this.#ledger = options.ledger ?? createFileLedgerStore(path.join(agentStateDir(), "bus-ledger.json"));
		this.#botUserId = options.botUserId;
		this.#capacity = options.capacity ?? LEDGER_CAPACITY;
	}

	/** Loads the ledger. Idempotent; every entry point awaits it. */
	async ready(): Promise<void> {
		this.#hydrated ??= this.#ledger.read().then(ids => {
			for (const id of ids) {
				if (this.#seen.has(id)) continue;
				this.#seen.add(id);
				this.#order.push(id);
			}
		});
		return this.#hydrated;
	}

	async publish(record: BusRecord): Promise<string> {
		const message = await this.#rest.createMessage(this.channelId, { content: encodeRecord(record) });
		return message.id;
	}

	async poll(options: { after?: string; limit?: number } = {}): Promise<BusPollResult> {
		const page = await this.#rest.getMessages(this.channelId, { after: options.after, limit: options.limit });
		const records: BusEntry[] = [];
		let after: string | null = null;
		let blindBotMessages = 0;
		// Discord answers newest-first; walking in reverse yields issue order and
		// leaves `after` holding the newest id in the page.
		for (let index = page.length - 1; index >= 0; index -= 1) {
			const message = page[index];
			if (!message) continue;
			after = message.id;
			if (message.content.length === 0) {
				if (this.#botUserId && message.author?.id === this.#botUserId) blindBotMessages += 1;
				continue;
			}
			const record = decodeRecord(message.content);
			if (record) records.push({ messageId: message.id, record });
		}
		return { records, after, scanned: page.length, blindBotMessages };
	}

	seen(id: string): boolean {
		return this.#seen.has(id);
	}

	async remember(id: string): Promise<void> {
		if (this.#seen.has(id)) return;
		this.#seen.add(id);
		this.#order.push(id);
		if (this.#order.length > this.#capacity) {
			const dropped = this.#order.splice(0, this.#order.length - this.#capacity);
			for (const stale of dropped) this.#seen.delete(stale);
		}
		await this.#ledger.write(this.#order);
	}
}

/** `CC_AGENT_DIR`, else XDG state. Mutable per-machine bridge state, not config. */
export function agentStateDir(): string {
	const override = process.env.CC_AGENT_DIR?.trim();
	if (override) return path.resolve(override);
	const xdgState = process.env.XDG_STATE_HOME?.trim();
	const root = xdgState && xdgState.length > 0 ? xdgState : path.join(os.homedir(), ".local", "state");
	return path.join(root, "cloudcastle", "cc-agent");
}

export function createFileLedgerStore(filePath: string): LedgerStore {
	return {
		async read() {
			let raw: string;
			try {
				raw = await fs.readFile(filePath, "utf8");
			} catch {
				return [];
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				// A truncated ledger costs at most one duplicate execution, which the
				// host and age filters bound. Losing the daemon to it costs more.
				return [];
			}
			if (parsed === null || typeof parsed !== "object" || !("ids" in parsed)) return [];
			const ids = parsed.ids;
			return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
		},
		async write(ids) {
			await writeStateFile(filePath, `${JSON.stringify({ version: 1, ids })}\n`);
		},
	};
}

export class MemoryLedgerStore implements LedgerStore {
	ids: readonly string[] = [];

	async read() {
		return this.ids;
	}

	async write(ids: readonly string[]) {
		this.ids = [...ids];
	}
}

/** Owner-only, atomic. Bridge state records what has already been executed; a torn write re-executes it. */
export async function writeStateFile(destination: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
	const temporary = `${destination}.${process.pid}.${Date.now().toString(36)}.tmp`;
	await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
	await fs.rename(temporary, destination);
}
