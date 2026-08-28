/**
 * Status Line Hook
 *
 * Demonstrates ctx.ui.setStatus() for displaying persistent status text in the footer.
 * Shows plain-text turn progress across session and turn events.
 */
import type { HookAPI } from "@chudware/coding-agent";

export default function (chud: HookAPI) {
	let turnCount = 0;

	chud.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("status-demo", "Ready");
	});

	chud.on("turn_start", async (_event, ctx) => {
		turnCount++;
		ctx.ui.setStatus("status-demo", `● Turn ${turnCount}…`);
	});

	chud.on("turn_end", async (_event, ctx) => {
		ctx.ui.setStatus("status-demo", `✓ Turn ${turnCount} complete`);
	});

	chud.on("session_switch", async (event, ctx) => {
		if (event.reason === "new") {
			turnCount = 0;
			ctx.ui.setStatus("status-demo", "Ready");
		}
	});
}
