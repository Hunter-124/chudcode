import { describe, expect, it } from "bun:test";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSettingsAwareStreamFn } from "@oh-my-pi/pi-coding-agent/session/settings-stream-fn";

const model = getBundledModel("anthropic", "claude-sonnet-4-6");
if (!model) throw new Error("Expected bundled Claude Sonnet 4.6 model");
const modelKey = `${model.provider}/${model.id}`;
const temporaryModel = { ...model, id: "temporary-profile-model" } as Model;
const temporaryModelKey = `${temporaryModel.provider}/${temporaryModel.id}`;
const context = { messages: [], tools: [], systemPrompt: [] } as unknown as Context;

function captureBase(): { fn: StreamFn; calls: Array<{ model: Model; options?: SimpleStreamOptions }> } {
	const calls: Array<{ model: Model; options?: SimpleStreamOptions }> = [];
	const fn: StreamFn = (requestModel, _context, options) => {
		calls.push({ model: requestModel, options });
		return new AssistantMessageEventStream();
	};
	return { fn, calls };
}

describe("settings-aware model profile requests", () => {
	it("applies the main session's default semantic role", () => {
		const settings = Settings.isolated({
			"providers.cacheRetention": "long",
			modelSettings: { roles: { default: { cacheRetention: "short" } } },
		});
		const capture = captureBase();
		const stream = createSettingsAwareStreamFn(settings, capture.fn, { resolveRole: () => "default" });

		stream(model, context, undefined);

		expect(capture.calls[0]?.options?.cacheRetention).toBe("short");
	});

	it("keeps advisor and task role identities after both resolve to the same model", () => {
		const settings = Settings.isolated({
			modelSettings: {
				roles: {
					advisor: { cacheRetention: "long" },
					task: { cacheRetention: "none" },
				},
			},
		});
		const capture = captureBase();
		let role: string | undefined = "advisor";
		const stream = createSettingsAwareStreamFn(settings, capture.fn, { resolveRole: () => role });

		stream(model, context, undefined);
		role = "task";
		stream(model, context, undefined);

		expect(capture.calls.map(call => call.model)).toEqual([model, model]);
		expect(capture.calls.map(call => call.options?.cacheRetention)).toEqual(["long", "none"]);
	});

	it("recomputes exact-model settings for a temporary model without fabricating a role", () => {
		const settings = Settings.isolated({
			"providers.cacheRetention": "short",
			modelSettings: {
				roles: { task: { cacheRetention: "none" } },
				models: { [temporaryModelKey]: { cacheRetention: "long" } },
			},
		});
		const capture = captureBase();
		const stream = createSettingsAwareStreamFn(settings, capture.fn, { resolveRole: () => undefined });

		stream(temporaryModel, context, undefined);

		expect(capture.calls[0]?.model).toBe(temporaryModel);
		expect(capture.calls[0]?.options?.cacheRetention).toBe("long");
	});

	it("keeps an explicit request cache retention above effective model settings", () => {
		const settings = Settings.isolated({
			modelSettings: { roles: { task: { cacheRetention: "long" } } },
		});
		const capture = captureBase();
		const stream = createSettingsAwareStreamFn(settings, capture.fn, { resolveRole: () => "task" });

		stream(model, context, { cacheRetention: "none" });

		expect(capture.calls[0]?.options?.cacheRetention).toBe("none");
	});

	it("preserves legacy cache retention when modelSettings is absent", () => {
		const settings = Settings.isolated({ "providers.cacheRetention": "short" });
		const capture = captureBase();
		const stream = createSettingsAwareStreamFn(settings, capture.fn, { resolveRole: () => "task" });

		stream(model, context, undefined);

		expect(capture.calls[0]?.options?.cacheRetention).toBe("short");
	});

	it("derives per-request retention without mutating Settings", () => {
		const settings = Settings.isolated({
			"providers.cacheRetention": "short",
			modelSettings: {
				roles: { task: { cacheRetention: "none" } },
				models: { [modelKey]: { cacheRetention: "long" } },
			},
		});
		const before = structuredClone(settings.get("modelSettings"));
		const capture = captureBase();
		let role: string | undefined = "task";
		const stream = createSettingsAwareStreamFn(settings, capture.fn, { resolveRole: () => role });

		stream(model, context, undefined);
		role = undefined;
		stream(temporaryModel, context, undefined);
		stream(model, context, { cacheRetention: "none" });

		expect(settings.get("modelSettings")).toEqual(before);
	});
});
