import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getThemeByName } from "@chudware/coding-agent/modes/theme/theme";
import { getAgentDir, getCustomThemesDir, removeWithRetries, setAgentDir } from "@chudware/utils";
import * as fsx from "@chudware/utils/fsx";

const DARK_THEME_PATH = path.join(import.meta.dir, "..", "src", "modes", "theme", "dark.json");

let tempAgentDir: string | undefined;
let originalAgentDir = "";
let originalAgentDirEnv: string | undefined;

afterEach(async () => {
	if (tempAgentDir === undefined) return;
	setAgentDir(originalAgentDir);
	if (originalAgentDirEnv === undefined) {
		delete process.env.CHUDCODE_CODING_AGENT_DIR;
	} else {
		process.env.CHUDCODE_CODING_AGENT_DIR = originalAgentDirEnv;
	}
	await removeWithRetries(tempAgentDir);
	tempAgentDir = undefined;
});

it("uses the Nerd Fonts v3 session and C# icons", async () => {
	originalAgentDir = getAgentDir();
	originalAgentDirEnv = process.env.CHUDCODE_CODING_AGENT_DIR;
	tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "chudcode-nerd-symbols-"));
	setAgentDir(tempAgentDir);

	const dark = await fsx.readJson(DARK_THEME_PATH);
	const customThemeName = "nerd-symbols";
	await fsx.write(
		path.join(getCustomThemesDir(), `${customThemeName}.json`),
		JSON.stringify({ ...dark, name: customThemeName, symbols: { ...dark.symbols, preset: "nerd" } }),
	);

	const theme = await getThemeByName(customThemeName);
	expect(theme?.symbol("icon.session")).toBe("\u{f0051}");
	expect(theme?.getLangIcon("csharp")).toBe("\u{e7b2}");
});

it("resolves subscription and advisor icons in Nerd Font mode", async () => {
	originalAgentDir = getAgentDir();
	originalAgentDirEnv = process.env.CHUDCODE_CODING_AGENT_DIR;
	tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "chudcode-nerd-symbols-"));
	setAgentDir(tempAgentDir);

	const dark = await fsx.readJson(DARK_THEME_PATH);
	const customThemeName = "nerd-annotation-symbols";
	await fsx.write(
		path.join(getCustomThemesDir(), `${customThemeName}.json`),
		JSON.stringify({ ...dark, name: customThemeName, symbols: { ...dark.symbols, preset: "nerd" } }),
	);

	const theme = await getThemeByName(customThemeName);
	expect(theme?.symbol("icon.subscription")).toBe("\u{f067a}");
	expect(theme?.symbol("icon.advisor")).toBe("\uea70");
	expect(theme?.icon.subscription).toBe("\u{f067a}");
	expect(theme?.icon.advisor).toBe("\uea70");
});
