import { containsAutobot, highlightAutobot } from "./autobot";
import { containsOrchestrate, highlightOrchestrate } from "./orchestrate";
import { containsTokenmaxxing, highlightTokenmaxxing } from "./tokenmaxxing";
import { containsUltragoon, highlightUltragoon } from "./ultragoon";
import { containsUltrathink, highlightUltrathink } from "./ultrathink";
import { containsWorkflow, highlightWorkflow } from "./workflow";

/** Every magic keyword, paired with its substring probe and prose detector. */
const KEYWORDS = [
	{ word: "ultrathink", contains: containsUltrathink },
	{ word: "orchestrate", contains: containsOrchestrate },
	{ word: "workflowz", contains: containsWorkflow },
	{ word: "ultragoon", contains: containsUltragoon },
	{ word: "tokenmaxxing", contains: containsTokenmaxxing },
	{ word: "autobot", contains: containsAutobot },
] as const;

/**
 * Gradient-highlight every magic keyword ("ultrathink", "orchestrate",
 * "workflowz", "ultragoon", "tokenmaxxing", "autobot") that appears as
 * standalone prose, skipping any occurrence inside a code block, inline code
 * span, or XML/HTML section. Each highlighter paints its
 * own keyword with its own gradient, so chaining is order-independent — the
 * earlier passes only inject zero-width SGR escapes (no backticks or angle
 * brackets), which never confuse the later passes' markdown masking.
 *
 * `resetTo` is the SGR foreground sequence restored after each painted keyword;
 * pass the surrounding text color when decorating already-colored content (e.g.
 * a themed message bubble) so the gradient does not bleed into the rest of the
 * line. Defaults to a plain foreground reset for default-colored editor text.
 *
 * `phase` ∈ [0, 1) cyclically rotates each gradient — the editor passes a
 * `Date.now()`-derived value to animate a Claude-Code-style shimmer while a
 * keyword is on screen and the prompt is focused; sent message bubbles omit it
 * to keep the static gradient.
 */
export function highlightMagicKeywords(text: string, resetTo?: string, phase?: number): string {
	let out = highlightUltrathink(text, resetTo, phase);
	out = highlightOrchestrate(out, resetTo, phase);
	out = highlightWorkflow(out, resetTo, phase);
	out = highlightUltragoon(out, resetTo, phase);
	out = highlightTokenmaxxing(out, resetTo, phase);
	return highlightAutobot(out, resetTo, phase);
}

/**
 * Cheap test for "does this text contain any magic keyword as standalone prose?".
 * Short-circuits on substring probes before paying for the markdown-aware
 * prose check, so the common "no keyword in buffer" path is just a handful of
 * `String#indexOf`s.
 */
export function hasMagicKeyword(text: string): boolean {
	for (const keyword of KEYWORDS) {
		if (text.includes(keyword.word) && keyword.contains(text)) return true;
	}
	return false;
}
