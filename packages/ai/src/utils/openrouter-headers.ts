import { USER_AGENT } from "@chudware/utils";

export function getOpenRouterHeaders(): Record<string, string> {
	return {
		"User-Agent": USER_AGENT,
		"HTTP-Referer": "https://chudware.sh/",
		"X-OpenRouter-Title": "chudcode",
		"X-OpenRouter-Categories": "cli-agent",
		"X-OpenRouter-Cache": "true",
		"X-OpenRouter-Cache-TTL": "3600",
	};
}
