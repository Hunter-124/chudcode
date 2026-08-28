import { isUnknownRecord } from "./guards";
import type {
	CloudCastleContextSettings,
	CloudCastleEndpointSettings,
	CloudCastleSettingsResult,
} from "./types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLASS_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,47}$/;
const ITEM_PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]{0,127}$/;
const ACTION_SEGMENT_PATTERN = /\/(?:accept|assign|tier|transition|handoff|pir|close|reopen)(?:\/|$|\?)/i;

const DEFAULT_ENDPOINTS: readonly CloudCastleEndpointSettings[] = [
	{
		className: "incident",
		pathTemplate: "/v1/incidents/{incidentId}",
		entityKind: "incident",
		classPriority: 100,
		defaultEvidencePriority: 100,
		maxItems: 1,
	},
	{
		className: "timeline",
		pathTemplate: "/v1/incidents/{incidentId}/events",
		itemsPath: "items",
		entityKind: "incident-event",
		classPriority: 80,
		defaultEvidencePriority: 60,
		maxItems: 8,
	},
];

export type CloudCastleContextEnv = Readonly<Record<string, string | undefined>>;

export function parseCloudCastleContextSettings(env: CloudCastleContextEnv): CloudCastleSettingsResult {
	const baseUrlRaw = env.CLOUDCASTLE_CONTEXT_BASE_URL?.trim();
	if (!baseUrlRaw) return { ok: false, errorCode: "missing_base_url" };

	let baseUrl: URL;
	try {
		baseUrl = new URL(baseUrlRaw);
	} catch {
		return { ok: false, errorCode: "invalid_base_url" };
	}
	if (baseUrl.username || baseUrl.password) return { ok: false, errorCode: "base_url_credentials_forbidden" };
	if (baseUrl.protocol !== "https:" && !isLoopbackHttp(baseUrl)) {
		return { ok: false, errorCode: "insecure_base_url" };
	}
	baseUrl.hash = "";
	baseUrl.search = "";
	baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, "") || "/";

	const bearerToken = env.CLOUDCASTLE_CONTEXT_TOKEN?.trim();
	if (!bearerToken) return { ok: false, errorCode: "missing_token" };

	const incidentId = env.CLOUDCASTLE_CONTEXT_INCIDENT_ID?.trim() || undefined;
	if (incidentId && !UUID_PATTERN.test(incidentId)) return { ok: false, errorCode: "invalid_incident_id" };

	const endpoints = parseEndpoints(env.CLOUDCASTLE_CONTEXT_ENDPOINTS);
	if (!endpoints) return { ok: false, errorCode: "invalid_endpoints" };

	const tokenBudget = parseBound(env.CLOUDCASTLE_CONTEXT_TOKEN_BUDGET, 1_200, 128, 4_000);
	const requestTimeoutMs = parseBound(env.CLOUDCASTLE_CONTEXT_TIMEOUT_MS, 4_000, 250, 15_000);
	const maxResponseBytes = parseBound(env.CLOUDCASTLE_CONTEXT_MAX_RESPONSE_BYTES, 131_072, 1_024, 524_288);
	const queryTermLimit = parseBound(env.CLOUDCASTLE_CONTEXT_QUERY_TERM_LIMIT, 24, 4, 64);
	if (
		tokenBudget === undefined ||
		requestTimeoutMs === undefined ||
		maxResponseBytes === undefined ||
		queryTermLimit === undefined
	) {
		return { ok: false, errorCode: "invalid_limits" };
	}

	return {
		ok: true,
		settings: {
			baseUrl,
			bearerToken,
			incidentId,
			endpoints,
			tokenBudget,
			requestTimeoutMs,
			maxResponseBytes,
			queryTermLimit,
		},
	};
}

export function findIncidentId(text: string): string | undefined {
	const match = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
	return match?.[0]?.toLowerCase();
}

function parseEndpoints(raw: string | undefined): readonly CloudCastleEndpointSettings[] | undefined {
	if (!raw?.trim()) return DEFAULT_ENDPOINTS;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 8) return undefined;

	const endpoints: CloudCastleEndpointSettings[] = [];
	const classNames = new Set<string>();
	for (const value of parsed) {
		if (!isUnknownRecord(value)) return undefined;
		const className = stringField(value, "className");
		const pathTemplate = stringField(value, "pathTemplate");
		const entityKind = stringField(value, "entityKind");
		const itemsPathValue = value.itemsPath;
		const itemsPath = typeof itemsPathValue === "string" ? itemsPathValue.trim() : undefined;
		const classPriority = integerField(value, "classPriority");
		const defaultEvidencePriority = integerField(value, "defaultEvidencePriority");
		const maxItems = integerField(value, "maxItems");
		if (
			!className ||
			!CLASS_NAME_PATTERN.test(className) ||
			classNames.has(className) ||
			!pathTemplate ||
			!isReadOnlyIncidentPath(pathTemplate) ||
			!entityKind ||
			entityKind.length > 64 ||
			(itemsPath !== undefined && !ITEM_PATH_PATTERN.test(itemsPath)) ||
			classPriority === undefined ||
			classPriority < 0 ||
			classPriority > 100 ||
			defaultEvidencePriority === undefined ||
			defaultEvidencePriority < 0 ||
			defaultEvidencePriority > 100 ||
			maxItems === undefined ||
			maxItems < 1 ||
			maxItems > 20
		) {
			return undefined;
		}
		classNames.add(className);
		endpoints.push({
			className,
			pathTemplate,
			...(itemsPath ? { itemsPath } : {}),
			entityKind,
			classPriority,
			defaultEvidencePriority,
			maxItems,
		});
	}
	return endpoints.sort((left, right) => right.classPriority - left.classPriority || left.className.localeCompare(right.className));
}

function isReadOnlyIncidentPath(pathTemplate: string): boolean {
	if (!pathTemplate.startsWith("/") || pathTemplate.startsWith("//")) return false;
	if (!pathTemplate.includes("{incidentId}")) return false;
	if (pathTemplate.includes("#") || pathTemplate.includes("\\") || ACTION_SEGMENT_PATTERN.test(pathTemplate)) return false;
	try {
		const probe = new URL(pathTemplate.replaceAll("{incidentId}", "00000000-0000-4000-8000-000000000000"), "https://control.invalid");
		return probe.origin === "https://control.invalid";
	} catch {
		return false;
	}
}

function isLoopbackHttp(url: URL): boolean {
	if (url.protocol !== "http:") return false;
	return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

function parseBound(raw: string | undefined, fallback: number, minimum: number, maximum: number): number | undefined {
	if (!raw?.trim()) return fallback;
	if (!/^\d+$/.test(raw.trim())) return undefined;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : undefined;
}


function stringField(value: Record<string, unknown>, key: string): string | undefined {
	const field = value[key];
	return typeof field === "string" && field.trim() ? field.trim() : undefined;
}

function integerField(value: Record<string, unknown>, key: string): number | undefined {
	const field = value[key];
	return typeof field === "number" && Number.isSafeInteger(field) ? field : undefined;
}
