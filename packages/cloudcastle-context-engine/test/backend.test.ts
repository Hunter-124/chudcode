import { describe, expect, it } from "bun:test";
import type { AgentSession, Settings } from "@oh-my-pi/pi-coding-agent";
import { createCloudCastleIncidentBackend } from "../src/backend";
import { fetchIncidentContext } from "../src/client";
import { parseCloudCastleContextSettings } from "../src/settings";

const INCIDENT_ID = "018f47e2-7b6a-7000-8000-123456789abc";
const TOKEN = "service-token-that-must-not-leak";
const ENV = {
	CLOUDCASTLE_CONTEXT_BASE_URL: "https://control.cloudcastle.example",
	CLOUDCASTLE_CONTEXT_TOKEN: TOKEN,
	CLOUDCASTLE_CONTEXT_INCIDENT_ID: INCIDENT_ID,
};
const NOW = new Date("2026-08-27T12:00:00.000Z");

function settings() {
	const parsed = parseCloudCastleContextSettings(ENV);
	if (!parsed.ok) throw new Error(parsed.errorCode);
	return parsed.settings;
}

describe("CloudCastle incident retrieval", () => {
	it("preserves provenance and Unknown coverage while redacting payload secrets", async () => {
		let requestedMethod: string | undefined;
		let authorization: string | null = null;
		const fetchFn: typeof fetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				requestedMethod = init?.method;
				authorization = new Headers(init?.headers).get("authorization");
				const url = new URL(input instanceof Request ? input.url : input);
				if (url.pathname.endsWith("/events")) return new Response(null, { status: 404 });
				return Response.json({
					id: INCIDENT_ID,
					severity: "critical",
					created_at: "2026-08-27T11:00:00Z",
					device_id: "device-7",
					provenance: "rmm-incident-store",
					access_token: TOKEN,
					note: `Authorization: Bearer ${TOKEN}`,
					clientSecret: "second-secret-value",
				});
			},
			{ preconnect() {} },
		);
		const result = await fetchIncidentContext(settings(), `inspect ${INCIDENT_ID}`, {
			fetch: fetchFn,
			now: () => NOW,
		});
		expect(requestedMethod).toBe("GET");
		expect(authorization as string | null).toBe(`Bearer ${TOKEN}`);
		expect(result.failedClosed).toBe(false);
		expect(result.evidence).toHaveLength(1);
		expect(result.evidence[0]).toMatchObject({
			entity: "incident:device-7",
			provenance: "rmm-incident-store",
			timestamp: "2026-08-27T11:00:00.000Z",
			sourceUrl: `https://control.cloudcastle.example/v1/incidents/${INCIDENT_ID}`,
		});
		expect(result.evidence[0]?.content).not.toContain(TOKEN);
		expect(result.evidence[0]?.content).not.toContain("second-secret-value");
		expect(result.evidence[0]?.content).toContain("[REDACTED]");
		expect(result.coverage.map(item => item.state)).toEqual(["Known", "Unknown"]);
	});

	it("fails closed across all classes when any endpoint rejects authentication", async () => {
		const fetchFn: typeof fetch = Object.assign(
			async (input: string | URL | Request) => {
				const url = new URL(input instanceof Request ? input.url : input);
				return url.pathname.endsWith("/events")
					? new Response(null, { status: 401 })
					: Response.json({ id: INCIDENT_ID, title: "real but unusable after partial failure" });
			},
			{ preconnect() {} },
		);
		const result = await fetchIncidentContext(settings(), INCIDENT_ID, {
			fetch: fetchFn,
			now: () => NOW,
		});
		expect(result.failedClosed).toBe(true);
		expect(result.errorCode).toBe("auth");
		expect(result.evidence).toEqual([]);
		expect(result.coverage.map(item => item.state)).toEqual(["Known", "Error"]);
	});

	it("classifies oversized and network responses without manufacturing context", async () => {
		const oversizedFetch: typeof fetch = Object.assign(
			async () => new Response("{}", { headers: { "content-length": "999999" } }),
			{ preconnect() {} },
		);
		const oversized = await fetchIncidentContext(settings(), INCIDENT_ID, {
			fetch: oversizedFetch,
			now: () => NOW,
		});
		expect(oversized.failedClosed).toBe(true);
		expect(oversized.errorCode).toBe("response_too_large");
		expect(oversized.evidence).toEqual([]);

		const networkFetch: typeof fetch = Object.assign(
			async () => {
				throw new TypeError("socket included a secret that must never be surfaced");
			},
			{ preconnect() {} },
		);
		const network = await fetchIncidentContext(settings(), INCIDENT_ID, {
			fetch: networkFetch,
			now: () => NOW,
		});
		expect(network.failedClosed).toBe(true);
		expect(network.errorCode).toBe("network");
		expect(JSON.stringify(network)).not.toContain("socket included");
	});
});

describe("cloudcastle-incident MemoryBackend", () => {
	it("injects one compact developer block and caches no failed context", async () => {
		let rejectAuth = false;
		let promptRefreshes = 0;
		const fetchFn: typeof fetch = Object.assign(
			async (input: string | URL | Request) => {
				if (rejectAuth) return new Response(null, { status: 401 });
				const url = new URL(input instanceof Request ? input.url : input);
				if (url.pathname.endsWith("/events")) return new Response(null, { status: 404 });
				return Response.json({ id: INCIDENT_ID, severity: "high", title: "Endpoint offline" });
			},
			{ preconnect() {} },
		);
		const backend = createCloudCastleIncidentBackend(ENV, { fetch: fetchFn, now: () => NOW });
		const session = {
			async refreshBaseSystemPrompt() {
				promptRefreshes += 1;
			},
		} as unknown as AgentSession;
		const prepared = await backend.beforeAgentStartPrompt?.(session, `Investigate ${INCIDENT_ID}`);
		const block = prepared?.context;
		expect(block?.match(/<cloudcastle-incident-context>/g)).toHaveLength(1);
		expect(block).toContain('"state":"Unknown"');
		expect(block).toContain("control-api:incident");
		expect(block).toContain(`https://control.cloudcastle.example/v1/incidents/${INCIDENT_ID}`);
		expect(block).not.toContain(TOKEN);
		const unusedSettings = {} as Settings;
		expect(await backend.buildDeveloperInstructions("", unusedSettings, session)).toBeUndefined();
		expect(prepared?.commit()).toBe(true);
		expect(await backend.buildDeveloperInstructions("", unusedSettings, session)).toBe(block);
		rejectAuth = true;
		const authFailureBlock = await backend.beforeAgentStartPrompt?.(session, `Investigate ${INCIDENT_ID}`);
		expect(authFailureBlock).toBeUndefined();
		expect(promptRefreshes).toBe(1);

		let calls = 0;
		const invalidBackend = createCloudCastleIncidentBackend(
			{ CLOUDCASTLE_CONTEXT_BASE_URL: "https://control.cloudcastle.example" },
			{
				fetch: Object.assign(
					async () => {
						calls += 1;
						return Response.json({ fabricated: true });
					},
					{ preconnect() {} },
				),
				now: () => NOW,
			},
		);
		const failedBlock = await invalidBackend.beforeAgentStartPrompt?.(session, INCIDENT_ID);
		expect(failedBlock).toBeUndefined();
		expect(calls).toBe(0);
	});
});
