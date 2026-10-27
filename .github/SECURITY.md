# Security Policy

## Supported Versions

Only the latest release is supported with security updates.

## Reporting a Vulnerability

Report security issues through a
[private security advisory](https://github.com/Hunter-124/chudcode/security/advisories/new)
on GitHub.

Include steps to reproduce and any relevant details. Do not open a public issue for security vulnerabilities.

## Diagnostic Traces

The developer-only `scripts/claude-trace.ts` helper captures request and response
headers and bodies. These traces can contain access tokens and private data.
Redact them before sharing, and invalidate any credentials already exposed.

Its self-signed TLS key and certificate are intentionally public upstream debug
material, not production credentials. Never install that certificate in a trust
store or reuse the key for an authenticated service. The explicitly launched
capture child disables certificate verification; upstream verification remains
enabled by default. Public debug material is not a claim of global revocation or
evidence that an unrelated system has not mistakenly trusted it.

## Response

Reports are handled on a best-effort basis. You can expect an initial acknowledgment within a few days.
