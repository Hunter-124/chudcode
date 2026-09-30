import { prompt } from "@oh-my-pi/pi-utils";
import autobotNotice from "../prompts/system/autobot-notice.md" with { type: "text" };
import jevifyNotice from "../prompts/system/jevify-notice.md" with { type: "text" };
import orchestrateNotice from "../prompts/system/orchestrate-notice.md" with { type: "text" };
import tokenmaxxingNotice from "../prompts/system/tokenmaxxing-notice.md" with { type: "text" };
import ultragoonNotice from "../prompts/system/ultragoon-notice.md" with { type: "text" };
import ultrathinkNotice from "../prompts/system/ultrathink-notice.md" with { type: "text" };
import workflowNotice from "../prompts/system/workflow-notice.md" with { type: "text" };

/**
 * Magic keywords: standalone lowercase prose words in a user prompt that
 * append a hidden, user-attributed notice for that turn and glow in the TUI.
 *
 * This table is the single source of truth. Every downstream surface derives
 * from it: the `magicKeywords.<id>` settings (`modes/settings.ts`), the notice
 * injection and `<id>-notice` message types (agent-session, queued-messages),
 * and the editor/bubble gradients (`setMagicKeywords` in pi-tui). Adding a
 * keyword means one row here plus its notice template under `prompts/system/`.
 */

/** Session facts a keyword notice may render against. */
export interface MagicKeywordContext {
	/** Enabled tool names for the turn. */
	tools: readonly string[];
	/** `task.batch`: whether `task` accepts a `tasks[]` array. */
	taskBatch: boolean;
	/** Whether the `scout` agent can be dispatched. */
	scoutAvailable: boolean;
	/** `eval.tools.enabled`: whether `@tool`-defined kernel tools exist. */
	evalTools: boolean;
}

/** One magic keyword: trigger word, gradient, settings copy, and the notice it injects. */
export interface MagicKeyword {
	/** Settings key suffix (`magicKeywords.<id>`) and notice message type prefix (`<id>-notice`). */
	id: string;
	/** Exact lowercase trigger, matched only as standalone prose. */
	word: string;
	/** Editor/bubble gradient as an HSL hue sweep `[from, to]` in degrees; `to` may exceed 360 to wrap. */
	hue: readonly [number, number];
	/** Settings panel label. */
	label: string;
	/** Settings panel description. */
	description: string;
	/** Tools that must all be enabled for the notice to apply; the notice is skipped otherwise. */
	requires: readonly string[];
	/** Render the hidden notice queued ahead of the user message. */
	notice: (context: MagicKeywordContext) => string;
}

/** Hidden notice for "ultrathink": careful multi-step reasoning. */
export const ULTRATHINK_NOTICE: string = ultrathinkNotice.trim();

/** Hidden notice for "jevify": bulk classification through the eval kernel's `judge()`. */
export const JEVIFY_NOTICE: string = jevifyNotice.trim();

/** Hidden notice for "autobot": standing authority without permission checkpoints. */
export const AUTOBOT_NOTICE: string = autobotNotice.trim();

/** Hidden notice for "ultragoon": intent-first research and execution. */
export function renderUltragoonNotice({
	tools,
	scoutAvailable,
}: Pick<MagicKeywordContext, "tools" | "scoutAvailable">): string {
	return prompt.render(ultragoonNotice, { tools, scoutAvailable }).trim();
}

/** Hidden notice for "tokenmaxxing": choose the strongest applicable harness. */
export function renderTokenmaxxingNotice({
	tools,
	scoutAvailable,
}: Pick<MagicKeywordContext, "tools" | "scoutAvailable">): string {
	return prompt.render(tokenmaxxingNotice, { tools, scoutAvailable }).trim();
}

/** Hidden notice for "orchestrate", naming only the tools the session actually exposes. */
export function renderOrchestrateNotice({ tools }: Pick<MagicKeywordContext, "tools">): string {
	return prompt.render(orchestrateNotice, { tools }).trim();
}

/** Hidden notice for "workflowz", shaped by the active task/eval capabilities. */
export function renderWorkflowNotice({
	taskBatch,
	scoutAvailable,
	evalTools,
}: Pick<MagicKeywordContext, "taskBatch" | "scoutAvailable" | "evalTools">): string {
	return prompt.render(workflowNotice, { taskBatch, scoutAvailable, evalTools }).trim();
}

export const MAGIC_KEYWORDS = [
	{
		id: "ultrathink",
		word: "ultrathink",
		hue: [0, 330],
		label: "Ultrathink Keyword",
		description: "Let standalone ultrathink request maximum automatic thinking and append its hidden notice",
		requires: [],
		notice: () => ULTRATHINK_NOTICE,
	},
	{
		id: "orchestrate",
		word: "orchestrate",
		hue: [150, 280],
		label: "Orchestrate Keyword",
		description: "Let standalone orchestrate append its hidden multi-agent orchestration notice",
		// The contract is entirely about `task` subagent dispatch.
		requires: ["task"],
		notice: renderOrchestrateNotice,
	},
	{
		id: "workflow",
		word: "workflowz",
		hue: [30, 150],
		label: "Workflow Keyword",
		description: "Let standalone workflowz append its hidden eval workflow notice",
		requires: ["task", "eval"],
		notice: renderWorkflowNotice,
	},
	{
		id: "jevify",
		word: "jevify",
		hue: [300, 420],
		label: "Jevify Keyword",
		description: "Let standalone jevify append its hidden bulk-judge classification notice",
		// The contract is entirely about the eval kernel's `judge()` helper.
		requires: ["eval"],
		notice: () => JEVIFY_NOTICE,
	},
	{
		id: "ultragoon",
		word: "ultragoon",
		hue: [330, 270],
		label: "Ultragoon Keyword",
		description: "Let standalone ultragoon append its hidden intent-first research notice",
		requires: [],
		notice: renderUltragoonNotice,
	},
	{
		id: "autobot",
		word: "autobot",
		hue: [190, 260],
		label: "Autobot Keyword",
		description: "Let standalone autobot append its hidden standing-authority notice",
		requires: [],
		notice: () => AUTOBOT_NOTICE,
	},
	{
		id: "tokenmaxxing",
		word: "tokenmaxxing",
		hue: [410, 340],
		label: "Tokenmaxxing Keyword",
		description: "Let standalone tokenmaxxing append its hidden capability-routing notice",
		requires: [],
		notice: renderTokenmaxxingNotice,
	},
] as const satisfies readonly MagicKeyword[];

/** Settings key suffix of a registered keyword. */
export type MagicKeywordId = (typeof MAGIC_KEYWORDS)[number]["id"];

/** Hidden custom-message type carrying a keyword's notice. */
export type MagicKeywordNoticeType = `${MagicKeywordId}-notice`;
