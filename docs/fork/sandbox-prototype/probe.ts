#!/usr/bin/env bun
/**
 * Read-only capability probe for Chudware Code's real desktop backend (@oh-my-pi/pi-natives).
 * Prints capabilities + enumerable windows for whatever display the *environment*
 * points at. No capture, no input: safe to run against the user's live session.
 */
import { createDesktopSession } from "@oh-my-pi/pi-natives/desktop";

const session = createDesktopSession({ display: "all" });
console.log(
	JSON.stringify(
		{
			env: {
				DISPLAY: process.env.DISPLAY ?? null,
				WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? null,
				XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE ?? null,
			},
			capabilities: session.capabilities,
		},
		null,
		2,
	),
);
try {
	const windows = await session.listWindows();
	console.log(
		"windows:",
		JSON.stringify(
			windows.map(w => ({ id: w.id, app: w.app, title: w.title, w: w.width, h: w.height })),
			null,
			2,
		),
	);
} catch (error) {
	console.log("windows: ERROR", String(error));
}
try {
	console.log("displays:", JSON.stringify(await session.listDisplays()));
} catch (error) {
	console.log("displays: ERROR", String(error));
}
await session.close();
