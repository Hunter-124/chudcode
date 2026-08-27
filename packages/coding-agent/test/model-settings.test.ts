import { describe, expect, it } from "bun:test";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import { type Context, Effort, type Model, type SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	describeModelSettingProvenance,
	type ModelSettingsSourceLayers,
	resolveEffectiveModelSettings,
	resolveMergedModelSettings,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { formatEffectiveModelSettingsLines } from "@oh-my-pi/pi-coding-agent/modes/components/model-hub";
import { createSettingsAwareStreamFn } from "@oh-my-pi/pi-coding-agent/session/settings-stream-fn";

const model = getBundledModel("anthropic", "claude-sonnet-4-6");
if (!model) throw new Error("Expected bundled Claude Sonnet 4.6 model");
const modelKey = `${model.provider}/${model.id}`;
const context = { messages: [], tools: [], systemPrompt: [] } as unknown as Context;

describe("resolveEffectiveModelSettings", () => {
	it("preserves source precedence before specificity within each source", () => {
		const globalOnly = resolveEffectiveModelSettings({
			model,
			role: "task",
			sources: {
				global: {
					roleThinking: Effort.XHigh,
					modelSettings: {
						roles: { task: { cacheRetention: "none" } },
						models: { [modelKey]: { thinking: Effort.Medium, cacheRetention: "long" } },
					},
				},
			},
		});
		expect(globalOnly.thinking.value).toBe(Effort.Medium);
		expect(globalOnly.cacheRetention.value).toBe("long");
		expect(globalOnly.cacheRetention.provenance).toMatchObject({ scope: "global", specificity: "model" });

		const projectWins = resolveEffectiveModelSettings({
			model,
			role: "task",
			sources: {
				global: {
					modelSettings: { models: { [modelKey]: { thinking: Effort.High, cacheRetention: "long" } } },
				},
				project: {
					base: { thinking: Effort.Low, cacheRetention: "short" },
					modelSettings: { roles: { task: { cacheRetention: "none" } } },
				},
			},
		});
		expect(projectWins.thinking.value).toBe(Effort.Low);
		expect(projectWins.thinking.provenance).toMatchObject({ scope: "project", specificity: "base" });
		expect(projectWins.cacheRetention.value).toBe("none");
		expect(projectWins.cacheRetention.provenance).toMatchObject({ scope: "project", specificity: "role" });

		const runtimeWins = resolveEffectiveModelSettings({
			model,
			sources: {
				global: { base: { cacheRetention: "none" } },
				project: { base: { cacheRetention: "long" } },
				overlay: { base: { cacheRetention: "short" } },
				runtime: { base: { cacheRetention: "auto" } },
			},
		});
		expect(runtimeWins.cacheRetention.value).toBe("auto");
		expect(runtimeWins.cacheRetention.provenance.scope).toBe("runtime");
	});

	it("uses the source-layer runtime path and lets a higher-scope role beat a lower-scope model", () => {
		let receivedModel: Pick<Model, "provider" | "id"> | undefined;
		let receivedRole: string | undefined;
		const sourceLookup = {
			getModelSettingsSourceLayers(
				selectedModel: Pick<Model, "provider" | "id">,
				role?: string,
			): Readonly<ModelSettingsSourceLayers> {
				receivedModel = selectedModel;
				receivedRole = role;
				return {
					global: {
						modelSettings: {
							models: { [modelKey]: { thinking: Effort.High, cacheRetention: "long" } },
						},
					},
					project: {
						roleThinking: Effort.Low,
						modelSettings: { roles: { task: { cacheRetention: "short" } } },
					},
				};
			},
		};

		const effective = resolveMergedModelSettings(sourceLookup, model, "task");

		expect(receivedModel).toBe(model);
		expect(receivedRole).toBe("task");
		expect(effective.thinking).toMatchObject({
			value: Effort.Low,
			provenance: { scope: "project", specificity: "role", role: "task" },
		});
		expect(effective.cacheRetention).toMatchObject({
			value: "short",
			provenance: { scope: "project", specificity: "role", role: "task" },
		});
	});

	it("resolves fresh immutable Settings source snapshots on every call", () => {
		const settings = Settings.isolated({
			modelRoles: { task: `${modelKey}:${Effort.Low}` },
			modelSettings: {
				roles: { task: { cacheRetention: "short" } },
				models: { [modelKey]: { cacheRetention: "long" } },
			},
		});
		const sources = settings.getModelSettingsSourceLayers(model, "task");

		expect(Object.keys(sources)).toEqual(["global", "project", "overlay", "runtime"]);
		expect(Object.isFrozen(sources)).toBe(true);
		expect(Object.isFrozen(sources.runtime?.modelSettings?.models?.[modelKey])).toBe(true);

		const effective = resolveMergedModelSettings(settings, model, "task");
		expect(effective.thinking.value).toBe(Effort.Low);
		expect(effective.thinking.provenance).toMatchObject({ scope: "runtime", specificity: "role" });
		expect(effective.cacheRetention.value).toBe("long");
		expect(effective.cacheRetention.provenance).toMatchObject({ scope: "runtime", specificity: "model" });

		settings.override("modelSettings", { models: { [modelKey]: { cacheRetention: "none" } } });
		expect(sources.runtime?.modelSettings?.models?.[modelKey]?.cacheRetention).toBe("long");
		expect(
			settings.getModelSettingsSourceLayers(model, "task").runtime?.modelSettings?.models?.[modelKey]
				?.cacheRetention,
		).toBe("none");

		const updated = resolveMergedModelSettings(settings, model, "task");
		expect(updated.cacheRetention).toMatchObject({
			value: "none",
			provenance: { scope: "runtime", specificity: "model", model: modelKey },
		});
	});

	it("ignores an unknown role while retaining base and exact-model behavior", () => {
		const effective = resolveEffectiveModelSettings({
			model,
			role: "unconfigured-role",
			sources: {
				global: {
					base: { cacheRetention: "short" },
					modelSettings: {
						roles: { task: { cacheRetention: "none" } },
						models: { [modelKey]: { cacheRetention: "long" } },
					},
				},
			},
		});
		expect(effective.cacheRetention.value).toBe("long");
		expect(effective.cacheRetention.provenance.specificity).toBe("model");
	});

	it("matches only exact canonical provider/model keys", () => {
		for (const nonCanonicalKey of ["anthropic/*", "*/claude-sonnet-4-6", "@task", model.id]) {
			const effective = resolveEffectiveModelSettings({
				model,
				sources: {
					global: {
						base: { cacheRetention: "short" },
						modelSettings: { models: { [nonCanonicalKey]: { cacheRetention: "none" } } },
					},
				},
			});
			expect(effective.cacheRetention.value).toBe("short");
		}

		const exact = resolveEffectiveModelSettings({
			model,
			sources: { global: { modelSettings: { models: { [modelKey]: { cacheRetention: "none" } } } } },
		});
		expect(exact.cacheRetention.value).toBe("none");
	});

	it("treats null as per-field inheritance instead of a winning value", () => {
		const effective = resolveEffectiveModelSettings({
			model,
			role: "task",
			sources: {
				global: {
					modelSettings: {
						models: { [modelKey]: { thinking: Effort.High, cacheRetention: "long" } },
					},
				},
				project: {
					base: { thinking: Effort.Low },
					modelSettings: {
						roles: { task: { cacheRetention: "short" } },
						models: {
							[modelKey]: {
								thinking: null,
								cacheRetention: null,
							},
						},
					},
				},
			},
		});

		expect(effective.thinking).toMatchObject({
			value: Effort.Low,
			provenance: { scope: "project", specificity: "base" },
		});
		expect(effective.cacheRetention).toMatchObject({
			value: "short",
			provenance: { scope: "project", specificity: "role", role: "task" },
		});
	});

	it("applies temporary values last without changing persisted profiles", () => {
		const settings = Settings.isolated({
			modelSettings: {
				models: { [modelKey]: { thinking: Effort.Low, cacheRetention: "long" } },
			},
		});
		const before = settings.get("modelSettings");
		const temporary = resolveMergedModelSettings(settings, model, undefined, {
			thinking: Effort.Medium,
			cacheRetention: "none",
		});
		expect(temporary.thinking.value).toBe(Effort.Medium);
		expect(temporary.cacheRetention.value).toBe("none");
		expect(temporary.thinking.provenance.scope).toBe("temporary");
		expect(temporary.cacheRetention.provenance.scope).toBe("temporary");

		const persisted = resolveMergedModelSettings(settings, model);
		expect(persisted.thinking.value).toBe(Effort.Low);
		expect(persisted.cacheRetention.value).toBe("long");
		expect(settings.get("modelSettings")).toEqual(before);
	});

	it("keeps role selector thinking below an exact-model setting in the same source", () => {
		const settings = Settings.isolated({
			modelRoles: { task: `${modelKey}:${Effort.XHigh}` },
			modelSettings: { models: { [modelKey]: { thinking: Effort.Medium } } },
		});
		const effective = resolveMergedModelSettings(settings, model, "task");
		expect(effective.thinking.value).toBe(Effort.Medium);
		expect(effective.thinking.provenance).toMatchObject({ scope: "runtime", specificity: "model" });
	});

	it("clamps unsupported thinking to the selected model's supported ladder", () => {
		const effective = resolveEffectiveModelSettings({
			model,
			sources: { global: { modelSettings: { models: { [modelKey]: { thinking: Effort.XHigh } } } } },
		});
		expect(effective.thinking.value).toBe(Effort.High);
		expect(effective.thinking.adjustedFrom).toBe(Effort.XHigh);
		expect(effective.thinking.provenance).toMatchObject({ scope: "global", specificity: "model" });
	});

	it("leaves existing base behavior unchanged when modelSettings is absent", () => {
		const settings = Settings.isolated({
			defaultThinkingLevel: Effort.Medium,
			"providers.cacheRetention": "short",
		});
		const effective = resolveMergedModelSettings(settings, model, "task");
		expect(effective.thinking.value).toBe(Effort.Medium);
		expect(effective.cacheRetention.value).toBe("short");
		expect(effective.thinking.provenance).toMatchObject({ scope: "runtime", specificity: "base" });
		expect(effective.cacheRetention.provenance).toMatchObject({ scope: "runtime", specificity: "base" });

		const emptySettings = Settings.isolated();
		const defaults = resolveMergedModelSettings(emptySettings, model, "task");
		expect(defaults.thinking.value).toBe(emptySettings.get("defaultThinkingLevel"));
		expect(defaults.cacheRetention.value).toBe(emptySettings.get("providers.cacheRetention"));
		expect(defaults.thinking.provenance.scope).toBe("schema");
		expect(defaults.cacheRetention.provenance.scope).toBe("schema");
	});

	it("provides stable plain-language provenance for the model hub", () => {
		const effective = resolveEffectiveModelSettings({
			model,
			role: "task",
			sources: {
				global: { base: { thinking: Effort.Medium } },
				project: { modelSettings: { roles: { task: { cacheRetention: "long" } } } },
			},
		});
		expect(describeModelSettingProvenance(effective.thinking.provenance)).toBe("Inherited from global setting");
		expect(describeModelSettingProvenance(effective.cacheRetention.provenance)).toBe("Project role “task”");
		expect(formatEffectiveModelSettingsLines(effective, "advanced")).toEqual([
			"Effective settings",
			"Thinking: Medium — Inherited from global setting",
			"Prompt cache: Long — Project role “task”",
		]);
		expect(formatEffectiveModelSettingsLines(effective, "basic")).toEqual([
			"Effective: Thinking Medium · Prompt cache Long",
		]);
	});
});

describe("settings-aware stream model profiles", () => {
	it("uses the current request role and selected model without mutating Settings", () => {
		const settings = Settings.isolated({
			"providers.cacheRetention": "long",
			modelSettings: { roles: { task: { cacheRetention: "short" } } },
		});
		const before = settings.get("modelSettings");
		const calls: Array<SimpleStreamOptions | undefined> = [];
		const base: StreamFn = (_model, _context, options) => {
			calls.push(options);
			return new AssistantMessageEventStream();
		};
		const stream = createSettingsAwareStreamFn(settings, base, { resolveRole: () => "task" });

		stream(model as Model, context, undefined);
		stream(model as Model, context, { cacheRetention: "none" });

		expect(calls[0]?.cacheRetention).toBe("short");
		expect(calls[1]?.cacheRetention).toBe("none");
		expect(settings.get("modelSettings")).toEqual(before);
	});
});
