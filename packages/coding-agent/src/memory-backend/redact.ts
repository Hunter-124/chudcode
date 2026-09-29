/**
 * Credential redaction for text that memory backends persist and later inject
 * into prompts. A stored credential would otherwise reach every provider on
 * every later turn. Shared by the `local` and `sharpshooter` backends.
 */

const MEMORY_SECRET_PATTERNS: readonly RegExp[] = [
	/(?:sk|pk|rk|tok|key|secret|token|password)[-_A-Za-z0-9]{12,}/g,
	/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
	/(?:AKIA|ASIA)[A-Z0-9]{16}/g,
	// Common provider token prefixes (GitHub, npm, Slack, Google).
	/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
	/github_pat_[A-Za-z0-9_]{20,}/g,
	/npm_[A-Za-z0-9]{30,}/g,
	/xox[baprs]-[A-Za-z0-9-]{10,}/g,
	/AIza[A-Za-z0-9_-]{30,}/g,
];

/** Replace credential-shaped substrings with `[REDACTED]`. */
export function redactMemorySecrets(input: string): string {
	let out = input;
	for (const pattern of MEMORY_SECRET_PATTERNS) {
		out = out.replace(pattern, "[REDACTED]");
	}
	return out;
}
