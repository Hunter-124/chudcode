/**
 * Extensions Configuration
 *
 * Extensions intercept agent events and can register custom tools.
 * They provide a unified system for extensions, custom tools, commands, and more.
 *
 * Extension files are discovered from:
 * - ~/.chudcode/agent/extensions/ (legacy: ~/.pi/agent/extensions/)
 * - <cwd>/.chudcode/extensions/ (legacy: <cwd>/.pi/extensions/)
 * - Paths specified in settings.json "extensions" array
 * - Paths passed via --extension CLI flag
 *
 * An extension is a TypeScript file that exports a default function:
 *   export default function (chud: ExtensionAPI) { ... }
 */
import { createAgentSession, SessionManager } from "@chudware/coding-agent";

// Extensions are loaded from disk, not passed inline to createAgentSession.
// Use the discovery mechanism:
//   1. Place extension files in ~/.chudcode/agent/extensions/ or .chudcode/extensions/
//   2. Add paths to settings.json: { "extensions": ["./my-extension.ts"] }
//   3. Use --extension flag: chud --extension ./my-extension.ts

// To add additional extension paths beyond discovery:
const { session } = await createAgentSession({
	additionalExtensionPaths: ["./my-logging-extension.ts", "./my-safety-extension.ts"],
	sessionManager: SessionManager.inMemory(),
});

session.subscribe(event => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
});

await session.prompt("List files in the current directory.");
console.log();

// Example extension file (./my-logging-extension.ts):
/*
import type { ExtensionAPI } from "@chudware/coding-agent";

export default function (chud: ExtensionAPI) {
	const z = chud.zod;

	chud.on("agent_start", async () => {
		console.log("[Extension] Agent starting");
	});

	chud.on("tool_call", async (event) => {
		console.log(\`[Extension] Tool: \${event.toolName}\`);
		// Return { block: true, reason: "..." } to block execution
		return undefined;
	});

	chud.on("agent_end", async (event) => {
		console.log(\`[Extension] Done, \${event.messages.length} messages\`);
	});

	// Register a custom tool
	chud.registerTool({
		name: "my_tool",
		label: "My Tool",
		description: "Does something useful",
		parameters: z.object({
			input: z.string(),
		}),
		execute: async (_toolCallId, params, _onUpdate, _ctx, _signal) => ({
			content: [{ type: "text", text: \`Processed: \${params.input}\` }],
			details: {},
		}),
	});

	// Register a command
	chud.registerCommand("mycommand", {
		description: "Do something",
		handler: async (args, ctx) => {
			ctx.ui.notify(\`Command executed with: \${args}\`);
		},
	});
}
*/
