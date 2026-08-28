#!/usr/bin/env bun
import { ChudcodeDiagnosisRunner } from "./chudcode-diagnosis";
import {
	AtomicFileStateStore,
	CloudCastleIncidentApi,
	DiscordRestPublisher,
	IncidentDispatcher,
	parseIncidentDispatcherConfig,
} from "./incident-dispatcher";

const HELP = `Usage: bun src/incident-cli.ts [--once]

Required environment:
  CLOUDCASTLE_INCIDENT_BASE_URL
  CLOUDCASTLE_INCIDENT_TOKEN
  CLOUDCASTLE_INCIDENT_DISCORD_TOKEN
  CLOUDCASTLE_INCIDENT_DEFECT_CHANNEL_ID
  CLOUDCASTLE_INCIDENT_ESCALATION_CHANNEL_ID

Optional environment:
  CLOUDCASTLE_INCIDENT_ORG_ID
  CLOUDCASTLE_INCIDENT_STATE_PATH
  CLOUDCASTLE_INCIDENT_DIAGNOSIS_CWD
  CLOUDCASTLE_INCIDENT_POLL_MS
  CLOUDCASTLE_INCIDENT_MAX_BACKOFF_MS
  CLOUDCASTLE_INCIDENT_REQUEST_TIMEOUT_MS
  CLOUDCASTLE_INCIDENT_DIAGNOSIS_TIMEOUT_MS
  CLOUDCASTLE_INCIDENT_MISSING_POLLS
  CLOUDCASTLE_CONTEXT_ENDPOINTS
`;

const args = new Set(Bun.argv.slice(2));
if (args.has("--help") || args.has("-h")) {
	console.log(HELP);
	process.exit(0);
}
for (const arg of args) {
	if (arg !== "--once") throw new Error(`Unknown argument: ${arg}`);
}

const config = parseIncidentDispatcherConfig(process.env);
const abort = new AbortController();
process.once("SIGINT", () => abort.abort());
process.once("SIGTERM", () => abort.abort());

const dispatcher = new IncidentDispatcher({
	api: new CloudCastleIncidentApi({
		baseUrl: config.apiBaseUrl,
		bearerToken: config.apiToken,
		orgId: config.orgId,
		requestTimeoutMs: config.requestTimeoutMs,
	}),
	discord: new DiscordRestPublisher(config.discordToken),
	diagnosis: new ChudcodeDiagnosisRunner({
		cwd: config.diagnosisCwd,
		apiBaseUrl: config.apiBaseUrl,
		apiToken: config.apiToken,
		timeoutMs: config.diagnosisTimeoutMs,
		contextEndpoints: process.env.CLOUDCASTLE_CONTEXT_ENDPOINTS,
	}),
	stateStore: new AtomicFileStateStore(config.statePath),
	channels: config.channels,
	explicitSecrets: [config.apiToken, config.discordToken],
	missingPollThreshold: config.missingPollThreshold,
});

try {
	await dispatcher.run({
		pollIntervalMs: config.pollIntervalMs,
		maxBackoffMs: config.maxBackoffMs,
		signal: abort.signal,
		once: args.has("--once"),
		onError: message => console.error(`[cloudcastle-incident-dispatcher] ${message}`),
	});
} catch (error) {
	const message = error instanceof Error ? error.message : "Incident dispatcher failed";
	console.error(`[cloudcastle-incident-dispatcher] ${message}`);
	process.exitCode = 1;
}
