import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ContextFile, contextFileCapability } from "@chudware/coding-agent/capability/context-file";
import { resetSettingsForTest, Settings } from "@chudware/coding-agent/config/settings";
import { initializeWithSettings, loadCapability } from "@chudware/coding-agent/discovery";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@chudware/utils";

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete process.env[key];
		return;
	}
	process.env[key] = value;
	process.env[key] = value;
}

describe("disabledExtensions runtime filtering", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;
	let originalAgentDirEnv: string | undefined;
	let originalOmpProfileEnv: string | undefined;
	let originalPiProfileEnv: string | undefined;
	let originalUserProfile: string | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		originalAgentDirEnv = process.env.CHUDCODE_CODING_AGENT_DIR;
		originalOmpProfileEnv = process.env.CHUDCODE_PROFILE;
		originalPiProfileEnv = process.env.CHUDCODE_PROFILE;
		originalHome = process.env.HOME;
		originalUserProfile = process.env.USERPROFILE;
		tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "chudcode-disabled-ext-home-"));
		process.env.HOME = tempHomeDir;
		process.env.USERPROFILE = tempHomeDir;
		vi.spyOn(os, "homedir").mockReturnValue(tempHomeDir);
		setAgentDir(path.join(tempHomeDir, ".chudcode", "agent"));
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chudcode-disabled-ext-"));
		await fs.mkdir(path.join(tempDir, ".chudcode"), { recursive: true });
		await fs.writeFile(path.join(tempDir, ".chudcode", "AGENTS.md"), "# project instructions\n");

		const settings = await Settings.init({
			inMemory: true,
			cwd: tempDir,
			overrides: {
				disabledExtensions: ["context-file:project:AGENTS.md"],
			},
		});
		initializeWithSettings(settings);
	});

	afterEach(async () => {
		resetSettingsForTest();
		vi.restoreAllMocks();
		restoreEnvValue("HOME", originalHome);
		restoreEnvValue("CHUDCODE_PROFILE", originalOmpProfileEnv);
		restoreEnvValue("CHUDCODE_PROFILE", originalPiProfileEnv);
		restoreEnvValue("CHUDCODE_CODING_AGENT_DIR", originalAgentDirEnv);
		restoreEnvValue("USERPROFILE", originalUserProfile);
		__resetDirsFromEnvForTests();
		await removeWithRetries(tempHomeDir);
		await removeWithRetries(tempDir);
	});

	test("hides disabled context files from runtime loads by default", async () => {
		const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: tempDir });

		expect(result.items).toHaveLength(0);
	});

	test("can include disabled context files for dashboard-style loads", async () => {
		const result = await loadCapability<ContextFile>(contextFileCapability.id, {
			cwd: tempDir,
			includeDisabled: true,
		});

		expect(result.items).toHaveLength(1);
		expect(path.basename(result.items[0]!.path)).toBe("AGENTS.md");
	});
});
