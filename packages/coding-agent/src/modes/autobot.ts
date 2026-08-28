import autobotNotice from "../prompts/system/autobot-notice.md" with { type: "text" };
import { createGradientHighlighter, type KeywordHighlighter } from "./gradient-highlight";
import { magicKeywordRegex } from "./magic-keyword-boundary";
import { keywordInProse } from "./markdown-prose";

/**
 * "autobot" keyword support.
 *
 * Typing the standalone word in the input editor paints it with a bold chrome
 * shimmer ({@link highlightAutobot}); submitting a message that mentions it
 * appends the hidden {@link AUTOBOT_NOTICE}, which grants standing authority for
 * the request: decide, execute, and finish without permission checkpoints, while
 * still representing the user's interests on destructive or externally
 * irreversible actions. Matching is prose-delimited and case-sensitive
 * (lowercase only), so "autobots", "Autobot", or a path like "autobot.ts" never
 * trigger either behavior.
 */

// Detection: lowercase keyword flanked by prose punctuation, whitespace, or a string edge.
const AUTOBOT_WORD = magicKeywordRegex("autobot");

/** Hidden system notice appended after a user message that mentions "autobot". */
export const AUTOBOT_NOTICE: string = autobotNotice.trim();

/**
 * Whether `text` contains the standalone keyword "autobot" (lowercase,
 * prose-delimited) in prose — never inside a code block, inline code span,
 * or XML/HTML section.
 */
export function containsAutobot(text: string): boolean {
	return keywordInProse(text, AUTOBOT_WORD);
}

/**
 * Highlight every standalone "autobot" in `text` for editor display with a bold
 * desaturated chrome gradient (hue 190..260 at low saturation and high
 * lightness) — a brushed-metal sheen that reads distinctly against the
 * saturated palettes of the other magic keywords.
 */
export const highlightAutobot: KeywordHighlighter = createGradientHighlighter({
	probe: /autobot/,
	highlight: magicKeywordRegex("autobot", "g"),
	stops: 16,
	hue: t => 190 + t * 70,
	saturation: 48,
	lightness: 78,
	phaseScale: 1.5,
	bold: true,
});
