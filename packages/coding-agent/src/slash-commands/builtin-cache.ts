import { cfgDisplayCacheMissMarker } from "../modes/settings";
import { cfgProvidersCacheRetention, cfgProvidersCacheWarming } from "../session/settings";
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
					activeModel: runtime.session.model,
					findModel: (provider, modelId) => runtime.session.modelRegistry.find(provider, modelId),
					retention: cfgProvidersCacheRetention.get(runtime.settings),
					warming: cfgProvidersCacheWarming.get(runtime.settings),
					cacheMissMarker: cfgDisplayCacheMissMarker.get(runtime.settings),
				}),
			);
			return commandConsumed();
		},
	},
];
