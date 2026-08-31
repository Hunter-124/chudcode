import { describe, expect, it } from "bun:test";
import { buildModel } from "@chudware/catalog/build";
import { Effort } from "@chudware/catalog/effort";
import type { ModelSpec } from "@chudware/catalog/types";
import { collapseEffortVariantsAcrossProviders } from "@chudware/catalog/variant-collapse";
import { cursorVariantLaneId, parseCursorModelVariant } from "@chudware/catalog/wire/cursor";

function cursorSpec(id: string): ModelSpec<"cursor-agent"> {
	return {
		id,
		name: id,
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "https://api2.cursor.sh",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	};
}

describe("Cursor model variants", () => {
	it("parses effort and fast metadata while retaining the exact wire id", () => {
		const standard = parseCursorModelVariant("claude-opus-5-medium");
		expect(standard).toEqual({
			baseId: "claude-opus-5",
			effort: Effort.Medium,
			fast: false,
			thinking: false,
			token: "medium",
			wireModelId: "claude-opus-5-medium",
		});
		expect(standard && cursorVariantLaneId(standard)).toBe("claude-opus-5");

		const fast = parseCursorModelVariant("claude-opus-5-xhigh-fast");
		expect(fast).toEqual({
			baseId: "claude-opus-5",
			effort: Effort.XHigh,
			fast: true,
			token: "xhigh",
			thinking: false,
			wireModelId: "claude-opus-5-xhigh-fast",
		});
		expect(fast && cursorVariantLaneId(fast)).toBe("claude-opus-5-fast");

		const explicitThinking = parseCursorModelVariant("claude-opus-5-thinking-high-fast");
		expect(explicitThinking).toEqual({
			baseId: "claude-opus-5",
			effort: Effort.High,
			fast: true,
			thinking: true,
			token: "high",
			wireModelId: "claude-opus-5-thinking-high-fast",
		});
	});

	it("does not reinterpret non-variant or release-dated model ids", () => {
		expect(parseCursorModelVariant("composer-2.5")).toBeUndefined();
		expect(parseCursorModelVariant("grok-code-fast-1")).toBeUndefined();
		expect(parseCursorModelVariant("claude-3-5-sonnet-20241022")).toBeUndefined();
	});

	it("collapses effort noise into one truthful row per service-tier lane", () => {
		const ids = ["low", "medium", "high", "xhigh"].flatMap(effort => [
			`claude-opus-5-${effort}`,
			`claude-opus-5-${effort}-fast`,
		]);
		const collapsed = collapseEffortVariantsAcrossProviders(ids.map(cursorSpec));
		expect(collapsed.map(model => model.id).sort()).toEqual(["claude-opus-5", "claude-opus-5-fast"]);

		const standard = collapsed.find(model => model.id === "claude-opus-5");
		const fast = collapsed.find(model => model.id === "claude-opus-5-fast");
		if (!standard || !fast) throw new Error("Cursor service-tier lanes did not collapse");
		for (const row of [standard, fast]) {
			expect(row.reasoning).toBe(true);
			expect(row.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]);
		}

		expect(buildModel(standard).thinking?.effortRouting).toEqual({
			[Effort.Low]: "claude-opus-5-low",
			[Effort.Medium]: "claude-opus-5-medium",
			[Effort.High]: "claude-opus-5-high",
			[Effort.XHigh]: "claude-opus-5-xhigh",
		});
		expect(buildModel(fast).thinking?.effortRouting).toEqual({
			[Effort.Low]: "claude-opus-5-low-fast",
			[Effort.Medium]: "claude-opus-5-medium-fast",
			[Effort.High]: "claude-opus-5-high-fast",
			[Effort.XHigh]: "claude-opus-5-xhigh-fast",
		});
	});
});
