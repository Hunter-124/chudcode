import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	containsTokenmaxxing,
	highlightTokenmaxxing,
	renderTokenmaxxingNotice,
} from "@oh-my-pi/pi-coding-agent/modes/tokenmaxxing";

beforeAll(() => {
	// highlightTokenmaxxing reads the global theme's color mode.
	initTheme();
});

describe("tokenmaxxing keyword detection", () => {
	it("matches the lowercase trigger word delimited by whitespace or a string edge", () => {
		expect(containsTokenmaxxing("tokenmaxxing")).toBe(true);
		expect(containsTokenmaxxing("please tokenmaxxing this audit")).toBe(true);
		expect(containsTokenmaxxing("worth tokenmaxxing")).toBe(true);
	});

	it("matches the lowercase trigger word beside prose punctuation and quotes", () => {
		for (const text of ["do it. tokenmaxxing.", "tokenmaxxing, then report", 'say "tokenmaxxing" now']) {
			expect(containsTokenmaxxing(text)).toBe(true);
		}
	});

	it("ignores casing, inflections, code symbols, and path-embedded forms", () => {
		expect(containsTokenmaxxing("Tokenmaxxing")).toBe(false);
		expect(containsTokenmaxxing("TOKENMAXXING")).toBe(false);
		expect(containsTokenmaxxing("tokenmaxxed the turn")).toBe(false);
		expect(containsTokenmaxxing("tokenmaxxings")).toBe(false);
		expect(containsTokenmaxxing("tokenmaxxing()")).toBe(false);
		expect(containsTokenmaxxing("foo::tokenmaxxing")).toBe(false);
		expect(containsTokenmaxxing("src/modes/tokenmaxxing.ts")).toBe(false);
	});

	it("ignores the keyword inside code spans, fences, and xml sections", () => {
		expect(containsTokenmaxxing("`tokenmaxxing`")).toBe(false);
		expect(containsTokenmaxxing("```\ntokenmaxxing\n```")).toBe(false);
		expect(containsTokenmaxxing("<x>tokenmaxxing</x>")).toBe(false);
	});
});

describe("tokenmaxxing keyword highlighting", () => {
	it("decorates the keyword in bold with zero-width escapes, preserving visible text", () => {
		const input = "please tokenmaxxing this";
		const decorated = highlightTokenmaxxing(input);
		expect(decorated).not.toBe(input);
		expect(decorated).toContain("\x1b[1m");
		expect(decorated).toContain("\x1b[22m");
		expect(Bun.stripANSI(decorated)).toBe(input);
	});

	it("leaves text without the standalone keyword untouched", () => {
		expect(highlightTokenmaxxing("tokenmaxxinged builds")).toBe("tokenmaxxinged builds");
		expect(highlightTokenmaxxing("Tokenmaxxing this")).toBe("Tokenmaxxing this");
		const filePath = "src/modes/tokenmaxxing.ts";
		expect(highlightTokenmaxxing(filePath)).toBe(filePath);
	});

	it("keeps its palette inside the HSL hue range while wrapping gold through red to pink", () => {
		// The hue map wraps below 0; a wrapped stop that fell out of range would
		// compile to an empty escape and leave part of the word unpainted.
		const decorated = highlightTokenmaxxing("tokenmaxxing");
		const stops = new Set(decorated.match(/\x1b\[38[;0-9:]*m/g) ?? []);
		expect(stops.size).toBeGreaterThan(4);
	});
});

describe("renderTokenmaxxingNotice", () => {
	it("delegates the dispatch branch to the orchestration contract only when task is active", () => {
		const withTask = renderTokenmaxxingNotice({ tools: ["task", "eval"], scoutAvailable: true });
		const withoutTask = renderTokenmaxxingNotice({ tools: ["read"], scoutAvailable: true });
		expect(withTask).toContain("parallel `task` calls in one message under the orchestration contract");
		expect(withoutTask).not.toContain("orchestration contract");
		expect(withoutTask).toContain("sequence them yourself");
	});

	it("offers the programmatic fan-out branch only when eval is active", () => {
		expect(renderTokenmaxxingNotice({ tools: ["eval"], scoutAvailable: true })).toContain("program it in `eval`");
		expect(renderTokenmaxxingNotice({ tools: ["task"], scoutAvailable: true })).toContain(
			"bounded sequential rounds",
		);
	});
});
