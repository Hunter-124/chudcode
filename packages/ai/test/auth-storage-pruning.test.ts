import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AuthStorage,
	DISABLED_CREDENTIAL_TOMBSTONE_TTL_MS,
	type OAuthCredential,
	SqliteAuthCredentialStore,
} from "@chudware/ai";
import {
	AuthBrokerClient,
	type AuthBrokerServerHandle,
	RemoteAuthCredentialStore,
	startAuthBroker,
} from "@chudware/ai/auth-broker";
import { removeWithRetries } from "../../utils/src/temp";

const DAY_MS = 24 * 60 * 60_000;
const NOW_MS = Date.UTC(2026, 7, 30, 12);
const STALE_PERMANENT_EMAIL = "stale-permanent@example.test";
const STALE_REVOKED_EMAIL = "stale-revoked@example.test";
const STALE_TRANSIENT_EMAIL = "stale-transient@example.test";
const RECENT_INVALIDATION_EMAIL = "recent-invalidation@example.test";
const STALE_PERMANENT_CAUSE = "replaced by newer credential";
const STALE_REVOKED_CAUSE = "oauth refresh failed: invalid_grant; refresh token revoked";
const STALE_TRANSIENT_CAUSE = "oauth refresh failed: 429 rate limit after network timeout";
const RECENT_INVALIDATION_CAUSE = "oauth refresh failed: invalid_grant; refresh token revoked";

function mintOAuth(email: string): OAuthCredential {
	return {
		type: "oauth",
		access: `secret-access-${email}`,
		refresh: `secret-refresh-${email}`,
		expires: NOW_MS + DAY_MS,
		email,
		accountId: `account-${email}`,
	};
}

function seedDisabledCredentials(store: SqliteAuthCredentialStore, db: Database): void {
	const fixtures = [
		{ email: STALE_PERMANENT_EMAIL, cause: STALE_PERMANENT_CAUSE, ageDays: 47 },
		{ email: STALE_TRANSIENT_EMAIL, cause: STALE_TRANSIENT_CAUSE, ageDays: 47 },
		{ email: STALE_REVOKED_EMAIL, cause: STALE_REVOKED_CAUSE, ageDays: 47 },
		{ email: RECENT_INVALIDATION_EMAIL, cause: RECENT_INVALIDATION_CAUSE, ageDays: 35 },
	];
	for (const fixture of fixtures) {
		store.saveOAuth("anthropic", mintOAuth(fixture.email));
		const row = store.listAuthCredentials("anthropic").find(candidate => {
			return candidate.credential.type === "oauth" && candidate.credential.email === fixture.email;
		});
		if (!row) throw new Error(`missing seeded credential for ${fixture.email}`);
		store.deleteAuthCredential(row.id, fixture.cause);
		db.run("UPDATE auth_credentials SET updated_at = ? WHERE id = ?", [
			Math.floor((NOW_MS - fixture.ageDays * DAY_MS) / 1000),
			row.id,
		]);
	}
}

async function expectRetainedTombstones(storage: AuthStorage): Promise<void> {
	const disabled = await storage.listDisabledCredentials("anthropic");
	expect(disabled.map(summary => summary.email).sort()).toEqual(
		[RECENT_INVALIDATION_EMAIL, STALE_TRANSIENT_EMAIL].sort(),
	);
	expect(disabled.find(summary => summary.email === STALE_TRANSIENT_EMAIL)?.cause).toBe(STALE_TRANSIENT_CAUSE);
	expect(disabled.find(summary => summary.email === RECENT_INVALIDATION_EMAIL)?.cause).toBe(RECENT_INVALIDATION_CAUSE);
	const serialized = JSON.stringify(disabled);
	expect(serialized).not.toContain("secret-access-");
	expect(serialized).not.toContain("secret-refresh-");
}

test("local maintenance prunes only stale permanent tombstones with injected time", async () => {
	expect(DISABLED_CREDENTIAL_TOMBSTONE_TTL_MS).toBeGreaterThanOrEqual(35 * DAY_MS);
	expect(DISABLED_CREDENTIAL_TOMBSTONE_TTL_MS).toBeLessThanOrEqual(47 * DAY_MS);
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-pruning-local-"));
	const db = new Database(path.join(tempDir, "agent.db"));
	const store = new SqliteAuthCredentialStore(db);
	let storage: AuthStorage | undefined;
	try {
		seedDisabledCredentials(store, db);
		storage = new AuthStorage(store, { maintenanceNow: () => NOW_MS });
		await storage.reload();
		await expectRetainedTombstones(storage);
		store.saveOAuth("anthropic", mintOAuth("manual-delete@example.test"));
		const manualRow = store
			.listAuthCredentials("anthropic")
			.find(
				candidate =>
					candidate.credential.type === "oauth" && candidate.credential.email === "manual-delete@example.test",
			);
		if (!manualRow) throw new Error("missing manual-delete credential");
		store.deleteAuthCredential(manualRow.id, "deleted by user");
		expect((await storage.listDisabledCredentials("anthropic")).map(summary => summary.email)).not.toContain(
			"manual-delete@example.test",
		);
	} finally {
		storage?.close();
		if (!storage) store.close();
		await removeWithRetries(tempDir);
	}
});

test("broker-backed maintenance has the same retention behavior without client clock authority", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-pruning-remote-"));
	const db = new Database(path.join(tempDir, "broker.db"));
	const store = new SqliteAuthCredentialStore(db);
	let serverNowMs = NOW_MS - 6 * DAY_MS;
	let serverStorage: AuthStorage | undefined;
	let clientStorage: AuthStorage | undefined;
	let remoteStore: RemoteAuthCredentialStore | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	try {
		seedDisabledCredentials(store, db);
		serverStorage = new AuthStorage(store, { maintenanceNow: () => serverNowMs });
		await serverStorage.reload();
		expect((await serverStorage.listDisabledCredentials("anthropic")).map(summary => summary.email)).toContain(
			STALE_PERMANENT_EMAIL,
		);

		handle = startAuthBroker({
			storage: serverStorage,
			bind: "127.0.0.1:0",
			bearerTokens: ["pruning-test-token"],
			disableRefresher: true,
		});
		serverNowMs = NOW_MS;
		remoteStore = new RemoteAuthCredentialStore({
			client: new AuthBrokerClient({ url: handle.url, token: "pruning-test-token" }),
			streamSnapshots: false,
		});
		clientStorage = new AuthStorage(remoteStore, { maintenanceNow: () => NOW_MS });
		await clientStorage.reload();
		await expectRetainedTombstones(clientStorage);
	} finally {
		clientStorage?.close();
		if (!clientStorage) remoteStore?.close();
		await handle?.close();
		serverStorage?.close();
		if (!serverStorage) store.close();
		await removeWithRetries(tempDir);
	}
});
