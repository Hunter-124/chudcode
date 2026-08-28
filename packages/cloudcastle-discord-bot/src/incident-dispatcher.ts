import { createHash, randomUUID } from "node:crypto";
import { type FileHandle, open, mkdir, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { REST, Routes } from "discord.js";
import { redactText } from "@cloudcastle/context-engine";
import { isUnknownRecord } from "./incident-guards";

export type IncidentSource = "product-defect" | "escalation";
export type IncidentLifecycle = "create" | "update" | "resolved";

const INCIDENT_SOURCES: readonly IncidentSource[] = ["product-defect", "escalation"];
const TERMINAL_STATUSES: Readonly<Record<string, true>> = {
	auto_resolved: true,
	cancelled: true,
	closed: true,
	completed: true,
	dismissed: true,
	fixed: true,
	resolved: true,
};
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6_PATTERN = /\b(?:[A-F0-9]{1,4}:){2,7}[A-F0-9]{0,4}\b/gi;
const MAC_PATTERN = /\b(?:[A-F0-9]{2}[:-]){5}[A-F0-9]{2}\b/gi;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>]+/gi;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_ENUM_PATTERN = /^[a-z0-9][a-z0-9._ -]{0,47}$/;
const MAX_API_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const STATE_VERSION = 1;

export interface NormalizedIncident {
	readonly source: IncidentSource;
	readonly id: string;
	readonly status: string;
	readonly terminal: boolean;
	readonly title: string;
	readonly category?: string;
	readonly severity: "critical" | "high" | "medium" | "low" | "info" | "unknown";
	readonly priority: number;
	readonly createdAt?: string;
	readonly updatedAt?: string;
}

interface PendingLifecycle {
	kind: IncidentLifecycle;
	fingerprint: string;
	nonce: string;
	incident: NormalizedIncident;
}

export interface IncidentState {
	latest: NormalizedIncident;
	latestFingerprint: string;
	missedPolls: number;
	pending?: PendingLifecycle;
	deliveredFingerprint?: string;
	deliveredLifecycle?: IncidentLifecycle;
	deliveredIncident?: NormalizedIncident;
	discordMessageId?: string;
	diagnosisFingerprint?: string;
	diagnosisSessionPath?: string;
	lastObservedAt: string;
	resolvedAt?: string;
}

export interface DispatcherState {
	version: 1;
	incidents: Record<string, IncidentState>;
}

export interface IncidentApi {
	fetch(source: IncidentSource): Promise<readonly unknown[]>;
}

export interface DiscordPublisher {
	post(channelId: string, content: string, nonce: string): Promise<{ readonly messageId: string }>;
}

export interface DiagnosisRequest {
	readonly incident: NormalizedIncident;
	readonly fingerprint: string;
	readonly sessionPath?: string;
	readonly registerSession: (sessionPath: string) => Promise<void>;
}

export interface DiagnosisRunner {
	diagnose(request: DiagnosisRequest): Promise<void>;
}

export interface DispatcherStateStore {
	load(): Promise<DispatcherState>;
	save(state: DispatcherState): Promise<void>;
}

export interface IncidentDispatcherOptions {
	readonly api: IncidentApi;
	readonly discord: DiscordPublisher;
	readonly diagnosis: DiagnosisRunner;
	readonly stateStore: DispatcherStateStore;
	readonly channels: Readonly<Record<IncidentSource, string>>;
	readonly explicitSecrets?: readonly string[];
	readonly missingPollThreshold?: number;
	readonly now?: () => Date;
}

export interface PollLoopOptions {
	readonly pollIntervalMs: number;
	readonly maxBackoffMs: number;
	readonly random?: () => number;
	readonly signal?: AbortSignal;
	readonly once?: boolean;
	readonly onError?: (message: string) => void;
}

export interface CloudCastleApiOptions {
	readonly baseUrl: URL;
	readonly bearerToken: string;
	readonly orgId?: string;
	readonly requestTimeoutMs: number;
	readonly maxResponseBytes?: number;
	readonly fetch?: typeof globalThis.fetch;
}

export interface IncidentDispatcherConfig {
	readonly apiBaseUrl: URL;
	readonly apiToken: string;
	readonly orgId?: string;
	readonly discordToken: string;
	readonly channels: Readonly<Record<IncidentSource, string>>;
	readonly statePath: string;
	readonly diagnosisCwd: string;
	readonly pollIntervalMs: number;
	readonly maxBackoffMs: number;
	readonly requestTimeoutMs: number;
	readonly diagnosisTimeoutMs: number;
	readonly missingPollThreshold: number;
}

export class CloudCastleIncidentApi implements IncidentApi {
	readonly #baseUrl: URL;
	readonly #token: string;
	readonly #orgId?: string;
	readonly #timeoutMs: number;
	readonly #maxResponseBytes: number;
	readonly #fetch: typeof globalThis.fetch;

	constructor(options: CloudCastleApiOptions) {
		this.#baseUrl = new URL(options.baseUrl);
		this.#token = options.bearerToken;
		this.#orgId = options.orgId;
		this.#timeoutMs = options.requestTimeoutMs;
		this.#maxResponseBytes = options.maxResponseBytes ?? MAX_API_RESPONSE_BYTES;
		this.#fetch = options.fetch ?? globalThis.fetch;
	}

	async fetch(source: IncidentSource): Promise<readonly unknown[]> {
		const route = source === "product-defect" ? "/v1/product-defects" : "/v1/escalations";
		const url = new URL(route, this.#baseUrl);
		const headers = new Headers({
			accept: "application/json",
			authorization: `Bearer ${this.#token}`,
		});
		if (this.#orgId) headers.set("x-org-id", this.#orgId);
		const response = await this.#fetch(url, {
			method: "GET",
			headers,
			redirect: "error",
			signal: AbortSignal.timeout(this.#timeoutMs),
		});
		if (!response.ok) throw new Error(`CloudCastle ${source} read failed with HTTP ${response.status}`);
		const payload = await readBoundedJson(response, this.#maxResponseBytes);
		return extractRecords(payload, source);
	}
}

export class DiscordRestPublisher implements DiscordPublisher {
	readonly #rest: REST;

	constructor(token: string, rest: REST = new REST({ version: "10" })) {
		this.#rest = rest.setToken(token);
	}

	async post(channelId: string, content: string, nonce: string): Promise<{ readonly messageId: string }> {
		const result = (await this.#rest.post(Routes.channelMessages(channelId), {
			body: {
				content,
				allowed_mentions: { parse: [] },
				nonce,
				enforce_nonce: true,
			},
		})) as { id?: unknown };
		if (typeof result.id !== "string" || !result.id) throw new Error("Discord did not return a message id");
		return { messageId: result.id };
	}
}

export class AtomicFileStateStore implements DispatcherStateStore {
	readonly #statePath: string;

	constructor(statePath: string) {
		this.#statePath = path.resolve(statePath);
	}

	async load(): Promise<DispatcherState> {
		let bytes: Buffer;
		try {
			bytes = await readFile(this.#statePath);
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return emptyState();
			throw error;
		}
		if (bytes.byteLength > MAX_STATE_BYTES) throw new Error("Incident dispatcher state exceeds the size limit");
		let parsed: unknown;
		try {
			parsed = JSON.parse(bytes.toString("utf8"));
		} catch {
			throw new Error("Incident dispatcher state is not valid JSON");
		}
		if (!isDispatcherState(parsed)) throw new Error("Incident dispatcher state has an unsupported schema");
		return parsed;
	}

	async save(state: DispatcherState): Promise<void> {
		const directory = path.dirname(this.#statePath);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const temporary = `${this.#statePath}.${process.pid}.${randomUUID()}.tmp`;
		const payload = `${JSON.stringify(state)}\n`;
		if (Buffer.byteLength(payload) > MAX_STATE_BYTES) throw new Error("Incident dispatcher state exceeds the size limit");
		let handle: FileHandle | undefined;
		try {
			handle = await open(temporary, "wx", 0o600);
			await handle.writeFile(payload, "utf8");
			await handle.sync();
			await handle.close();
			handle = undefined;
			await rename(temporary, this.#statePath);
			const directoryHandle = await open(directory, "r");
			try {
				await directoryHandle.sync();
			} finally {
				await directoryHandle.close();
			}
		} catch (error) {
			await handle?.close().catch(() => undefined);
			await unlink(temporary).catch(() => undefined);
			throw error;
		}
	}
}

export class IncidentDispatcher {
	readonly #api: IncidentApi;
	readonly #discord: DiscordPublisher;
	readonly #diagnosis: DiagnosisRunner;
	readonly #store: DispatcherStateStore;
	readonly #channels: Readonly<Record<IncidentSource, string>>;
	readonly #secrets: readonly string[];
	readonly #missingPollThreshold: number;
	readonly #now: () => Date;
	#state?: DispatcherState;

	constructor(options: IncidentDispatcherOptions) {
		this.#api = options.api;
		this.#discord = options.discord;
		this.#diagnosis = options.diagnosis;
		this.#store = options.stateStore;
		this.#channels = options.channels;
		this.#secrets = options.explicitSecrets ?? [];
		this.#missingPollThreshold = Math.max(1, Math.floor(options.missingPollThreshold ?? 2));
		this.#now = options.now ?? (() => new Date());
	}

	async pollOnce(): Promise<void> {
		const state = await this.#getState();
		const observedAt = this.#now().toISOString();
		const results = await Promise.allSettled(INCIDENT_SOURCES.map(source => this.#api.fetch(source)));
		const failures: Error[] = [];
		let stateChanged = false;

		for (let index = 0; index < INCIDENT_SOURCES.length; index += 1) {
			const source = INCIDENT_SOURCES[index];
			const result = results[index];
			if (result.status === "rejected") {
				failures.push(asSafeError(result.reason, this.#secrets, `${source} API read failed`));
				continue;
			}
			const normalized = canonicalizeIncidents(
				result.value.map(value => normalizeIncident(source, value, this.#secrets)).filter(isNormalizedIncident),
			);
			stateChanged = this.#reconcileSource(state, source, normalized, observedAt) || stateChanged;
		}

		if (stateChanged) await this.#store.save(state);

		const ordered = Object.values(state.incidents).sort((left, right) => compareIncidents(left.pending?.incident ?? left.latest, right.pending?.incident ?? right.latest));
		for (const incidentState of ordered) {
			if (incidentState.pending) {
				try {
					const pending = incidentState.pending;
					const posted = await this.#discord.post(
						this.#channels[pending.incident.source],
						formatLifecycleMessage(pending.kind, pending.incident),
						pending.nonce,
					);
					incidentState.deliveredFingerprint = pending.fingerprint;
					incidentState.deliveredLifecycle = pending.kind;
					incidentState.deliveredIncident = pending.incident;
					incidentState.discordMessageId = posted.messageId;
					incidentState.pending = undefined;
					await this.#store.save(state);
				} catch (error) {
					failures.push(asSafeError(error, this.#secrets, "Discord lifecycle post failed"));
					continue;
				}
			}

		}

		for (const incidentState of ordered) {
			if (
				incidentState.deliveredLifecycle !== "resolved" &&
				incidentState.deliveredIncident &&
				incidentState.deliveredFingerprint &&
				incidentState.diagnosisFingerprint !== incidentState.deliveredFingerprint
			) {
				const fingerprint = incidentState.deliveredFingerprint;
				try {
					await this.#diagnosis.diagnose({
						incident: incidentState.deliveredIncident,
						fingerprint,
						sessionPath: incidentState.diagnosisSessionPath,
						registerSession: async sessionPath => {
							incidentState.diagnosisSessionPath = sessionPath;
							await this.#store.save(state);
						},
					});
					incidentState.diagnosisFingerprint = fingerprint;
					await this.#store.save(state);
				} catch (error) {
					failures.push(asSafeError(error, this.#secrets, "Chudcode diagnosis failed"));
				}
			}
		}

		if (failures.length > 0) throw new AggregateError(failures, failures.map(error => error.message).join("; "));
	}

	async run(options: PollLoopOptions): Promise<void> {
		const random = options.random ?? Math.random;
		let consecutiveFailures = 0;
		while (!options.signal?.aborted) {
			try {
				await this.pollOnce();
				consecutiveFailures = 0;
				if (options.once) return;
				await sleep(options.pollIntervalMs, options.signal);
			} catch (error) {
				consecutiveFailures += 1;
				const safe = asSafeError(error, this.#secrets, "Incident dispatcher poll failed");
				options.onError?.(safe.message);
				if (options.once) throw safe;
				await sleep(computeBackoffMs(consecutiveFailures, options.pollIntervalMs, options.maxBackoffMs, random), options.signal);
			}
		}
	}

	async #getState(): Promise<DispatcherState> {
		this.#state ??= await this.#store.load();
		return this.#state;
	}

	#reconcileSource(
		state: DispatcherState,
		source: IncidentSource,
		observed: readonly NormalizedIncident[],
		observedAt: string,
	): boolean {
		let changed = false;
		const seenKeys = new Set<string>();
		for (const incident of observed) {
			const key = incidentKey(incident);
			seenKeys.add(key);
			const fingerprint = fingerprintIncident(incident);
			let current = state.incidents[key];
			if (!current) {
				current = {
					latest: incident,
					latestFingerprint: fingerprint,
					missedPolls: 0,
					lastObservedAt: observedAt,
					...(incident.terminal
						? {
								deliveredFingerprint: fingerprint,
								deliveredLifecycle: "resolved" as const,
								deliveredIncident: incident,
								resolvedAt: observedAt,
							}
						: {}),
				};
				state.incidents[key] = current;
				changed = true;
			} else if (
				current.latestFingerprint !== fingerprint ||
				current.missedPolls !== 0 ||
				current.lastObservedAt !== observedAt
			) {
				current.latest = incident;
				current.latestFingerprint = fingerprint;
				current.missedPolls = 0;
				current.lastObservedAt = observedAt;
				changed = true;
			}
			changed = queueLifecycle(current) || changed;
		}

		for (const [key, current] of Object.entries(state.incidents)) {
			if (current.latest.source !== source || seenKeys.has(key) || current.deliveredLifecycle === "resolved") continue;
			current.missedPolls += 1;
			current.lastObservedAt = observedAt;
			changed = true;
			if (current.missedPolls < this.#missingPollThreshold) continue;
			const resolved: NormalizedIncident = { ...current.latest, status: "resolved", terminal: true, updatedAt: observedAt };
			current.latest = resolved;
			current.latestFingerprint = fingerprintIncident(resolved);
			current.resolvedAt = observedAt;
			changed = queueLifecycle(current) || changed;
		}
		return changed;
	}
}

export function normalizeIncident(
	source: IncidentSource,
	value: unknown,
	explicitSecrets: readonly string[] = [],
): NormalizedIncident | undefined {
	if (!isUnknownRecord(value)) return undefined;
	const rawId = firstScalar(value, ["id", "defect_id", "escalation_id", "work_order_id"]);
	if (!rawId) return undefined;
	const id = safeIncidentId(rawId);
	const status = safeEnum(firstScalar(value, ["status", "state", "resolution_status"]) ?? "open", "open");
	const severity = normalizeSeverity(firstScalar(value, ["severity", "impact", "risk"]));
	const priority = normalizePriority(firstScalar(value, ["priority", "tier", "urgency"]), severity);
	const category = safeOptionalEnum(firstScalar(value, ["category", "kind", "defect_kind", "reason_code"]));
	const titleCandidate = firstScalar(value, ["title", "name", "summary", "kind", "escalate_reason"]);
	const title = redactOperationalText(titleCandidate ?? defaultTitle(source), explicitSecrets, 240);
	const createdAt = normalizeTimestamp(firstScalar(value, ["created_at", "createdAt", "opened_at"]));
	const updatedAt = normalizeTimestamp(
		firstScalar(value, ["updated_at", "updatedAt", "last_seen_at", "fixed_at", "resolved_at"]),
	);
	return {
		source,
		id,
		status,
		terminal: TERMINAL_STATUSES[status] === true,
		title,
		...(category ? { category } : {}),
		severity,
		priority,
		...(createdAt ? { createdAt } : {}),
		...(updatedAt ? { updatedAt } : {}),
	};
}

export function compareIncidents(left: NormalizedIncident, right: NormalizedIncident): number {
	return (
		Number(left.terminal) - Number(right.terminal) ||
		left.priority - right.priority ||
		severityRank(right.severity) - severityRank(left.severity) ||
		compareStrings(left.createdAt ?? "", right.createdAt ?? "") ||
		compareStrings(left.source, right.source) ||
		compareStrings(left.id, right.id)
	);
}

export function fingerprintIncident(incident: NormalizedIncident): string {
	const material = [
		incident.source,
		incident.id,
		incident.status,
		incident.terminal ? "terminal" : "open",
		incident.title,
		incident.category ?? "",
		incident.severity,
		String(incident.priority),
	].join("\u0000");
	return createHash("sha256").update(material).digest("hex");
}

export function computeBackoffMs(
	consecutiveFailures: number,
	pollIntervalMs: number,
	maxBackoffMs: number,
	random: () => number = Math.random,
): number {
	const exponent = Math.max(0, Math.min(20, Math.floor(consecutiveFailures) - 1));
	const ceiling = Math.min(maxBackoffMs, pollIntervalMs * 2 ** exponent);
	const jitter = 0.5 + Math.max(0, Math.min(1, random())) * 0.5;
	return Math.max(1, Math.floor(ceiling * jitter));
}

export function formatLifecycleMessage(lifecycle: IncidentLifecycle, incident: NormalizedIncident): string {
	const source = incident.source === "product-defect" ? "Product defect" : "Escalation";
	const heading = lifecycle === "create" ? "created" : lifecycle === "update" ? "updated" : "resolved";
	const lines = [
		`**[P${incident.priority} · ${incident.severity.toUpperCase()}] ${source} ${heading}**`,
		`Reference: \`${escapeInlineCode(incident.id)}\``,
		`Title: ${escapeDiscordText(incident.title)}`,
		`Status: ${escapeDiscordText(incident.status)}`,
	];
	if (incident.category) lines.push(`Category: ${escapeDiscordText(incident.category)}`);
	if (incident.createdAt) lines.push(`Opened: ${incident.createdAt}`);
	return lines.join("\n").slice(0, 1_900);
}

export function parseIncidentDispatcherConfig(
	env: Readonly<Record<string, string | undefined>>,
	cwd: string = process.cwd(),
): IncidentDispatcherConfig {
	const apiBaseUrl = parseSecureUrl(requireEnv(env, "CLOUDCASTLE_INCIDENT_BASE_URL"));
	const apiToken = requireEnv(env, "CLOUDCASTLE_INCIDENT_TOKEN");
	const discordToken = requireEnv(env, "CLOUDCASTLE_INCIDENT_DISCORD_TOKEN");
	const channels = {
		"product-defect": requireSnowflake(env, "CLOUDCASTLE_INCIDENT_DEFECT_CHANNEL_ID"),
		escalation: requireSnowflake(env, "CLOUDCASTLE_INCIDENT_ESCALATION_CHANNEL_ID"),
	} as const;
	return {
		apiBaseUrl,
		apiToken,
		...(env.CLOUDCASTLE_INCIDENT_ORG_ID?.trim() ? { orgId: env.CLOUDCASTLE_INCIDENT_ORG_ID.trim() } : {}),
		discordToken,
		channels,
		statePath: path.resolve(env.CLOUDCASTLE_INCIDENT_STATE_PATH?.trim() || path.join(cwd, ".cloudcastle-incidents", "state.json")),
		diagnosisCwd: path.resolve(env.CLOUDCASTLE_INCIDENT_DIAGNOSIS_CWD?.trim() || cwd),
		pollIntervalMs: parseBoundedInteger(env.CLOUDCASTLE_INCIDENT_POLL_MS, 30_000, 5_000, 900_000, "poll interval"),
		maxBackoffMs: parseBoundedInteger(env.CLOUDCASTLE_INCIDENT_MAX_BACKOFF_MS, 900_000, 30_000, 1_800_000, "maximum backoff"),
		requestTimeoutMs: parseBoundedInteger(env.CLOUDCASTLE_INCIDENT_REQUEST_TIMEOUT_MS, 10_000, 1_000, 60_000, "request timeout"),
		diagnosisTimeoutMs: parseBoundedInteger(env.CLOUDCASTLE_INCIDENT_DIAGNOSIS_TIMEOUT_MS, 180_000, 15_000, 600_000, "diagnosis timeout"),
		missingPollThreshold: parseBoundedInteger(env.CLOUDCASTLE_INCIDENT_MISSING_POLLS, 2, 1, 10, "missing poll threshold"),
	};
}

function queueLifecycle(state: IncidentState): boolean {
	if (state.pending) return false;
	const latest = state.latest;
	const fingerprint = state.latestFingerprint;
	let kind: IncidentLifecycle | undefined;
	if (latest.terminal) {
		if (state.deliveredLifecycle !== "resolved") kind = "resolved";
	} else if (!state.deliveredFingerprint) {
		kind = "create";
	} else if (state.deliveredFingerprint !== fingerprint || state.deliveredLifecycle === "resolved") {
		kind = "update";
	}
	if (!kind) return false;
	state.pending = {
		kind,
		fingerprint,
		incident: latest,
		nonce: createNonce(kind, latest, fingerprint),
	};
	return true;
}

function canonicalizeIncidents(incidents: readonly NormalizedIncident[]): readonly NormalizedIncident[] {
	const byKey = new Map<string, NormalizedIncident>();
	for (const incident of incidents) {
		const key = incidentKey(incident);
		const current = byKey.get(key);
		if (!current || compareCanonical(current, incident) < 0) byKey.set(key, incident);
	}
	return [...byKey.values()].sort(compareIncidents);
}

function compareCanonical(left: NormalizedIncident, right: NormalizedIncident): number {
	return compareStrings(left.updatedAt ?? "", right.updatedAt ?? "") || compareStrings(fingerprintIncident(left), fingerprintIncident(right));
}

function incidentKey(incident: Pick<NormalizedIncident, "source" | "id">): string {
	return `${incident.source}:${incident.id}`;
}

function createNonce(kind: IncidentLifecycle, incident: NormalizedIncident, fingerprint: string): string {
	return createHash("sha256").update(`${kind}\u0000${incidentKey(incident)}\u0000${fingerprint}`).digest("hex").slice(0, 24);
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
	const contentLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error("CloudCastle API response exceeds the size limit");
	if (!response.body) return JSON.parse(await response.text());
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new Error("CloudCastle API response exceeds the size limit");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new Error("CloudCastle API returned invalid JSON");
	}
}

function extractRecords(payload: unknown, source: IncidentSource): readonly unknown[] {
	if (Array.isArray(payload)) return payload;
	if (!isUnknownRecord(payload)) throw new Error(`CloudCastle ${source} response is not a list`);
	for (const key of ["items", "data", source === "product-defect" ? "defects" : "escalations"]) {
		if (Array.isArray(payload[key])) return payload[key];
	}
	throw new Error(`CloudCastle ${source} response is not a list`);
}

function isDispatcherState(value: unknown): value is DispatcherState {
	if (!isUnknownRecord(value) || value.version !== STATE_VERSION || !isUnknownRecord(value.incidents)) return false;
	return Object.values(value.incidents).every(entry => {
		if (!isUnknownRecord(entry) || !isNormalizedIncident(entry.latest)) return false;
		if (
			typeof entry.latestFingerprint !== "string" ||
			typeof entry.missedPolls !== "number" ||
			typeof entry.lastObservedAt !== "string"
		) {
			return false;
		}
		if (entry.pending !== undefined && !isPendingLifecycle(entry.pending)) return false;
		if (entry.deliveredIncident !== undefined && !isNormalizedIncident(entry.deliveredIncident)) return false;
		for (const key of [
			"deliveredFingerprint",
			"deliveredLifecycle",
			"discordMessageId",
			"diagnosisFingerprint",
			"diagnosisSessionPath",
			"resolvedAt",
		]) {
			if (entry[key] !== undefined && typeof entry[key] !== "string") return false;
		}
		return true;
	});
}

function isNormalizedIncident(value: unknown): value is NormalizedIncident {
	if (!isUnknownRecord(value)) return false;
	return (
		(value.source === "product-defect" || value.source === "escalation") &&
		typeof value.id === "string" &&
		typeof value.status === "string" &&
		typeof value.terminal === "boolean" &&
		typeof value.title === "string" &&
		typeof value.severity === "string" &&
		typeof value.priority === "number"
	);
}

function isPendingLifecycle(value: unknown): value is PendingLifecycle {
	if (!isUnknownRecord(value)) return false;
	return (
		(value.kind === "create" || value.kind === "update" || value.kind === "resolved") &&
		typeof value.fingerprint === "string" &&
		typeof value.nonce === "string" &&
		isNormalizedIncident(value.incident)
	);
}

function emptyState(): DispatcherState {
	return { version: STATE_VERSION, incidents: {} };
}

function defaultTitle(source: IncidentSource): string {
	return source === "product-defect" ? "CloudCastle product defect" : "CloudCastle escalation";
}

function firstScalar(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const candidate = value[key];
		if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
		if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
	}
	return undefined;
}

function safeIncidentId(value: string): string {
	const trimmed = value.trim();
	if (SAFE_ID_PATTERN.test(trimmed)) return trimmed;
	return `ref-${createHash("sha256").update(trimmed).digest("hex").slice(0, 16)}`;
}

function safeEnum(value: string, fallback: string): string {
	const normalized = value.trim().toLowerCase().replace(/[-\s]+/g, "_");
	return normalized && SAFE_ENUM_PATTERN.test(normalized) ? normalized : fallback;
}

function safeOptionalEnum(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const normalized = safeEnum(value, "");
	return normalized || undefined;
}

function normalizeSeverity(value: string | undefined): NormalizedIncident["severity"] {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "critical" || normalized === "sev0" || normalized === "sev1") return "critical";
	if (normalized === "high" || normalized === "sev2") return "high";
	if (normalized === "medium" || normalized === "moderate" || normalized === "sev3") return "medium";
	if (normalized === "low" || normalized === "sev4") return "low";
	if (normalized === "info" || normalized === "informational") return "info";
	return "unknown";
}

function normalizePriority(value: string | undefined, severity: NormalizedIncident["severity"]): number {
	const matched = value?.trim().match(/^(?:p|tier\s*)?([1-5])$/i);
	if (matched) return Number(matched[1]);
	return severity === "critical" ? 1 : severity === "high" ? 2 : severity === "medium" ? 3 : severity === "low" ? 4 : 5;
}

function severityRank(value: NormalizedIncident["severity"]): number {
	return value === "critical" ? 5 : value === "high" ? 4 : value === "medium" ? 3 : value === "low" ? 2 : value === "info" ? 1 : 0;
}

export function redactOperationalText(value: string, explicitSecrets: readonly string[] = [], maxChars = 1_200): string {
	const redacted = redactText(value, explicitSecrets)
		.replace(URL_PATTERN, "[REDACTED_URL]")
		.replace(EMAIL_PATTERN, "[REDACTED_EMAIL]")
		.replace(IPV4_PATTERN, "[REDACTED_IP]")
		.replace(IPV6_PATTERN, "[REDACTED_IP]")
		.replace(MAC_PATTERN, "[REDACTED_MAC]")
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
	return (redacted || "Redacted incident").slice(0, maxChars);
}

function normalizeTimestamp(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const millis = Date.parse(value);
	return Number.isFinite(millis) ? new Date(millis).toISOString() : undefined;
}

function escapeInlineCode(value: string): string {
	return value.replace(/`/g, "ˋ");
}

function escapeDiscordText(value: string): string {
	return value.replace(/([\\*_~|])/g, "\\$1").replace(/</g, "‹").replace(/>/g, "›");
}

function requireEnv(env: Readonly<Record<string, string | undefined>>, key: string): string {
	const value = env[key]?.trim();
	if (!value) throw new Error(`Missing required configuration: ${key}`);
	return value;
}

function requireSnowflake(env: Readonly<Record<string, string | undefined>>, key: string): string {
	const value = requireEnv(env, key);
	if (!/^\d{15,22}$/.test(value)) throw new Error(`Invalid Discord channel id: ${key}`);
	return value;
}

function parseSecureUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("CLOUDCASTLE_INCIDENT_BASE_URL is not a valid URL");
	}
	if (url.username || url.password) throw new Error("CLOUDCASTLE_INCIDENT_BASE_URL must not contain credentials");
	const loopback = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
	if (url.protocol !== "https:" && !loopback) throw new Error("CLOUDCASTLE_INCIDENT_BASE_URL must use HTTPS");
	url.hash = "";
	url.search = "";
	url.pathname = url.pathname.replace(/\/+$/, "") || "/";
	return url;
}

function parseBoundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
	if (!value?.trim()) return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`Invalid ${label}`);
	return parsed;
}

function asSafeError(error: unknown, secrets: readonly string[], fallback: string): Error {
	if (error instanceof AggregateError) {
		return new Error(redactOperationalText(error.errors.map(item => (item instanceof Error ? item.message : String(item))).join("; "), secrets, 1_000));
	}
	const message = error instanceof Error ? error.message : fallback;
	return new Error(redactOperationalText(message || fallback, secrets, 1_000));
}


function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.resolve();
	return new Promise(resolve => {
		const timer = setTimeout(done, Math.max(1, ms));
		function done() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		}
		signal?.addEventListener("abort", done, { once: true });
	});
}
