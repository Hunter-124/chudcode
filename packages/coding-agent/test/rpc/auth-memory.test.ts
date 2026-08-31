import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@chudware/ai";
import type { AgentSession } from "@chudware/coding-agent";
import { getMemoryRoot } from "@chudware/coding-agent/memories";
import { localBackend } from "@chudware/coding-agent/memory-backend/local-backend";
import {
	boundRpcMemoryHits,
	getRpcAuthProviderState,
	RPC_MEMORY_TOKEN_BUDGET_MAX,
	resolveRpcMemoryRoot,
} from "@chudware/coding-agent/modes/rpc/rpc-mode";
import type { RpcCommand } from "@chudware/coding-agent/modes/rpc/rpc-types";

const tempDirs: string[] = [];

async function tempDir(label: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `chudcode-rpc-${label}-`));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { force: true, recursive: true })));
});

describe("RPC auth and memory protocol", () => {
	test("declares every additive auth and memory command shape", () => {
		const commands: RpcCommand[] = [
			{ id: "auth-state", type: "get_auth_state", providerId: "anthropic" },
			{ id: "validate", type: "validate_api_key", providerId: "anthropic", apiKey: "secret" },
			{ id: "set", type: "set_api_key", providerId: "anthropic", apiKey: "secret" },
			{ id: "remove", type: "remove_api_key", providerId: "anthropic", accountId: "account" },
			{ id: "logout", type: "logout_provider", providerId: "anthropic", accountId: "account" },
			{ id: "remember", type: "memory_remember", root: ".", content: "value", kind: "project" },
			{ id: "recall", type: "memory_recall", root: ".", query: "value", limit: 3, tokenBudget: 64 },
			{ id: "stats", type: "memory_stats", root: "." },
		];
		expect(commands.map(command => command.type)).toEqual([
			"get_auth_state",
			"validate_api_key",
			"set_api_key",
			"remove_api_key",
			"logout_provider",
			"memory_remember",
			"memory_recall",
			"memory_stats",
		]);
		expect(commands.map(command => command.id)).toEqual([
			"auth-state",
			"validate",
			"set",
			"remove",
			"logout",
			"remember",
			"recall",
			"stats",
		]);
	});

	test("sanitizes state read from the real credential store", async () => {
		const dir = await tempDir("auth-store");
		const authStorage = await AuthStorage.create(path.join(dir, "agent.db"));
		try {
			await authStorage.set("anthropic", [
				{ type: "api_key", key: "sk-never-return-this", source: "login" },
				{
					type: "oauth",
					access: "oauth-access-never-return-this",
					refresh: "oauth-refresh-never-return-this",
					expires: Date.now() + 60_000,
					accountId: "acct-7",
					email: "person@example.test",
					orgId: "org-4",
					orgName: "Example Org",
				},
			]);
			const session = { modelRegistry: { authStorage } } as unknown as AgentSession;
			const state = getRpcAuthProviderState(session, "anthropic");
			expect(state).toMatchObject({
				providerId: "anthropic",
				authenticated: true,
				hasApiKey: true,
				hasOAuth: true,
				accounts: [{ accountId: "acct-7", email: "person@example.test", orgId: "org-4", orgName: "Example Org" }],
			});
			const serialized = JSON.stringify(state);
			expect(serialized).not.toContain("sk-never-return-this");
			expect(serialized).not.toContain("oauth-access-never-return-this");
			expect(serialized).not.toContain("oauth-refresh-never-return-this");
		} finally {
			authStorage.close();
		}
	});

	test("uses the real local backend without a parallel memory store", async () => {
		const dir = await tempDir("memory-store");
		const agentDir = path.join(dir, "agent");
		const projectRoot = path.join(dir, "project");
		await fs.mkdir(projectRoot, { recursive: true });
		const result = await localBackend.save?.(
			{ agentDir, cwd: projectRoot },
			{ content: "Assembly units are millimeters.", context: "kind:project", source: "rpc-test", importance: 0.9 },
		);
		expect(result?.stored).toBe(1);
		const learned = await fs.readFile(path.join(getMemoryRoot(agentDir, projectRoot), "learned.md"), "utf8");
		expect(learned).toContain("Assembly units are millimeters.");
		expect(learned).toContain("kind:project");
	});

	test("rejects lexical and symlink project-root escapes", async () => {
		const dir = await tempDir("memory-scope");
		const projectRoot = path.join(dir, "project");
		const outsideRoot = path.join(dir, "outside");
		await Promise.all([fs.mkdir(projectRoot), fs.mkdir(outsideRoot)]);
		await fs.symlink(outsideRoot, path.join(projectRoot, "escape"));
		const session = {
			sessionManager: { getCwd: () => projectRoot },
		} as unknown as AgentSession;
		expect(await resolveRpcMemoryRoot(session, ".")).toBe(await fs.realpath(projectRoot));
		await expect(resolveRpcMemoryRoot(session, "../outside")).rejects.toThrow("escapes the active project");
		await expect(resolveRpcMemoryRoot(session, "escape")).rejects.toThrow("escapes the active project");
	});

	test("bounds recall hit count and approximate output tokens", () => {
		const hits = boundRpcMemoryHits(
			Array.from({ length: 150 }, (_, index) => ({
				id: `memory-${index}`,
				content: "x".repeat(4_096),
				source: "test",
				score: 1 - index / 1_000,
			})),
			100,
			64,
		);
		expect(hits.length).toBeGreaterThan(0);
		expect(hits.length).toBeLessThanOrEqual(100);
		expect(JSON.stringify(hits).length).toBeLessThanOrEqual(64 * 4 + 2);
		expect(RPC_MEMORY_TOKEN_BUDGET_MAX).toBe(32_768);
	});
});
