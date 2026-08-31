import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Agent } from "@chudware/agent-core";
import type { AssistantMessage, Model, Usage } from "@chudware/ai";
import { applyOpenRouterReportedCost } from "@chudware/ai/providers/openai-shared";
import { buildModel } from "@chudware/catalog/build";
import { calculateCost, calculateUsageTotalTokens, hasKnownModelPricing } from "@chudware/catalog/models";
import { ModelRegistry } from "@chudware/coding-agent/config/model-registry";
import { Settings } from "@chudware/coding-agent/config/settings";
import { getTemplate } from "@chudware/coding-agent/export/html";
import { calculateCacheMetrics } from "@chudware/coding-agent/modes/components/status-line/cache-metrics";
import { AgentSession } from "@chudware/coding-agent/session/agent-session";
import { AuthStorage } from "@chudware/coding-agent/session/auth-storage";
import { SessionManager } from "@chudware/coding-agent/session/session-manager";

interface ExportStats {
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

function model(id: string, pricingKnown = true): Model {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: pricingKnown
			? { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.25 }
			: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		pricingKnown,
		contextWindow: 128_000,
		maxTokens: 8_000,
	});
}

function usage(): Usage {
	return {
		input: 1_000,
		output: 200,
		cacheRead: 3_000,
		cacheWrite: 400,
		totalTokens: 99_999,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(activeModel: Model, turnUsage: Usage, timestamp = 1): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: activeModel.api,
		provider: activeModel.provider,
		model: activeModel.id,
		usage: turnUsage,
		stopReason: "stop",
		timestamp,
	};
}

function exportStats(entries: unknown[]): ExportStats {
	const source = getTemplate().match(/function usageTokenComponents\(usage\) \{[\s\S]*?\n {6}const globalStats/)?.[0];
	if (!source) throw new Error("HTML export usage summary functions were not found");
	const functionSource = source.slice(0, source.lastIndexOf("\n      const globalStats"));
	const computeStats = Function(`"use strict"; ${functionSource}; return computeStats;`)() as (
		values: unknown[],
	) => ExportStats;
	return computeStats(entries);
}

describe("cost accounting basis consistency", () => {
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	afterAll(() => {
		authStorage.close();
	});

	it("keeps cache-read/write token and dollar components aligned across turn, session, export, and status summaries", () => {
		const activeModel = model("priced");
		const turnUsage = usage();
		turnUsage.orchestration = { input: 50, output: 25, cacheRead: 75 };
		calculateCost(activeModel, turnUsage);
		const message = assistant(activeModel, turnUsage);
		const agent = new Agent({
			initialState: { model: activeModel, systemPrompt: ["Test"], tools: [], messages: [message] },
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});

		const expectedTokens = { input: 1_050, output: 225, cacheRead: 3_075, cacheWrite: 400 };
		const expectedCost = { input: 0.00105, output: 0.00045, cacheRead: 0.0015375, cacheWrite: 0.0005 };
		expect(calculateUsageTotalTokens(turnUsage)).toBe(4_750);
		expect(turnUsage.totalTokens).toBe(4_750);
		expect(turnUsage.cost).toMatchObject(expectedCost);
		expect(turnUsage.cost.total).toBeCloseTo(0.0035375, 12);

		const sessionStats = session.getSessionStats();
		expect(sessionStats.tokens).toEqual({ ...expectedTokens, reasoning: 0, total: 4_750 });
		expect(sessionStats.cost).toBeCloseTo(0.0035375, 12);

		const exported = exportStats([{ type: "message", message }]);
		expect(exported.tokens).toEqual(expectedTokens);
		expect(exported.cost).toEqual(expectedCost);

		const status = calculateCacheMetrics([message], () => activeModel);
		expect({
			input: status.input,
			output: status.output,
			cacheRead: status.cacheRead,
			cacheWrite: status.cacheWrite,
		}).toEqual(expectedTokens);
		expect(status.pricedSpend).toBeCloseTo(0.0035375, 12);
		expect(status.pricedModels).toBe(1);
		expect(status.totalModels).toBe(1);
	});

	it("reports mixed priced-model coverage instead of treating zero-filled unknown pricing as free", () => {
		const priced = model("priced");
		const unknown = model("unknown", false);
		const pricedUsage = usage();
		const unknownUsage = usage();
		calculateCost(priced, pricedUsage);
		calculateCost(unknown, unknownUsage);

		expect(hasKnownModelPricing(priced)).toBe(true);
		expect(hasKnownModelPricing(unknown)).toBe(false);
		const metrics = calculateCacheMetrics(
			[assistant(priced, pricedUsage, 1), assistant(unknown, unknownUsage, 2)],
			(_provider, id) => (id === priced.id ? priced : unknown),
		);
		expect(metrics.pricedModels).toBe(1);
		expect(metrics.totalModels).toBe(2);
		expect(metrics.pricedSpend).toBeCloseTo(pricedUsage.cost.total, 12);
		expect(metrics.savings).toBeUndefined();
	});

	it("reconciles an authoritative provider total once and preserves every component basis without a rate card", () => {
		const unknown = model("reported", false);
		const turnUsage = usage();
		calculateCost(unknown, turnUsage);
		expect(turnUsage.cost.total).toBe(0);

		applyOpenRouterReportedCost(unknown, turnUsage, { cost: 4.6 });
		expect(turnUsage.cost.total).toBeCloseTo(
			turnUsage.cost.input + turnUsage.cost.output + turnUsage.cost.cacheRead + turnUsage.cost.cacheWrite,
			12,
		);
		expect(turnUsage.cost.input).toBeCloseTo(1, 12);
		expect(turnUsage.cost.output).toBeCloseTo(0.2, 12);
		expect(turnUsage.cost.cacheRead).toBeCloseTo(3, 12);
		expect(turnUsage.cost.cacheWrite).toBeCloseTo(0.4, 12);
		expect(turnUsage.cost.total).toBeCloseTo(4.6, 12);
		const reportedMetrics = calculateCacheMetrics([assistant(unknown, turnUsage)], () => unknown);
		expect(reportedMetrics.pricedSpend).toBeCloseTo(4.6, 12);
		expect(reportedMetrics.pricedModels).toBe(0);
		expect(reportedMetrics.totalModels).toBe(1);
		expect(reportedMetrics.savings).toBeUndefined();
		const reconciled = { ...turnUsage.cost };
		applyOpenRouterReportedCost(unknown, turnUsage, { cost: 4.6 });
		expect(turnUsage.cost).toEqual(reconciled);
	});
});
