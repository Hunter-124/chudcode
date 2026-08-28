import type { EvidenceCoverage, IncidentEvidence } from "./types";

export interface IncidentContextEvaluation {
	readonly contextPrecision: number;
	readonly contextRecall: number;
	readonly provenanceCoverage: number;
	readonly knownCoverageRate: number;
}

/** Deterministic package-local retrieval metrics; performs no model or network calls. */
export function evaluateIncidentContext(
	selectedEvidence: readonly IncidentEvidence[],
	coverage: readonly EvidenceCoverage[],
	relevantEvidenceIds: readonly string[],
): IncidentContextEvaluation {
	const relevant = new Set(relevantEvidenceIds);
	let selectedRelevant = 0;
	let fullyAttributed = 0;
	for (const item of selectedEvidence) {
		if (relevant.has(item.id)) selectedRelevant += 1;
		if (item.sourceUrl && item.timestamp && item.entity && item.provenance) fullyAttributed += 1;
	}
	const selectedIds = new Set(selectedEvidence.map(item => item.id));
	let retrievedRelevant = 0;
	for (const id of relevant) {
		if (selectedIds.has(id)) retrievedRelevant += 1;
	}
	const knownClasses = coverage.filter(item => item.state === "Known").length;
	return {
		contextPrecision: selectedEvidence.length === 0 ? 0 : selectedRelevant / selectedEvidence.length,
		contextRecall: relevant.size === 0 ? 1 : retrievedRelevant / relevant.size,
		provenanceCoverage: selectedEvidence.length === 0 ? 1 : fullyAttributed / selectedEvidence.length,
		knownCoverageRate: coverage.length === 0 ? 0 : knownClasses / coverage.length,
	};
}
