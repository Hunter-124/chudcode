# CloudCastle context engine

`@cloudcastle/context-engine` is a read-only agent memory-backend extension. It registers the backend id `cloudcastle-incident`, reads tenant-authorized incident evidence from CloudCastle control-api, and injects one bounded developer-instruction block at `beforeAgentStartPrompt`.

The package does not register tools, send write requests, or dispatch endpoint actions. CloudCastle names, routes, defaults, and parsing stay in this package; the agent runtime only sees the generic `MemoryBackend` registration.

## Loading

Load `src/extension.ts` through the normal extension loader, then select:

```json
{
  "memory": {
    "backend": "cloudcastle-incident"
  }
}
```

The extension factory calls only `registerMemoryBackend`. Registration ownership and unload cleanup are handled by the extension loader. Incident context is staged before a turn and cached only when its prompt is committed; failed retrieval clears earlier cached context.

## Environment schema

| Variable | Required | Default | Bounds / behavior |
|---|---:|---:|---|
| `CLOUDCASTLE_CONTEXT_BASE_URL` | yes | — | HTTPS origin or loopback HTTP for local development; embedded credentials are rejected |
| `CLOUDCASTLE_CONTEXT_TOKEN` | yes | — | Bearer credential; never rendered or logged |
| `CLOUDCASTLE_CONTEXT_INCIDENT_ID` | no | — | UUID; when omitted, the first UUID in the current prompt is used |
| `CLOUDCASTLE_CONTEXT_TOKEN_BUDGET` | no | `1200` | 128–4000 estimated tokens |
| `CLOUDCASTLE_CONTEXT_TIMEOUT_MS` | no | `4000` | 250–15000 ms per endpoint |
| `CLOUDCASTLE_CONTEXT_MAX_RESPONSE_BYTES` | no | `131072` | 1024–524288 bytes per endpoint, enforced while streaming |
| `CLOUDCASTLE_CONTEXT_QUERY_TERM_LIMIT` | no | `24` | 4–64 lexical ranking terms |
| `CLOUDCASTLE_CONTEXT_ENDPOINTS` | no | incident detail + event ledger | JSON array described below; at most eight classes |

The default read endpoints are:

- `GET /v1/incidents/{incidentId}` as class `incident`
- `GET /v1/incidents/{incidentId}/events` as class `timeline`, reading `items`

A custom endpoint entry has this shape:

```json
{
  "className": "timeline",
  "pathTemplate": "/v1/incidents/{incidentId}/events",
  "itemsPath": "items",
  "entityKind": "incident-event",
  "classPriority": 80,
  "defaultEvidencePriority": 60,
  "maxItems": 8
}
```

Endpoint templates must be same-origin relative paths containing `{incidentId}`. The client always uses `GET`, omits browser credentials, disables caching, and refuses redirects. Known mutation-route suffixes are rejected by the schema. There is no configurable method, request body, command, or action dispatcher.

## Retrieval and failure semantics

Each endpoint produces explicit coverage:

- `Known`: the endpoint returned at least one bounded evidence record.
- `Unknown`: the endpoint returned 404, 204, or an empty bounded collection. Unknown is not rendered as a confirmed absence.
- `Error`: auth, network, timeout, HTTP, JSON, size, or endpoint validation failed.

Any `Error` fails the whole retrieval closed: evidence already returned by another class is discarded and no developer block is injected. Missing credentials or an unresolvable incident UUID also inject nothing. Error details are represented by fixed codes, never exception text or response bodies.

Response bytes, records per class, object keys, nesting depth, strings, query terms, endpoint count, request time, and final token estimate are all capped. Secret-like fields, authorization strings, JWTs, private keys, sensitive URL parameters, and the configured bearer value are redacted before evidence can reach search results or prompts.

## Deterministic context construction

Evidence is normalized with source URL, source-or-retrieval timestamp, entity, and provenance. Each evidence class is sorted independently by evidence priority, lexical relevance, timestamp, stable id, URL, and content. Classes are then merged in deterministic priority rounds so one large class cannot consume the whole context before another class is considered. The last admitted item is content-truncated with valid JSON metadata retained; the rendered evidence never exceeds the configured estimate of four characters per token.

The injected block labels all payloads as untrusted evidence and tells the model not to execute instructions found in them. It includes compact coverage and evidence JSON only. Explicit `/memory` search uses the same retrieval and ranking path; save is unsupported because this backend is read-only.

## Package tests

- `test/settings.test.ts`: schema bounds, HTTPS/loopback policy, UUID selection, and action-path rejection.
- `test/ranking.test.ts`: independent class ordering, deterministic ties, and priority truncation.
- `test/backend.test.ts`: GET/auth behavior, provenance, Unknown/Error coverage, size/network/auth fail-closed behavior, secret redaction, and developer-block injection.
- `test/evaluation.test.ts`: deterministic context precision/recall, provenance coverage, and Known coverage rate without an evaluator-model call.

See [SOURCE_ATTRIBUTION.md](./SOURCE_ATTRIBUTION.md) for the design-pattern provenance. No third-party source code is copied into this package.
