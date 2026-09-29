import { fileURLToPath } from "node:url";
import { type AnalyzerFinding, normalizeSeverity } from "./findings";

function field(value: unknown, key: string): unknown {
	return value !== null && typeof value === "object" && key in value ? Reflect.get(value, key) : undefined;
}

function nested(value: unknown, ...keys: string[]): unknown {
	let current = value;
	for (const key of keys) current = field(current, key);
	return current;
}

function locationFile(uri: unknown): string {
	if (typeof uri !== "string" || uri.length === 0) return "<unknown>";
	if (uri.startsWith("file://")) {
		try {
			return fileURLToPath(uri);
		} catch {
			return uri;
		}
	}
	try {
		return decodeURIComponent(uri);
	} catch {
		return uri;
	}
}

export function parseSarif(input: string | unknown, fallbackTool = "sarif"): AnalyzerFinding[] {
	let document: unknown;
	try {
		document = typeof input === "string" ? JSON.parse(input) : input;
	} catch {
		return [];
	}
	const runs = field(document, "runs");
	if (!Array.isArray(runs)) return [];
	const findings: AnalyzerFinding[] = [];
	for (const run of runs) {
		const tool = String(nested(run, "tool", "driver", "name") ?? fallbackTool);
		const results = field(run, "results");
		if (!Array.isArray(results)) continue;
		for (const result of results) {
			const locations = field(result, "locations");
			const location = Array.isArray(locations) ? locations[0] : undefined;
			const messageValue =
				nested(result, "message", "text") ?? nested(result, "message", "markdown") ?? field(result, "message");
			const startColumn = Number(nested(location, "physicalLocation", "region", "startColumn"));
			findings.push({
				tool,
				rule: String(field(result, "ruleId") ?? nested(result, "rule", "id") ?? "unknown"),
				severity: normalizeSeverity(field(result, "level") ?? nested(result, "properties", "severity")),
				file: locationFile(nested(location, "physicalLocation", "artifactLocation", "uri")),
				line: Math.max(1, Number(nested(location, "physicalLocation", "region", "startLine")) || 1),
				...(startColumn > 0 ? { col: Math.max(1, startColumn) } : {}),
				message: typeof messageValue === "string" ? messageValue : JSON.stringify(messageValue ?? "SARIF finding"),
			});
			if (findings.length >= 10_000) return findings;
		}
	}
	return findings;
}
