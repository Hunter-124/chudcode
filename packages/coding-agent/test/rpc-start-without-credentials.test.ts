import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";

const cleanup: string[] = [];

afterEach(async () => {
	for (const dir of cleanup.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

// Embedding hosts start the RPC process before any credential exists and supply
// one later (set_api_key, login, or a scoped environment). The process must stay
// up and answer service commands instead of exiting on "No models available".
describe("RPC mode without credentials", () => {
	test("starts and answers state, catalog and auth commands", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "rpc-no-credentials-"));
		cleanup.push(home);
		const blanked = Object.fromEntries(
			Object.keys(process.env)
				.filter(name => /(_API_KEY|_TOKEN|_OAUTH)/.test(name))
				.map(name => [name, ""]),
		);
		using client = new RpcClient({
			cliPath: path.join(import.meta.dir, "..", "src", "cli.ts"),
			cwd: home,
			args: ["--no-session", "--no-lsp", "--no-skills"],
			env: {
				...blanked,
				HOME: home,
				XDG_CONFIG_HOME: path.join(home, "config"),
				XDG_DATA_HOME: path.join(home, "data"),
				XDG_STATE_HOME: path.join(home, "state"),
				XDG_CACHE_HOME: path.join(home, "cache"),
				PI_CODING_AGENT_DIR: path.join(home, "agent"),
				PI_NO_TITLE: "1",
				// Local model servers on the test host would otherwise supply a model.
				OLLAMA_BASE_URL: "http://127.0.0.1:9/v1",
				LM_STUDIO_BASE_URL: "http://127.0.0.1:9/v1",
				LLAMA_CPP_BASE_URL: "http://127.0.0.1:9/v1",
			},
		});

		await client.start();
		const state = await client.getState();
		expect(state.model).toBeUndefined();
		expect(Array.isArray(await client.getAvailableModels())).toBe(true);
		const auth = await client.getAuthState();
		expect(auth.providers.length).toBeGreaterThan(0);
	}, 60_000);
});
