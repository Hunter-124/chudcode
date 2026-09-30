import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, Usage } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { buildCacheReportText } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/cache-report";
import { calculateCacheMetrics } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/cache-metrics";

function model(id: string, inputRate = 10): Model {
	return buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: inputRate, output: 20, cacheRead: 1, cacheWrite: 12.5 },
		promptCache: { short: 300, long: 3_600 },
		contextWindow: 200_000,
		maxTokens: 8_000,
	});
}

function usage(input: number, cacheRead: number, cacheWrite: number, cttl?: Usage["cttl"]): Usage {
	return {
		input,
		output: 100,
		cacheRead,
		cacheWrite,
		cttl,
		totalTokens: input + cacheRead + cacheWrite + 100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(id: string, tokens: Usage, timestamp = 1_000): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: id,
		usage: tokens,
		stopReason: "stop",
		timestamp,
	};
}

function report(
	messages: readonly AgentMessage[],
	models: Record<string, Model>,
	retention: "short" | "long" = "short",
) {
	return buildCacheReportText({
		messages,
		findModel: (_provider, id) => models[id],
		activeModel: models.priced,
		retention,
		warming: "idle",
		cacheMissMarker: true,
		now: 61_000,
	});
}

describe("cache report", () => {
	it("reports net savings and hit rate from observed prompt buckets", () => {
		const priced = model("priced");
		const tokens = usage(1_000, 9_000, 0);
		const text = report([assistant("priced", tokens)], { priced });
		expect(text).toContain("Hit rate: 90.0% (9K of 10K prompt tokens)");
		expect(text).toContain("Estimated cache savings: $0.0810 net of cache-write premiums");
		expect(text).toContain("1 of 1 model priced");
		expect(text).toContain("Idle: 1m since the last recorded response");
		expect(text).toContain("Retention: short · TTL depends on model (Anthropic: 5m)");
		expect(text).toContain("Active model cache TTL: short 5m · long 1h");
		expect(tokens.cost.total).toBe(0);
	});

	it("reports negative net savings when cache-write premiums outweigh reuse", () => {
		const priced = model("priced");
		const text = report([assistant("priced", usage(0, 0, 1_000, { ephemeral1h: 1_000 }))], { priced }, "long");
		expect(text).toContain("Estimated cache savings: -$0.0100 net of cache-write premiums");
		expect(text).toContain("Retention: long · TTL depends on model");
	});

	it("does not claim dollar savings when any model lacks reliable input pricing", () => {
		const priced = model("priced");
		const unpriced = model("unpriced", 0);
		const messages = [assistant("priced", usage(100, 900, 0)), assistant("unpriced", usage(0, 1_000, 0), 2_000)];
		const text = report(messages, { priced, unpriced });
		expect(text).toContain("Estimated cache savings: unknown — 1 of 2 models priced");
		expect(text).toContain("Hit rate: 95.0% (1.9K of 2K prompt tokens)");
		expect(calculateCacheMetrics([], () => undefined).hitRate).toBeUndefined();
	});
});
