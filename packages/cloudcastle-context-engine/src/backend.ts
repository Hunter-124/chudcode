import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { MemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend";
import { DEFAULT_CONTEXT_DEPENDENCIES, fetchIncidentContext } from "./client";
import incidentContextTemplate from "./prompts/incident-context.md" with { type: "text" };
import { rankAndMergeEvidence } from "./ranking";
import { type CloudCastleContextEnv, parseCloudCastleContextSettings } from "./settings";
import { CLOUDCASTLE_INCIDENT_BACKEND_ID, type CloudCastleContextDependencies, type EvidenceCoverage } from "./types";

const MAX_QUERY_CHARS = 16_000;

export function createCloudCastleIncidentBackend(
	env: CloudCastleContextEnv,
	dependencies: CloudCastleContextDependencies = DEFAULT_CONTEXT_DEPENDENCIES,
): MemoryBackend {
	const parsedSettings = parseCloudCastleContextSettings(env);
	let contextBySession = new WeakMap<object, string>();
	const evictPromptContext = async (session: AgentSession): Promise<void> => {
		if (!contextBySession.delete(session)) return;
		try {
			await session.refreshBaseSystemPrompt();
		} catch {
			// The backend remains empty; the host owns reporting prompt-refresh failures.
		}
	};

	const backend: MemoryBackend = {
		id: CLOUDCASTLE_INCIDENT_BACKEND_ID,

		async start() {},

		async buildDeveloperInstructions(_agentDir, _settings, session) {
			return session ? contextBySession.get(session) : undefined;
		},

		async clear(_agentDir, _cwd, session) {
			if (session) contextBySession.delete(session);
			else contextBySession = new WeakMap<object, string>();
		},

		async enqueue() {},

		async status() {
			return {
				backend: CLOUDCASTLE_INCIDENT_BACKEND_ID,
				active: parsedSettings.ok,
				writable: false,
				searchable: parsedSettings.ok,
				scope: "cloudcastle-control-api:incident",
				...(parsedSettings.ok
					? { message: "Read-only incident context is configured." }
					: { message: `Incident context unavailable (${parsedSettings.errorCode}).` }),
			};
		},

		async search(_context, query, options) {
			if (!parsedSettings.ok) {
				return {
					backend: CLOUDCASTLE_INCIDENT_BACKEND_ID,
					query,
					count: 0,
					items: [],
					message: `Incident context unavailable (${parsedSettings.errorCode}).`,
				};
			}
			if (options?.signal?.aborted) {
				return {
					backend: CLOUDCASTLE_INCIDENT_BACKEND_ID,
					query,
					count: 0,
					items: [],
					message: "Incident context search was cancelled.",
				};
			}
			const safeQuery = query.slice(-MAX_QUERY_CHARS);
			const context = await fetchIncidentContext(parsedSettings.settings, safeQuery, dependencies);
			if (context.failedClosed || options?.signal?.aborted) {
				return {
					backend: CLOUDCASTLE_INCIDENT_BACKEND_ID,
					query,
					count: 0,
					items: [],
					message: context.errorCode
						? `Incident context unavailable (${context.errorCode}).`
						: "Incident context search was cancelled.",
				};
			}
			const limit = Math.max(0, Math.min(options?.limit ?? 10, 20));
			const ranked = rankAndMergeEvidence(context.evidence, parsedSettings.settings.tokenBudget).evidence.slice(
				0,
				limit,
			);
			return {
				backend: CLOUDCASTLE_INCIDENT_BACKEND_ID,
				query,
				count: ranked.length,
				items: ranked.map(item => ({
					id: item.id,
					content: item.content,
					source: item.sourceUrl,
					timestamp: item.timestamp,
					score: item.evidencePriority / 100,
				})),
			};
		},

		async beforeAgentStartPrompt(session, promptText) {
			if (!parsedSettings.ok) {
				await evictPromptContext(session);
				return undefined;
			}
			try {
				const context = await fetchIncidentContext(
					parsedSettings.settings,
					promptText.slice(-MAX_QUERY_CHARS),
					dependencies,
				);
				if (context.failedClosed || context.evidence.length === 0 || !context.incidentId) {
					await evictPromptContext(session);
					return undefined;
				}
				const ranked = rankAndMergeEvidence(context.evidence, parsedSettings.settings.tokenBudget);
				if (!ranked.renderedEvidence) {
					await evictPromptContext(session);
					return undefined;
				}
				const block = renderDeveloperBlock(context.incidentId, context.coverage, ranked.renderedEvidence);
				return {
					context: block,
					commit: () => {
						contextBySession.set(session, block);
						return true;
					},
				};
			} catch {
				await evictPromptContext(session);
				return undefined;
			}
		},
	};
	return backend;
}

function renderDeveloperBlock(
	incidentId: string,
	coverage: readonly EvidenceCoverage[],
	renderedEvidence: string,
): string {
	const renderedCoverage = coverage
		.map(item =>
			JSON.stringify({
				class: item.className,
				state: item.state,
				entity: item.entity,
				item_count: item.itemCount,
				provenance: item.provenance,
				source_url: item.sourceUrl,
				timestamp: item.timestamp,
			}),
		)
		.join(" ");
	return incidentContextTemplate
		.replace("{{incident_id}}", incidentId)
		.replace("{{coverage}}", renderedCoverage)
		.replace("{{evidence}}", renderedEvidence)
		.trim();
}
