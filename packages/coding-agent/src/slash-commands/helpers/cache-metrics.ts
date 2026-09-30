import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Api, Model, Usage } from "@oh-my-pi/pi-ai";
import { calculateUncachedInputCost, calculateUsageCost } from "@oh-my-pi/pi-catalog/models";

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

/** Model catalog entries with zero input rates do not establish a dollar price for prompt reuse. */
function hasInputPrice(model: Model<Api> | undefined): model is Model<Api> {
	return (
		!!model &&
		Number.isFinite(model.cost.input) &&
		model.cost.input > 0 &&
		Number.isFinite(model.cost.cacheRead) &&
		Number.isFinite(model.cost.cacheWrite) &&
		model.cost.cacheRead >= 0 &&
		model.cost.cacheWrite >= 0
	);
}

/** Aggregate only actual assistant usage; never count persisted user/tool messages as billable turns. */
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
	const models = new Map<string, Model<Api> | undefined>();
	let unpriced = 0;

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
		let model: Model<Api> | undefined;
		if (models.has(key)) {
			model = models.get(key);
		} else {
			model = findModel(message.provider, message.model);
			models.set(key, model);
			if (!hasInputPrice(model)) unpriced++;
		}
		if (Number.isFinite(usage.cost.total) && usage.cost.total > 0) pricedSpend += usage.cost.total;
		if (!hasInputPrice(model)) continue;

		// Catalog pricing handles historical tariffs, long-context rates and Anthropic's
		// per-TTL cache-write premium. Price a copy: session usage must remain immutable.
		const actual = calculateUsageCost(model.cost, { ...usage, cost: { ...usage.cost } }, message.timestamp);
		const promptTokens =
			usage.input +
			usage.cacheRead +
			usage.cacheWrite +
			(usage.orchestration?.input ?? 0) +
			(usage.orchestration?.cacheRead ?? 0);
		const uncached = calculateUncachedInputCost(model.cost, promptTokens, message.timestamp);
		measuredSavings += uncached - actual.input - actual.cacheRead - actual.cacheWrite;
		if (usage.cost.total === 0) pricedSpend += actual.total;
	}

	const promptTokens = input + cacheRead + cacheWrite;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		promptTokens,
		hitRate: promptTokens > 0 ? cacheRead / promptTokens : undefined,
		pricedSpend,
		savings: unpriced === 0 ? measuredSavings : undefined,
		pricedModels: models.size - unpriced,
		totalModels: models.size,
		lastResponseAt,
	};
}

export function describeCacheRetention(mode: CacheRetentionMode): string {
	switch (mode) {
		case "none":
			return "disabled";
		case "short":
			return "short · TTL depends on model (Anthropic: 5m)";
		case "long":
			return "long · TTL depends on model (Anthropic: up to 1h where supported)";
		case "auto":
			return "auto · provider default (Anthropic: 5m or 1h for supported OAuth models)";
	}
}
