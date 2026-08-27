import { describe, expect, it } from "bun:test";
import { applyGeneratedModelPolicies } from "../scripts/generated-policies";
import { buildModel } from "../src/build";
import { Effort } from "../src/effort";
import { getCursorModelIdThinking } from "../src/model-thinking";
import type { ModelSpec } from "../src/types";

function cursorSpec(overrides: Partial<ModelSpec<"cursor-agent">> & { id: string }): ModelSpec<"cursor-agent"> {
	return {
		name: overrides.id,
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "https://api2.cursor.sh",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
		...overrides,
	};
}

describe("Cursor fixed-effort model ids", () => {
	it("classifies baked effort suffixes into canonical thinking metadata", () => {
		const cases = [
			["gpt-5.2-codex-low", Effort.Low],
			["gpt-5.3-codex-xhigh-fast", Effort.XHigh],
			["gpt-5.4-medium", Effort.Medium],
			["gpt-5.4-high-fast", Effort.High],
			["gpt-5.4-minimal", Effort.Minimal],
		] as const;

		for (const [id, effort] of cases) {
			expect(getCursorModelIdThinking(id)).toEqual({
				mode: "effort",
				efforts: [effort],
				defaultLevel: effort,
				requiresEffort: true,
			});
		}
	});

	it("does not confuse model and service-tier names with fixed effort", () => {
		// '-max' also names a family (gpt-5.1-codex-max), and a bare '-fast' is a
		// service tier, not an effort.
		expect(getCursorModelIdThinking("gpt-5.1-codex-max")).toBeUndefined();
		expect(getCursorModelIdThinking("gpt-5.3-codex-fast")).toBeUndefined();
		expect(getCursorModelIdThinking("gpt-5.3-codex")).toBeUndefined();
	});

	it("buildModel corrects reasoning and bakes fixed thinking for a discovered Cursor spec", () => {
		const model = buildModel(cursorSpec({ id: "gpt-5.4-medium", reasoning: false }));
		expect(model.reasoning).toBe(true);
		expect(model.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Medium],
			defaultLevel: Effort.Medium,
			requiresEffort: true,
		});
	});

	it("buildModel leaves a collapsed variant's effortRouting ladder alone", () => {
		// A sibling-routed collapsed row already encodes wire semantics through
		// effortRouting; normalizing it to a single fixed effort would break it.
		const routedThinking = {
			mode: "effort" as const,
			efforts: [Effort.Low, Effort.Medium, Effort.High],
			requiresEffort: true,
			effortRouting: {
				[Effort.Low]: "gpt-5.4-low",
				[Effort.Medium]: "gpt-5.4-medium",
				[Effort.High]: "gpt-5.4-high",
			},
		};
		const model = buildModel(
			cursorSpec({ id: "gpt-5.4-medium", reasoning: true, thinking: routedThinking, requestModelId: "gpt-5.4" }),
		);
		expect(model.thinking).toEqual(routedThinking);
	});

	it("rebakeModelThinking (generator policy) applies the same fixed-effort correction", () => {
		const specs: ModelSpec<"cursor-agent">[] = [
			cursorSpec({ id: "gpt-5.3-codex-xhigh-fast", reasoning: false }),
			cursorSpec({ id: "gpt-5.1-codex-max", reasoning: false }),
		];
		applyGeneratedModelPolicies(specs);
		expect(specs[0]?.reasoning).toBe(true);
		expect(specs[0]?.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.XHigh],
			defaultLevel: Effort.XHigh,
			requiresEffort: true,
		});
		// Not a fixed-effort id: falls through to generic derivation instead of
		// being force-corrected to reasoning: true.
		expect(specs[1]?.reasoning).toBe(false);
	});
});
