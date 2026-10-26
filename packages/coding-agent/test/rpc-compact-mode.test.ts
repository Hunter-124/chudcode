import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { CompactMode } from "@oh-my-pi/pi-coding-agent/session/compact-modes";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("RPC compact mode", () => {
	let client: RpcClient;
	let directory: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-compact-mode-"));
		client = new RpcClient({
			command: [process.execPath, path.join(import.meta.dir, "fixtures", "queued-message-rpc-agent.ts")],
			cwd: directory,
			env: { PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1" },
		});
	});

	afterEach(async () => {
		await client?.stop();
		await removeWithRetries(directory);
	});

	test("refuses an unknown mode instead of running the configured methods", async () => {
		await client.start();
		await expect(client.compact(undefined, "squash" as CompactMode)).rejects.toThrow(
			"mode must be one of: soft, remote, snapcompact",
		);
	}, 30_000);

	test("hands a known mode to the compaction itself", async () => {
		await client.start();
		// Accepted modes reach the session: snapcompact's own focus rule and the
		// empty-session precondition answer, not the RPC mode validation.
		await expect(client.compact("keep the dims", "snapcompact")).rejects.toThrow(
			"/compact snapcompact does not take focus instructions.",
		);
		await expect(client.compact(undefined, "soft")).rejects.toThrow("Nothing to compact");
	}, 30_000);
});
