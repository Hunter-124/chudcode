import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme } from "@chudware/coding-agent/modes/theme/theme";
import {
	containsUltragoon,
	highlightUltragoon,
	renderUltragoonNotice,
} from "@chudware/coding-agent/modes/ultragoon";

beforeAll(() => {
	// highlightUltragoon reads the global theme's color mode.
	initTheme();
});

describe("ultragoon keyword detection", () => {
	it("matches the lowercase trigger word delimited by whitespace or a string edge", () => {
		expect(containsUltragoon("ultragoon")).toBe(true);
		expect(containsUltragoon("please ultragoon this rewrite")).toBe(true);
		expect(containsUltragoon("time to ultragoon")).toBe(true);
	});

	it("matches the lowercase trigger word beside prose punctuation and quotes", () => {
		for (const text of ["do it. ultragoon.", "please ultragoon, then report", 'say "ultragoon" now']) {
			expect(containsUltragoon(text)).toBe(true);
		}
	});

	it("ignores casing, inflections, code symbols, and path-embedded forms", () => {
		expect(containsUltragoon("Ultragoon")).toBe(false);
		expect(containsUltragoon("ULTRAGOON")).toBe(false);
		expect(containsUltragoon("ultragooning the refactor")).toBe(false);
		expect(containsUltragoon("preultragoon checks")).toBe(false);
		expect(containsUltragoon("ultragoon()")).toBe(false);
		expect(containsUltragoon("foo::ultragoon")).toBe(false);
		expect(containsUltragoon("packages/coding-agent/src/modes/ultragoon.ts")).toBe(false);
		expect(containsUltragoon("nothing to see here")).toBe(false);
	});

	it("ignores the keyword inside code spans, fences, and xml sections", () => {
		expect(containsUltragoon("`ultragoon`")).toBe(false);
		expect(containsUltragoon("```\nultragoon\n```")).toBe(false);
		expect(containsUltragoon("<x>ultragoon</x>")).toBe(false);
	});
});

describe("ultragoon keyword highlighting", () => {
	it("decorates the keyword in bold with zero-width escapes, preserving visible text", () => {
		const input = "please ultragoon this";
		const decorated = highlightUltragoon(input);
		expect(decorated).not.toBe(input);
		// Bold-on / bold-off frame the painted keyword so the glow reads brighter
		// than the other keywords without changing the visible width.
		expect(decorated).toContain("\x1b[1m");
		expect(decorated).toContain("\x1b[22m");
		expect(Bun.stripANSI(decorated)).toBe(input);
	});

	it("leaves text without the standalone keyword untouched", () => {
		expect(highlightUltragoon("ultragooning builds")).toBe("ultragooning builds");
		expect(highlightUltragoon("Ultragoon this")).toBe("Ultragoon this");
		const filePath = "packages/coding-agent/src/modes/ultragoon.ts";
		expect(highlightUltragoon(filePath)).toBe(filePath);
	});

	it("sweeps twice per host shimmer cycle", () => {
		const text = "go ultragoon now";
		// phaseScale 2: half a host cycle is a full gradient revolution, so the
		// painted bytes repeat at 0.5 but differ at a quarter cycle.
		expect(highlightUltragoon(text, undefined, 0.5)).toBe(highlightUltragoon(text, undefined, 0));
		expect(highlightUltragoon(text, undefined, 0.25)).not.toBe(highlightUltragoon(text, undefined, 0));
	});
});

describe("renderUltragoonNotice", () => {
	it("routes research through scout subagents only when scout is available", () => {
		const withScout = renderUltragoonNotice({ tools: ["ask", "task"], scoutAvailable: true });
		const withoutScout = renderUltragoonNotice({ tools: ["ask", "task"], scoutAvailable: false });
		expect(withScout).toContain("`scout` subagents");
		expect(withoutScout).not.toContain("`scout`");
		expect(withoutScout).toContain("read-only `task` subagents");
	});

	it("falls back to self-directed exploration and stated defaults without task or ask", () => {
		const notice = renderUltragoonNotice({ tools: ["read", "grep"], scoutAvailable: true });
		expect(notice).toContain("`glob`/`grep`/`read`");
		expect(notice).toContain("No `ask` tool");
		expect(notice).not.toContain("subagents");
	});

	it("keeps the todo-backed acceptance criteria only when todo is active", () => {
		expect(renderUltragoonNotice({ tools: ["ask", "todo"], scoutAvailable: true })).toContain("`todo` phases");
		expect(renderUltragoonNotice({ tools: ["ask"], scoutAvailable: true })).not.toContain("`todo`");
	});
});
