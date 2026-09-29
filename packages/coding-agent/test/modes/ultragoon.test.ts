import { beforeAll, describe, expect, it } from "bun:test";
import { renderUltragoonNotice, MAGIC_KEYWORDS } from "@oh-my-pi/pi-coding-agent/modes/magic-keywords";
import { containsMagicKeyword, highlightMagicKeywords, setMagicKeywords } from "@oh-my-pi/pi-tui/prompt/magic-keywords";
import { initThemeSync } from "@oh-my-pi/pi-tui/theme";

beforeAll(() => {
	initThemeSync();
	setMagicKeywords(MAGIC_KEYWORDS);
});

const word = "ultragoon";

describe("ultragoon prose trigger", () => {
	it("matches lowercase standalone words in prose but not inflections or code", () => {
		for (const text of [word, "please ultragoon this", "do it. ultragoon.", 'say "ultragoon" now']) {
			expect(containsMagicKeyword(text, word)).toBe(true);
		}
		for (const text of [
			"Ultragoon",
			"ULTRAGOON",
			"ultragooning",
			"preultragoon",
			"ultragoon()",
			"foo::ultragoon",
			"src/modes/ultragoon.ts",
			"`ultragoon`",
			"```\nultragoon\n```",
			"<x>ultragoon</x>",
		]) {
			expect(containsMagicKeyword(text, word)).toBe(false);
		}
	});

	it("paints prose while retaining the visible message and leaving paths untouched", () => {
		const input = "please ultragoon this";
		const highlighted = highlightMagicKeywords(input);
		expect(highlighted).not.toBe(input);
		expect(Bun.stripANSI(highlighted)).toBe(input);
		expect(highlightMagicKeywords("src/modes/ultragoon.ts")).toBe("src/modes/ultragoon.ts");
	});
});

describe("ultragoon notice", () => {
	it("chooses scout only when available and offers read-only task workers otherwise", () => {
		const withScout = renderUltragoonNotice({ tools: ["ask", "task"], scoutAvailable: true });
		const withoutScout = renderUltragoonNotice({ tools: ["ask", "task"], scoutAvailable: false });
		expect(withScout).toContain("`scout` subagents");
		expect(withoutScout).not.toContain("`scout`");
		expect(withoutScout).toContain("read-only `task` subagents");
	});

	it("uses only available research helpers and explicit defaults when dispatch and ask are absent", () => {
		const notice = renderUltragoonNotice({ tools: ["read", "grep"], scoutAvailable: true });
		expect(notice).toContain("`grep`/`read`");
		expect(notice).not.toContain("`glob`");
		expect(notice).toContain("No `ask` tool");
		expect(notice).not.toContain("subagents");
		expect(notice).not.toContain("{{");
	});

	it("only names optional acceptance tracking when todo is present", () => {
		expect(renderUltragoonNotice({ tools: ["ask", "todo"], scoutAvailable: true })).toContain("`todo` phases");
		expect(renderUltragoonNotice({ tools: ["ask"], scoutAvailable: true })).not.toContain("`todo`");
	});
});
