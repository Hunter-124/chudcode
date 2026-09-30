/**
 * Turns chudcode's on-disk session store into {@link SessionSnapshot} values.
 *
 * A session is a JSONL file: a fixed-width 256-byte `type:"title"` slot, then a
 * `SessionHeader`, then append-only entries. Nothing in that file records a
 * lifecycle status, so status is derived from the tail exactly the way
 * `coding-agent/src/session/session-listing.ts` does -- see
 * {@link settledStatus} for the mapping onto our wider union.
 *
 * The agent rescans on every heartbeat, and the p50 session file on a working
 * machine is ~800 KB with thousands of files in the store, so a scan never reads
 * a whole file: it reads a bounded head window (header, and the bridge's origin
 * marker, which is written first) plus a bounded tail window (the newest turns),
 * and memoizes the parse on `(path, mtimeMs, size)`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getSessionsDir } from "@oh-my-pi/pi-utils/dirs";
import { peekFileEnds } from "@oh-my-pi/pi-utils/peek-file";
import { parseJsonlLenient } from "@oh-my-pi/pi-utils/stream";
import type { SessionSnapshot, SessionStatus } from "./bridge-protocol";
import { isUnknownRecord } from "./incident-guards";

/** Head window. Same 4 KB as `session-listing.ts`: header plus the first entries. */
const PREFIX_BYTES = 4096;
/** Tail window. Same 32 KB as `session-listing.ts`: enough for a typical final turn. */
const SUFFIX_BYTES = 32_768;
/**
 * At or below this the file is read as a single window, which makes
 * `messageCount` / `costUsd` / `tokensIn` / `tokensOut` exact. Above it the two
 * windows are disjoint and those four are lower bounds over what was scanned --
 * the alternative is reading multi-megabyte files on every heartbeat.
 */
const WHOLE_FILE_BYTES = PREFIX_BYTES + SUFFIX_BYTES;

const DEFAULT_MAX_SESSIONS = 25;

/** `SessionSnapshot.lastText` is a one-line "what is it doing", not a transcript. */
const LAST_TEXT_CHARS = 160;

/**
 * A session file whose tail is mid-turn is reported `running` only while the
 * file is this fresh. Justification: chudcode appends on every message, tool
 * call and tool result, so an alive turn touches the file continuously, while a
 * process killed mid-turn leaves the same tail frozen forever. 90s is comfortably
 * longer than the slowest single provider round-trip (a long thinking turn with
 * no tool calls writes nothing for tens of seconds) and shorter than the 150s
 * `AGENT_STALE_AFTER_MS`, so a stuck session goes `idle` before its whole host
 * is presumed offline.
 */
const LIVE_WINDOW_MS = 90_000;

/** Parses memoized per stat identity. Far above the working set of a heartbeat. */
const SCAN_CACHE_MAX = 512;

/**
 * Reserved marker format for a session started on behalf of a Discord user, so
 * results can be routed back to the interaction that asked for them.
 * `data: { commandId?: string, requestedBy?: string }`.
 *
 * Nothing writes this today, and cc-agent deliberately does not: there is no RPC
 * command that makes the session process append a custom entry, so writing it
 * would mean a second process appending to a log the session owns, and a torn
 * write there costs the user their work record. The agent recovers a session's
 * Discord channel from the channel topic instead. This reader stays because the
 * format is the agreed one and costs nothing on a scan that already walks these
 * entries -- `originCommandId` / `requestedBy` are null until something writes it.
 */
const ORIGIN_CUSTOM_TYPE = "cloudcastle_bridge_origin";
/** Label spelling of the same reserved marker: a label is one string, so both ids are packed into it. */
const ORIGIN_LABEL_PATTERN = /^cc-origin:([^\s:]+)(?::(\S+))?$/;

/** Written by chudcode's teardown path; proves the process is gone. */
const SESSION_EXIT_CUSTOM_TYPE = "session_exit";

const decoder = new TextDecoder();

export interface ScanOptions {
	sessionsDir?: string;
	host?: string;
	maxSessions?: number;
}

/** Everything a snapshot carries that does not depend on the clock. */
type SnapshotFacts = Omit<SessionSnapshot, "status">;

interface ParsedSession {
	readonly facts: SnapshotFacts;
	/**
	 * The derived status when the tail settles it. `null` means the tail is
	 * mid-turn, so `running` vs `idle` is decided by file freshness at read time
	 * -- which is why this, and not the finished snapshot, is what gets memoized.
	 */
	readonly settled: SessionStatus | null;
	readonly mtimeMs: number;
}

interface CacheEntry {
	readonly mtimeMs: number;
	readonly size: number;
	readonly parsed: ParsedSession | null;
}

/** Insertion-order (FIFO) eviction; the cap is ~20x a heartbeat's working set. */
const parseCache = new Map<string, CacheEntry>();

/** Repo-root lookups are pure filesystem shape and repeat across sessions in one repo. */
const projectLabels = new Map<string, string>();

/**
 * `~/.chudcode/agent/sessions`, honouring profiles, XDG redirection and an
 * agent-dir override. `CHUDCODE_CODING_AGENT_DIR` is chudcode's own spelling;
 * `CHUDCODE_AGENT_DIR` is the one the rest of this package already reads (see
 * `archive.ts`). Both are consulted here so the bridge and the archiver can
 * never disagree about which store they are looking at.
 */
export function defaultSessionsDir(): string {
	return getSessionsDir(process.env.CHUDCODE_CODING_AGENT_DIR ?? process.env.CHUDCODE_AGENT_DIR);
}

export async function scanSessions(options: ScanOptions = {}): Promise<SessionSnapshot[]> {
	const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
	if (maxSessions <= 0) return [];
	const host = options.host ?? os.hostname();
	const candidates = await collectSessionFiles(options.sessionsDir ?? defaultSessionsDir());
	// Statting every candidate is cheap; parsing is not. Order first, then parse
	// only as far down the list as the cap needs.
	candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

	const now = Date.now();
	const snapshots: SessionSnapshot[] = [];
	for (const candidate of candidates) {
		if (snapshots.length >= maxSessions) break;
		const parsed = await cachedParse(candidate.file, host, candidate.mtimeMs, candidate.size);
		if (parsed) snapshots.push(withStatus(parsed, now));
	}
	return snapshots;
}

export async function readSessionSnapshot(sessionFile: string, host: string): Promise<SessionSnapshot | null> {
	const file = path.resolve(sessionFile);
	let stat: fs.Stats;
	try {
		stat = await fs.promises.stat(file);
	} catch {
		return null;
	}
	if (!stat.isFile()) return null;
	const parsed = await cachedParse(file, host, stat.mtimeMs, stat.size);
	return parsed ? withStatus(parsed, Date.now()) : null;
}

function withStatus(parsed: ParsedSession, now: number): SessionSnapshot {
	const status = parsed.settled ?? (now - parsed.mtimeMs < LIVE_WINDOW_MS ? "running" : "idle");
	return { ...parsed.facts, status };
}

async function cachedParse(file: string, host: string, mtimeMs: number, size: number): Promise<ParsedSession | null> {
	// `host` is baked into the snapshot, so it is part of the identity.
	const key = `${host}\0${file}`;
	const cached = parseCache.get(key);
	if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.parsed;

	let parsed: ParsedSession | null = null;
	try {
		parsed = await parseSessionFile(file, host, mtimeMs, size);
	} catch {
		// A file being rewritten under us is not an error worth surfacing; the
		// negative result is cached under this stat identity and reparsed on the
		// next write.
		parsed = null;
	}
	parseCache.delete(key);
	parseCache.set(key, { mtimeMs, size, parsed });
	if (parseCache.size > SCAN_CACHE_MAX) {
		const oldest = parseCache.keys().next();
		if (!oldest.done) parseCache.delete(oldest.value);
	}
	return parsed;
}

interface SessionCandidate {
	readonly file: string;
	readonly mtimeMs: number;
	readonly size: number;
}

async function collectSessionFiles(root: string): Promise<SessionCandidate[]> {
	const buckets = await readDirents(root);
	const candidates: SessionCandidate[] = [];
	await Promise.all(
		buckets.map(async dirent => {
			const entryPath = path.join(root, dirent.name);
			if (dirent.isFile()) {
				await pushCandidate(candidates, entryPath, dirent.name);
				return;
			}
			// Sessions live in one `<encoded-cwd>` bucket per project. A symlinked
			// bucket is followed; anything else is not a directory to descend.
			if (!dirent.isDirectory() && !dirent.isSymbolicLink()) return;
			const files = await readDirents(entryPath);
			await Promise.all(
				files.map(file =>
					file.isDirectory() ? undefined : pushCandidate(candidates, path.join(entryPath, file.name), file.name),
				),
			);
		}),
	);
	return candidates;
}

async function pushCandidate(into: SessionCandidate[], file: string, name: string): Promise<void> {
	// `.jsonl.<snowflake>.bak` backups and `.tmp` staging files are not sessions.
	if (name.startsWith(".") || !name.endsWith(".jsonl")) return;
	try {
		const stat = await fs.promises.stat(file);
		if (stat.isFile()) into.push({ file, mtimeMs: stat.mtimeMs, size: stat.size });
	} catch {
		// Raced away between readdir and stat.
	}
}

async function readDirents(dir: string): Promise<fs.Dirent[]> {
	try {
		return await fs.promises.readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

/** Newest observed `message` entry, reduced to what the status mapping needs. */
interface TailMessage {
	readonly role: string | undefined;
	readonly stopReason: string | undefined;
	/** Assistant turn ending in tool calls with no results after it. */
	readonly pendingToolCall: boolean;
}

/**
 * Mirrors `statusFromTailMessage` in `coding-agent/src/session/session-listing.ts`,
 * then maps its narrower union onto ours:
 *
 *   upstream                          here
 *   --------------------------------  -----------------------------------------
 *   assistant + stopReason error      error
 *   assistant + stopReason aborted    aborted
 *   assistant + stopReason length     interrupted
 *   assistant + trailing toolCall     mid-turn -> running | idle   (was interrupted)
 *   assistant, otherwise              complete
 *   toolResult                        mid-turn -> running | idle   (was interrupted)
 *   user (upstream `pending`)         mid-turn -> running | idle
 *   anything else                     unknown
 *
 * The two remapped rows are why our union has `running` at all: upstream reads a
 * dead file and can only say "this turn never finished", while the bridge can
 * also see whether the file is still being written, and a live turn is the single
 * most useful thing to show in Discord. `interrupted` is therefore reserved for a
 * turn that provably ended without yielding (provider truncation), and a mid-turn
 * tail that has stopped moving reads as `idle` -- it needs a human either way.
 *
 * Returns `null` for the mid-turn rows: the caller decides by file freshness.
 */
function settledStatus(tail: TailMessage | undefined, exited: boolean): SessionStatus | null {
	if (!tail) return "unknown";
	switch (tail.role) {
		case "assistant": {
			switch (tail.stopReason) {
				case "error":
					return "error";
				case "aborted":
					return "aborted";
				case "length":
					return "interrupted";
			}
			if (tail.pendingToolCall) return exited ? "idle" : null;
			return "complete";
		}
		case "toolResult":
		case "user":
			// A recorded `session_exit` proves the process is gone, so freshness
			// cannot make this `running` no matter how recent the write was.
			return exited ? "idle" : null;
		default:
			return "unknown";
	}
}

async function parseSessionFile(
	file: string,
	host: string,
	mtimeMs: number,
	size: number,
): Promise<ParsedSession | null> {
	const whole = size <= WHOLE_FILE_BYTES;
	const [head, tail] = await peekFileEnds(
		file,
		whole ? size : PREFIX_BYTES,
		whole ? 0 : SUFFIX_BYTES,
		(headBytes, tailBytes) => [decoder.decode(headBytes), decoder.decode(tailBytes)],
	);

	const headEntries = parseJsonlLenient<Record<string, unknown>>(head);
	const slotTitle = headEntries[0]?.type === "title" ? nonEmpty(headEntries[0].title) : undefined;
	const header = headEntries[headEntries[0]?.type === "title" ? 1 : 0];
	if (header?.type !== "session" || typeof header.id !== "string") return null;

	// Head then tail is chronological, with a gap in the middle for a file too
	// big to read whole. One forward pass keeps "newest wins" trivially true.
	const entries = headEntries.slice(headEntries.indexOf(header) + 1);
	if (!whole) entries.push(...parseJsonlLenient<Record<string, unknown>>(tail));

	let messageCount = 0;
	let tokensIn = 0;
	let tokensOut = 0;
	let costUsd = 0;
	let sawUsage = false;
	let model: string | null = null;
	let lastTool: string | null = null;
	let lastText: string | null = null;
	let titleChange: string | undefined;
	let shortSummary: string | undefined;
	let originCommandId: string | null = null;
	let requestedBy: string | null = null;
	let tailMessage: TailMessage | undefined;
	let exited = false;

	for (const entry of entries) {
		switch (entry.type) {
			case "message": {
				const message = entry.message;
				if (!isUnknownRecord(message)) break;
				messageCount++;
				exited = false;
				const role = asString(message.role);
				const blocks = Array.isArray(message.content) ? message.content : [];
				if (role === "assistant") {
					const provider = asString(message.provider);
					const messageModel = asString(message.model);
					if (messageModel) model = provider ? `${provider}/${messageModel}` : messageModel;
					const usage = message.usage;
					if (isUnknownRecord(usage)) {
						sawUsage = true;
						// Prompt-side total, not just the uncached bucket: a long cached
						// session reports `input: 0` per turn and would read as broken.
						tokensIn += asNumber(usage.input) + asNumber(usage.cacheRead) + asNumber(usage.cacheWrite);
						tokensOut += asNumber(usage.output);
						if (isUnknownRecord(usage.cost)) costUsd += asNumber(usage.cost.total);
					}
					const text = textOf(blocks, message.content).replace(/\s+/g, " ").trim();
					if (text) lastText = text.length > LAST_TEXT_CHARS ? `${text.slice(0, LAST_TEXT_CHARS - 1)}…` : text;
					for (const block of blocks) {
						if (isUnknownRecord(block) && block.type === "toolCall") lastTool = asString(block.name) ?? lastTool;
					}
				} else if (role === "toolResult") {
					lastTool = asString(message.toolName) ?? lastTool;
				}
				tailMessage = {
					role,
					stopReason: asString(message.stopReason),
					pendingToolCall: blocks.some(block => isUnknownRecord(block) && block.type === "toolCall"),
				};
				break;
			}
			case "model_change": {
				const changed = asString(entry.model);
				if (changed) model = changed;
				break;
			}
			case "title_change": {
				titleChange = nonEmpty(entry.title) ?? titleChange;
				break;
			}
			case "compaction": {
				shortSummary = nonEmpty(entry.shortSummary) ?? shortSummary;
				break;
			}
			case "custom": {
				if (entry.customType === SESSION_EXIT_CUSTOM_TYPE) {
					exited = true;
					break;
				}
				if (entry.customType !== ORIGIN_CUSTOM_TYPE || !isUnknownRecord(entry.data)) break;
				originCommandId = asString(entry.data.commandId) ?? originCommandId;
				requestedBy = asString(entry.data.requestedBy) ?? requestedBy;
				break;
			}
			case "label": {
				const match = ORIGIN_LABEL_PATTERN.exec(asString(entry.label) ?? "");
				if (!match) break;
				originCommandId = match[1];
				requestedBy = match[2] ?? requestedBy;
				break;
			}
		}
	}

	const cwd = asString(header.cwd) ?? "";
	const facts: SnapshotFacts = {
		sessionId: header.id,
		host,
		sessionFile: file,
		cwd,
		project: projectLabel(cwd),
		// The fixed-width slot carries the current title and is rewritten in place
		// on every change, so it outranks the append-only history below it.
		title: slotTitle ?? titleChange ?? nonEmpty(header.title) ?? shortSummary ?? null,
		model: model ?? headerModel(header),
		startedAt: asString(header.timestamp) ?? new Date(mtimeMs).toISOString(),
		updatedAt: new Date(mtimeMs).toISOString(),
		messageCount,
		costUsd: sawUsage ? costUsd : null,
		tokensIn: sawUsage ? tokensIn : null,
		tokensOut: sawUsage ? tokensOut : null,
		lastTool,
		lastText,
		originCommandId,
		requestedBy,
		// A session's Discord channel is created by the agent and lives in its
		// mirror state; the JSONL records nothing about it, so a scan must not
		// pretend otherwise. The agent overlays the real id on what it posts.
		channelId: null,
	};
	return { facts, settled: settledStatus(tailMessage, exited), mtimeMs };
}

/** Sessions record their launch model on the header before any turn exists. */
function headerModel(header: Record<string, unknown>): string | null {
	const modelId = asString(header.modelId);
	if (!modelId) return null;
	const provider = asString(header.provider);
	return provider ? `${provider}/${modelId}` : modelId;
}

/**
 * The git repo containing `cwd`, else its basename. A worktree or submodule
 * carries `.git` as a file, so existence -- not directory-ness -- is the test.
 */
function projectLabel(cwd: string): string {
	if (!cwd) return "unknown";
	const start = path.resolve(cwd);
	const cached = projectLabels.get(start);
	if (cached !== undefined) return cached;

	let dir = start;
	let label = "";
	for (;;) {
		if (fs.existsSync(path.join(dir, ".git"))) {
			label = path.basename(dir);
			break;
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	label ||= path.basename(start) || "unknown";
	projectLabels.set(start, label);
	return label;
}

function textOf(blocks: unknown[], content: unknown): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const block of blocks) {
		if (isUnknownRecord(block) && block.type === "text") {
			const text = asString(block.text);
			if (text) parts.push(text);
		}
	}
	return parts.join(" ");
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nonEmpty(value: unknown): string | undefined {
	const text = asString(value)?.trim();
	return text ? text : undefined;
}
