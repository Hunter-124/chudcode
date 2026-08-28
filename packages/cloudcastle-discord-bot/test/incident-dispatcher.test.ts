import { describe, expect, it } from "bun:test";
import {
	computeBackoffMs,
	type DiagnosisRequest,
	type DiagnosisRunner,
	type DiscordPublisher,
	type DispatcherState,
	type DispatcherStateStore,
	type IncidentApi,
	IncidentDispatcher,
	type IncidentSource,
	normalizeIncident,
	parseIncidentDispatcherConfig,
} from "../src/incident-dispatcher";

const NOW = new Date("2026-08-27T12:00:00.000Z");
const CHANNELS = { "product-defect": "111111111111111", escalation: "222222222222222" } as const;
const DEFECT_ID = "11111111-1111-4111-8111-111111111111";
const ESCALATION_ID = "22222222-2222-4222-8222-222222222222";

class MutableApi implements IncidentApi {
	records: Record<IncidentSource, readonly unknown[]> = { "product-defect": [], escalation: [] };
	failures = new Set<IncidentSource>();

	async fetch(source: IncidentSource) {
		if (this.failures.has(source)) throw new Error(`${source} unavailable`);
		return this.records[source];
	}
}

class MemoryStateStore implements DispatcherStateStore {
	state: DispatcherState = { version: 1, incidents: {} };

	async load() {
		return structuredClone(this.state);
	}

	async save(state: DispatcherState) {
		this.state = structuredClone(state);
	}
}

class RecordingDiscord implements DiscordPublisher {
	attempts = 0;
	failuresRemaining = 0;
	messages: Array<{ channelId: string; content: string; nonce: string }> = [];
	readonly #messageByNonce = new Map<string, string>();

	async post(channelId: string, content: string, nonce: string) {
		this.attempts += 1;
		if (this.failuresRemaining > 0) {
			this.failuresRemaining -= 1;
			throw new Error("Discord temporarily unavailable");
		}
		const previous = this.#messageByNonce.get(nonce);
		if (previous) return { messageId: previous };
		const messageId = String(this.messages.length + 1);
		this.#messageByNonce.set(nonce, messageId);
		this.messages.push({ channelId, content, nonce });
		return { messageId };
	}
}

class RecordingDiagnosis implements DiagnosisRunner {
	attempts = 0;
	failuresRemaining = 0;
	calls: DiagnosisRequest[] = [];

	async diagnose(request: DiagnosisRequest) {
		this.attempts += 1;
		this.calls.push(request);
		if (!request.sessionPath) await request.registerSession(`/sessions/${request.incident.id}.jsonl`);
		if (this.failuresRemaining > 0) {
			this.failuresRemaining -= 1;
			throw new Error("model temporarily unavailable");
		}
	}
}

function createHarness(
	options: {
		api?: MutableApi;
		store?: MemoryStateStore;
		discord?: RecordingDiscord;
		diagnosis?: RecordingDiagnosis;
		missingPollThreshold?: number;
	} = {},
) {
	const api = options.api ?? new MutableApi();
	const store = options.store ?? new MemoryStateStore();
	const discord = options.discord ?? new RecordingDiscord();
	const diagnosis = options.diagnosis ?? new RecordingDiagnosis();
	const dispatcher = new IncidentDispatcher({
		api,
		discord,
		diagnosis,
		stateStore: store,
		channels: CHANNELS,
		explicitSecrets: ["api-secret", "discord-secret"],
		missingPollThreshold: options.missingPollThreshold ?? 1,
		now: () => NOW,
	});
	return { api, store, discord, diagnosis, dispatcher };
}

function openDefect(overrides: Record<string, unknown> = {}) {
	return {
		id: DEFECT_ID,
		status: "open",
		title: "Agent upgrade fails safely",
		severity: "high",
		priority: "P2",
		created_at: "2026-08-27T10:00:00Z",
		...overrides,
	};
}

function openEscalation(overrides: Record<string, unknown> = {}) {
	return {
		id: ESCALATION_ID,
		status: "open",
		title: "Automation needs a technician",
		severity: "critical",
		priority: "P1",
		created_at: "2026-08-27T09:00:00Z",
		...overrides,
	};
}

describe("incident lifecycle dispatch", () => {
	it("posts create, one material update, and one closure without duplicates across restart", async () => {
		const harness = createHarness();
		harness.api.records["product-defect"] = [openDefect()];

		await harness.dispatcher.pollOnce();
		await harness.dispatcher.pollOnce();
		expect(harness.discord.messages.map(message => message.content.split("\n")[0])).toEqual([
			"**[P2 · HIGH] Product defect created**",
		]);
		expect(harness.diagnosis.attempts).toBe(1);

		const restarted = createHarness({
			api: harness.api,
			store: harness.store,
			discord: harness.discord,
			diagnosis: harness.diagnosis,
		});
		await restarted.dispatcher.pollOnce();
		expect(harness.discord.messages).toHaveLength(1);
		expect(harness.diagnosis.attempts).toBe(1);

		harness.api.records["product-defect"] = [openDefect({ severity: "critical", priority: "P1" })];
		await restarted.dispatcher.pollOnce();
		await restarted.dispatcher.pollOnce();
		expect(harness.discord.messages).toHaveLength(2);
		expect(harness.discord.messages[1].content).toContain("Product defect updated");
		expect(harness.diagnosis.attempts).toBe(2);

		harness.api.records["product-defect"] = [openDefect({ status: "fixed", severity: "critical", priority: "P1" })];
		await restarted.dispatcher.pollOnce();
		await restarted.dispatcher.pollOnce();
		expect(harness.discord.messages).toHaveLength(3);
		expect(harness.discord.messages[2].content).toContain("Product defect resolved");
		expect(harness.diagnosis.attempts).toBe(2);
	});

	it("closes an escalation only after a successful source read confirms it is absent", async () => {
		const harness = createHarness({ missingPollThreshold: 1 });
		harness.api.records.escalation = [openEscalation()];
		await harness.dispatcher.pollOnce();

		harness.api.failures.add("escalation");
		await expect(harness.dispatcher.pollOnce()).rejects.toThrow("escalation unavailable");
		expect(harness.discord.messages).toHaveLength(1);

		harness.api.failures.delete("escalation");
		harness.api.records.escalation = [];
		await harness.dispatcher.pollOnce();
		await harness.dispatcher.pollOnce();
		expect(harness.discord.messages).toHaveLength(2);
		expect(harness.discord.messages[1].content).toContain("Escalation resolved");
	});

	it("orders lifecycle posts deterministically before invoking Chudcode", async () => {
		const harness = createHarness();
		harness.api.records["product-defect"] = [
			openDefect({ id: "33333333-3333-4333-8333-333333333333", priority: "P3", severity: "medium" }),
			openDefect({ id: "44444444-4444-4444-8444-444444444444", priority: "P1", severity: "high" }),
		];
		harness.api.records.escalation = [openEscalation()];
		await harness.dispatcher.pollOnce();
		expect(harness.discord.messages.map(message => message.content.match(/Reference: `([^`]+)`/)?.[1])).toEqual([
			ESCALATION_ID,
			"44444444-4444-4444-8444-444444444444",
			"33333333-3333-4333-8333-333333333333",
		]);
	});
});

describe("failure recovery", () => {
	it("retains a pending Discord lifecycle and retries it without losing diagnosis state", async () => {
		const harness = createHarness();
		harness.discord.failuresRemaining = 1;
		harness.api.records["product-defect"] = [openDefect()];
		await expect(harness.dispatcher.pollOnce()).rejects.toThrow("Discord temporarily unavailable");
		expect(harness.discord.messages).toHaveLength(0);
		expect(harness.diagnosis.attempts).toBe(0);

		await harness.dispatcher.pollOnce();
		expect(harness.discord.messages).toHaveLength(1);
		expect(harness.diagnosis.attempts).toBe(1);
	});

	it("retries Chudcode in the persisted session without duplicating Discord", async () => {
		const harness = createHarness();
		harness.diagnosis.failuresRemaining = 1;
		harness.api.records["product-defect"] = [openDefect()];
		await expect(harness.dispatcher.pollOnce()).rejects.toThrow("model temporarily unavailable");
		expect(harness.discord.messages).toHaveLength(1);
		expect(harness.diagnosis.calls[0].sessionPath).toBeUndefined();

		await harness.dispatcher.pollOnce();
		expect(harness.discord.messages).toHaveLength(1);
		expect(harness.diagnosis.attempts).toBe(2);
		expect(harness.diagnosis.calls[1].sessionPath).toBe(`/sessions/${DEFECT_ID}.jsonl`);
	});
});

describe("normalization and bounded retry", () => {
	it("redacts allowlisted text and never serializes raw customer or action payloads", () => {
		const incident = normalizeIncident(
			"product-defect",
			{
				id: DEFECT_ID,
				status: "open",
				title: "api-secret at admin@example.com from 192.0.2.10 https://customer.example/case?token=bad",
				severity: "high",
				customer_payload: { token: "raw-customer-token", hostname: "customer-pc" },
				endpoint_action_command: "reboot --force",
			},
			["api-secret"],
		);
		expect(incident?.title).toBe("[REDACTED] at [REDACTED_EMAIL] from [REDACTED_IP] [REDACTED_URL]");
		expect(JSON.stringify(incident)).not.toContain("raw-customer-token");
		expect(JSON.stringify(incident)).not.toContain("reboot");
	});

	it("caps exponential backoff and applies bounded jitter", () => {
		expect(computeBackoffMs(1, 10_000, 60_000, () => 0)).toBe(5_000);
		expect(computeBackoffMs(3, 10_000, 60_000, () => 1)).toBe(40_000);
		expect(computeBackoffMs(10, 10_000, 60_000, () => 1)).toBe(60_000);
	});

	it("parses bounded production configuration without exposing credentials", () => {
		const env = {
			CLOUDCASTLE_INCIDENT_BASE_URL: "https://control.cloudcastle.example",
			CLOUDCASTLE_INCIDENT_TOKEN: "api-secret",
			CLOUDCASTLE_INCIDENT_DISCORD_TOKEN: "discord-secret",
			CLOUDCASTLE_INCIDENT_DEFECT_CHANNEL_ID: CHANNELS["product-defect"],
			CLOUDCASTLE_INCIDENT_ESCALATION_CHANNEL_ID: CHANNELS.escalation,
			CLOUDCASTLE_INCIDENT_POLL_MS: "5000",
		};
		const config = parseIncidentDispatcherConfig(env, "/srv/cloudcastle");
		expect(config.pollIntervalMs).toBe(5_000);
		expect(config.statePath).toBe("/srv/cloudcastle/.cloudcastle-incidents/state.json");
		expect(() =>
			parseIncidentDispatcherConfig({ ...env, CLOUDCASTLE_INCIDENT_BASE_URL: "http://control.cloudcastle.example" }),
		).toThrow("must use HTTPS");
		expect(() => parseIncidentDispatcherConfig({ ...env, CLOUDCASTLE_INCIDENT_POLL_MS: "4999" })).toThrow(
			"Invalid poll interval",
		);
	});
});
