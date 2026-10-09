import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { providerEntry, seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { classifyModel } from "@oh-my-pi/pi-catalog/compat/taxonomy";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import {
	getSupportedEfforts,
	mapEffortToAnthropicAdaptiveEffort,
	requireSupportedEffort,
} from "@oh-my-pi/pi-catalog/model-thinking";
import { calculateUncachedInputCost } from "@oh-my-pi/pi-catalog/models";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

function nativeSpec(): ModelSpec<"anthropic-messages"> {
	const seed = seedModels<"anthropic-messages">("anthropic").find(model => model.id === "claude-haiku-5-5");
	if (!seed) throw new Error("Haiku 5.5 must remain selectable without upstream discovery");
	return seed;
}

type WirePayload = {
	model: string;
	thinking?: {
		type: string;
		display?: string;
		budget_tokens?: number;
		block_binding?: { prefix_mismatch_behavior: string };
	};
	output_config?: { effort?: string };
	temperature?: number;
	top_p?: number;
	top_k?: number;
	tool_choice?: { type: string };
};

describe("Claude Haiku 5.5", () => {
	it("builds a selectable adaptive model from the durable first-party seed without ambiguous budget rules", () => {
		const model = buildModel(nativeSpec());
		expect(providerEntry("anthropic")?.seed?.bundle).toBe("always");
		expect(classifyModel(model.provider, model.id)).toEqual({
			class: "anthropic",
			family: "haiku",
			revision: "5.5.0",
		});
		expect(model).toMatchObject({
			id: "claude-haiku-5-5",
			name: "Claude Haiku 5.5",
			api: "anthropic-messages",
			provider: "anthropic",
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			tokenizer: "claude-v47",
			thinking: { mode: "anthropic-adaptive", supportsDisplay: true, prefixBinding: true },
			compat: {
				supportsSamplingParams: false,
				supportsThinkingBindingControls: true,
				supportsForcedToolChoice: true,
			},
		});
		expect(getSupportedEfforts(model)).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]);
		expect(model.thinking?.defaultLevel).toBe(Effort.Medium);
		expect(mapEffortToAnthropicAdaptiveEffort(model, Effort.XHigh)).toBe("xhigh");
		expect(mapEffortToAnthropicAdaptiveEffort(model, Effort.Max)).toBe("max");
		expect(() => requireSupportedEffort(model, Effort.Minimal)).toThrow(/not supported/);
		// Native model registration resolves rules even when callers supply thinking.
		expect(buildModel({ ...nativeSpec(), thinking: model.thinking }).thinking?.mode).toBe("anthropic-adaptive");
	});

	it("repairs sparse Models API metadata and prices prompts at the documented 100k boundary", () => {
		const model = buildModel({
			...nativeSpec(),
			reasoning: false,
			contextWindow: null,
			maxTokens: null,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		expect(model.reasoning).toBe(true);
		expect(model.thinking?.mode).toBe("anthropic-adaptive");
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxTokens).toBe(128_000);
		expect(calculateUncachedInputCost(model.cost, 100_000)).toBeCloseTo(0.01);
		expect(calculateUncachedInputCost(model.cost, 100_001)).toBeCloseTo(0.0500005);
		expect(model.cost.longContext).toMatchObject({ output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 });
	});

	it("retains budget thinking, legacy tokenization, and sampling for older Haiku", () => {
		const model = buildModel({ ...nativeSpec(), id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" });
		expect(model.thinking?.mode).toBe("budget");
		expect(model.tokenizer).toBe("claude-v3");
		expect(model.compat.supportsSamplingParams).toBe(true);
		expect(model.compat.supportsThinkingBindingControls).toBe(false);
		expect(model.thinking?.prefixBinding).toBeUndefined();
		expect(model.thinking?.supportsDisplay).toBeUndefined();
	});

	it("uses the native Messages policy on Vertex and custom Foundry routes without fabricating host catalog entries", () => {
		const vertex = buildModel({ ...nativeSpec(), provider: "google-vertex" });
		const foundry = buildModel({
			...nativeSpec(),
			provider: "enterprise-foundry",
			baseUrl: "https://resource.services.ai.azure.com/anthropic",
		});
		expect(vertex.thinking?.mode).toBe("anthropic-adaptive");
		expect(vertex.compat.supportsThinkingBindingControls).toBe(true);
		expect(foundry.thinking?.mode).toBe("anthropic-adaptive");
		expect(foundry.compat.signingEndpoint).toBe(true);
		expect(foundry.compat.disableStrictTools).toBe(true);
		expect(foundry.compat.supportsSamplingParams).toBe(false);
		expect(foundry.tokenizer).toBe("claude-v47");
	});

	it("keeps Bedrock Converse on its supported effort vocabulary while removing legacy budget overlap", () => {
		const model = buildModel({
			...nativeSpec(),
			id: "anthropic.claude-haiku-5-5",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		});
		expect(model.thinking?.mode).toBe("anthropic-adaptive");
		expect(getSupportedEfforts(model)).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]);
		expect(model.thinking?.defaultLevel).toBe(Effort.Medium);
		expect(model.tokenizer).toBe("claude-v47");
	});

	for (const isOAuth of [false, true]) {
		it(`sends native ${isOAuth ? "subscription OAuth" : "API-key"} adaptive requests without rejected budget or sampling fields`, async () => {
			let payload: WirePayload | undefined;
			const controller = new AbortController();
			controller.abort();
			await streamAnthropic(
				buildModel(nativeSpec()),
				{
					messages: [{ role: "user", content: "Classify this item.", timestamp: 1 }],
					tools: [
						{
							name: "classify",
							description: "Classify an item.",
							parameters: { type: "object", properties: {} },
						},
					],
				},
				{
					apiKey: isOAuth ? "sk-ant-oat-test" : "sk-ant-test",
					isOAuth,
					signal: controller.signal,
					thinkingEnabled: true,
					reasoning: Effort.XHigh,
					thinkingBudgetTokens: 8192,
					temperature: 0.2,
					topP: 0.8,
					topK: 10,
					toolChoice: "auto",
					onPayload: value => {
						payload = value as WirePayload;
					},
				},
			).result();
			if (!payload) throw new Error("expected a native Anthropic request payload");
			expect(payload.model).toBe("claude-haiku-5-5");
			expect(payload.thinking).toEqual({
				type: "adaptive",
				display: "summarized",
				block_binding: { prefix_mismatch_behavior: "drop_block" },
			});
			expect(payload.output_config?.effort).toBe("xhigh");
			expect(payload.temperature).toBeUndefined();
			expect(payload.top_p).toBeUndefined();
			expect(payload.top_k).toBeUndefined();
			expect(payload.tool_choice?.type).toBe("auto");
		});
	}
});
