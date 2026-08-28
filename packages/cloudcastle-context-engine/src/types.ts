export const CLOUDCASTLE_INCIDENT_BACKEND_ID = "cloudcastle-incident" as const;

export type CoverageState = "Known" | "Unknown" | "Error";

export interface CloudCastleEndpointSettings {
	readonly className: string;
	readonly pathTemplate: string;
	readonly itemsPath?: string;
	readonly entityKind: string;
	readonly classPriority: number;
	readonly defaultEvidencePriority: number;
	readonly maxItems: number;
}

export interface CloudCastleContextSettings {
	readonly baseUrl: URL;
	readonly bearerToken: string;
	readonly incidentId?: string;
	readonly endpoints: readonly CloudCastleEndpointSettings[];
	readonly tokenBudget: number;
	readonly requestTimeoutMs: number;
	readonly maxResponseBytes: number;
	readonly queryTermLimit: number;
}

export type CloudCastleSettingsResult =
	| { readonly ok: true; readonly settings: CloudCastleContextSettings }
	| { readonly ok: false; readonly errorCode: CloudCastleConfigErrorCode };

export type CloudCastleConfigErrorCode =
	| "missing_base_url"
	| "invalid_base_url"
	| "insecure_base_url"
	| "base_url_credentials_forbidden"
	| "missing_token"
	| "invalid_incident_id"
	| "invalid_endpoints"
	| "invalid_limits";

export interface IncidentEvidence {
	readonly id: string;
	readonly className: string;
	readonly classPriority: number;
	readonly evidencePriority: number;
	readonly relevance: number;
	readonly content: string;
	readonly sourceUrl: string;
	readonly timestamp?: string;
	readonly entity: string;
	readonly provenance: string;
}

export interface EvidenceCoverage {
	readonly className: string;
	readonly state: CoverageState;
	readonly sourceUrl: string;
	readonly timestamp: string;
	readonly entity: string;
	readonly provenance: string;
	readonly itemCount: number;
	readonly errorCode?: RetrievalErrorCode;
}

export type RetrievalErrorCode =
	| "auth"
	| "network"
	| "timeout"
	| "http"
	| "invalid_json"
	| "response_too_large"
	| "invalid_endpoint"
	| "config";

export interface IncidentContextResult {
	readonly incidentId?: string;
	readonly evidence: readonly IncidentEvidence[];
	readonly coverage: readonly EvidenceCoverage[];
	readonly failedClosed: boolean;
	readonly errorCode?: RetrievalErrorCode;
}

export interface RankedContext {
	readonly evidence: readonly IncidentEvidence[];
	readonly renderedEvidence: string;
	readonly estimatedTokens: number;
	readonly truncated: boolean;
}

export interface CloudCastleContextDependencies {
	readonly fetch: typeof globalThis.fetch;
	readonly now: () => Date;
}
