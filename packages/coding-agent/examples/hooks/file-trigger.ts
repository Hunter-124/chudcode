/**
 * File Trigger Hook
 *
 * Watches a trigger file and injects its contents into the conversation.
 * Useful for external systems to send messages to the agent.
 *
 * Usage:
 *   echo "Run the tests" > /tmp/agent-trigger.txt
 */
import * as fs from "node:fs";
import type { HookAPI } from "@chudware/coding-agent";
import * as fsx from "@chudware/utils/fsx";

export default function (chud: HookAPI) {
	chud.on("session_start", async (_event, ctx) => {
		const triggerFile = "/tmp/agent-trigger.txt";

		fs.watch(triggerFile, async () => {
			try {
				const content = (await fsx.readText(triggerFile)).trim();
				if (content) {
					chud.sendMessage(
						{
							customType: "file-trigger",
							content: `External trigger: ${content}`,
							display: true,
						},
						true, // triggerTurn - get LLM to respond
					);
					await fsx.write(triggerFile, ""); // Clear after reading
				}
			} catch {
				// File might not exist yet
			}
		});

		if (ctx.hasUI) {
			ctx.ui.notify(`Watching ${triggerFile}`, "info");
		}
	});
}
