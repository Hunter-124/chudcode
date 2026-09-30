import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { getMemoryRoot } from "@oh-my-pi/pi-coding-agent/memories";
import { localBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/local-backend";
import {
	boundRpcMemoryHits,
	getRpcAuthProviderState,
	resolveRpcMemoryRoot,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-auth-memory-"));
	dirs.push(dir);
	return dir;
}

describe("RPC auth and memory boundary", () => {
	test("reports stored OAuth identity without exposing key or token bytes", async () => {
		const dir = await tempDir();
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		try {
			await storage.credentials.set("anthropic", [
				{ type: "api_key", key: "sk-never-return-this", source: "login" },
				{
					type: "oauth",
					access: "oauth-access-never-return-this",
					refresh: "oauth-refresh-never-return-this",
					expires: Date.now() + 60_000,
					accountId: "acct-7",
					email: "person@example.test",
				},
			]);
			const session = { modelRegistry: { authStorage: storage } } as unknown as AgentSession;
			const state = getRpcAuthProviderState(session, "anthropic");
			expect(state).toMatchObject({
				authenticated: true,
				hasApiKey: true,
				hasOAuth: true,
				accounts: [{ accountId: "acct-7", email: "person@example.test" }],
			});
			const json = JSON.stringify(state);
			for (const secret of [
				"sk-never-return-this",
				"oauth-access-never-return-this",
				"oauth-refresh-never-return-this",
			])
				expect(json).not.toContain(secret);
		} finally {
			storage.close();
		}
	});

	test("accepts an explicit absolute project root outside service cwd, but confines relative roots", async () => {
		const dir = await tempDir();
		const project = path.join(dir, "project");
		const outside = path.join(dir, "outside");
		await Promise.all([fs.mkdir(project), fs.mkdir(outside)]);
		await fs.symlink(outside, path.join(project, "escape"));
		const session = { sessionManager: { getCwd: () => project } } as unknown as AgentSession;
		expect(await resolveRpcMemoryRoot(session, ".")).toBe(await fs.realpath(project));
		expect(await resolveRpcMemoryRoot(session, outside)).toBe(await fs.realpath(outside));
		await expect(resolveRpcMemoryRoot(session, "../outside")).rejects.toThrow("escapes the active project");
		await expect(resolveRpcMemoryRoot(session, "escape")).rejects.toThrow("escapes the active project");
	});

	test("stores project lessons in the configured local backend, not an RPC-specific store", async () => {
		const dir = await tempDir();
		const root = path.join(dir, "project");
		const agentDir = path.join(dir, "agent");
		await fs.mkdir(root);
		const result = await localBackend.save?.(
			{ agentDir, cwd: root },
			{ content: "Assembly units are millimeters.", context: "kind:project", source: "rpc" },
		);
		expect(result?.stored).toBe(1);
		const learned = await fs.readFile(path.join(getMemoryRoot(agentDir, root), "learned.md"), "utf8");
		expect(learned).toContain("Assembly units are millimeters.");
		expect(learned).toContain("kind:project");
	});

	test("bounds recall content, metadata, and hit count to token budget", () => {
		const hits = boundRpcMemoryHits(
			Array.from({ length: 150 }, (_, index) => ({
				id: `memory-${index}`,
				content: "x".repeat(4096),
				source: "source",
				score: 1 - index / 1000,
			})),
			100,
			64,
		);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.content.length).toBeLessThan(4096);
		expect(JSON.stringify(hits).length).toBeLessThanOrEqual(64 * 4 + 2);
	});
});
