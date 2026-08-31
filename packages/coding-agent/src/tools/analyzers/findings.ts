export type FindingSeverity = "error" | "warning" | "note";

export interface AnalyzerFinding {
	tool: string;
	rule: string;
	severity: FindingSeverity;
	file: string;
	line: number;
	col?: number;
	message: string;
}

export function capFindings(
	findings: AnalyzerFinding[],
	requested?: number,
): {
	findings: AnalyzerFinding[];
	total_findings: number;
	truncated: boolean;
	counts_by_rule: Record<string, number>;
} {
	const limit = Math.max(1, Math.min(500, Math.trunc(requested ?? 50)));
	const counts: Record<string, number> = {};
	for (const finding of findings) counts[finding.rule] = (counts[finding.rule] ?? 0) + 1;
	return {
		findings: findings.slice(0, limit),
		total_findings: findings.length,
		truncated: findings.length > limit,
		counts_by_rule: counts,
	};
}

export function normalizeSeverity(value: unknown): FindingSeverity {
	const severity = String(value ?? "").toLowerCase();
	if (severity === "error" || severity === "fatal" || severity === "critical" || severity === "high") return "error";
	if (severity === "warning" || severity === "warn" || severity === "medium") return "warning";
	return "note";
}
