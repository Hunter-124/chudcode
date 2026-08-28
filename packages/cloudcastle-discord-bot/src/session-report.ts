/**
 * Agent session reports: the chudcode half of `cc-track`
 * (`docs/19-development-tracking-bridge.md` §7 "Session report", §11).
 *
 * A chudcode session is invisible to the rest of the team the moment it ends.
 * This turns one into two durable artifacts from a single build:
 *
 * - an embed posted to `#sessions`, so a teammate sees what an agent did without
 *   being told, and
 * - the same record as JSON on disk, so the CloudCastle side can ingest it into
 *   the committed ledger and answer "what happened" from `git pull` alone.
 *
 * Rendering is pure and separate from emitting: `buildSessionRecord` and
 * `renderSessionReport` take no clock, no filesystem, and no network, so the
 * report shape is unit-testable and byte-identical for identical input. The
 * digest exists so the JSON record and the posted embed are provably the same
 * session.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { JsonObject } from "./archive";
import { CHANNELS, GUILD_ID } from "./channels";
import {
	type DeliveryResult,
	type NotifyDependencies,
	postWebhook,
	resolveSecretObfuscator,
	screenJson,
	type WebhookPayload,
} from "./notify";

/** Discord's documented embed ceilings. Exceeding any one rejects the whole message. */
const LIMIT_TITLE = 256;
const LIMIT_DESCRIPTION = 4096;
const LIMIT_FIELD_VALUE = 1024;
const SESSION_COLOR = 0x5865f2;

export interface SessionCommit {
	sha: string;
	subject: string;
}

export interface SessionToolUse {
	name: string;
	count: number;
}

export interface SessionInput {
	repo: string;
	branch: string;
	model: string;
	sessionId?: string | null;
	/** ISO 8601 instants; the duration is derived from them, never from a clock. */
	startedAt: string;
	endedAt: string;
	filesTouched?: readonly string[];
	commits?: readonly SessionCommit[];
	tools?: readonly SessionToolUse[];
	notes?: string | null;
}

export interface SessionRecord {
	version: 1;
	kind: "chudcode.session";
	guild_id: string;
	channel_id: string;
	repo: string;
	branch: string;
	model: string;
	session_id: string | null;
	started_at: string;
	ended_at: string;
	duration_seconds: number;
	files_touched: string[];
	commits: SessionCommit[];
	tools: SessionToolUse[];
	notes: string | null;
	digest: string;
}

export interface EmitSessionOptions {
	input: SessionInput;
	/** Where the JSON record is written. Omitted means "post only". */
	outPath?: string;
	/** Omitted, or `dryRun`, means nothing is posted. */
	webhookUrl?: string;
	dryRun?: boolean;
	dependencies?: Partial<NotifyDependencies>;
}

export interface EmitSessionResult {
	record: SessionRecord;
	payload: WebhookPayload;
	outPath: string | null;
	wrote: boolean;
	delivered: boolean;
	messageId: string | null;
	/** Already redacted: a `WebhookError` never carries the webhook URL. */
	deliveryError: string | null;
	redactedPaths: readonly string[];
	dryRun: boolean;
}

/**
 * Normalise raw session inputs into the canonical, order-stable record.
 *
 * Ordering is fixed here rather than at render time because the record is what
 * gets hashed and committed: two runs over the same session must produce the
 * same bytes, whatever order the caller happened to collect files and tools in.
 */
export function buildSessionRecord(input: SessionInput): SessionRecord {
	const startedAt = requireInstant(input.startedAt, "startedAt");
	const endedAt = requireInstant(input.endedAt, "endedAt");
	if (endedAt.getTime() < startedAt.getTime()) throw new Error("endedAt must not precede startedAt");
	if (input.repo.trim() === "") throw new Error("repo is required");
	if (input.branch.trim() === "") throw new Error("branch is required");
	if (input.model.trim() === "") throw new Error("model is required");

	const commits: SessionCommit[] = [];
	const seenCommits = new Set<string>();
	for (const commit of input.commits ?? []) {
		const sha = commit.sha.trim();
		if (sha === "" || seenCommits.has(sha)) continue;
		seenCommits.add(sha);
		commits.push({ sha, subject: commit.subject.trim() });
	}

	const toolCounts = new Map<string, number>();
	for (const tool of input.tools ?? []) {
		const name = tool.name.trim();
		if (name === "") continue;
		toolCounts.set(name, (toolCounts.get(name) ?? 0) + Math.max(0, Math.trunc(tool.count)));
	}
	const tools = [...toolCounts]
		.map(([name, count]) => ({ name, count }))
		.sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));

	const base = {
		version: 1,
		kind: "chudcode.session",
		guild_id: GUILD_ID,
		channel_id: CHANNELS.sessions.id,
		repo: input.repo.trim(),
		branch: input.branch.trim(),
		model: input.model.trim(),
		session_id: input.sessionId?.trim() || null,
		started_at: startedAt.toISOString(),
		ended_at: endedAt.toISOString(),
		duration_seconds: Math.round((endedAt.getTime() - startedAt.getTime()) / 1000),
		files_touched: [...new Set((input.filesTouched ?? []).map(file => file.trim()).filter(file => file !== ""))].sort(),
		commits,
		tools,
		notes: input.notes?.trim() || null,
	} as const;

	return { ...base, digest: `sha256:${createHash("sha256").update(JSON.stringify(base)).digest("hex")}` };
}

/** Pure: record in, Discord webhook payload out. No clock, no I/O, no network. */
export function renderSessionReport(record: SessionRecord): WebhookPayload {
	const fields: JsonObject[] = [
		{ name: "Model", value: truncate(record.model, LIMIT_FIELD_VALUE), inline: true },
		{ name: "Duration", value: formatDuration(record.duration_seconds), inline: true },
		{ name: "Branch", value: truncate(record.branch, LIMIT_FIELD_VALUE), inline: true },
		{
			name: `Files touched (${record.files_touched.length})`,
			value: bulletList(record.files_touched, "no files changed"),
			inline: false,
		},
		{
			name: `Commits (${record.commits.length})`,
			value: bulletList(
				record.commits.map(commit => `\`${commit.sha.slice(0, 8)}\` ${commit.subject}`),
				"no commits produced",
			),
			inline: false,
		},
		{
			name: "Tools invoked",
			value: truncate(
				record.tools.map(tool => `${tool.name} ×${tool.count}`).join(", ") || "none recorded",
				LIMIT_FIELD_VALUE,
			),
			inline: false,
		},
	];

	const embed: JsonObject = {
		title: truncate(`Session — ${record.repo}`, LIMIT_TITLE),
		description: truncate(record.notes ?? `Agent session on \`${record.branch}\`.`, LIMIT_DESCRIPTION),
		color: SESSION_COLOR,
		fields,
		timestamp: record.ended_at,
		footer: { text: truncate(record.session_id ? `session ${record.session_id}` : record.digest, LIMIT_FIELD_VALUE) },
	};
	// No `content`: mentions in a session firehose are noise, and an empty
	// allowed_mentions makes that a property of the request, not of the text.
	return { embeds: [embed], allowed_mentions: { parse: [] } };
}

/**
 * Screen the inputs, build the record, write it as evidence, then attempt delivery.
 *
 * Screening happens on the *input*, before the digest is computed, so the JSON
 * record, its digest, and the posted embed all describe the same screened
 * session. Screening only the outbound body would leave a credential sitting in
 * a file that the CloudCastle side commits to a git ledger forever -- the more
 * permanent leak of the two.
 *
 * Evidence is written before delivery and a delivery failure is returned rather
 * than thrown, because the two outputs have different value: the JSON record is
 * the ledger input and must survive Discord being down. The caller decides what
 * a partial success means -- `report-cli` reports it as exit code 2.
 */
export async function emitSessionReport(options: EmitSessionOptions): Promise<EmitSessionResult> {
	const screened = screenJson(options.input, await resolveSecretObfuscator(options.dependencies));
	const record = buildSessionRecord(screened.value);
	const payload = renderSessionReport(record);
	const outPath = options.outPath ? path.resolve(options.outPath) : null;
	const dryRun = options.dryRun === true;

	if (outPath && !dryRun) await atomicWrite(outPath, `${JSON.stringify(record, null, 2)}\n`);

	const base = {
		record,
		payload,
		outPath,
		wrote: outPath !== null && !dryRun,
		redactedPaths: screened.redactedPaths as readonly string[],
		dryRun,
	};
	if (dryRun || !options.webhookUrl) {
		return { ...base, delivered: false, messageId: null, deliveryError: null };
	}
	let delivery: DeliveryResult;
	try {
		delivery = await postWebhook(options.webhookUrl, payload, options.dependencies);
	} catch (error) {
		const message = error instanceof Error ? error.message : "session report delivery failed";
		return { ...base, delivered: false, messageId: null, deliveryError: message };
	}
	return { ...base, delivered: true, messageId: delivery.messageId, deliveryError: null };
}

export function formatDuration(seconds: number): string {
	const total = Math.max(0, Math.trunc(seconds));
	const hours = Math.trunc(total / 3600);
	const minutes = Math.trunc((total % 3600) / 60);
	const rest = total % 60;
	if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(rest).padStart(2, "0")}s`;
	return minutes > 0 ? `${minutes}m ${String(rest).padStart(2, "0")}s` : `${rest}s`;
}

export function truncate(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * A field value that overflows is trimmed by dropping whole entries and saying
 * how many were dropped -- a half-written path is worse than an honest count.
 */
function bulletList(entries: readonly string[], empty: string): string {
	if (entries.length === 0) return empty;
	const kept: string[] = [];
	let length = 0;
	for (const entry of entries) {
		const line = `• ${entry}`;
		if (length + line.length + 1 > LIMIT_FIELD_VALUE - 32) break;
		kept.push(line);
		length += line.length + 1;
	}
	const dropped = entries.length - kept.length;
	if (dropped > 0) kept.push(`… and ${dropped} more`);
	return truncate(kept.join("\n"), LIMIT_FIELD_VALUE);
}

function requireInstant(value: string, label: string): Date {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) throw new Error(`${label} must be an ISO 8601 timestamp`);
	return parsed;
}

let atomicSequence = 0;

/** Same shape as `archive.ts`: write beside the destination, then rename over it. */
async function atomicWrite(destination: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(destination), { recursive: true });
	const temporary = path.join(
		path.dirname(destination),
		`.${path.basename(destination)}.tmp-${process.pid}-${atomicSequence++}`,
	);
	try {
		await fs.writeFile(temporary, content, { flag: "wx", mode: 0o600 });
		await fs.rename(temporary, destination);
	} catch (error) {
		await fs.rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}
