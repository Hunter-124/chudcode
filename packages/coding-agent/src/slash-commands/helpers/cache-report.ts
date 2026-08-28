import type { AgentMessage } from "@chudware/agent-core";
import type { Api, Model } from "@chudware/ai";
import { formatNumber } from "@chudware/utils";
import { formatCost } from "../../modes/components/agent-hub-renderer";
import {
	calculateCacheMetrics,
	describeCacheRetention,
	type CacheRetentionMode,
} from "../../modes/components/status-line/cache-metrics";
import { formatDuration } from "./format";

export interface CacheReportInput {
	messages: readonly AgentMessage[];
	findModel: (provider: string, modelId: string) => Model<Api> | undefined;
	retention: CacheRetentionMode;
	cacheMissMarker: boolean;
	now?: number;
}

/** Render the user-facing cache economics and retention report. */
export function buildCacheReportText(input: CacheReportInput): string {
	const metrics = calculateCacheMetrics(input.messages, input.findModel);
	const retention = describeCacheRetention(input.retention);
	const coverage = `${metrics.pricedModels} of ${metrics.totalModels} model${metrics.totalModels === 1 ? "" : "s"} priced`;
	const hitRate = metrics.hitRate === undefined ? "—" : `${(metrics.hitRate * 100).toFixed(1)}%`;
	const hitDetail = metrics.promptTokens > 0
		? ` (${formatNumber(metrics.cacheRead)} of ${formatNumber(metrics.promptTokens)} prompt tokens)`
		: "";
	const savings =
		metrics.savings === undefined
			? `unknown — ${coverage}`
			: `${formatCost(metrics.savings)} net of cache-write premiums`;
	const now = input.now ?? Date.now();
	const idle =
		metrics.lastResponseAt === undefined
			? "no recorded response"
			: `${formatDuration(Math.max(0, now - metrics.lastResponseAt))} since the last recorded response`;

	return [
		"Prompt cache",
		`Tokens: input ${formatNumber(metrics.input)} · output ${formatNumber(metrics.output)} · cache read ${formatNumber(metrics.cacheRead)} · cache write ${formatNumber(metrics.cacheWrite)}`,
		`Hit rate: ${hitRate}${hitDetail}`,
		`Measured spend (priced models): ${formatCost(metrics.pricedSpend)} · ${coverage}`,
		`Estimated cache savings: ${savings}`,
		`Retention: ${retention.mode} · TTL ${retention.ttlLabel} · ${retention.refreshLabel}`,
		`Idle: ${idle}`,
		"Warmth: providers do not expose authoritative cache state here; idle time and TTL are shown instead of guessing warm or expired.",
		`Cache-miss attribution: ${input.cacheMissMarker ? "on" : "off"} · a proven miss identifies reprocessed tokens and whether the cache expired or the prompt prefix changed.`,
	].join("\n");
}
