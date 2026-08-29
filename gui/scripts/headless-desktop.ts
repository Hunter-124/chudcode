/**
 * Starts the Chudcode desktop server with no attached client and prints the
 * native-GUI connection details as a single JSON line on stdout, then blocks
 * until it receives SIGINT/SIGTERM. Used by `capture.sh` so screenshot runs get
 * a real runtime (workspace, sessions, git, terminal) instead of the offline
 * "Reconnecting" shell.
 *
 * Usage: bun gui/scripts/headless-desktop.ts [projectDir]
 */
import { desktopWebSocketUrl, launchDesktop } from "../../packages/chudcode-desktop/src/launch";

const cwd = process.argv[2] ?? process.cwd();

// `launchDesktop` always attaches a client; neutering `which`/`spawn` keeps the
// server headless without forking the launch path.
const desktop = await launchDesktop({
	cwd,
	client: "browser",
	browser: {
		which: () => null,
		spawn: () => ({}),
		print: () => {},
	},
});

process.stdout.write(
	`${JSON.stringify({
		url: desktop.url,
		wsUrl: desktopWebSocketUrl(desktop.url),
		token: desktop.token,
		reused: desktop.reused,
	})}\n`,
);

let shuttingDown = false;
const shutdown = async (): Promise<void> => {
	if (shuttingDown) return;
	shuttingDown = true;
	await desktop.stop();
	process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await new Promise<never>(() => {});
