/**
 * Pure image inventory over a session's message array.
 *
 * `history://` renders transcripts as concise markdown
 * (`session-history-format.ts`), collapsing every `ImageContent` block to a
 * `[image]`/`[image #N]` token — pixels never survive that render. This
 * module walks the same message array and collects the underlying image
 * blocks themselves, numbered in the exact encounter order
 * `formatSessionHistoryMarkdown` uses for its DEFAULT-options render (the one
 * every `history://` call site actually uses: no `watchedRoles`,
 * `expandPrimaryContext`, `includeToolIntent`, or `expandEditDiffs`), so a
 * `[image #N]` token in the rendered transcript and the `#N` row in
 * `history://<id>/images` name the same image.
 *
 * Custom/hook messages are intentionally NOT walked: their default-branch
 * render (`customOneliner`'s `default:` case) is gated behind a `display`
 * flag and a customType allowlist that would have to be duplicated here to
 * stay in sync, and in practice their content never carries raw
 * `ImageContent` blocks (e.g. `image-attachment-description` carries a text
 * vision description, not pixels). Assistant messages' OWN inline `image`
 * content blocks are likewise not walked: the render's assistant loop never
 * calls `contentToText` on them (only `text`/`toolCall`/`thinking` blocks are
 * handled), so they carry no `[image #N]` token to agree with.
 */

/** One image block recovered from a session transcript. */
export interface SessionImageRef {
	/** 1-based index in transcript order, stable across the whole message array. */
	index: number;
	mimeType: string;
	/** Message role the image was attached to ("user", "assistant", "toolResult", ...). */
	role: string;
	/** Raw `ImageContent.data`: either base64 or a `blob:sha256:<hash>` reference. */
	data: string;
}

interface RawImageBlock {
	mimeType: string;
	data: string;
}

/** Narrow an unknown content block to an `ImageContent` shape without importing the type
 *  (entries come from `unknown[]`, possibly stale/foreign shapes off disk). */
function asImageBlock(block: unknown): RawImageBlock | undefined {
	if (!block || typeof block !== "object") return undefined;
	const b = block as Record<string, unknown>;
	if (b.type !== "image" || typeof b.data !== "string" || typeof b.mimeType !== "string") return undefined;
	return { mimeType: b.mimeType, data: b.data };
}

/** Extract every image block from a string-or-blocks content field, in order. String content
 *  (plain text) never carries images. */
function imagesFromContent(content: unknown): RawImageBlock[] {
	if (!Array.isArray(content)) return [];
	const images: RawImageBlock[] = [];
	for (const block of content) {
		const image = asImageBlock(block);
		if (image) images.push(image);
	}
	return images;
}

/**
 * Walk a session's message array and collect every image block, numbered to
 * agree with the `[image #N]` tokens `formatSessionHistoryMarkdown` emits for
 * the same array.
 *
 * Mirrors the render's tool-pair collapsing exactly: a toolResult consumed by
 * a matching assistant toolCall is walked at the ASSISTANT message's
 * position (the render never re-visits the toolResult itself once
 * consumed), not at the toolResult's own position; an orphaned toolResult
 * (no matching toolCall — e.g. truncated history) is walked at its own
 * position, same as the render's orphan-line fallback.
 *
 * Defensive: entries are `unknown` — missing/non-array content, string
 * content, and non-object blocks are all tolerated silently rather than
 * thrown on.
 */
export function collectSessionImages(messages: unknown[]): SessionImageRef[] {
	// Pre-index toolResults by call id, exactly like formatSessionHistoryMarkdown's
	// local (non-chunked) index: last write wins, built before the main walk.
	const resultsByCallId = new Map<string, { content: unknown }>();
	for (const raw of messages) {
		if (!raw || typeof raw !== "object") continue;
		const msg = raw as Record<string, unknown>;
		if (msg.role === "toolResult" && typeof msg.toolCallId === "string") {
			resultsByCallId.set(msg.toolCallId, { content: msg.content });
		}
	}

	const refs: SessionImageRef[] = [];
	let index = 0;
	const pushImages = (role: string, content: unknown): void => {
		for (const image of imagesFromContent(content)) {
			index += 1;
			refs.push({ index, mimeType: image.mimeType, role, data: image.data });
		}
	};

	const consumed = new Set<string>();
	for (const raw of messages) {
		if (!raw || typeof raw !== "object") continue;
		const msg = raw as Record<string, unknown>;
		switch (msg.role) {
			case "user":
			case "developer":
				pushImages(msg.role, msg.content);
				break;
			case "assistant": {
				const content = msg.content;
				if (!Array.isArray(content)) break;
				for (const block of content) {
					if (!block || typeof block !== "object") continue;
					const b = block as Record<string, unknown>;
					if (b.type !== "toolCall" || typeof b.id !== "string") continue;
					const result = resultsByCallId.get(b.id);
					if (!result) continue;
					consumed.add(b.id);
					pushImages("toolResult", result.content);
				}
				break;
			}
			case "toolResult": {
				const toolCallId = msg.toolCallId;
				if (typeof toolCallId === "string" && consumed.has(toolCallId)) break;
				pushImages("toolResult", msg.content);
				break;
			}
			default:
				break;
		}
	}

	return refs;
}
