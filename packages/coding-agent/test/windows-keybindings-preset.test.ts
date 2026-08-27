import { afterEach, describe, expect, it } from "bun:test";
import {
	KeybindingsManager,
	WINDOWS_KEYBINDINGS,
} from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { canonicalKeyId, parseKey } from "@oh-my-pi/pi-tui";

const NEW_ACTION_IDS = new Set([
	"tui.editor.redo",
	"tui.editor.selectAll",
	"tui.editor.selectLeft",
	"tui.editor.selectRight",
	"tui.editor.selectUp",
	"tui.editor.selectDown",
	"tui.editor.selectWordLeft",
	"tui.editor.selectWordRight",
	"tui.editor.selectToLineStart",
	"tui.editor.selectToLineEnd",
	"tui.editor.cut",
	"tui.editor.paste",
	"app.draft.restore",
	"app.copy.picker",
]);

// SHA-256 of JSON.stringify(getResolvedBindings()) for every action that existed
// before presets were introduced. New, unbound action ids are filtered out and
// the already-platform-dependent image-paste value is normalized.
const PRESET_FREE_DEFAULT_BINDINGS_SHA256 = "632b9e642e3696eb63b1453706f287d2150ebab5ef8fc6d000eb29d88092a52d";

afterEach(() => {
	resetSettingsForTest();
});

describe("Windows keybinding preset", () => {
	it("defaults the settings-selected preset to default", async () => {
		await Settings.init({ inMemory: true });
		const missingAgentDir = `${process.cwd()}/.missing-default-keybindings-test`;
		const keybindings = KeybindingsManager.create(missingAgentDir, { inheritedAgentDir: missingAgentDir });

		expect(keybindings.getPreset()).toBe("default");
		expect(keybindings.getKeys("tui.editor.selectAll")).toEqual([]);
	});

	it("loads keybindings.preset from the settings configuration", async () => {
		await Settings.init({
			inMemory: true,
			overrides: { "keybindings.preset": "windows" },
		});
		const missingAgentDir = `${process.cwd()}/.missing-windows-keybindings-test`;
		const keybindings = KeybindingsManager.create(missingAgentDir, { inheritedAgentDir: missingAgentDir });

		expect(keybindings.getPreset()).toBe("windows");
		expect(keybindings.getKeys("tui.editor.selectAll")).toEqual(["ctrl+a"]);
	});

	it("resolves explicit user overrides before the active preset, then built-in defaults", () => {
		const keybindings = KeybindingsManager.inMemory({ "app.clear": "f12" }, "windows");

		expect(keybindings.getKeys("app.clear")).toEqual(["f12"]);
		expect(keybindings.getKeys("tui.editor.selectAll")).toEqual(["ctrl+a"]);
		expect(keybindings.getKeys("app.retry")).toEqual(["alt+r"]);
		expect(keybindings.getPreset()).toBe("windows");
	});

	it("implements the complete Windows editing map without conflicting preset claims", () => {
		const keybindings = KeybindingsManager.inMemory({}, "windows");

		for (const [action, configuredKeys] of Object.entries(WINDOWS_KEYBINDINGS)) {
			const expectedKeys = Array.isArray(configuredKeys) ? configuredKeys : [configuredKeys];
			expect(keybindings.getKeys(action as keyof typeof WINDOWS_KEYBINDINGS)).toEqual(expectedKeys);
		}
		expect(keybindings.getConflicts()).toEqual([]);

		expect(keybindings.getKeys("app.suspend")).not.toContain("ctrl+z");
		expect(keybindings.getKeys("tui.editor.yank")).toEqual([]);
		expect(keybindings.getKeys("tui.editor.cursorLineStart")).toEqual(["home"]);
	});

	it("provides parseable legacy-terminal fallbacks for Ctrl+Shift+letter-only actions", () => {
		const keybindings = KeybindingsManager.inMemory({}, "windows");

		expect(parseKey("\x1bk")).toBe("alt+k");
		expect(keybindings.matches("\x1bk", "app.clear")).toBe(true);
		expect(keybindings.getKeys("app.clear")).toContain("alt+k");

		expect(parseKey("\x1bc")).toBe("alt+c");
		expect(keybindings.matches("\x1bc", "app.copy.picker")).toBe(true);
		expect(keybindings.getKeys("app.copy.picker")).toContain("alt+c");
	});

	it("parses the preset's modified navigation chords without CSI-u", () => {
		const legacySequences = [
			["shift+left", "\x1b[1;2D"],
			["shift+right", "\x1b[1;2C"],
			["shift+up", "\x1b[1;2A"],
			["shift+down", "\x1b[1;2B"],
			["ctrl+shift+left", "\x1b[1;6D"],
			["ctrl+shift+right", "\x1b[1;6C"],
			["shift+home", "\x1b[1;2H"],
			["shift+end", "\x1b[1;2F"],
			["ctrl+alt+z", "\x1b\x1a"],
		] as const;

		for (const [chord, sequence] of legacySequences) {
			const parsed = parseKey(sequence);
			if (parsed === undefined) throw new Error(`Expected ${chord} legacy sequence to parse`);
			expect(canonicalKeyId(parsed)).toBe(canonicalKeyId(chord));
		}
	});

	it("keeps the pre-preset default bindings byte-identical and leaves new actions unbound", () => {
		const resolved = KeybindingsManager.inMemory().getResolvedBindings();
		// Typed as unknown-valued: the image-paste entry is normalized to a sentinel string
		// below so the digest stays stable across platforms, which the binding value type
		// (KeyId[] | KeyId | undefined) would otherwise reject.
		const prePresetBindings: Record<string, unknown> = Object.fromEntries(
			Object.entries(resolved).filter(([action]) => !NEW_ACTION_IDS.has(action)),
		);
		prePresetBindings["app.clipboard.pasteImage"] = "<platform-default>";
		const digest = new Bun.CryptoHasher("sha256").update(JSON.stringify(prePresetBindings)).digest("hex");

		expect(digest).toBe(PRESET_FREE_DEFAULT_BINDINGS_SHA256);
		for (const action of NEW_ACTION_IDS) {
			expect(resolved[action]).toEqual([]);
		}
	});
});
