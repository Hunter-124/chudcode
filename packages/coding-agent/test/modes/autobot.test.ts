import { beforeAll, describe, expect, it } from "bun:test";
import { AUTOBOT_NOTICE, MAGIC_KEYWORDS } from "@oh-my-pi/pi-coding-agent/modes/magic-keywords";
import { containsMagicKeyword, highlightMagicKeywords, setMagicKeywords } from "@oh-my-pi/pi-tui/prompt/magic-keywords";
import { initThemeSync } from "@oh-my-pi/pi-tui/theme";

beforeAll(() => {
	initThemeSync();
	setMagicKeywords(MAGIC_KEYWORDS);
});

const word = "autobot";

describe("autobot prose trigger", () => {
	it("matches lowercase standalone words in prose but not inflections or code", () => {
		for (const text of [word, "please autobot this", "do it. autobot.", 'say "autobot" now']) {
			expect(containsMagicKeyword(text, word)).toBe(true);
		}
		for (const text of [
			"Autobot",
			"AUTOBOT",
			"autobots",
			"semiautobot",
			"autobot()",
			"foo::autobot",
			"src/modes/autobot.ts",
			"`autobot`",
			"```\nautobot\n```",
			"<x>autobot</x>",
		]) {
			expect(containsMagicKeyword(text, word)).toBe(false);
		}
	});

	it("paints prose while retaining the visible message and leaving paths untouched", () => {
		const input = "please autobot this";
		const highlighted = highlightMagicKeywords(input);
		expect(highlighted).not.toBe(input);
		expect(Bun.stripANSI(highlighted)).toBe(input);
		expect(highlightMagicKeywords("src/modes/autobot.ts")).toBe("src/modes/autobot.ts");
	});
});

describe("autobot notice", () => {
	it("grants standing authority without granting destructive or irreversible actions", () => {
		expect(AUTOBOT_NOTICE.startsWith("<system-notice>")).toBe(true);
		expect(AUTOBOT_NOTICE.endsWith("</system-notice>")).toBe(true);
		expect(AUTOBOT_NOTICE).toContain("Reversible actions need no approval");
		expect(AUTOBOT_NOTICE).toContain("destructive or externally irreversible actions");
		expect(AUTOBOT_NOTICE).toContain("intent verification");
	});
});
