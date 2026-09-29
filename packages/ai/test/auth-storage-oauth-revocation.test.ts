import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerCustomApi, unregisterCustomApis } from "@chudware/ai";
import { AuthStorage, type CredentialDisabledEvent, SqliteAuthCredentialStore } from "@chudware/ai/auth-storage";
import { ProviderHttpError } from "@chudware/ai/error";
import { registerOAuthProvider, unregisterOAuthProviders } from "@chudware/ai/registry/oauth";
import { streamSimple } from "@chudware/ai/stream";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@chudware/ai/types";
import type { CredentialRankingStrategy, UsageLimit, UsageProvider, UsageReport } from "@chudware/ai/usage";
import { AssistantMessageEventStream } from "@chudware/ai/utils/event-stream";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "unit-oauth-revocation";
const SOURCE = "auth-storage-oauth-revocation-test";
const API = "auth-storage-oauth-revocation-test" as Api;

/** Verbatim Anthropic body from the failed CAD session (request id trimmed). */
const ORG_OAUTH_DENIAL =
	'403 {"type":"error","error":{"type":"permission_error","message":"OAuth authentication is currently not allowed for this organization.","details":{"error_code":"oauth_not_allowed_for_organization"}},"request_id":"req_test"}';
const USAGE_LIMIT_MESSAGE = "You have hit your ChatGPT usage limit (pro plan). Try again in ~158 min.";

const context: Context = {
	systemPrompt: [],
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

function farExpiry(): number {
	return Date.now() + 24 * 60 * 60_000;
}

function model(): Model<Api> {
	return {
		id: "unit-model",
		name: "Unit Model",
		api: API,
		provider: PROVIDER,
		contextWindow: 1000,
		maxTokens: 100,
	} as Model<Api>;
}

function assistant(text?: string): AssistantMessage {
	return {
		role: "assistant",
		content: text === undefined ? [] : [{ type: "text", text }],
		api: API,
		provider: PROVIDER,
		model: "unit-model",
		timestamp: 1,
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

describe("AuthStorage OAuth revocation and usage-report failures", () => {
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthCredentialStore | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chud-ai-oauth-revocation-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		registerOAuthProvider({
			id: PROVIDER,
			name: "OAuth Revocation Unit",
			sourceId: SOURCE,
			async login() {
				return { access: "login", refresh: "login", expires: farExpiry() };
			},
			async refreshToken(credentials) {
				return { ...credentials, expires: farExpiry() };
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		unregisterCustomApis(SOURCE);
		unregisterOAuthProviders(SOURCE);
		store?.close();
		store = undefined;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	/**
	 * Provider stub keyed by bearer: `acc-B` belongs to an organization that
	 * forbids OAuth; `acc-A` answers normally unless `aUsageLimited` is set.
	 */
	function registerUpstream(state: { keys: unknown[]; aUsageLimited: boolean }): void {
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				const key = options?.apiKey;
				state.keys.push(key);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const failure =
						key === "acc-B"
							? { errorMessage: ORG_OAUTH_DENIAL, errorStatus: 403 }
							: state.aUsageLimited
								? { errorMessage: USAGE_LIMIT_MESSAGE, errorStatus: 429 }
								: undefined;
					if (failure) {
						stream.push({ type: "start", partial: assistant() });
						stream.push({
							type: "error",
							reason: "error",
							error: { ...assistant(), stopReason: "error", ...failure },
						});
						return;
					}
					const message = assistant("ok");
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
			SOURCE,
		);
	}

	async function openStorage(events: CredentialDisabledEvent[]): Promise<AuthStorage> {
		if (!store) throw new Error("test setup failed");
		const storage = new AuthStorage(store, {
			onCredentialDisabled: event => {
				events.push(event);
			},
		});
		await storage.set(PROVIDER, [
			{ type: "oauth", access: "acc-A", refresh: "ref-A", expires: farExpiry() },
			{ type: "oauth", access: "acc-B", refresh: "ref-B", expires: farExpiry() },
		]);
		return storage;
	}

	async function sessionPinnedTo(storage: AuthStorage, key: string): Promise<string> {
		for (let index = 0; index < 64; index += 1) {
			const sessionId = `pin-${key}-${index}`;
			if ((await storage.getApiKey(PROVIDER, sessionId)) === key) return sessionId;
		}
		throw new Error(`no session hashed onto ${key}`);
	}

	async function run(storage: AuthStorage, sessionId: string): Promise<AssistantMessage> {
		const stream = streamSimple(model(), context, { apiKey: storage.resolver(PROVIDER, { sessionId }) });
		for await (const _event of stream) {
			// drain
		}
		return stream.result();
	}

	test("403 oauth_not_allowed_for_organization disables the credential and retries on the working sibling", async () => {
		const events: CredentialDisabledEvent[] = [];
		const storage = await openStorage(events);
		const upstream = { keys: [] as unknown[], aUsageLimited: false };
		registerUpstream(upstream);
		const sessionId = await sessionPinnedTo(storage, "acc-B");

		const result = await run(storage, sessionId);

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "ok" }]);
		expect(upstream.keys).toEqual(["acc-B", "acc-A"]);
		expect(events).toHaveLength(1);
		expect(events[0]?.provider).toBe(PROVIDER);
		expect(events[0]?.disabledCause).toContain("oauth_not_allowed_for_organization");
		const disabled = await storage.listDisabledCredentials(PROVIDER);
		expect(disabled.map(entry => entry.cause)).toEqual([
			expect.stringContaining("oauth_not_allowed_for_organization"),
		]);

		// Sub-agents share this storage; a later process opens the same database.
		// Neither may hand the org-denied credential out again.
		for (let index = 0; index < 8; index += 1) {
			expect(await storage.getApiKey(PROVIDER, `subagent-${index}`)).toBe("acc-A");
		}
		const nextProcess = new AuthStorage(store!);
		await nextProcess.reload();
		for (let index = 0; index < 8; index += 1) {
			expect(await nextProcess.getApiKey(PROVIDER, `next-process-${index}`)).toBe("acc-A");
		}
	});

	test("when the only sibling is org-denied, the usage limit of the retained credential is surfaced", async () => {
		const events: CredentialDisabledEvent[] = [];
		const storage = await openStorage(events);
		const upstream = { keys: [] as unknown[], aUsageLimited: true };
		registerUpstream(upstream);
		const sessionId = await sessionPinnedTo(storage, "acc-A");

		const first = await run(storage, sessionId);

		expect(upstream.keys).toEqual(["acc-A", "acc-B"]);
		expect(first.stopReason).toBe("error");
		// The retryable quota failure, not the non-retryable 403 of a credential
		// that just left rotation: the caller's retry layer can wait this out.
		expect(first.errorMessage).toContain("usage limit");
		expect(first.errorMessage).not.toContain("oauth_not_allowed_for_organization");
		expect(events.map(event => event.disabledCause)).toEqual([
			expect.stringContaining("oauth_not_allowed_for_organization"),
		]);

		// A concurrent sub-agent never burns a request on the org-denied credential.
		upstream.keys.length = 0;
		const second = await run(storage, "subagent-after-revocation");
		expect(upstream.keys).toEqual(["acc-A"]);
		expect(second.errorMessage).toContain("usage limit");
	});

	test("a failed usage-report fetch does not block or switch away from a working credential", async () => {
		if (!store) throw new Error("test setup failed");
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const startedAt = now;
		const fiveHourLimit = (usedFraction: number, resetsAt: number): UsageLimit => ({
			id: `${PROVIDER}:5h`,
			label: "5 Hour",
			scope: { provider: PROVIDER, windowId: "5h", shared: true },
			window: { id: "5h", label: "5 Hour", durationMs: 5 * 60 * 60_000, resetsAt },
			amount: { used: usedFraction * 100, limit: 100, usedFraction, unit: "percent" },
			status: usedFraction >= 1 ? "exhausted" : "ok",
		});
		const report = (limit: UsageLimit): UsageReport => ({ provider: PROVIDER, fetchedAt: now, limits: [limit] });
		const usageCalls: string[] = [];
		const usageProvider: UsageProvider = {
			id: PROVIDER,
			async fetchUsage(params) {
				const token = params.credential.accessToken ?? "";
				usageCalls.push(token);
				const aCalls = usageCalls.filter(call => call === "acc-A").length;
				if (token === "acc-A" && aCalls === 1) return report(fiveHourLimit(0.5, startedAt + 60 * 60_000));
				// The 5h window fills and resets seven minutes later.
				if (token === "acc-A" && aCalls === 2) return report(fiveHourLimit(1, startedAt + 7 * 60_000));
				// Afterwards the usage endpoint is IP-throttled, as in the CAD trace.
				throw new ProviderHttpError("429 Too Many Requests", 429);
			},
		};
		const rankingStrategy: CredentialRankingStrategy = {
			findWindowLimits: usage => ({ primary: usage.limits[0] }),
			windowDefaults: { primaryMs: 5 * 60 * 60_000, secondaryMs: 7 * 24 * 60 * 60_000 },
		};
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === PROVIDER ? usageProvider : undefined),
			rankingStrategyResolver: provider => (provider === PROVIDER ? rankingStrategy : undefined),
		});
		await storage.set(PROVIDER, [
			{ type: "oauth", access: "acc-A", refresh: "ref-A", expires: farExpiry() },
			{ type: "oauth", access: "acc-B", refresh: "ref-B", expires: farExpiry() },
		]);
		const [rowA] = store.listAuthCredentials(PROVIDER);
		if (!rowA) throw new Error("expected credential A");

		// A (measured, half used) outranks B (usage fetch throttled) and becomes sticky.
		expect(await storage.getApiKey(PROVIDER, "main")).toBe("acc-A");

		// Another session sees A exhausted and legitimately routes around it until the reset.
		// 6.5 min clears the first report's cache (5 min TTL, up to +25% jitter) but stays
		// before the 7 min reset.
		now = startedAt + 6.5 * 60_000;
		expect(await storage.getApiKey(PROVIDER, "other")).toBe("acc-B");

		// Past the reset, every usage fetch for A fails with 429, so storage can only
		// serve A's last good report — the pre-reset exhaustion. That is not evidence
		// A is limited now: its sticky session must stay on A and A must stay unblocked.
		now = startedAt + 20 * 60_000;
		const callsBefore = usageCalls.length;
		expect(await storage.getApiKey(PROVIDER, "main")).toBe("acc-A");
		expect(usageCalls.slice(callsBefore)).toContain("acc-A");
		const block = store.getCredentialBlock?.(rowA.id, `${PROVIDER}:oauth`, "");
		expect(block === undefined || block <= now).toBe(true);
	});
});
