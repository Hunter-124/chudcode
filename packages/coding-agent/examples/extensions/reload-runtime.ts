/**
 * Reload Runtime Extension
 *
 * Demonstrates ctx.reload() from ExtensionCommandContext and an LLM-callable
 * tool that queues a follow-up command to trigger reload.
 */

import type { ExtensionAPI } from "@chudware/coding-agent";

export default function (chud: ExtensionAPI) {
	const z = chud.zod;

	// Command entrypoint for reload.
	// Treat reload as terminal for this handler.
	chud.registerCommand("reload-runtime", {
		description: "Reload extensions, skills, prompts, and themes",
		handler: async (_args, ctx) => {
			await ctx.reload();
			return;
		},
	});

	// LLM-callable tool. Tools get ExtensionContext, so they cannot call ctx.reload() directly.
	// Instead, queue a follow-up user command that executes the command above.
	chud.registerTool({
		name: "reload_runtime",
		label: "Reload Runtime",
		description: "Reload extensions, skills, prompts, and themes",
		parameters: z.object({}),
		async execute() {
			chud.sendUserMessage("/reload-runtime", { deliverAs: "followUp" });
			return {
				content: [{ type: "text", text: "Queued /reload-runtime as a follow-up command." }],
				details: {},
			};
		},
	});
}
