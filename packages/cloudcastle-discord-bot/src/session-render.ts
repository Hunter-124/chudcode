/**
 * Renders a {@link SessionSnapshot} for Discord.
 *
 * Two hard rules shape this file. First, every string that leaves here is inside
 * Discord's embed limits, including the 6000-character whole-embed ceiling that
 * is easy to blow by summing per-field limits. Second, the embed is a pure
 * function of the snapshot -- nothing reads the wall clock -- because the agent
 * compares {@link embedHash} against the last posted hash to decide whether to
 * spend an API call, and a clock-dependent embed would repost forever.
 */

import { createHash } from "node:crypto";
import { peekFileTail } from "@oh-my-pi/pi-utils/peek-file";
import { parseJsonlLenient } from "@oh-my-pi/pi-utils/stream";
import { MAX_MESSAGE_CHARS, type SessionSnapshot, type SessionStatus } from "./bridge-protocol";
import { isUnknownRecord } from "./incident-guards";

const TITLE_LIMIT = 256;
const DESCRIPTION_LIMIT = 4096;
const FIELD_NAME_LIMIT = 256;
const FIELD_VALUE_LIMIT = 1024;
const FOOTER_LIMIT = 2048;
const FIELD_COUNT_LIMIT = 25;
/** Sum of title, description, field names, field values and footer text. */
const TOTAL_LIMIT = 6000;

const STATUS_COLORS: Record<SessionStatus, number> = {
	running: 0x2ecc71,
	idle: 0x95a5a6,
	complete: 0x3498db,
	interrupted: 0xf39c12,
	aborted: 0xe74c3c,
	error: 0xe74c3c,
	unknown: 0x4f545c,
};

/** Tail read for {@link renderTail}; large enough to hold several long turns. */
const TAIL_WINDOW_BYTES = 262_144;
/**
 * Opening/closing fence, CommonMark-style (up to 3 spaces of indent). The
 * marker length is capped so a pathological line of 500 backticks cannot make
 * the reopening prefix outgrow {@link FENCE_RESERVE}.
 */
const FENCE_PATTERN = /^ {0,3}(`{3,8}|~{3,8})([^\n]*)$/;
/** Characters held back per chunk for a closing marker plus the next chunk's reopening marker. */
const FENCE_RESERVE = 48;
const FENCE_INFO_CHARS = 24;

const decoder = new TextDecoder();

interface EmbedField {
	name: string;
	value: string;
	inline: boolean;
}

export function taskStatusLabel(status: SessionStatus): string {
	switch (status) {
		case "running":
			return "Working";
		case "idle":
			return "Waiting for direction";
		case "complete":
			return "Finished";
		case "interrupted":
			return "Paused";
		case "aborted":
			return "Stopped";
		case "error":
			return "Needs attention";
		default:
			return "Status unavailable";
	}
}

export function renderSessionEmbed(snapshot: SessionSnapshot): Record<string, unknown> {
	const taskTitle = snapshot.title?.trim() || snapshot.project || "Untitled task";
	const title = truncate(`Task: ${taskTitle}`, TITLE_LIMIT);
	const footer = truncate(`Task ${snapshot.sessionId.slice(0, 12)} · ${snapshot.host}`, FOOTER_LIMIT);
	const facts: [string, string][] = [
		["State", taskStatusLabel(snapshot.status)],
		["Project", snapshot.project],
		["Elapsed", formatElapsed(snapshot)],
	];
	const started = discordTimestamp(snapshot.startedAt);
	const updated = discordTimestamp(snapshot.updatedAt);
	if (started) facts.push(["Started", started]);
	if (updated) facts.push(["Last update", updated]);
	if (snapshot.requestedBy) facts.push(["Started by", `<@${snapshot.requestedBy}>`]);

	const fields: EmbedField[] = facts.slice(0, FIELD_COUNT_LIMIT).map(([name, value]) => ({
		name: truncate(name, FIELD_NAME_LIMIT),
		value: truncate(value, FIELD_VALUE_LIMIT) || "—",
		inline: true,
	}));

	let used = title.length + footer.length;
	for (const field of fields) used += field.name.length + field.value.length;
	while (used > TOTAL_LIMIT) {
		const dropped = fields.pop();
		if (!dropped) break;
		used -= dropped.name.length + dropped.value.length;
	}
	const fallback =
		snapshot.status === "complete"
			? "The task finished."
			: snapshot.status === "running"
				? "The agent is working. Progress updates will appear below."
				: "No progress summary is available yet.";
	const summary = snapshot.lastText?.trim() || fallback;
	const description = truncate(`**Latest update**\n${summary}`, Math.min(DESCRIPTION_LIMIT, TOTAL_LIMIT - used));

	return {
		title,
		description,
		color: STATUS_COLORS[snapshot.status] ?? STATUS_COLORS.unknown,
		fields,
		footer: { text: footer },
	};
}

export function embedHash(embed: Record<string, unknown>): string {
	return createHash("sha256").update(canonicalJson(embed)).digest("hex");
}

export async function renderTail(snapshot: SessionSnapshot, limit: number): Promise<string[]> {
	if (limit <= 0) return [];
	let tail: string;
	try {
		tail = await peekFileTail(snapshot.sessionFile, TAIL_WINDOW_BYTES, bytes => decoder.decode(bytes));
	} catch {
		return [];
	}

	const turns: string[] = [];
	// The window starts mid-line; the lenient parser drops that fragment.
	for (const entry of parseJsonlLenient<Record<string, unknown>>(tail)) {
		if (entry.type !== "message" || !isUnknownRecord(entry.message)) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;
		const turn = renderTurn(role, entry.message);
		if (turn) turns.push(turn);
	}

	const messages: string[] = [];
	let current = "";
	for (const turn of turns.slice(-limit)) {
		const chunks = splitFenceAware(turn, MAX_MESSAGE_CHARS);
		// A turn small enough to stand alone may share a message with the previous
		// turn. A split turn owns its messages so reopened code fences stay valid.
		if (chunks.length === 1 && current && current.length + 2 + chunks[0].length <= MAX_MESSAGE_CHARS) {
			current += `\n\n${chunks[0]}`;
			continue;
		}
		if (current) messages.push(current);
		current = chunks.length === 1 ? chunks[0] : "";
		if (chunks.length > 1) messages.push(...chunks);
	}
	if (current) messages.push(current);
	return messages;
}

function renderTurn(role: string, message: Record<string, unknown>): string {
	const texts: string[] = [];
	if (typeof message.content === "string") {
		texts.push(message.content);
	} else if (Array.isArray(message.content)) {
		for (const block of message.content) {
			if (!isUnknownRecord(block)) continue;
			if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
		}
	}
	const body = texts.join("\n\n").trim();
	if (!body) return "";
	return role === "user" ? `**You**\n${body}` : `**Agent**\n${body}`;
}

/**
 * Split `text` into chunks of at most `limit` characters, cutting only between
 * lines. A cut inside a fenced block closes the fence on the way out and reopens
 * it -- marker and info string intact -- on the way in, so no chunk Discord
 * renders ever contains half a code block. A fence left dangling by the source
 * text is closed on the final chunk, which keeps every chunk balanced and lets
 * the caller merge whole chunks without nesting fences.
 */
function splitFenceAware(text: string, limit: number): string[] {
	const budget = limit - FENCE_RESERVE;
	// Hard-split overlong lines first: after this a line always fits beside the
	// fence markers a cut may need to add.
	const lines: string[] = [];
	for (const line of text.split("\n")) {
		if (line.length <= budget) {
			lines.push(line);
			continue;
		}
		for (let at = 0; at < line.length; at += budget) lines.push(line.slice(at, at + budget));
	}

	const chunks: string[] = [];
	let marker: string | null = null;
	let info = "";
	let carry = "";
	let body: string | null = null;

	for (const line of lines) {
		const closeCost = marker ? marker.length + 1 : 0;
		if (body !== null && carry.length + body.length + 1 + line.length + closeCost > limit) {
			chunks.push(marker ? `${carry}${body}\n${marker}` : `${carry}${body}`);
			carry = marker ? `${marker}${info}\n` : "";
			body = null;
		}
		body = body === null ? line : `${body}\n${line}`;

		const fence = FENCE_PATTERN.exec(line);

		if (!fence) continue;
		if (marker === null) {
			marker = fence[1];
			info = fence[2].slice(0, FENCE_INFO_CHARS);
		} else if (fence[1][0] === marker[0] && fence[1].length >= marker.length && fence[2].trim() === "") {
			marker = null;
			info = "";
		}
	}
	if (body !== null || carry) {
		const tail = body ?? "";
		chunks.push(marker ? `${carry}${tail}\n${marker}` : `${carry}${tail}`);
	}
	return chunks;
}

/**
 * Session duration from the snapshot's own timestamps. Deliberately not
 * "time since last update": that would move on every scan and defeat
 * {@link embedHash}.
 */
function discordTimestamp(value: string): string | null {
	const millis = Date.parse(value);
	if (!Number.isFinite(millis)) return null;
	return `<t:${Math.floor(millis / 1000)}:R>`;
}

function formatElapsed(snapshot: SessionSnapshot): string {
	const started = Date.parse(snapshot.startedAt);
	const updated = Date.parse(snapshot.updatedAt);
	if (!Number.isFinite(started) || !Number.isFinite(updated) || updated < started) return "unknown";

	const seconds = Math.floor((updated - started) / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ${minutes % 60}m`;
	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function truncate(value: string, limit: number): string {
	if (limit <= 0) return "";
	if (value.length <= limit) return value;
	return limit === 1 ? "…" : `${value.slice(0, limit - 1)}…`;
}

/** Key-sorted serialisation. Undefined-valued keys are dropped, as `JSON.stringify` would. */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isUnknownRecord(value)) {
		const parts: string[] = [];
		for (const key of Object.keys(value).sort()) {
			if (value[key] === undefined) continue;
			parts.push(`${JSON.stringify(key)}:${canonicalJson(value[key])}`);
		}
		return `{${parts.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}
