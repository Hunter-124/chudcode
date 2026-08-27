import { describe, expect, it } from "bun:test";
import { isModelOlderThanMonths, normalizeModelReleaseDate } from "../src/model-recency";
import { type ModelsDevProviderDescriptor, mapModelsDevToModels } from "../src/provider-models/openai-compat";

const TEST_MODELS_DEV_DESCRIPTORS = [
	{
		modelsDevKey: "test",
		providerId: "test-provider",
		api: "openai-completions",
		baseUrl: "https://example.test/v1",
	},
] as const satisfies readonly ModelsDevProviderDescriptor[];

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
