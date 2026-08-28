import { beforeAll, describe, expect, it } from "bun:test";
import { containsAutobot, highlightAutobot } from "@oh-my-pi/pi-coding-agent/modes/autobot";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(() => {
	// highlightAutobot reads the global theme's color mode.
	initTheme();
});

describe("autobot keyword detection", () => {
	it("matches the lowercase trigger word delimited by whitespace or a string edge", () => {
		expect(containsAutobot("autobot")).toBe(true);
		expect(containsAutobot("autobot the release prep")).toBe(true);
		expect(containsAutobot("just autobot")).toBe(true);
	});

	it("matches the lowercase trigger word beside prose punctuation and quotes", () => {
		for (const text of ["do it. autobot.", "autobot, then report", 'say "autobot" now']) {
			expect(containsAutobot(text)).toBe(true);
		}
	});

	it("ignores casing, inflections, code symbols, and path-embedded forms", () => {
		expect(containsAutobot("Autobot")).toBe(false);
		expect(containsAutobot("AUTOBOT")).toBe(false);
		expect(containsAutobot("autobots roll out")).toBe(false);
		expect(containsAutobot("semiautobot mode")).toBe(false);
		expect(containsAutobot("autobot()")).toBe(false);
		expect(containsAutobot("foo::autobot")).toBe(false);
		expect(containsAutobot("src/modes/autobot.ts")).toBe(false);
	});

	it("ignores the keyword inside code spans, fences, and xml sections", () => {
		expect(containsAutobot("`autobot`")).toBe(false);
		expect(containsAutobot("```\nautobot\n```")).toBe(false);
		expect(containsAutobot("<x>autobot</x>")).toBe(false);
	});
});

describe("autobot keyword highlighting", () => {
	it("decorates the keyword in bold with zero-width escapes, preserving visible text", () => {
		const input = "please autobot this";
		const decorated = highlightAutobot(input);
		expect(decorated).not.toBe(input);
		expect(decorated).toContain("\x1b[1m");
		expect(decorated).toContain("\x1b[22m");
		expect(Bun.stripANSI(decorated)).toBe(input);
	});

	it("leaves text without the standalone keyword untouched", () => {
		expect(highlightAutobot("autobots assemble")).toBe("autobots assemble");
		expect(highlightAutobot("Autobot this")).toBe("Autobot this");
		const filePath = "src/modes/autobot.ts";
		expect(highlightAutobot(filePath)).toBe(filePath);
	});
});
