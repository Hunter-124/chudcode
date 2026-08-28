/** Canonical boundary guard for untrusted JSON values in this standalone package. */
export function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
