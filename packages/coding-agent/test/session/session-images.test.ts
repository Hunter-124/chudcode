/**
 * Contracts: pure image inventory over a session's message array.
 *
 * - Images are numbered in the same encounter order
 *   `formatSessionHistoryMarkdown` uses, so a `[image #N]` token in the
 *   rendered transcript and the Nth entry from `collectSessionImages` name
 *   the same image.
 * - A toolResult consumed by its matching assistant toolCall is counted at
 *   the assistant's position; an orphaned toolResult is counted at its own
 *   position.
 * - Defensive against `unknown[]` input: missing/non-array content, string
 *   content, and non-object blocks are tolerated without throwing.
 */
import { describe, expect, it } from "bun:test";
import { formatSessionHistoryMarkdown } from "@oh-my-pi/pi-coding-agent/session/session-history-format";
import { collectSessionImages } from "@oh-my-pi/pi-coding-agent/session/session-images";

const IMG_A = { type: "image", data: "aaaa-base64", mimeType: "image/png" };
const IMG_B = { type: "image", data: "bbbb-base64", mimeType: "image/jpeg" };
const IMG_C = { type: "image", data: "cccc-base64", mimeType: "image/webp" };

describe("collectSessionImages", () => {
	it("numbers images across user, consumed-toolResult, and developer roles in encounter order, agreeing with the transcript's [image #N] tokens", () => {
		const messages: unknown[] = [
			{ role: "user", content: [{ type: "text", text: "look at this" }, IMG_A], timestamp: 1 },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Taking a screenshot." },
					{ type: "toolCall", id: "tc-1", name: "screenshot", arguments: {} },
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test-model",
				usage: {},
				stopReason: "toolUse",
				timestamp: 2,
			},
			{ role: "toolResult", toolCallId: "tc-1", toolName: "screenshot", content: [IMG_B], isError: false, timestamp: 3 },
			{ role: "developer", content: [IMG_C], timestamp: 4 },
		];

		const images = collectSessionImages(messages);
		expect(images).toEqual([
			{ index: 1, role: "user", mimeType: "image/png", data: "aaaa-base64" },
			{ index: 2, role: "toolResult", mimeType: "image/jpeg", data: "bbbb-base64" },
			{ index: 3, role: "developer", mimeType: "image/webp", data: "cccc-base64" },
		]);

		const rendered = formatSessionHistoryMarkdown(messages);
		// User and developer content is rendered verbatim, so their numbered tokens
		// are directly visible and must agree with collectSessionImages' indices.
		expect(rendered).toContain("[image #1]");
		expect(rendered).toContain("[image #3]");
		// The consumed toolResult's image is walked (advancing the shared counter,
		// which is why the developer image above is correctly #3 and not #2) but its
		// token is never rendered — only the tool-call line's line count survives.
		expect(rendered).not.toContain("[image #2]");
		expect(rendered).toContain("→ screenshot({}) ⇒ ok · 1 line");
	});

	it("counts an orphaned toolResult's image at its own array position, not at a consuming toolCall", () => {
		const messages: unknown[] = [
			{ role: "user", content: [IMG_A], timestamp: 1 },
			// No assistant toolCall anywhere in this array references "orphan-1" —
			// e.g. truncated history dropped the assistant turn that issued it.
			{
				role: "toolResult",
				toolCallId: "orphan-1",
				toolName: "screenshot",
				content: [IMG_B],
				isError: false,
				timestamp: 2,
			},
			{ role: "user", content: [IMG_C], timestamp: 3 },
		];

		const images = collectSessionImages(messages);
		expect(images.map(i => i.role)).toEqual(["user", "toolResult", "user"]);
		expect(images.map(i => i.index)).toEqual([1, 2, 3]);

		const rendered = formatSessionHistoryMarkdown(messages);
		expect(rendered).toContain("[image #1]");
		expect(rendered).toContain("[image #3]");
		// Orphan toolResult renders its own line (unconsumed), still without a
		// visible token for the ok path.
		expect(rendered).toContain("→ screenshot() ⇒ ok · 1 line");
	});

	it("keeps an error-path toolResult's first-line preview as a bare [image], never numbered", () => {
		const messages: unknown[] = [
			{
				role: "toolResult",
				toolCallId: "orphan-err",
				toolName: "screenshot",
				content: [IMG_A],
				isError: true,
				timestamp: 1,
			},
		];

		expect(collectSessionImages(messages)).toEqual([
			{ index: 1, role: "toolResult", mimeType: "image/png", data: "aaaa-base64" },
		]);

		const rendered = formatSessionHistoryMarkdown(messages);
		expect(rendered).toContain("⇒ error · 1 line — [image]");
		expect(rendered).not.toContain("[image #1]");
	});

	it("returns an empty list for a transcript with no images", () => {
		const messages: unknown[] = [
			{ role: "user", content: "just text", timestamp: 1 },
			{ role: "user", content: [{ type: "text", text: "still just text" }], timestamp: 2 },
		];
		expect(collectSessionImages(messages)).toEqual([]);
	});

	it("returns an empty list for an empty message array", () => {
		expect(collectSessionImages([])).toEqual([]);
	});

	it("tolerates malformed/foreign entries without throwing: non-objects, missing content, string content, and non-object blocks", () => {
		const messages: unknown[] = [
			null,
			42,
			"a bare string entry",
			{ role: "user" }, // missing content entirely
			{ role: "user", content: "plain string content" },
			{ role: "user", content: [null, 1, "x", { type: "text" }, { type: "image" }, { type: "image", data: 5 }] },
			{ role: "assistant", content: "not an array" },
			{ role: "assistant" }, // missing content
			{ role: "toolResult" }, // missing toolCallId/content
			{ role: "user", content: [IMG_A] },
		];

		expect(() => collectSessionImages(messages)).not.toThrow();
		expect(collectSessionImages(messages)).toEqual([
			{ index: 1, role: "user", mimeType: "image/png", data: "aaaa-base64" },
		]);
	});
});
