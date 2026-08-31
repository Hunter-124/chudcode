import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { loadExtensions } from "@chudware/coding-agent/extensibility/extensions/loader";
import { __resetDirsFromEnvForTests, setAgentDir, TempDir } from "@chudware/utils";
import * as fsx from "@chudware/utils/fsx";

describe("issue #5879: provider extension compatibility", () => {
	it("creates a fresh agent database while loading current auth exports", async () => {
		const projectDir = TempDir.createSync("@issue-5879-");
		const freshAgentDir = projectDir.join("fresh", "agent");
		const originalDirEnv: Record<string, string | undefined> = {
			CHUDCODE_CODING_AGENT_DIR: process.env.CHUDCODE_CODING_AGENT_DIR,
			CHUDCODE_PROFILE: process.env.CHUDCODE_PROFILE,
		};
		const extensionPath = path.join(projectDir.path(), "chud-provider-like-plugin", "index.ts");
		const aiModule = pathToFileURL(path.resolve(import.meta.dir, "../../ai/src/index.ts")).href;
		const authStorageModule = pathToFileURL(path.resolve(import.meta.dir, "../src/session/auth-storage.ts")).href;
		const authDbPath = path.join(freshAgentDir, "agent.db");
		await fsx.write(
			extensionPath,
			[
				`import { createAssistantMessageEventStream } from ${JSON.stringify(aiModule)};`,
				`import { AuthStorage } from ${JSON.stringify(authStorageModule)};`,
				"",
				"export default async function() {",
				"\tconst stream = createAssistantMessageEventStream();",
				`\tconst auth = await AuthStorage.create(${JSON.stringify(authDbPath)});`,
				'\tif (auth.list().includes("issue-5879-missing-provider")) throw new Error("Unexpected test credential");',
				'\tif (typeof stream.push !== "function") throw new Error("Invalid assistant message event stream");',
				"}",
			].join("\n"),
		);

		setAgentDir(freshAgentDir);

		try {
			const result = await loadExtensions([extensionPath], projectDir.path());

			expect(result.errors).toEqual([]);
			expect(result.extensions).toHaveLength(1);
			expect(await fsx.exists(path.join(freshAgentDir, "agent.db"))).toBe(true);
		} finally {
			for (const key in originalDirEnv) {
				const value = originalDirEnv[key];
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			__resetDirsFromEnvForTests();
			projectDir.removeSync();
		}
	});
});
