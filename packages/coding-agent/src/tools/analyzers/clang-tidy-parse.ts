import type { AnalyzerFinding } from "./findings";

const CLANG_TIDY_LINE = /^(.*?):(\d+):(\d+):\s+(error|warning|note):\s+(.*?)\s+\[([^\]]+)\]\s*$/;

export function parseClangTidy(output: string): AnalyzerFinding[] {
	const findings: AnalyzerFinding[] = [];
	for (const line of output.split(/\r?\n/)) {
		const match = CLANG_TIDY_LINE.exec(line);
		if (!match) continue;
		findings.push({
			tool: "clang-tidy",
			rule: match[6]!,
			severity: match[4] as "error" | "warning" | "note",
			file: match[1]!,
			line: Number(match[2]),
			col: Number(match[3]),
			message: match[5]!,
		});
		if (findings.length >= 10_000) break;
	}
	return findings;
}
