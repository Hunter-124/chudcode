import { prompt } from "@oh-my-pi/pi-utils";
import ultragoonNotice from "../prompts/system/ultragoon-notice.md" with { type: "text" };
import { createGradientHighlighter, type KeywordHighlighter } from "./gradient-highlight";
import { magicKeywordRegex } from "./magic-keyword-boundary";
import { keywordInProse } from "./markdown-prose";

/**
 * "ultragoon" keyword support.
 *
 * Typing the standalone word in the input editor paints it with a bold
 * crimson→violet gradient that sweeps at twice the base shimmer rate
 * ({@link highlightUltragoon}); submitting a message that mentions it appends a
 * hidden {@link renderUltragoonNotice} notice that puts the turn into
 * intent-first mode: saturate the request with parallel read-only research,
 * surface the load-bearing decisions the user has not made yet, lock the
 * acceptance criteria, then execute against them. Matching is prose-delimited
 * and case-sensitive (lowercase only), so "ultragooning", "Ultragoon", or a path
 * like "ultragoon.ts" never trigger either behavior.
 */

// Detection: lowercase keyword flanked by prose punctuation, whitespace, or a string edge.
const ULTRAGOON_WORD = magicKeywordRegex("ultragoon");

/** Hidden system notice appended after a user message that mentions "ultragoon". */
export function renderUltragoonNotice(options: { tools: readonly string[]; scoutAvailable: boolean }): string {
	return prompt.render(ultragoonNotice, { tools: options.tools, scoutAvailable: options.scoutAvailable }).trim();
}

/**
 * Whether `text` contains the standalone keyword "ultragoon" (lowercase,
 * prose-delimited) in prose — never inside a code block, inline code span,
 * or XML/HTML section.
 */
export function containsUltragoon(text: string): boolean {
	return keywordInProse(text, ULTRAGOON_WORD);
}

/**
 * Highlight every standalone "ultragoon" in `text` for editor display with a
 * bold crimson→violet gradient (hue 330..270) that sweeps twice per host
 * shimmer cycle — visually distinct from ultrathink's rainbow, orchestrate's
 * teal→violet, and workflowz's amber→green.
 */
export const highlightUltragoon: KeywordHighlighter = createGradientHighlighter({
	probe: /ultragoon/,
	highlight: magicKeywordRegex("ultragoon", "g"),
	stops: 18,
	hue: t => 330 - t * 60,
	saturation: 100,
	lightness: 68,
	phaseScale: 2,
	bold: true,
});
