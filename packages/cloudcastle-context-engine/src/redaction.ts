import { isUnknownRecord } from "./guards";

const SENSITIVE_KEY_PATTERN = /authorization|cookie|csrf|pass(?:word|wd)|secret|token|api[-_]?key|private[-_]?key|credential/i;
const SENSITIVE_QUERY_PATTERN = /access[-_]?token|api[-_]?key|authorization|auth|code|cookie|key|password|secret|signature|token/i;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const AUTH_PATTERN = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]{8,}=*/gi;
const PEM_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const ASSIGNMENT_SECRET_PATTERN = /\b(api[-_]?key|access[-_]?token|client[-_]?secret|password)\s*[:=]\s*[^\s,;]+/gi;
const MAX_STRING_CHARS = 1_200;
const MAX_KEYS = 64;
const MAX_DEPTH = 8;

export function redactText(text: string, explicitSecrets: readonly string[] = []): string {
	let redacted = text;
	for (const secret of explicitSecrets) {
		if (secret) redacted = redacted.split(secret).join("[REDACTED]");
	}
	redacted = redacted
		.replace(PEM_PATTERN, "[REDACTED_PRIVATE_KEY]")
		.replace(JWT_PATTERN, "[REDACTED_JWT]")
		.replace(AUTH_PATTERN, "[REDACTED_AUTH]")
		.replace(ASSIGNMENT_SECRET_PATTERN, "$1=[REDACTED]");
	return redacted.length > MAX_STRING_CHARS ? `${redacted.slice(0, MAX_STRING_CHARS - 1)}…` : redacted;
}

export function redactUntrustedValue(value: unknown, explicitSecrets: readonly string[] = []): unknown {
	return redactAtDepth(value, explicitSecrets, 0);
}

export function sanitizeSourceUrl(url: URL): string {
	const safe = new URL(url);
	safe.username = "";
	safe.password = "";
	safe.hash = "";
	for (const key of safe.searchParams.keys()) {
		if (SENSITIVE_QUERY_PATTERN.test(key)) safe.searchParams.set(key, "[REDACTED]");
	}
	return safe.toString();
}

function redactAtDepth(value: unknown, explicitSecrets: readonly string[], depth: number): unknown {
	if (depth >= MAX_DEPTH) return "[TRUNCATED_DEPTH]";
	if (typeof value === "string") return redactText(value, explicitSecrets);
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
	if (typeof value === "boolean" || value === null) return value;
	if (Array.isArray(value)) {
		return value.slice(0, MAX_KEYS).map(item => redactAtDepth(item, explicitSecrets, depth + 1));
	}
	if (!isUnknownRecord(value)) return String(value);

	const output: Record<string, unknown> = {};
	const keys = Object.keys(value).sort().slice(0, MAX_KEYS);
	for (const key of keys) {
		output[key] = SENSITIVE_KEY_PATTERN.test(key)
			? "[REDACTED]"
			: redactAtDepth(value[key], explicitSecrets, depth + 1);
	}
	if (Object.keys(value).length > MAX_KEYS) output._truncated_keys = true;
	return output;
}
