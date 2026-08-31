import type { AgentMessage } from "@chudware/agent-core";
import type { Api, Model, Usage } from "@chudware/ai";
import {
	calculatePromptCacheSavings,
	calculateUsageCostTotal,
	calculateUsageTokenComponents,
	hasKnownModelPricing,
} from "@chudware/catalog/models";

export type CacheRetentionMode = "auto" | "short" | "long" | "none";

export interface CacheMetrics {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	promptTokens: number;
	hitRate: number | undefined;
	/** Spend backed by either a known rate card or an authoritative provider-reported charge. */
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

function resolvePricing(model: Model<Api> | undefined): ModelPricingState {
	return { model, priced: hasKnownModelPricing(model) };
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
		const tokens = calculateUsageTokenComponents(usage);
		input += tokens.input;
		output += tokens.output;
		cacheRead += tokens.cacheRead;
		cacheWrite += tokens.cacheWrite;
		if (Number.isFinite(message.timestamp)) {
			lastResponseAt = Math.max(lastResponseAt ?? 0, message.timestamp);
		}

		const key = `${message.provider}\u0000${message.model}`;
		const pricing = models[key] ?? resolvePricing(findModel(message.provider, message.model));
		models[key] = pricing;
		const turnSpend = calculateUsageCostTotal(usage);
		if (pricing.priced || turnSpend > 0) pricedSpend += turnSpend;
		if (!pricing.priced || !pricing.model) continue;
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
