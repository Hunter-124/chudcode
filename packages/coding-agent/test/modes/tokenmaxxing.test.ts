import { beforeAll, describe, expect, it } from "bun:test";
import { MAGIC_KEYWORDS, renderTokenmaxxingNotice } from "@oh-my-pi/pi-coding-agent/modes/magic-keywords";
import { containsMagicKeyword, highlightMagicKeywords, setMagicKeywords } from "@oh-my-pi/pi-tui/prompt/magic-keywords";
import { initThemeSync } from "@oh-my-pi/pi-tui/theme";

beforeAll(() => {
	initThemeSync();
	setMagicKeywords(MAGIC_KEYWORDS);
});

const word = "tokenmaxxing";

describe("tokenmaxxing prose trigger", () => {
	it("matches lowercase standalone words in prose but not inflections or code", () => {
		for (const text of [word, "please tokenmaxxing this", "do it. tokenmaxxing.", 'say "tokenmaxxing" now']) {
			expect(containsMagicKeyword(text, word)).toBe(true);
		}
		for (const text of [
			"Tokenmaxxing",
			"TOKENMAXXING",
			"tokenmaxxed",
			"tokenmaxxings",
			"tokenmaxxing()",
			"foo::tokenmaxxing",
			"src/modes/tokenmaxxing.ts",
			"`tokenmaxxing`",
			"```\ntokenmaxxing\n```",
			"<x>tokenmaxxing</x>",
		]) {
			expect(containsMagicKeyword(text, word)).toBe(false);
		}
	});

	it("paints prose across the gold-to-pink sweep without losing any visible letters", () => {
		const input = "please tokenmaxxing this";
		const highlighted = highlightMagicKeywords(input);
		expect(Bun.stripANSI(highlighted)).toBe(input);
		expect(new Set(highlighted.match(/\x1b\[38[;0-9:]*m/g) ?? []).size).toBeGreaterThan(4);
		expect(highlightMagicKeywords("src/modes/tokenmaxxing.ts")).toBe("src/modes/tokenmaxxing.ts");
	});
});

describe("tokenmaxxing notice", () => {
	it("routes independent work through task only when available", () => {
		const withTask = renderTokenmaxxingNotice({ tools: ["task", "eval"], scoutAvailable: true });
		const withoutTask = renderTokenmaxxingNotice({ tools: ["read"], scoutAvailable: true });
		expect(withTask).toContain("parallel `task` calls");
		expect(withTask).toContain("`scout`");
		expect(withoutTask).toContain("sequence them yourself");
		expect(withoutTask).not.toContain("`scout`");
		expect(withoutTask).not.toContain("`task`");
	});

	it("uses eval fan-out and ask only when active, without changing reasoning level", () => {
		const withEval = renderTokenmaxxingNotice({ tools: ["eval", "ask"], scoutAvailable: false });
		const withoutEval = renderTokenmaxxingNotice({ tools: [], scoutAvailable: false });
		expect(withEval).toContain("program it in `eval`");
		expect(withEval).toContain("batched `ask`");
		expect(withoutEval).not.toContain("program it in `eval`");
		expect(withoutEval).not.toContain("batched `ask`");
		expect(withoutEval).toContain("Reasoning level is unchanged");
		expect(withoutEval).not.toContain("{{");
	});
});
