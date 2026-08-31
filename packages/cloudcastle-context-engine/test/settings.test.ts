import { describe, expect, it } from "bun:test";
import { findIncidentId, parseCloudCastleContextSettings } from "../src/settings";

const BASE_ENV = {
	CLOUDCASTLE_CONTEXT_BASE_URL: "https://control.cloudcastle.example",
	CLOUDCASTLE_CONTEXT_TOKEN: "service-token",
	CLOUDCASTLE_CONTEXT_INCIDENT_ID: "018f47e2-7b6a-7000-8000-123456789abc",
};

describe("CloudCastle context settings", () => {
	it("loads bounded read-only defaults", () => {
		const result = parseCloudCastleContextSettings(BASE_ENV);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.settings.tokenBudget).toBe(1_200);
		expect(result.settings.maxResponseBytes).toBe(131_072);
		expect(result.settings.endpoints.map(endpoint => endpoint.className)).toEqual(["incident", "timeline"]);
		expect(result.settings.endpoints.every(endpoint => endpoint.pathTemplate.includes("{incidentId}"))).toBe(true);
	});

	it("rejects missing credentials without including credential values in the error", () => {
		const result = parseCloudCastleContextSettings({
			CLOUDCASTLE_CONTEXT_BASE_URL: BASE_ENV.CLOUDCASTLE_CONTEXT_BASE_URL,
		});
		expect(result).toEqual({ ok: false, errorCode: "missing_token" });
	});

	it("rejects non-loopback plaintext origins and endpoint action paths", () => {
		expect(
			parseCloudCastleContextSettings({
				...BASE_ENV,
				CLOUDCASTLE_CONTEXT_BASE_URL: "http://control.cloudcastle.example",
			}),
		).toEqual({ ok: false, errorCode: "insecure_base_url" });
		expect(
			parseCloudCastleContextSettings({
				...BASE_ENV,
				CLOUDCASTLE_CONTEXT_ENDPOINTS: JSON.stringify([
					{
						className: "action",
						pathTemplate: "/v1/incidents/{incidentId}/close",
						entityKind: "incident",
						classPriority: 100,
						defaultEvidencePriority: 100,
						maxItems: 1,
					},
				]),
			}),
		).toEqual({ ok: false, errorCode: "invalid_endpoints" });
	});

	it("accepts loopback development APIs and extracts a UUID from a prompt", () => {
		const result = parseCloudCastleContextSettings({
			...BASE_ENV,
			CLOUDCASTLE_CONTEXT_BASE_URL: "http://127.0.0.1:8080",
			CLOUDCASTLE_CONTEXT_INCIDENT_ID: undefined,
		});
		expect(result.ok).toBe(true);
		expect(findIncidentId("Investigate 018F47E2-7B6A-7000-8000-123456789ABC now")).toBe(
			"018f47e2-7b6a-7000-8000-123456789abc",
		);
	});

	it("rejects limits outside the schema caps", () => {
		expect(parseCloudCastleContextSettings({ ...BASE_ENV, CLOUDCASTLE_CONTEXT_TOKEN_BUDGET: "4001" })).toEqual({
			ok: false,
			errorCode: "invalid_limits",
		});
	});
});
