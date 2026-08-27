import { buildCacheReportText } from "./helpers/cache-report";
import { commandConsumed } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

export const BUILTIN_CACHE_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "cache",
		icon: "gauge",
		description: "Show prompt-cache savings, hit rate, and retention",
		acpDescription: "Show prompt-cache savings, hit rate, and retention",
		handle: async (_command, runtime) => {
			await runtime.output(
				buildCacheReportText({
					messages: runtime.session.state.messages,
					findModel: (provider, modelId) => runtime.session.modelRegistry.find(provider, modelId),
					retention: runtime.settings.get("providers.cacheRetention"),
					cacheMissMarker: runtime.settings.get("display.cacheMissMarker"),
				}),
			);
			return commandConsumed();
		},
	},
];
