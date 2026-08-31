import { describe, expect, it } from "bun:test";
import { rankAndMergeEvidence } from "../src/ranking";
import type { IncidentEvidence } from "../src/types";

function evidence(
	id: string,
	className: string,
	classPriority: number,
	evidencePriority: number,
	content = id,
): IncidentEvidence {
	return {
		id,
		className,
		classPriority,
		evidencePriority,
		relevance: 0,
		content,
		sourceUrl: `https://control.example/${id}`,
		timestamp: "2026-08-27T12:00:00.000Z",
		entity: `incident:${id}`,
		provenance: `control-api:${className}`,
	};
}

describe("incident evidence ranking", () => {
	it("ranks within each evidence class before deterministic class-round merging", () => {
		const ranked = rankAndMergeEvidence(
			[
				evidence("timeline-low", "timeline", 80, 10),
				evidence("entity", "entity", 70, 90),
				evidence("incident", "incident", 100, 50),
				evidence("timeline-high", "timeline", 80, 90),
			],
			4_000,
		);
		expect(ranked.evidence.map(item => item.id)).toEqual(["incident", "timeline-high", "entity", "timeline-low"]);
	});

	it("uses stable ids to break equal-priority and equal-time ties", () => {
		const input = [evidence("z", "timeline", 80, 60), evidence("a", "timeline", 80, 60)];
		expect(rankAndMergeEvidence(input, 4_000).evidence.map(item => item.id)).toEqual(["a", "z"]);
		expect(rankAndMergeEvidence([...input].reverse(), 4_000).evidence.map(item => item.id)).toEqual(["a", "z"]);
	});

	it("priority-truncates the last admitted item without exceeding the token budget", () => {
		const ranked = rankAndMergeEvidence(
			[
				evidence("first", "incident", 100, 100, "A".repeat(300)),
				evidence("second", "timeline", 80, 80, "B".repeat(2_000)),
				evidence("third", "entity", 60, 60, "C".repeat(300)),
			],
			220,
		);
		expect(ranked.estimatedTokens).toBeLessThanOrEqual(220);
		expect(ranked.truncated).toBe(true);
		expect(ranked.evidence[0]?.id).toBe("first");
		expect(ranked.evidence.at(-1)?.content.endsWith("…")).toBe(true);
		expect(ranked.renderedEvidence.length).toBeLessThanOrEqual(880);
	});
});
