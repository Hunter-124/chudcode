import { extractHttpStatusFromError } from "@chudware/utils";
import { isAccountPolicyError, isOAuthExpiry, isUsageLimit } from "./flags";
import { OAuthError } from "./oauth";
import { isConcurrencyCapExclusion, isUsageLimitOutcome } from "./rate-limit";

/**
 * Whether an OAuth refresh failure is definitive (the credential must be
 * disabled) versus transient. Thin alias over the {@link Flag.OAuthExpiry}
 * text classifier {@link isOAuthExpiry}; retained as the public
 * `@chudware/ai` entrypoint name used by the coding agent and auth-broker.
 */
export function isDefinitiveOAuthFailure(errorMsg: string): boolean {
	return isOAuthExpiry(errorMsg);
}

const INVALIDATED_OAUTH_TOKEN_PATTERN = /\binvalidated oauth token\b/i;
/**
 * Anthropic `403 permission_error` with `error_code: oauth_not_allowed_for_organization`:
 * the account's organization forbids OAuth (subscription) access. An org admin
 * policy, not a token or quota state — refresh and backoff never heal it.
 */
const OAUTH_NOT_ALLOWED_FOR_ORGANIZATION_PATTERN =
	/\boauth_not_allowed_for_organization\b|\bOAuth authentication is currently not allowed for this organization\b/i;

function authErrorMatches(error: unknown, pattern: RegExp): boolean {
	if (typeof error === "object" && error !== null && "errorMessage" in error) {
		const errorMessage =
			"errorClassificationMessage" in error ? error.errorClassificationMessage : error.errorMessage;
		if (typeof errorMessage === "string" && pattern.test(errorMessage)) return true;
	}
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
	return message !== undefined && pattern.test(message);
}

/** Whether an upstream response explicitly says the supplied OAuth bearer was invalidated. */
export function isInvalidatedOAuthTokenError(error: unknown): boolean {
	return authErrorMatches(error, INVALIDATED_OAUTH_TOKEN_PATTERN);
}

/** Whether upstream refused OAuth access for the credential's whole organization. */
export function isOAuthNotAllowedForOrganizationError(error: unknown): boolean {
	return authErrorMatches(error, OAUTH_NOT_ALLOWED_FOR_ORGANIZATION_PATTERN);
}

/**
 * Whether an upstream rejection permanently disqualifies the OAuth credential
 * that sent it (invalidated bearer, organization forbids OAuth). Such a
 * credential is disabled and leaves rotation instead of taking a timed block,
 * so concurrent sessions sharing the auth storage stop selecting it.
 */
export function isRevokedOAuthCredentialError(error: unknown): boolean {
	return isInvalidatedOAuthTokenError(error) || isOAuthNotAllowedForOrganizationError(error);
}

/**
 * Whether an upstream failure should retry through the credential resolver: a
 * typed token-refresh request, a hard `401`, a `403` (token valid but access
 * denied — plan, model policy, or org restriction a sibling account may not
 * share), an account-scoped policy denial such as Codex `cyber_policy`, a
 * body-classified usage limit (Codex `usage_limit_reached`, Anthropic account
 * rate-limit, Google `resource_exhausted`, OpenAI `insufficient_quota`, …), or
 * a bare `429` whose payload did not preserve a richer quota code. Transient
 * 429s (`Too many requests`, per-minute caps) stay in the upstream-backoff lane.
 */
export function isAuthRetryableError(error: unknown): boolean {
	if (error instanceof OAuthError && error.kind === "token-refresh") return true;
	if (isUsageLimit(error)) return true;
	if (isAccountPolicyError(error)) return true;
	if (isRevokedOAuthCredentialError(error)) return true;
	const httpStatus = extractHttpStatusFromError(error);
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
	const embeddedStatus = message ? extractHttpStatusFromError({ message }) : undefined;
	const status = httpStatus ?? embeddedStatus;
	if (isConcurrencyCapExclusion(status, message)) return false;
	if (status === 401 || status === 403) return true;
	return isUsageLimitOutcome(status, message);
}
