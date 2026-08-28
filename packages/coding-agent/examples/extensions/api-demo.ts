/**
 * API Demo Extension
 *
 * Demonstrates using ExtensionAPI's logger, injected schema builder, and chud
 * module access.
 */
import type { ExtensionAPI } from "@chudware/coding-agent";

export default function (chud: ExtensionAPI) {
	const z = chud.zod;

	// Access the logger for debugging
	chud.logger.debug("API demo extension loaded");

	chud.registerTool({
		name: "api_demo",
		label: "API Demo",
		description: "Demonstrates ExtensionAPI capabilities: logger, schema validation, and chud module access",
		parameters: z.object({
			message: z.string().describe("Test message"),
			logLevel: z.enum(["error", "warn", "debug"]).default("debug").describe("Log level to use"),
		}),

		async execute(_toolCallId, params, _onUpdate, ctx, _signal) {
			const { message, logLevel } = params;

			// Use logger at specified level
			chud.logger[logLevel]("API demo tool executed", { message, logLevel });

			// Access chud module utilities
			const { logger: piLogger } = chud.pi;
			piLogger.debug("Accessed chud module from extension", { sessionFile: ctx.sessionManager.getSessionFile() });

			// Get session information
			const sessionInfo = `Session: ${ctx.sessionManager.getSessionFile()}`;
			const modelInfo = ctx.model ? `Model: ${ctx.model.id}` : "Model: none";

			return {
				content: [
					{
						type: "text",
						text: [
							`API Demo Tool executed successfully!`,
							``,
							`Message: ${message}`,
							`Log Level: ${logLevel}`,
							``,
							`Features demonstrated:`,
							`1. ✓ Logger access via chud.logger`,
							`2. ✓ Schema builder access via chud.arktype`,
							`3. ✓ Chud module access via chud.pi`,
							``,
							`Context:`,
							`- ${sessionInfo}`,
							`- ${modelInfo}`,
							`- CWD: ${ctx.cwd}`,
						].join("\n"),
					},
				],
				details: {
					message,
					logLevel,
					sessionFile: ctx.sessionManager.getSessionFile(),
					modelId: ctx.model?.id,
				},
			};
		},
	});

	// Demonstrate event handling with logger
	chud.on("session_start", async () => {
		chud.logger.debug("Session started", { extension: "api-demo" });
	});

	chud.on("agent_start", async () => {
		chud.logger.debug("Agent started", { extension: "api-demo" });
	});
}
