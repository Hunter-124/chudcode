/**
 * Hello Tool - Minimal custom tool example
 *
 * Demonstrates using ExtensionAPI's logger and injected schema builder.
 */
import type { ExtensionAPI } from "@chudware/coding-agent";

export default function (chud: ExtensionAPI) {
	const z = chud.zod;

	chud.registerTool({
		name: "hello",
		label: "Hello",
		description: "A simple greeting tool",
		parameters: z.object({
			name: z.string().describe("Name to greet"),
		}),

		async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
			const { name } = params;

			// Use logger for debugging
			chud.logger.debug("Hello tool executed", { name });

			return {
				content: [{ type: "text", text: `Hello, ${name}!` }],
				details: { greeted: name },
			};
		},
	});
}
