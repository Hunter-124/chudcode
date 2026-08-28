/**
 * Discord incoming-webhook egress for `cc-track` Lane A.
 *
 * Why a webhook client and not a bot: no Discord application exists and creating
 * one is blocked on a human challenge (`docs/19-development-tracking-bridge.md`
 * §3). Incoming webhooks need no application, no token, and no captcha, and a
 * webhook may edit its own past messages -- which is the entire reason the live
 * board and these session reports are deliverable today.
 *
 * Three invariants this module exists to hold:
 *
 * 1. A webhook URL is a bearer credential. It never reaches a log, a thrown
 *    error, or a CLI line except through `redactUrl`.
 * 2. Egress is pinned to `discord.com` over https before a request is made, the
 *    same fixed-host allowlist posture `archive.ts` applies to CDN downloads.
 *    A misconfigured URL must fail locally, not exfiltrate the credential.
 * 3. Every outbound body is screened through the same `SecretObfuscator` the
 *    archive exporter uses, so an agent session summary cannot carry a
 *    credential into a chat channel that four people and their clients can read.
 *
 * The webhook URL arrives via environment (§14 mirrors it into Actions secrets),
 * not via a file, so the owner-only secret-file guard in `archive.ts` is not on
 * this path; that guard protects the Lane-B bot token, which this module by
 * design never touches.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { buildSecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import type { JsonObject, JsonValue, SecretScreener } from "./archive";

/** The only host `cc-track` will ever POST to. Not a list: there is exactly one. */
export const ALLOWED_WEBHOOK_HOST = "discord.com";

const WEBHOOK_PATH = /^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/;
const REDACTABLE_URL = /^(https?:\/\/[^/?#]+\/api\/webhooks\/\d+\/)[^/?#]+(.*)$/;
const MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;

export interface WebhookPayload {
	content?: string;
	username?: string;
	embeds?: readonly JsonObject[];
	allowed_mentions?: JsonObject;
}

export interface NotifyDependencies {
	fetch: typeof globalThis.fetch;
	sleep: (milliseconds: number) => Promise<void>;
	/** `undefined` disables screening; only tests and dry runs should do that. */
	secretObfuscator: SecretScreener | undefined;
	maxAttempts: number;
}

export interface DeliveryResult {
	status: number;
	/** Present for `?wait=true` POSTs and every PATCH; `null` when Discord returned no body. */
	messageId: string | null;
	attempts: number;
	/** JSON paths whose value was replaced because it tripped the secret screener. */
	redactedPaths: readonly string[];
}

/** `status` is 0 for local failures: bad configuration, blocked host, transport error. */
export class WebhookError extends Error {
	readonly status: number;
	constructor(status: number, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "WebhookError";
		this.status = status;
	}
}

/**
 * Rewrite a webhook URL so the token segment cannot be read. Anything that is
 * not recognisably a webhook URL collapses entirely rather than being echoed:
 * an unparsed string may be a credential in some other shape.
 */
export function redactUrl(url: string): string {
	const match = REDACTABLE_URL.exec(url);
	return match ? `${match[1]}<redacted>${match[2]}` : "<redacted webhook url>";
}

/**
 * Fail closed before any network call. Rejects non-https, any host but
 * `discord.com`, embedded credentials, a non-default port, and anything whose
 * path is not `/api/webhooks/<id>/<token>`.
 */
export function assertWebhookUrl(url: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch (error) {
		throw new WebhookError(0, "webhook URL is not a valid URL", { cause: error });
	}
	if (parsed.protocol !== "https:") throw new WebhookError(0, "webhook URL must use https");
	if (parsed.hostname !== ALLOWED_WEBHOOK_HOST) {
		throw new WebhookError(0, `webhook URL host must be ${ALLOWED_WEBHOOK_HOST}, got ${parsed.hostname}`);
	}
	if (parsed.port !== "") throw new WebhookError(0, "webhook URL must not specify a port");
	if (parsed.username !== "" || parsed.password !== "") {
		throw new WebhookError(0, "webhook URL must not embed credentials");
	}
	if (!WEBHOOK_PATH.test(parsed.pathname)) {
		throw new WebhookError(0, "webhook URL path must be /api/webhooks/<id>/<token>");
	}
	return parsed;
}

/**
 * Read a webhook URL out of the environment and validate it. Separated from the
 * posting functions so a CLI can distinguish a configuration error (exit 1) from
 * a delivery failure (exit 2) without attempting the delivery.
 */
export function webhookUrlFromEnv(variable: string, env: Record<string, string | undefined> = process.env): string {
	const value = env[variable]?.trim();
	if (!value) throw new WebhookError(0, `${variable} is unset or empty`);
	assertWebhookUrl(value);
	return value;
}

export interface ScreenedValue<T> {
	value: T;
	/** JSON paths whose value was replaced, e.g. `$.embeds[0].fields[0].value`. */
	redactedPaths: string[];
}

/**
 * Replace any string that trips the obfuscator with a digest marker, matching
 * `archive.ts`'s all-or-nothing posture: a field holding a credential is not
 * partially published, it is withheld and fingerprinted so it stays traceable.
 *
 * Generic over the value because the same screening must cover both a webhook
 * body and the JSON session record, which is committed to a ledger and is
 * therefore the more permanent of the two leak paths.
 */
export function screenJson<T>(value: T, obfuscator: SecretScreener | undefined): ScreenedValue<T> {
	if (!obfuscator) return { value, redactedPaths: [] };
	const redactedPaths: string[] = [];
	const visit = (current: JsonValue, currentPath: string): JsonValue => {
		if (typeof current === "string") {
			if (obfuscator.obfuscate(current) === current) return current;
			redactedPaths.push(currentPath);
			return `[REDACTED sha256:${createHash("sha256").update(current).digest("hex")}]`;
		}
		if (Array.isArray(current)) return current.map((item, index) => visit(item, `${currentPath}[${index}]`));
		if (current !== null && typeof current === "object") {
			const result: JsonObject = {};
			for (const [key, value] of Object.entries(current)) result[key] = visit(value ?? null, `${currentPath}.${key}`);
			return result;
		}
		return current;
	};
	return { value: visit(value as unknown as JsonValue, "$") as unknown as T, redactedPaths };
}

export async function postWebhook(
	url: string,
	payload: WebhookPayload,
	dependencies?: Partial<NotifyDependencies>,
): Promise<DeliveryResult> {
	const target = assertWebhookUrl(url);
	// `wait=true` makes Discord return the created message, which is the only way
	// to learn its id -- and the id is what later lets a webhook edit in place.
	target.searchParams.set("wait", "true");
	return deliver("POST", target, url, payload, dependencies);
}

export async function editWebhookMessage(
	url: string,
	messageId: string,
	payload: WebhookPayload,
	dependencies?: Partial<NotifyDependencies>,
): Promise<DeliveryResult> {
	const target = assertWebhookUrl(url);
	if (!/^\d+$/.test(messageId)) throw new WebhookError(0, "message id must be a decimal snowflake string");
	target.pathname = `${target.pathname}/messages/${messageId}`;
	return deliver("PATCH", target, url, payload, dependencies);
}

let defaultObfuscator: Promise<SecretScreener | undefined> | undefined;

/**
 * The screener `deliver` uses, exposed so a caller can screen a record it also
 * writes to disk with exactly the same rules the wire path applies. Built once
 * per process: scanning the repo for secret material is not cheap.
 */
export async function resolveSecretObfuscator(
	dependencies?: Partial<NotifyDependencies>,
): Promise<SecretScreener | undefined> {
	if (Object.hasOwn(dependencies ?? {}, "secretObfuscator")) return dependencies?.secretObfuscator;
	defaultObfuscator ??= buildSecretObfuscator(
		path.resolve(import.meta.dir, "../../.."),
		process.env.OMP_AGENT_DIR ?? path.join(homedir(), ".omp", "agent"),
	);
	return defaultObfuscator;
}

function defaultSleep(milliseconds: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, milliseconds);
	return promise;
}

async function deliver(
	method: "POST" | "PATCH",
	target: URL,
	originalUrl: string,
	payload: WebhookPayload,
	dependencies: Partial<NotifyDependencies> | undefined,
): Promise<DeliveryResult> {
	const fetchImpl = dependencies?.fetch ?? globalThis.fetch;
	const sleep = dependencies?.sleep ?? defaultSleep;
	const maxAttempts = Math.max(1, dependencies?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
	const screened = screenJson(payload, await resolveSecretObfuscator(dependencies));
	const body = JSON.stringify(screened.value);
	const safeUrl = redactUrl(originalUrl);

	for (let attempt = 1; ; attempt++) {
		let response: Response;
		try {
			response = await fetchImpl(target, {
				method,
				headers: { "content-type": "application/json", "user-agent": "cc-track/1.0 (+cloudcastle)" },
				body,
			});
		} catch (error) {
			// The transport error may quote the full URL, so only its shape escapes.
			throw new WebhookError(0, `webhook ${method} to ${safeUrl} failed at the transport layer`, { cause: error });
		}
		const text = await response.text();
		if (response.ok) {
			return {
				status: response.status,
				messageId: messageIdOf(text),
				attempts: attempt,
				redactedPaths: screened.redactedPaths,
			};
		}
		const retryable = response.status === 429 || response.status >= 500;
		if (!retryable || attempt >= maxAttempts) {
			throw new WebhookError(response.status, `webhook ${method} to ${safeUrl} returned HTTP ${response.status}`);
		}
		await sleep(retryDelayMs(response, text, attempt));
	}
}

/**
 * Discord reports webhook rate limits as a float `retry_after` in seconds in the
 * JSON body, and as a `retry-after` header. Honour the body first: it is the
 * value Discord actually enforces per-bucket. Everything else backs off linearly.
 */
function retryDelayMs(response: Response, text: string, attempt: number): number {
	let seconds: number | undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		const candidate = (parsed as { retry_after?: unknown } | null)?.retry_after;
		if (typeof candidate === "number" && Number.isFinite(candidate)) seconds = candidate;
	} catch {
		seconds = undefined;
	}
	if (seconds === undefined) {
		const header = Number(response.headers.get("retry-after"));
		if (Number.isFinite(header) && header > 0) seconds = header;
	}
	const milliseconds = seconds === undefined ? 250 * attempt : seconds * 1000;
	return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, milliseconds));
}

function messageIdOf(text: string): string | null {
	if (text.trim() === "") return null;
	try {
		const parsed: unknown = JSON.parse(text);
		const id = (parsed as { id?: unknown } | null)?.id;
		return typeof id === "string" ? id : null;
	} catch {
		return null;
	}
}
