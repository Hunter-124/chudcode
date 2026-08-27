/**
 * Tiny-model UI labels for spawned subagents.
 */
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import taskLabelSystemPrompt from "../prompts/system/task-label.md" with { type: "text" };
import { generateSessionTitle } from "../utils/title-generator";

const TASK_LABEL_SYSTEM_PROMPT = prompt.render(taskLabelSystemPrompt);

const TASK_LABEL_TITLE_FRAGMENT_RE =
	/<\s*\/?\s*title(?:\s+[^<>]*?)?\s*\/?\s*>|<\s*\/?\s*title(?:\s+[^<>]*)?\s*\/?\s*$/gi;
const TASK_LABEL_MARKUP_RE = /<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s+[^<>]*?)?\s*\/?>/gi;

/**
 * Strip tag-shaped model output at the label commit and render boundaries.
 * Labels are single-line UI chrome, not prose, so removing markup is clearer
 * than displaying escaped noise. Requiring a valid tag-name boundary keeps
 * comma-bearing generics such as `Map<K,V>` and arrows byte-identical.
 */
export function sanitizeTaskLabel(label: string): string {
	return label.replace(TASK_LABEL_TITLE_FRAGMENT_RE, "").replace(TASK_LABEL_MARKUP_RE, "").trim();
}

/** Compresses a delegated assignment into a one-sentence UI label via the tiny title model — fired by the executor spawn path because the task wire schema no longer carries a `description`; null on empty input or failure. */
export async function generateTaskLabel(
	assignment: string,
	registry: ModelRegistry,
	settings: Settings,
	sessionId?: string,
	signal?: AbortSignal,
): Promise<string | null> {
	const text = assignment.trim();
	if (!text) return null;
	try {
		const generated = await generateSessionTitle(
			text,
			registry,
			settings,
			sessionId,
			undefined,
			undefined,
			TASK_LABEL_SYSTEM_PROMPT,
			signal,
		);
		if (!generated) return null;
		return sanitizeTaskLabel(generated) || null;
	} catch (err) {
		logger.debug("task-label: generation failed", {
			sessionId,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}
