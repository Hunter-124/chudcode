import type { AgentMessage } from "@chudware/agent-core";
import { calculatePromptCacheSavings } from "@chudware/catalog/models";
import type { Api, Model, Usage } from "@chudware/ai";

export type CacheRetentionMode = "auto" | "short" | "long" | "none";

export interface CacheMetrics {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	promptTokens: number;
	hitRate: number | undefined;
	pricedSpend: number;
	savings: number | undefined;
	pricedModels: number;
	totalModels: number;
	lastResponseAt: number | undefined;
}

export interface CacheRetentionSummary {
	mode: CacheRetentionMode;
	ttlLabel: string;
	refreshLabel: string;
}

interface ModelPricingState {
	model: Model<Api> | undefined;
	priced: boolean;
}

function isUsablePrice(value: number): boolean {
	return Number.isFinite(value) && value >= 0;
}

function resolvePricing(model: Model<Api> | undefined): ModelPricingState {
	if (!model || model.pricingKnown === false) return { model, priced: false };
	const cost = model.cost;
	const ratesAreUsable =
		isUsablePrice(cost.input) &&
		isUsablePrice(cost.output) &&
		isUsablePrice(cost.cacheRead) &&
		isUsablePrice(cost.cacheWrite);
	// Legacy discovery paths encoded absent prices as an all-zero card. Unless
	// the source explicitly vouched for that card, zero is unknown—not free.
	const hasExplicitOrNonzeroPricing =
		model.pricingKnown === true || cost.input > 0 || cost.output > 0 || cost.cacheRead > 0 || cost.cacheWrite > 0;
	return { model, priced: ratesAreUsable && hasExplicitOrNonzeroPricing };
}

/** Aggregate cache economics from persisted assistant turns. */
export function calculateCacheMetrics(
	messages: readonly AgentMessage[],
	findModel: (provider: string, modelId: string) => Model<Api> | undefined,
): CacheMetrics {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let pricedSpend = 0;
	let measuredSavings = 0;
	let lastResponseAt: number | undefined;
	const models: Record<string, ModelPricingState> = {};

	for (const message of messages) {
		if (message.role !== "assistant" || !message.usage) continue;
		const usage: Usage = message.usage;
		input += usage.input;
		output += usage.output;
		cacheRead += usage.cacheRead;
		cacheWrite += usage.cacheWrite;
		if (Number.isFinite(message.timestamp)) {
			lastResponseAt = Math.max(lastResponseAt ?? 0, message.timestamp);
		}

		const key = `${message.provider}\u0000${message.model}`;
		const pricing = models[key] ?? resolvePricing(findModel(message.provider, message.model));
		models[key] = pricing;
		if (!pricing.priced || !pricing.model) continue;
		pricedSpend += usage.cost.total;
		measuredSavings += calculatePromptCacheSavings(pricing.model.cost, usage);
	}

	const modelStates = Object.values(models);
	const pricedModels = modelStates.filter(state => state.priced).length;
	const totalModels = modelStates.length;
	const promptTokens = input + cacheRead + cacheWrite;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		promptTokens,
		hitRate: promptTokens > 0 ? cacheRead / promptTokens : undefined,
		pricedSpend,
		savings: pricedModels === totalModels ? measuredSavings : undefined,
		pricedModels,
		totalModels,
		lastResponseAt,
	};
}

export function describeCacheRetention(mode: CacheRetentionMode): CacheRetentionSummary {
	switch (mode) {
		case "none":
			return { mode, ttlLabel: "disabled", refreshLabel: "no keep-alive refreshes" };
		case "long":
			return { mode, ttlLabel: "1h where supported", refreshLabel: "no keep-alive refreshes" };
		case "short":
			return {
				mode,
				ttlLabel: "5m",
				refreshLabel: "Anthropic may attempt up to 3 idle keep-alive refreshes",
			};
		case "auto":
			return {
				mode,
				ttlLabel: "provider default (Anthropic: 5m)",
				refreshLabel: "Anthropic may attempt up to 3 idle keep-alive refreshes",
			};
	}
}
