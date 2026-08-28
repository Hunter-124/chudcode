import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, Usage } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { mapModelsDevToModels } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import { lookupBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { buildCacheReportText } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/cache-report";

function pricedModel(id: string): Model {
	return buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 10, output: 20, cacheRead: 1, cacheWrite: 12.5 },
		pricingKnown: true,
		contextWindow: 200_000,
		maxTokens: 8_000,
	});
}

function assistant(model: string, usage: Usage, timestamp = 1_000): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model,
		usage,
		stopReason: "stop",
		timestamp,
	};
}

function usage(parts: { input: number; output: number; cacheRead: number; cacheWrite: number }): Usage {
	const inputCost = (parts.input * 10) / 1_000_000;
	const outputCost = (parts.output * 20) / 1_000_000;
	const cacheReadCost = (parts.cacheRead * 1) / 1_000_000;
	const cacheWriteCost = (parts.cacheWrite * 12.5) / 1_000_000;
	return {
		...parts,
		totalTokens: parts.input + parts.output + parts.cacheRead + parts.cacheWrite,
		cost: {
			input: inputCost,
			output: outputCost,
			cacheRead: cacheReadCost,
			cacheWrite: cacheWriteCost,
			total: inputCost + outputCost + cacheReadCost + cacheWriteCost,
		},
	};
}

function render(messages: readonly AgentMessage[], models: Record<string, Model>, retention: "short" | "long") {
	return buildCacheReportText({
		messages,
		findModel: (_provider, modelId) => models[modelId],
		retention,
		cacheMissMarker: true,
		now: 61_000,
	});
}

describe("cache report", () => {
	it("registers /cache as a built-in report command", () => {
		const command = lookupBuiltinSlashCommand("cache");
		expect(command?.description).toContain("savings");
		expect(command?.handle).toBeFunction();
	});

	it("renders plausible net savings and the correct hit rate for cached prompt tokens", () => {
		const output = render(
			[assistant("priced", usage({ input: 1_000, output: 100, cacheRead: 9_000, cacheWrite: 0 }))],
			{ priced: pricedModel("priced") },
			"short",
		);

		expect(output).toContain("Hit rate: 90.0% (9K of 10K prompt tokens)");
		expect(output).toContain("Estimated cache savings: $0.081 net of cache-write premiums");
		expect(output).toContain("1 of 1 model priced");
	});

	it("renders savings as explicitly unknown when any used model lacks pricing", () => {
		const unpricedSpec = mapModelsDevToModels({ fixture: { models: { unpriced: { tool_call: true } } } }, [
			{
				modelsDevKey: "fixture",
				providerId: "anthropic",
				api: "anthropic-messages",
				baseUrl: "https://api.anthropic.com",
			},
		])[0]!;
		expect(unpricedSpec.pricingKnown).toBe(false);
		const output = render(
			[
				assistant("priced", usage({ input: 1_000, output: 100, cacheRead: 9_000, cacheWrite: 0 })),
				assistant("unpriced", usage({ input: 0, output: 50, cacheRead: 10_000, cacheWrite: 0 }), 2_000),
			],
			{ priced: pricedModel("priced"), unpriced: buildModel(unpricedSpec) },
			"short",
		);
		expect(output).toContain("Estimated cache savings: unknown — 1 of 2 models priced");
		expect(output).not.toContain("Estimated cache savings: $0.0000");
	});

	it("reports configured retention TTL and bounded refresh behavior", () => {
		const messages = [assistant("priced", usage({ input: 100, output: 10, cacheRead: 900, cacheWrite: 0 }))];
		const models = { priced: pricedModel("priced") };

		expect(render(messages, models, "short")).toContain(
			"Retention: short · TTL 5m · Anthropic may attempt up to 3 idle keep-alive refreshes",
		);
		expect(render(messages, models, "long")).toContain(
			"Retention: long · TTL 1h where supported · no keep-alive refreshes",
		);
	});
});
