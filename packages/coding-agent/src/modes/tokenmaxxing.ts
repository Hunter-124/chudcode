import { prompt } from "@chudware/utils";
import tokenmaxxingNotice from "../prompts/system/tokenmaxxing-notice.md" with { type: "text" };
import { createGradientHighlighter, type KeywordHighlighter } from "./gradient-highlight";
import { magicKeywordRegex } from "./magic-keyword-boundary";
import { keywordInProse } from "./markdown-prose";

/**
 * "tokenmaxxing" keyword support.
 *
 * Typing the standalone word in the input editor paints it with a bold
 * gold→hot-pink gradient sweeping at three times the base shimmer rate
 * ({@link highlightTokenmaxxing}); submitting a message that mentions it forces
 * the model's highest supported thinking level (like "ultrathink") and appends a
 * hidden {@link renderTokenmaxxingNotice} routing contract that picks the
 * strongest applicable execution harness — intent verification, parallel
 * research, `task` dispatch, or programmatic `eval` fan-out — instead of
 * stacking every mode blindly. Matching is prose-delimited and case-sensitive
 * (lowercase only), so "tokenmaxxed", "Tokenmaxxing", or a path like
 * "tokenmaxxing.ts" never trigger any of it.
 */

// Detection: lowercase keyword flanked by prose punctuation, whitespace, or a string edge.
const TOKENMAXXING_WORD = magicKeywordRegex("tokenmaxxing");

/** Hidden system notice appended after a user message that mentions "tokenmaxxing". */
export function renderTokenmaxxingNotice(options: { tools: readonly string[]; scoutAvailable: boolean }): string {
	return prompt.render(tokenmaxxingNotice, { tools: options.tools, scoutAvailable: options.scoutAvailable }).trim();
}

/**
 * Whether `text` contains the standalone keyword "tokenmaxxing" (lowercase,
 * prose-delimited) in prose — never inside a code block, inline code span,
 * or XML/HTML section.
 */
export function containsTokenmaxxing(text: string): boolean {
	return keywordInProse(text, TOKENMAXXING_WORD);
}

/**
 * Highlight every standalone "tokenmaxxing" in `text` for editor display with a
 * bold gold→hot-pink gradient (hue 50..340, wrapping through red) that sweeps
 * three times per host shimmer cycle — the most intense palette of the magic
 * keywords, matching the strongest contract.
 */
export const highlightTokenmaxxing: KeywordHighlighter = createGradientHighlighter({
	probe: /tokenmaxxing/,
	highlight: magicKeywordRegex("tokenmaxxing", "g"),
	stops: 20,
	hue: t => (50 - t * 70 + 360) % 360,
	saturation: 100,
	lightness: 66,
	phaseScale: 3,
	bold: true,
});
