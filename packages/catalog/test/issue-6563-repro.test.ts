/**
 * Issue #6563 — `Snapcompact not working for anthropic/claude-opus-5`
 *
 * The registry derives Anthropic's discovery base URL from an existing bundled
 * model, and most bundled Anthropic rows use `https://api.anthropic.com`
 * without the `/v1` suffix. `anthropicModelManagerOptions` accepted that
 * override verbatim, so generic discovery requested
 * `https://api.anthropic.com/models` (404) instead of `/v1/models`. The failed
 * refresh then retained a stale text-only cache row, which `mergeDynamicModel`
 * treated as authoritative over fresh stencil.so vision metadata — leaving
 * `claude-opus-5` marked text-only and snapcompact refusing to run.
 *
 * The fix normalizes the discovery URL to always end in `/v1` while model rows
 * keep the provider base URL.
 */
import { describe, expect, it } from "bun:test";
import { buildModel } from "@chudware/catalog/build";
import { Effort } from "@chudware/catalog/effort";
import { createModelManager } from "@chudware/catalog/model-manager";
import { anthropicModelManagerOptions } from "@chudware/catalog/provider-models/openai-compat";

const PROVIDER_BASE_URL = "https://api.anthropic.com";

function modelsDevResponse(): Response {
	const body = {
		anthropic: {
			models: {
				// Not in the bundled catalog: capability must come from stencil.so
				// through the discovery path under repair.
				"claude-test-vision-1": {
					name: "Claude Test Vision",
					tool_call: true,
					reasoning: true,
					modalities: { input: ["text", "image"] },
					limit: { context: 1_000_000, output: 128_000 },
					cost: { input: 5, output: 25 },
				},
			},
		},
	};
	return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

function anthropicModelsResponse(): Response {
	const body = {
		data: [
			{ type: "model", id: "claude-opus-5", display_name: "Claude Opus 5" },
			{ type: "model", id: "claude-test-vision-1", display_name: "Claude Test Vision" },
		],
	};
	return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

describe("issue #6563 — anthropic discovery base URL missing /v1", () => {
	it("fetches /v1/models even when the registry passes a bare host base URL", async () => {
		const requestedUrls: string[] = [];
		const fetchMock = (async (input: string | URL | Request): Promise<Response> => {
			const url = String(input instanceof Request ? input.url : input);
			requestedUrls.push(url);
			if (url === "https://catalog.stencil.so/models.json.zstd") return modelsDevResponse();
			if (url === `${PROVIDER_BASE_URL}/v1/models`) return anthropicModelsResponse();
			return new Response("not found", { status: 404 });
		}) as typeof fetch;

		const models = await anthropicModelManagerOptions({
			apiKey: "sk-ant-test",
			baseUrl: PROVIDER_BASE_URL,
			fetch: fetchMock,
		}).fetchDynamicModels?.();

		// Pre-fix, discovery hit `https://api.anthropic.com/models`, got a 404,
		// and returned null — which let a stale text-only cache row survive.
		expect(requestedUrls).toContain(`${PROVIDER_BASE_URL}/v1/models`);
		expect(requestedUrls).not.toContain(`${PROVIDER_BASE_URL}/models`);
		expect(models).not.toBeNull();

		const opus5 = models?.find(m => m.id === "claude-opus-5");
		expect(opus5?.input).toContain("image");
		// Rows keep the provider base, not the /v1 discovery URL, so refreshed
		// rows merge against bundled models instead of registering an endpoint
		// change that would make stale capabilities authoritative.
		expect(opus5?.baseUrl).toBe(PROVIDER_BASE_URL);

		// A model absent from the bundled catalog picks up vision from stencil.so.
		const unbundled = models?.find(m => m.id === "claude-test-vision-1");
		expect(unbundled?.input).toContain("image");
		expect(unbundled?.baseUrl).toBe(PROVIDER_BASE_URL);
	});
});

it("derives a future Claude's adaptive ladder from /v1/models without a bundled or shared-catalog row", async () => {
	const modelId = "claude-sonnet-5-7";
	const fetchMock = (async (input: string | URL | Request): Promise<Response> => {
		const url = String(input instanceof Request ? input.url : input);
		if (url === "https://catalog.stencil.so/models.json.zstd") {
			return new Response(JSON.stringify({ anthropic: { models: {} } }));
		}
		if (url === `${PROVIDER_BASE_URL}/v1/models`) {
			return new Response(
				JSON.stringify({ data: [{ type: "model", id: modelId, display_name: "Claude Sonnet 5.7" }] }),
			);
		}
		throw new Error(`Unexpected discovery URL: ${url}`);
	}) as typeof fetch;

	const specs = await anthropicModelManagerOptions({ apiKey: "sk-ant-test", fetch: fetchMock }).fetchDynamicModels?.();
	const discovered = specs?.find(spec => spec.id === modelId);
	expect(discovered?.reasoning).toBe(true);
	expect(discovered && buildModel(discovered).thinking).toEqual({
		mode: "anthropic-adaptive",
		efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
		supportsDisplay: true,
	});
});

it("online refresh adds a future Claude from the shared catalog without a binary update", async () => {
	const modelId = "claude-opus-5-8";
	const fetchMock = (async (input: string | URL | Request): Promise<Response> => {
		const url = String(input instanceof Request ? input.url : input);
		if (url !== "https://catalog.stencil.so/models.json.zstd") throw new Error(`Unexpected discovery URL: ${url}`);
		return new Response(
			JSON.stringify({
				anthropic: {
					models: {
						[modelId]: {
							name: "Claude Opus 5.8",
							tool_call: true,
							reasoning: true,
							modalities: { input: ["text", "image"] },
							limit: { context: 1_000_000, output: 128_000 },
							cost: { input: 5, output: 25, cache_read: 0.25, cache_write: 6.25 },
						},
					},
				},
			}),
		);
	}) as typeof fetch;

	const manager = createModelManager({
		...anthropicModelManagerOptions({ fetch: fetchMock }),
		cacheDbPath: ":memory:",
	});
	const refreshed = await manager.refresh("online");
	const discovered = refreshed.models.find(model => model.id === modelId);
	expect(refreshed.source).toBe("models.dev");
	expect(discovered?.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]);
	expect(discovered?.cost).toEqual({ input: 5, output: 25, cacheRead: 0.25, cacheWrite: 6.25 });
});
