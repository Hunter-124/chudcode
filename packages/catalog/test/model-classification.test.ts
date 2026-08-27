import { describe, expect, it } from "bun:test";
import { Effort } from "../src/effort";
import { isModelOlderThanMonths, normalizeModelReleaseDate } from "../src/model-recency";
import { getCursorModelIdThinking } from "../src/model-thinking";
import { getBundledModel, getBundledModels } from "../src/models";
import RAW_MODELS from "../src/models.json" with { type: "json" };
import { type ModelsDevProviderDescriptor, mapModelsDevToModels } from "../src/provider-models/openai-compat";

const TEST_MODELS_DEV_DESCRIPTORS = [
	{
		modelsDevKey: "test",
		providerId: "test-provider",
		api: "openai-completions",
		baseUrl: "https://example.test/v1",
	},
] as const satisfies readonly ModelsDevProviderDescriptor[];

describe("Cursor fixed-effort model ids", () => {
	it("exposes baked effort suffixes through canonical thinking metadata", () => {
		const cases = [
			["gpt-5.2-codex-low", Effort.Low],
			["gpt-5.3-codex-xhigh-fast", Effort.XHigh],
			["gpt-5.4-medium", Effort.Medium],
			["gpt-5.4-high-fast", Effort.High],
		] as const;

		for (const [id, effort] of cases) {
			const model = getBundledModel("cursor", id);
			expect(model.id).toBe(id);
			expect(model.provider).toBe("cursor");
			expect(model.reasoning).toBeTrue();
			expect(model.thinking).toEqual({
				mode: "effort",
				efforts: [effort],
				defaultLevel: effort,
				requiresEffort: true,
			});
		}
	});

	it("does not confuse model and service-tier names with fixed effort", () => {
		expect(getCursorModelIdThinking("gpt-5.1-codex-max")).toBeUndefined();
		expect(getCursorModelIdThinking("gpt-5.3-codex-fast")).toBeUndefined();
		expect(getBundledModel("cursor", "gpt-5.1-codex-max").thinking?.efforts).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.Medium,
			Effort.High,
		]);
	});

	it("preserves every bundled Cursor id and entry", () => {
		expect(getBundledModels("cursor").map(model => model.id)).toEqual(Object.keys(RAW_MODELS.cursor));
	});
});

describe("model release dates", () => {
	it("maps only normalized YYYY-MM or YYYY-MM-DD values from models.dev", () => {
		const models = mapModelsDevToModels(
			{
				test: {
					models: {
						month: { tool_call: true, release_date: " 2025-02 " },
						day: { tool_call: true, release_date: "2024-02-29" },
						invalidDay: { tool_call: true, release_date: "2025-02-29" },
						invalidShape: { tool_call: true, release_date: "2025-2-01" },
						missing: { tool_call: true },
					},
				},
			},
			TEST_MODELS_DEV_DESCRIPTORS,
		);
		const byId = new Map(models.map(model => [model.id, model]));

		expect(byId.get("month")?.releaseDate).toBe("2025-02");
		expect(byId.get("day")?.releaseDate).toBe("2024-02-29");
		expect(byId.get("invalidDay")?.releaseDate).toBeUndefined();
		expect(byId.get("invalidShape")?.releaseDate).toBeUndefined();
		expect(byId.get("missing")?.releaseDate).toBeUndefined();
		expect(normalizeModelReleaseDate(202502)).toBeUndefined();
	});

	it("classifies age conservatively at calendar-month boundaries", () => {
		const asOf = new Date("2026-08-27T23:59:59Z");
		expect(isModelOlderThanMonths({ releaseDate: "2025-08-26" }, 12, asOf)).toBeTrue();
		expect(isModelOlderThanMonths({ releaseDate: "2025-08-27" }, 12, asOf)).toBeFalse();
		expect(isModelOlderThanMonths({ releaseDate: "2025-08" }, 12, asOf)).toBeFalse();
		expect(isModelOlderThanMonths({}, 12, asOf)).toBeFalse();
		expect(isModelOlderThanMonths({ releaseDate: "not-a-date" }, 12, asOf)).toBeFalse();
	});

	it("clamps end-of-month cutoffs without overflowing into the next month", () => {
		const asOf = new Date("2024-03-31T00:00:00Z");
		expect(isModelOlderThanMonths({ releaseDate: "2024-02-28" }, 1, asOf)).toBeTrue();
		expect(isModelOlderThanMonths({ releaseDate: "2024-02-29" }, 1, asOf)).toBeFalse();
		expect(() => isModelOlderThanMonths({}, -1, asOf)).toThrow(RangeError);
		expect(() => isModelOlderThanMonths({}, 1, new Date(Number.NaN))).toThrow(RangeError);
	});
});
