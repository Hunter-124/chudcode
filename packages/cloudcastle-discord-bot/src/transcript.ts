/**
 * Turning a live agent session into something readable in a Discord thread.
 *
 * The bot cannot stream tokens: Discord rate-limits message edits per channel,
 * so the thread is repainted every few seconds instead. That makes the render a
 * *fold* rather than a stream — the session events are accumulated here into a
 * small renderable snapshot, and the poster only redraws when `revision` moved.
 *
 * Everything in this file is pure. No clock, no `discord.js`, no network: the
 * elapsed time is a parameter, so a test can assert the exact string the thread
 * will show. That matters because the failure mode we are avoiding — a status
 * block that grew past 2000 characters and made every subsequent edit fail — is
 * only reachable with adversarial input (a 300-character path, a 100-item todo
 * list), which is cheap to write as a test and expensive to hit in production.
 */

import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";

/** Discord's hard ceiling on a single message body. Exceed it and the edit 400s. */
export const DISCORD_MESSAGE_LIMIT = 2000;

/** A todo line lifted from the agent's todo state, already flattened across phases. */
export interface TodoLine {
	readonly content: string;
	readonly status: string;
}

export type TurnPhase = "queued" | "thinking" | "working" | "compacting" | "retrying" | "done" | "error" | "aborted";

export interface TurnStatus {
	readonly phase: TurnPhase;
	/** Model id reported by the newest assistant message, or null before one arrives. */
	readonly model: string | null;
	/** Assistant messages completed in this turn. */
	readonly steps: number;
	/** Tool executions started in this turn. */
	readonly toolCalls: number;
	/** Tool executions that ended with `isError`. */
	readonly toolErrors: number;
	/** Most recent tool lines, oldest first, already formatted by `formatToolLine`. */
	readonly activity: readonly string[];
	/** Last notice / retry / compaction sentence worth showing, or null. */
	readonly note: string | null;
}

export interface TurnDigest {
	/** Concatenated assistant text of the turn. Empty string when the model said nothing. */
	readonly text: string;
	readonly toolCalls: number;
	readonly toolErrors: number;
	readonly steps: number;
	/** From `agent_end.telemetry` when present, else null. */
	readonly usd: number | null;
	readonly totalTokens: number | null;
	readonly errored: boolean;
	readonly aborted: boolean;
	/** Every notice/error sentence seen this turn, in order, deduped. */
	readonly notes: readonly string[];
}

/** Longest argument fragment `formatToolLine` will keep. One phone line, roughly. */
const TOOL_ARG_BUDGET = 60;
/** Marks a tool line whose execution came back with `isError`. */
const TOOL_FAILURE_MARK = " ✗";
const DEFAULT_ACTIVITY_LIMIT = 8;

/** How much of the status block each section may claim before it is trimmed. */
const MODEL_BUDGET = 40;
const NOTE_BUDGET = 300;
const TODO_BUDGET = 110;
const TODO_LINES = 12;
const ACTIVITY_BUDGET = 140;
const ACTIVITY_LINES = 8;

/**
 * A soft break is only worth taking when it lands in the back part of the
 * window. Without this a leading newline would emit a two-character chunk and
 * the thread would fill with slivers.
 */
const MIN_BREAK_RATIO = 0.4;
/** Appended to a chunk that would otherwise end inside an open code fence. */
const FENCE_CLOSE = "\n```";

const PHASE_EMOJI: Readonly<Record<TurnPhase, string>> = {
	queued: "⏳",
	thinking: "🧠",
	working: "🔧",
	compacting: "📦",
	retrying: "🔁",
	done: "✅",
	error: "❌",
	aborted: "🛑",
};

const PHASE_LABEL: Readonly<Record<TurnPhase, string>> = {
	queued: "queued",
	thinking: "thinking",
	working: "working",
	compacting: "compacting context",
	retrying: "retrying",
	done: "done",
	error: "error",
	aborted: "aborted",
};

/** Checkbox glyphs for the todo statuses the agent's todo tool can produce. */
const TODO_MARK: Readonly<Record<string, string>> = {
	completed: "[x]",
	in_progress: "[~]",
	pending: "[ ]",
	blocked: "[!]",
	abandoned: "[-]",
};

type SessionMessage = Extract<AgentSessionEvent, { type: "message_end" }>["message"];
type AssistantMessageLike = Extract<SessionMessage, { role: "assistant" }>;

interface ActivityEntry {
	readonly toolCallId: string;
	readonly line: string;
	failed: boolean;
}

/**
 * Folds one turn's worth of `AgentSessionEvent`s into a renderable status and a
 * final digest.
 */
export class TurnAccumulator {
	readonly #activityLimit: number;
	#revision = 0;
	#dirty = false;
	#started = false;
	#finished = false;
	#compacting = 0;
	#retrying = 0;
	#aborted = false;
	#noticeError = false;
	#telemetryError = false;
	/** Tracks only the *newest* assistant message, so a recovered turn stops reading as failed. */
	#messageError = false;
	#model: string | null = null;
	#steps = 0;
	#toolCalls = 0;
	#toolErrors = 0;
	readonly #pending = new Set<string>();
	readonly #activity: ActivityEntry[] = [];
	#activityLines: readonly string[] | null = null;
	readonly #notes: string[] = [];
	readonly #seenNotes = new Set<string>();
	readonly #texts: string[] = [];
	#usd: number | null = null;
	#totalTokens: number | null = null;
	#todos: readonly TodoLine[] = [];

	constructor(options?: { readonly activityLimit?: number }) {
		const limit = options?.activityLimit;
		this.#activityLimit = typeof limit === "number" && limit > 0 ? Math.floor(limit) : DEFAULT_ACTIVITY_LIMIT;
	}

	/**
	 * Absorb one event. The revision only moves when the rendered output would
	 * actually differ, which is what keeps the edit rate near the phase/tool
	 * cadence instead of the token cadence.
	 */
	push(event: AgentSessionEvent): void {
		if (typeof event !== "object" || event === null || typeof event.type !== "string") return;
		const phaseBefore = this.#phase();
		this.#dirty = false;
		this.#apply(event);
		if (this.#dirty || this.#phase() !== phaseBefore) this.#revision++;
	}

	setTodos(todos: readonly TodoLine[]): void {
		if (this.#applyTodos(todos)) this.#revision++;
	}

	/** Bumps whenever `status()` or `todos()` would render differently. */
	get revision(): number {
		return this.#revision;
	}

	/** True once a terminal `agent_end` (`isTerminal !== false`) arrived. */
	get finished(): boolean {
		return this.#finished;
	}

	status(): TurnStatus {
		return {
			phase: this.#phase(),
			model: this.#model,
			steps: this.#steps,
			toolCalls: this.#toolCalls,
			toolErrors: this.#toolErrors,
			activity: this.#renderActivity(),
			note: this.#notes.length > 0 ? this.#notes[this.#notes.length - 1] : null,
		};
	}

	todos(): readonly TodoLine[] {
		return this.#todos;
	}

	digest(): TurnDigest {
		return {
			text: this.#texts.join("\n\n").trim(),
			toolCalls: this.#toolCalls,
			toolErrors: this.#toolErrors,
			steps: this.#steps,
			usd: this.#usd,
			totalTokens: this.#totalTokens,
			errored: this.#errored(),
			aborted: this.#aborted,
			notes: this.#notes,
		};
	}

	#apply(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
			case "turn_start":
				this.#started = true;
				return;

			case "agent_end": {
				// A non-terminal end means an async delivery will resume this session;
				// treating it as final would freeze the thread on a half-done turn.
				if (event.isTerminal === false) return;
				this.#finished = true;
				this.#started = true;
				const telemetry = event.telemetry;
				if (telemetry) {
					this.#totalTokens = finiteOrNull(telemetry.usage?.totalTokens);
					this.#usd = finiteOrNull(telemetry.cost?.estimatedUsd);
					if ((telemetry.errors?.total ?? 0) > 0) this.#telemetryError = true;
				}
				return;
			}

			case "message_start":
			case "message_end": {
				const message = event.message;
				if (typeof message !== "object" || message === null || message.role !== "assistant") return;
				this.#started = true;
				this.#setModel(message.model);
				const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
				this.#messageError = errorMessage.length > 0;
				if (this.#messageError) this.#addNote(errorMessage);
				if (message.stopReason === "aborted") this.#aborted = true;
				if (event.type === "message_end") this.#recordAssistantTurn(message);
				return;
			}

			case "message_update": {
				// Deltas arrive per token; only an abort changes anything renderable.
				const update = event.assistantMessageEvent;
				if (update?.type === "error" && update.reason === "aborted") this.#aborted = true;
				return;
			}

			case "tool_execution_start":
				this.#pending.add(event.toolCallId);
				this.#toolCalls++;
				this.#appendActivity(event.toolCallId, formatToolLine(event.toolName, event.args, event.intent));
				this.#dirty = true;
				return;

			case "tool_execution_end":
				this.#pending.delete(event.toolCallId);
				if (event.isError === true) {
					this.#toolErrors++;
					this.#markFailed(event.toolCallId);
					this.#dirty = true;
				}
				return;

			case "auto_compaction_start":
				this.#compacting++;
				this.#addNote(`Compacting context (${event.reason})`);
				return;

			case "auto_compaction_end":
				this.#compacting = Math.max(0, this.#compacting - 1);
				if (typeof event.errorMessage === "string" && event.errorMessage.length > 0) {
					this.#addNote(`Compaction failed: ${event.errorMessage}`);
				}
				return;

			case "auto_retry_start":
				this.#retrying++;
				this.#addNote(`Retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`);
				return;

			case "auto_retry_end":
				this.#retrying = Math.max(0, this.#retrying - 1);
				if (!event.success) {
					const detail =
						typeof event.finalError === "string" && event.finalError.length > 0 ? `: ${event.finalError}` : "";
					this.#addNote(`Retry gave up after attempt ${event.attempt}${detail}`);
				}
				return;

			case "retry_fallback_applied":
				this.#addNote(`Model fallback: ${event.from} → ${event.to} (${event.role})`);
				return;

			case "notice":
				if (event.level === "error") this.#noticeError = true;
				this.#addNote(event.level === "info" ? event.message : `${event.level}: ${event.message}`);
				return;

			case "todo_reminder":
				// The reminder carries the agent's current list, so it doubles as a todo
				// feed for sessions where nothing else polls the todo state.
				if (this.#applyTodos(toTodoLines(event.todos))) this.#dirty = true;
				return;

			default:
				// Unknown and future event types are not an error: an older bot must keep
				// rendering a newer agent's session.
				return;
		}
	}

	#recordAssistantTurn(message: AssistantMessageLike): void {
		this.#steps++;
		this.#dirty = true;
		const content = message.content;
		if (!Array.isArray(content)) return;
		for (const block of content) {
			// Thinking is deliberately dropped: it is long, it is not an answer, and it
			// is the first thing that would blow the message budget.
			if (block?.type !== "text") continue;
			const text = typeof block.text === "string" ? block.text.trim() : "";
			if (text.length > 0) this.#texts.push(text);
		}
	}

	#applyTodos(todos: readonly TodoLine[]): boolean {
		if (sameTodos(this.#todos, todos)) return false;
		this.#todos = todos.slice();
		return true;
	}

	#setModel(model: unknown): void {
		if (typeof model !== "string" || model.length === 0 || model === this.#model) return;
		this.#model = model;
		this.#dirty = true;
	}

	#addNote(text: string): void {
		const line = collapse(text);
		if (line.length === 0 || this.#seenNotes.has(line)) return;
		this.#seenNotes.add(line);
		this.#notes.push(line);
		this.#dirty = true;
	}

	#appendActivity(toolCallId: string, line: string): void {
		this.#activity.push({ toolCallId, line, failed: false });
		const overflow = this.#activity.length - this.#activityLimit;
		if (overflow > 0) this.#activity.splice(0, overflow);
		this.#activityLines = null;
	}

	#markFailed(toolCallId: string): void {
		for (let index = this.#activity.length - 1; index >= 0; index--) {
			const entry = this.#activity[index];
			if (entry.toolCallId !== toolCallId || entry.failed) continue;
			entry.failed = true;
			this.#activityLines = null;
			return;
		}
	}

	#renderActivity(): readonly string[] {
		if (this.#activityLines === null) {
			this.#activityLines = this.#activity.map(entry =>
				entry.failed ? entry.line + TOOL_FAILURE_MARK : entry.line,
			);
		}
		return this.#activityLines;
	}

	#errored(): boolean {
		return this.#messageError || this.#noticeError || this.#telemetryError;
	}

	/**
	 * An abort outranks an error (the user asked for the stop, the error is just
	 * its shape), and a clean `done` never paints over either. While the run is
	 * still moving, the transient states win: "retrying" is more useful on a
	 * phone than the error that triggered the retry.
	 */
	#phase(): TurnPhase {
		if (this.#aborted) return "aborted";
		if (this.#finished) return this.#errored() ? "error" : "done";
		if (this.#retrying > 0) return "retrying";
		if (this.#compacting > 0) return "compacting";
		if (this.#errored()) return "error";
		if (!this.#started) return "queued";
		return this.#pending.size > 0 ? "working" : "thinking";
	}
}

/** One compact line describing a tool call, e.g. `` `read` docs/rpc.md `` . */
export function formatToolLine(toolName: string, args: unknown, intent?: string): string {
	const name = typeof toolName === "string" && toolName.length > 0 ? toolName.replaceAll("`", "") : "tool";
	const argument = clamp(collapse(toolArgument(name, args, intent)), TOOL_ARG_BUDGET);
	return argument.length > 0 ? `\`${name}\` ${argument}` : `\`${name}\``;
}

/**
 * The live status block posted while a turn runs. MUST always return a string
 * of at most `DISCORD_MESSAGE_LIMIT` characters, shrinking activity then todos
 * then the note until it fits.
 */
export function renderStatus(status: TurnStatus, todos: readonly TodoLine[], elapsedMs: number): string {
	const phase = status.phase;
	const emoji = PHASE_EMOJI[phase] ?? "•";
	const label = PHASE_LABEL[phase] ?? String(phase);
	const model =
		typeof status.model === "string" && status.model.length > 0 ? ` · ${clamp(status.model, MODEL_BUDGET)}` : "";
	const header: string[] = [`${emoji} **${label}** · ${formatDurationMs(elapsedMs)}${model}`];
	const counters = renderCounters(status);
	if (counters !== null) header.push(counters);

	let budget = DISCORD_MESSAGE_LIMIT - joinedLength(header);

	// The note is claimed first and printed last: it is the one line that usually
	// explains why the turn looks stuck, so it must survive every trim.
	const note =
		typeof status.note === "string" && status.note.length > 0
			? `> ${clamp(collapse(status.note), NOTE_BUDGET)}`
			: null;
	const noteLines: string[] = [];
	if (note !== null && note.length + 1 <= budget) {
		noteLines.push(note);
		budget -= note.length + 1;
	}

	const todoSection = fitSection(Array.isArray(todos) ? todos.map(renderTodoLine) : [], TODO_LINES, budget);
	budget -= todoSection.used;

	const activitySection = fitSection(
		(Array.isArray(status.activity) ? status.activity : []).map(line => clamp(collapse(line), ACTIVITY_BUDGET)),
		ACTIVITY_LINES,
		budget,
	);

	const rendered = [...header, ...todoSection.lines, ...activitySection.lines, ...noteLines].join("\n");
	// Belt and braces: a failed edit is worse than a clipped line.
	return rendered.length <= DISCORD_MESSAGE_LIMIT ? rendered : clamp(rendered, DISCORD_MESSAGE_LIMIT);
}

/** The footer line appended to a finished turn. */
export function renderFooter(digest: TurnDigest, elapsedMs: number): string {
	const outcome = digest.aborted ? "🛑 aborted" : digest.errored ? "❌ finished with errors" : "✅ done";
	const parts: string[] = [
		formatDurationMs(elapsedMs),
		`${digest.steps} ${plural(digest.steps, "step")}`,
		`${digest.toolCalls} ${plural(digest.toolCalls, "tool")}`,
	];
	if (digest.toolErrors > 0) parts.push(`${digest.toolErrors} failed`);
	const tokens = finiteOrNull(digest.totalTokens);
	// `\B(?=(\d{3})+(?!\d))` is a thousands-separator boundary: every position that
	// is not a word edge and has a whole number of digit triples to its right.
	if (tokens !== null) parts.push(`${String(Math.round(tokens)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} tokens`);
	const usd = finiteOrNull(digest.usd);
	if (usd !== null) parts.push(`$${usd.toFixed(4)}`);
	return `-# ${outcome} · ${parts.join(" · ")}`;
}

/**
 * Split arbitrary text into Discord-postable chunks, none exceeding `limit`.
 *
 * The chunks partition the input exactly — nothing is trimmed away — apart from
 * the fence repair, which closes a chunk that would otherwise end inside a
 * ``` block and reopens it with the same info string. Without that repair one
 * long code block turns the rest of the thread into a single grey rectangle.
 */
export function splitForDiscord(text: string, limit: number = DISCORD_MESSAGE_LIMIT): string[] {
	if (typeof text !== "string" || text.trim().length === 0) return [];
	const cap = Math.max(1, Math.floor(limit));
	const chunks: string[] = [];
	let rest = text;
	let fence: FenceState = CLOSED_FENCE;

	while (rest.length > 0) {
		const reopen = fence.open === null ? "" : `${fence.open}\n`;
		let prefix = reopen;
		let suffix = "";
		let body = "";
		// Two passes: the first discovers whether the cut lands inside a fence, the
		// second re-cuts with room for the closing line.
		for (let pass = 0; pass < 2; pass++) {
			const available = cap - prefix.length - suffix.length;
			if (available < 1) {
				// The limit is too small to carry the repair at all. Overflowing the
				// message would fail the post outright, so the repair is what goes.
				prefix = "";
				suffix = "";
				body = rest.slice(0, breakPoint(rest, cap));
				break;
			}
			body = rest.length <= available ? rest : rest.slice(0, breakPoint(rest, available));
			if (scanFences(body, fence).open === null) {
				suffix = "";
				break;
			}
			if (suffix.length > 0) break;
			suffix = FENCE_CLOSE;
		}

		chunks.push(prefix + body + suffix);
		fence = scanFences(body, fence);
		rest = rest.slice(body.length);
	}

	return chunks;
}

export function formatDurationMs(milliseconds: number): string {
	const total = Number.isFinite(milliseconds) ? Math.max(0, Math.floor(milliseconds / 1000)) : 0;
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** The exact opener line of an unclosed fence, so the next chunk can replay it. */
interface FenceState {
	readonly open: string | null;
	readonly ticks: number;
}

const CLOSED_FENCE: FenceState = { open: null, ticks: 0 };

function scanFences(text: string, from: FenceState): FenceState {
	let state = from;
	let index = 0;
	while (index <= text.length) {
		const newline = text.indexOf("\n", index);
		state = applyFenceLine(text, index, newline === -1 ? text.length : newline, state);
		if (newline === -1) break;
		index = newline + 1;
	}
	return state;
}

function applyFenceLine(text: string, start: number, end: number, state: FenceState): FenceState {
	let cursor = start;
	while (cursor < end && (text[cursor] === " " || text[cursor] === "\t")) cursor++;
	let ticks = 0;
	while (cursor + ticks < end && text[cursor + ticks] === "`") ticks++;
	if (ticks < 3) return state;
	const info = text.slice(cursor + ticks, end).trim();
	if (state.open === null) return { open: "`".repeat(ticks) + info, ticks };
	// A closer must be at least as long as its opener and carry no info string.
	return ticks >= state.ticks && info.length === 0 ? CLOSED_FENCE : state;
}

/** Index just past the best break within `available` characters; always ≥ 1. */
function breakPoint(text: string, available: number): number {
	const floor = Math.max(1, Math.floor(available * MIN_BREAK_RATIO));
	const blank = text.lastIndexOf("\n\n", available - 2);
	if (blank >= 0 && blank + 2 >= floor && blank + 2 <= available) return blank + 2;
	const newline = text.lastIndexOf("\n", available - 1);
	if (newline >= 0 && newline + 1 >= floor && newline + 1 <= available) return newline + 1;
	const space = text.lastIndexOf(" ", available - 1);
	if (space >= 0 && space + 1 >= floor && space + 1 <= available) return space + 1;
	return available;
}

/**
 * Pick the one argument that tells a human what the tool is doing. A tool line
 * is a glance, not a log: the wrong field costs more space than it explains.
 */
function toolArgument(toolName: string, args: unknown, intent?: string): string {
	const fallback = typeof intent === "string" ? intent : "";
	switch (toolName) {
		case "read":
		case "write":
		case "edit":
			return readString(args, "path") ?? fallback;
		case "bash":
			return readString(args, "command") ?? fallback;
		case "grep":
			return readString(args, "pattern") ?? fallback;
		case "glob":
			return readString(args, "path") ?? readString(args, "pattern") ?? fallback;
		case "task": {
			const tasks = (args as { tasks?: unknown } | null | undefined)?.tasks;
			return (Array.isArray(tasks) ? readString(tasks[0], "name") : null) ?? fallback;
		}
		default:
			return fallback;
	}
}

/**
 * Tool arguments arrive off the RPC wire as `any`. Nothing here is worth a
 * schema: read the one field, accept any shape, never throw on a surprise.
 */
function readString(source: unknown, key: string): string | null {
	if (typeof source !== "object" || source === null) return null;
	const value = (source as Record<string, unknown>)[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function toTodoLines(todos: unknown): TodoLine[] {
	if (!Array.isArray(todos)) return [];
	const lines: TodoLine[] = [];
	for (const todo of todos) {
		const content = readString(todo, "content");
		if (content === null) continue;
		lines.push({ content, status: readString(todo, "status") ?? "pending" });
	}
	return lines;
}

function sameTodos(left: readonly TodoLine[], right: readonly TodoLine[]): boolean {
	if (left === right) return true;
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) {
		if (left[index].content !== right[index].content || left[index].status !== right[index].status) return false;
	}
	return true;
}

/**
 * Take as many lines as `budget` allows, then own the truncation out loud: a
 * silently shortened todo list reads as a finished plan.
 */
function fitSection(source: readonly string[], maxLines: number, budget: number): { lines: string[]; used: number } {
	const lines: string[] = [];
	let used = 0;
	const wanted = Math.min(source.length, maxLines);
	for (let index = 0; index < wanted; index++) {
		const cost = source[index].length + 1;
		if (used + cost > budget) break;
		lines.push(source[index]);
		used += cost;
	}
	if (lines.length === source.length) return { lines, used };

	let more = `+${source.length - lines.length} more`;
	while (lines.length > 0 && used + more.length + 1 > budget) {
		const removed = lines.pop() as string;
		used -= removed.length + 1;
		more = `+${source.length - lines.length} more`;
	}
	if (used + more.length + 1 <= budget) {
		lines.push(more);
		used += more.length + 1;
	}
	return { lines, used };
}

function renderTodoLine(todo: TodoLine): string {
	const mark = TODO_MARK[todo?.status as string] ?? "[ ]";
	return `- ${mark} ${clamp(collapse(todo?.content ?? ""), TODO_BUDGET)}`;
}

function renderCounters(status: TurnStatus): string | null {
	if (status.steps === 0 && status.toolCalls === 0) return null;
	const parts = [
		`${status.steps} ${plural(status.steps, "step")}`,
		`${status.toolCalls} ${plural(status.toolCalls, "tool")}`,
	];
	if (status.toolErrors > 0) parts.push(`${status.toolErrors} failed`);
	return `-# ${parts.join(" · ")}`;
}

function joinedLength(lines: readonly string[]): number {
	let total = lines.length > 0 ? lines.length - 1 : 0;
	for (const line of lines) total += line.length;
	return total;
}

/** Newlines and runs of blanks collapse to one space: every line here is one line. */
function collapse(text: string): string {
	return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

function clamp(text: string, budget: number): string {
	if (budget <= 0) return "";
	return text.length <= budget ? text : `${text.slice(0, budget - 1)}…`;
}

function plural(count: number, word: string): string {
	return count === 1 ? word : `${word}s`;
}

function finiteOrNull(value: number | null | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
