// Cursor catalog rows collapse per-effort sibling ids into one logical model,
// but AgentService.Run still requires the exact opaque id advertised by
// GetUsableModels. buildGrpcRequest is exercised directly (the transport is
// HTTP/2) and the serialized run request is decoded back from the wire bytes.
import { describe, expect, it } from "bun:test";
import { buildGrpcRequest } from "@chudware/ai/providers/cursor";
import type { Context, Model } from "@chudware/ai/types";
import { buildModel } from "@chudware/catalog/build";
import { AgentClientMessageSchema } from "@chudware/catalog/discovery/cursor-proto";
import { fromBinary } from "@chudware/catalog/discovery/protobuf";
import { Effort } from "@chudware/catalog/effort";

const model: Model<"cursor-agent"> = buildModel({
	id: "gpt-5.6-terra",
	name: "GPT-5.6 Terra",
	api: "cursor-agent",
	provider: "cursor",
	baseUrl: "https://api2.cursor.sh",
	reasoning: true,
	requestModelId: "gpt-5.6-terra-none",
	thinking: {
		mode: "effort",
		efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
		effortRouting: {
			off: "gpt-5.6-terra-none",
			[Effort.Low]: "gpt-5.6-terra-low",
			[Effort.Medium]: "gpt-5.6-terra-medium",
			[Effort.High]: "gpt-5.6-terra-high",
			[Effort.XHigh]: "gpt-5.6-terra-xhigh",
			[Effort.Max]: "gpt-5.6-terra-max",
		},
	},
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

const context: Context = {
	messages: [{ role: "user", content: "Say hello", timestamp: 0 }],
};

function decodeRunRequest(requestBytes: Uint8Array): { case: string; value: Record<string, any> } {
	const decoded = fromBinary(AgentClientMessageSchema, requestBytes);
	return decoded.message as unknown as { case: string; value: Record<string, any> };
}

describe("cursor effort routing", () => {
	it("sends the exact effort-routed wire id", async () => {
		const { requestBytes } = await buildGrpcRequest(
			model,
			context,
			{ wireModelId: "gpt-5.6-terra-medium" },
			{ conversationId: "conv-1", blobStore: new Map() },
		);
		const run = decodeRunRequest(requestBytes).value;
		expect(run.requestedModel.modelId).toBe("gpt-5.6-terra-medium");
		expect(run.modelDetails.modelId).toBe("gpt-5.6-terra-medium");
		expect(run.requestedModel.parameters).toEqual([]);

		// Logical id stays as the display id for local attribution.
		expect(run.modelDetails.displayModelId).toBe("gpt-5.6-terra");
	});

	it("preserves the fast lane in the exact routed id", async () => {
		const { requestBytes } = await buildGrpcRequest(
			model,
			context,
			{ wireModelId: "gpt-5.6-terra-xhigh-fast" },
			{ conversationId: "conv-fast", blobStore: new Map() },
		);
		const run = decodeRunRequest(requestBytes).value;
		expect(run.requestedModel.modelId).toBe("gpt-5.6-terra-xhigh-fast");
		expect(run.modelDetails.modelId).toBe("gpt-5.6-terra-xhigh-fast");
		expect(run.requestedModel.parameters).toEqual([]);
	});

	it("preserves an explicit thinking fast variant as an opaque id", async () => {
		const { requestBytes } = await buildGrpcRequest(
			model,
			context,
			{ wireModelId: "claude-opus-5-thinking-xhigh-fast" },
			{ conversationId: "conv-thinking-fast", blobStore: new Map() },
		);
		const run = decodeRunRequest(requestBytes).value;
		expect(run.requestedModel.modelId).toBe("claude-opus-5-thinking-xhigh-fast");
		expect(run.modelDetails.modelId).toBe("claude-opus-5-thinking-xhigh-fast");
		expect(run.requestedModel.parameters).toEqual([]);
	});

	it("leaves a non-variant routed id unchanged", async () => {
		const { requestBytes } = await buildGrpcRequest(
			model,
			context,
			{ wireModelId: "cursor-grok-4.6" },
			{ conversationId: "conv-non-variant", blobStore: new Map() },
		);
		const run = decodeRunRequest(requestBytes).value;
		expect(run.requestedModel.modelId).toBe("cursor-grok-4.6");
		expect(run.modelDetails.modelId).toBe("cursor-grok-4.6");
		expect(run.requestedModel.parameters).toEqual([]);
	});

	it("falls back to requestModelId when no wire id is routed", async () => {
		const { requestBytes } = await buildGrpcRequest(model, context, undefined, {
			conversationId: "conv-2",
			blobStore: new Map(),
		});
		const run = decodeRunRequest(requestBytes).value;
		expect(run.requestedModel.modelId).toBe("gpt-5.6-terra-none");
		expect(run.modelDetails.modelId).toBe("gpt-5.6-terra-none");
	});
});
