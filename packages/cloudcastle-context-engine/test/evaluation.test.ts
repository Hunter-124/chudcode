import { describe, expect, it } from "bun:test";
import { evaluateIncidentContext } from "../src/evaluation";
import type { EvidenceCoverage, IncidentEvidence } from "../src/types";

const EVIDENCE: readonly IncidentEvidence[] = [
	{
		id: "relevant",
		className: "incident",
		classPriority: 100,
		evidencePriority: 100,
		relevance: 1,
		content: "relevant incident",
		sourceUrl: "https://control.example/v1/incidents/1",
		timestamp: "2026-08-27T12:00:00.000Z",
		entity: "incident:1",
		provenance: "control-api:incident",
	},
	{
		id: "noise",
		className: "timeline",
		classPriority: 80,
		evidencePriority: 20,
		relevance: 0,
		content: "unrelated event",
		sourceUrl: "https://control.example/v1/incidents/1/events",
		timestamp: "2026-08-27T11:00:00.000Z",
		entity: "incident-event:2",
		provenance: "control-api:timeline",
	},
];

const COVERAGE: readonly EvidenceCoverage[] = [
	{
		className: "incident",
		state: "Known",
		sourceUrl: "https://control.example/v1/incidents/1",
		timestamp: "2026-08-27T12:00:00.000Z",
		entity: "incident:1",
		provenance: "control-api:incident",
		itemCount: 1,
	},
	{
		className: "timeline",
		state: "Unknown",
		sourceUrl: "https://control.example/v1/incidents/1/events",
		timestamp: "2026-08-27T12:00:00.000Z",
		entity: "incident:1",
		provenance: "control-api:timeline",
		itemCount: 0,
	},
];

describe("incident context evaluation", () => {
	it("measures relevance, recall, provenance, and coverage without an evaluator model", () => {
		expect(evaluateIncidentContext(EVIDENCE, COVERAGE, ["relevant", "not-retrieved"])).toEqual({
			contextPrecision: 0.5,
			contextRecall: 0.5,
			provenanceCoverage: 1,
			knownCoverageRate: 0.5,
		});
	});
});
