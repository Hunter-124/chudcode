import { isUnknownRecord } from "./guards";
import { lexicalRelevance } from "./ranking";
import { redactUntrustedValue, sanitizeSourceUrl } from "./redaction";
import { findIncidentId } from "./settings";
import type {
	CloudCastleContextDependencies,
	CloudCastleContextSettings,
	CloudCastleEndpointSettings,
	EvidenceCoverage,
	IncidentContextResult,
	IncidentEvidence,
	RetrievalErrorCode,
} from "./types";

interface EndpointResult {
	readonly evidence: readonly IncidentEvidence[];
	readonly coverage: EvidenceCoverage;
}

type BoundedBodyResult =
	| { readonly ok: true; readonly text: string }
	| { readonly ok: false; readonly errorCode: "invalid_json" | "response_too_large" };

const SEVERITY_PRIORITY: Readonly<Record<string, number>> = {
	critical: 100,
	high: 80,
	medium: 60,
	low: 40,
	info: 20,
	informational: 20,
};

export const DEFAULT_CONTEXT_DEPENDENCIES: CloudCastleContextDependencies = {
	fetch: globalThis.fetch,
	now: () => new Date(),
};

export async function fetchIncidentContext(
	settings: CloudCastleContextSettings,
	query: string,
	dependencies: CloudCastleContextDependencies = DEFAULT_CONTEXT_DEPENDENCIES,
): Promise<IncidentContextResult> {
	const incidentId = settings.incidentId ?? findIncidentId(query);
	if (!incidentId) {
		return { evidence: [], coverage: [], failedClosed: true, errorCode: "config" };
	}

	const retrievedAt = dependencies.now().toISOString();
	const results = await Promise.all(
		settings.endpoints.map(endpoint =>
			fetchEndpoint(settings, endpoint, incidentId, query, retrievedAt, dependencies),
		),
	);
	const coverage = results.map(result => result.coverage);
	const error = coverage.find(item => item.state === "Error");
	if (error) {
		return {
			incidentId,
			evidence: [],
			coverage,
			failedClosed: true,
			errorCode: error.errorCode ?? "http",
		};
	}
	return {
		incidentId,
		evidence: results.flatMap(result => result.evidence),
		coverage,
		failedClosed: false,
	};
}

async function fetchEndpoint(
	settings: CloudCastleContextSettings,
	endpoint: CloudCastleEndpointSettings,
	incidentId: string,
	query: string,
	retrievedAt: string,
	dependencies: CloudCastleContextDependencies,
): Promise<EndpointResult> {
	const url = buildEndpointUrl(settings.baseUrl, endpoint.pathTemplate, incidentId);
	if (!url) return endpointError(endpoint, "invalid://endpoint", incidentId, retrievedAt, "invalid_endpoint");
	const sourceUrl = sanitizeSourceUrl(url);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), settings.requestTimeoutMs);
	try {
		const response = await dependencies.fetch(url, {
			method: "GET",
			headers: {
				accept: "application/json",
				authorization: `Bearer ${settings.bearerToken}`,
			},
			cache: "no-store",
			credentials: "omit",
			redirect: "manual",
			signal: controller.signal,
		});
		if (response.status === 401 || response.status === 403) {
			return endpointError(endpoint, sourceUrl, incidentId, retrievedAt, "auth");
		}
		if (response.status === 404 || response.status === 204) {
			return endpointUnknown(endpoint, sourceUrl, incidentId, retrievedAt);
		}
		if (!response.ok) return endpointError(endpoint, sourceUrl, incidentId, retrievedAt, "http");

		const body = await readBoundedBody(response, settings.maxResponseBytes);
		if (!body.ok) return endpointError(endpoint, sourceUrl, incidentId, retrievedAt, body.errorCode);

		let payload: unknown;
		try {
			payload = JSON.parse(body.text);
		} catch {
			return endpointError(endpoint, sourceUrl, incidentId, retrievedAt, "invalid_json");
		}
		const extracted = extractItems(payload, endpoint.itemsPath);
		if (!extracted) return endpointError(endpoint, sourceUrl, incidentId, retrievedAt, "invalid_json");
		const records = extracted.slice(0, endpoint.maxItems);
		if (records.length === 0) return endpointUnknown(endpoint, sourceUrl, incidentId, retrievedAt);

		const evidence = records.map((record, index) =>
			normalizeEvidence(record, index, endpoint, sourceUrl, incidentId, retrievedAt, query, settings),
		);
		return {
			evidence,
			coverage: {
				className: endpoint.className,
				state: "Known",
				sourceUrl,
				timestamp: retrievedAt,
				entity: `incident:${incidentId}`,
				provenance: `control-api:${endpoint.className}`,
				itemCount: evidence.length,
			},
		};
	} catch (error) {
		const wasAborted = controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
		return endpointError(endpoint, sourceUrl, incidentId, retrievedAt, wasAborted ? "timeout" : "network");
	} finally {
		clearTimeout(timeout);
	}
}

function normalizeEvidence(
	value: unknown,
	index: number,
	endpoint: CloudCastleEndpointSettings,
	sourceUrl: string,
	incidentId: string,
	retrievedAt: string,
	query: string,
	settings: CloudCastleContextSettings,
): IncidentEvidence {
	const redacted = redactUntrustedValue(value, [settings.bearerToken]);
	const content = JSON.stringify(redacted) ?? "null";
	const record = isUnknownRecord(redacted) ? redacted : undefined;
	const recordId = firstString(record, ["id", "event_id", "entity_id"]) ?? `${incidentId}:${index}`;
	const timestamp =
		normalizeTimestamp(firstString(record, ["timestamp", "occurred_at", "created_at", "updated_at", "at"])) ??
		retrievedAt;
	const entityId = firstString(record, ["entity", "entity_id", "device_id", "incident_id", "id"]) ?? incidentId;
	const provenance =
		firstString(record, ["provenance", "source", "origin"]) ?? `control-api:${endpoint.className}:${index}`;
	const explicitPriority = numberField(record, "priority");
	const severity = firstString(record, ["severity", "level"])?.toLowerCase();
	const evidencePriority = clampPriority(
		explicitPriority ?? (severity ? SEVERITY_PRIORITY[severity] : undefined) ?? endpoint.defaultEvidencePriority,
	);
	return {
		id: recordId,
		className: endpoint.className,
		classPriority: endpoint.classPriority,
		evidencePriority,
		relevance: lexicalRelevance(content, query, settings.queryTermLimit),
		content,
		sourceUrl,
		timestamp,
		entity: `${endpoint.entityKind}:${entityId}`,
		provenance,
	};
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<BoundedBodyResult> {
	const contentLength = response.headers.get("content-length");
	if (contentLength && Number(contentLength) > maxBytes) {
		await response.body?.cancel();
		return { ok: false, errorCode: "response_too_large" };
	}
	if (!response.body) return { ok: true, text: "" };

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) break;
		total += chunk.value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			return { ok: false, errorCode: "response_too_large" };
		}
		chunks.push(chunk.value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
	} catch {
		return { ok: false, errorCode: "invalid_json" };
	}
}

function extractItems(payload: unknown, itemsPath: string | undefined): readonly unknown[] | undefined {
	let selected = payload;
	if (itemsPath) {
		for (const segment of itemsPath.split(".")) {
			if (!isUnknownRecord(selected) || !(segment in selected)) return undefined;
			selected = selected[segment];
		}
	}
	if (Array.isArray(selected)) return selected;
	if (itemsPath) return undefined;
	return isUnknownRecord(selected) ? [selected] : undefined;
}

function buildEndpointUrl(baseUrl: URL, pathTemplate: string, incidentId: string): URL | undefined {
	try {
		const renderedPath = pathTemplate.replaceAll("{incidentId}", encodeURIComponent(incidentId));
		const path = new URL(renderedPath, "https://path.invalid");
		if (path.origin !== "https://path.invalid") return undefined;
		const url = new URL(baseUrl);
		const prefix = baseUrl.pathname.replace(/\/$/, "");
		url.pathname = `${prefix}${path.pathname}`;
		url.search = path.search;
		url.hash = "";
		return url;
	} catch {
		return undefined;
	}
}

function endpointUnknown(
	endpoint: CloudCastleEndpointSettings,
	sourceUrl: string,
	incidentId: string,
	retrievedAt: string,
): EndpointResult {
	return {
		evidence: [],
		coverage: {
			className: endpoint.className,
			state: "Unknown",
			sourceUrl,
			timestamp: retrievedAt,
			entity: `incident:${incidentId}`,
			provenance: `control-api:${endpoint.className}`,
			itemCount: 0,
		},
	};
}

function endpointError(
	endpoint: CloudCastleEndpointSettings,
	sourceUrl: string,
	incidentId: string,
	retrievedAt: string,
	errorCode: RetrievalErrorCode,
): EndpointResult {
	return {
		evidence: [],
		coverage: {
			className: endpoint.className,
			state: "Error",
			sourceUrl,
			timestamp: retrievedAt,
			entity: `incident:${incidentId}`,
			provenance: `control-api:${endpoint.className}`,
			itemCount: 0,
			errorCode,
		},
	};
}

function firstString(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
	if (!record) return undefined;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeTimestamp(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const milliseconds = Date.parse(value);
	return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

function clampPriority(value: number): number {
	return Math.max(0, Math.min(100, Math.round(value)));
}
