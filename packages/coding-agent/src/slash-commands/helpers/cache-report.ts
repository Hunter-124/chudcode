import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils/format";
import { type CacheRetentionMode, calculateCacheMetrics, describeCacheRetention } from "./cache-metrics";

export interface CacheReportInput {
	messages: readonly AgentMessage[];
	findModel: (provider: string, modelId: string) => Model<Api> | undefined;
	activeModel?: Model<Api>;
	retention: CacheRetentionMode;
	warming: "off" | "streaming" | "idle";
	cacheMissMarker: boolean;
	now?: number;
}

function formatDollars(amount: number): string {
	return `${amount < 0 ? "-" : ""}$${Math.abs(amount).toFixed(4)}`;
}

/** User-facing cache economics from recorded session usage, not a provider cache-state probe. */
export function buildCacheReportText(input: CacheReportInput): string {
	const metrics = calculateCacheMetrics(input.messages, input.findModel);
	const coverage = `${metrics.pricedModels} of ${metrics.totalModels} model${metrics.totalModels === 1 ? "" : "s"} priced`;
	const hitRate = metrics.hitRate === undefined ? "—" : `${(metrics.hitRate * 100).toFixed(1)}%`;
	const hitDetail =
		metrics.promptTokens > 0
			? ` (${formatNumber(metrics.cacheRead)} of ${formatNumber(metrics.promptTokens)} prompt tokens)`
			: "";
	const savings =
		metrics.savings === undefined
			? `unknown — ${coverage}`
			: `${formatDollars(metrics.savings)} net of cache-write premiums`;
	const idle =
		metrics.lastResponseAt === undefined
			? "no recorded response"
			: `${formatDuration(Math.max(0, (input.now ?? Date.now()) - metrics.lastResponseAt))} since the last recorded response`;
	const declaredTtl = input.activeModel?.promptCache;
	const tiers = [
		declaredTtl?.short && `short ${formatDuration(declaredTtl.short * 1_000)}`,
		declaredTtl?.long && `long ${formatDuration(declaredTtl.long * 1_000)}`,
	].filter(Boolean);
	const ttl = tiers.length > 0 ? tiers.join(" · ") : "not declared by catalog";

	return [
		"Prompt cache",
		`Tokens: input ${formatNumber(metrics.input)} · output ${formatNumber(metrics.output)} · cache read ${formatNumber(metrics.cacheRead)} · cache write ${formatNumber(metrics.cacheWrite)}`,
		`Hit rate: ${hitRate}${hitDetail}`,
		`Spend (reported or catalog-estimated): ${formatDollars(metrics.pricedSpend)} · ${coverage} (may include provider-reported charges on unpriced models)`,
		`Estimated cache savings: ${savings}`,
		`Retention: ${describeCacheRetention(input.retention)}`,
		`Active model cache TTL: ${ttl} (configured retention and provider credential select the tier)`,
		`Warming: ${input.warming} · refreshes are conditional on model TTL and expected benefit`,
		`Idle: ${idle}`,
		"Warmth: providers do not expose authoritative cache state here; idle time and configured retention do not prove a cache is warm or expired.",
		`Cache-miss marker: ${input.cacheMissMarker ? "on" : "off"} · identifies observed reprocessing, not provider cache state.`,
	].join("\n");
}
