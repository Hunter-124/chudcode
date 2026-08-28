import { describe, expect, test } from "bun:test";
import { encodeModelCatalog } from "../scripts/model-binary";
import { getBundledModel, getBundledModels, getBundledProviders } from "../src/models";
import type { GeneratedProvider } from "../src/models-bin-meta";
import models from "../src/models.json" with { type: "json" };

describe("bundled binary model catalog", () => {
	test("encodes the same in-memory catalog to identical bytes", () => {
		const first = encodeModelCatalog(models);
		const second = encodeModelCatalog(models);
		expect(second).toEqual(first);
	});

	test("preserves generated provider and model insertion order", () => {
		const providers = getBundledProviders();
		expect(providers).toEqual(Object.keys(models));
		expect(providers).toContain("minimax-cn");
		expect(getBundledModels("devin")).toEqual(Object.values(models.devin));
		expect(getBundledModels("nanogpt")).toEqual(Object.values(models.nanogpt));
	});

	test("caches model identity and keeps unknown lookups empty", () => {
		const devinModelId = Object.keys(models.devin)[0];
		if (devinModelId === undefined) throw new Error("Generated devin provider is empty");
		const first = getBundledModel("devin", devinModelId);
		expect(getBundledModel("devin", devinModelId)).toBe(first);

		const unknownProvider = "missing-provider" as GeneratedProvider;
		expect(getBundledModels(unknownProvider)).toEqual([]);
		expect(getBundledModel(unknownProvider, "missing-model")).toBeUndefined();
	});
});
