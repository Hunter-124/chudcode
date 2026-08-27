/**
 * Linux sleep inhibition via systemd-logind, plus a best-effort desktop
 * screensaver inhibit for the `display` level.
 *
 * ## Why `systemd-inhibit` and not a direct D-Bus call
 *
 * `org.freedesktop.login1.Manager.Inhibit` does not return a cookie — it
 * returns a **file descriptor**, and the lock lives exactly as long as that fd
 * stays open. Holding it therefore requires receiving an fd over the bus
 * (SCM_RIGHTS ancillary data). Bun's socket API exposes no ancillary-data
 * reception, and there is no D-Bus binding in this repo (`pi-tui`'s
 * `desktop-notify.ts` shells out to `gdbus`/`notify-send` for the same reason).
 * Nor can an out-of-process CLI stand in: `gdbus call` and `busctl call` exit
 * as soon as the reply arrives, which closes the fd and drops the lock
 * instantly — a one-shot D-Bus CLI physically cannot hold a logind inhibitor.
 *
 * `systemd-inhibit` is systemd's own holder for exactly this: it makes the same
 * `Inhibit` call with `mode=block` and keeps the fd open for the lifetime of
 * the command it runs. We run `cat` with a pipe on stdin, so the lock is
 * released two ways:
 *  - deliberately, when we kill the child on release; and
 *  - automatically, when omp dies for *any* reason (even SIGKILL) — the pipe's
 *    write end closes, `cat` sees EOF and exits, and the fd closes with it.
 *
 * That second property is the point: a leaked idle inhibitor outliving omp
 * would keep the machine awake indefinitely, which is worse than the bug this
 * replaces.
 *
 * ## Screensaver
 *
 * logind's `idle` lock blocks logind's own `IdleAction`; it does not stop a
 * desktop's screen dimming/blanking, which is driven by the desktop's power
 * manager and inhibited through `org.freedesktop.ScreenSaver`. That interface
 * is cookie-based and connection-scoped, so we hold it over our own session-bus
 * connection (see `dbus.ts`). Absent on headless servers and on desktops that
 * do not implement it — failure is logged at debug level and ignored.
 */

import { logger } from "@oh-my-pi/pi-utils";
import { DBusSessionConnection, parseDBusUnixPath } from "./dbus";
import {
	type PowerInhibitorBackend,
	type PowerInhibitorHandle,
	type PowerInhibitorRequest,
	powerInhibitPlan,
} from "./types";

const SCREENSAVER_DESTINATION = "org.freedesktop.ScreenSaver";
const SCREENSAVER_PATH = "/org/freedesktop/ScreenSaver";

/** logind inhibitor lock held by a `systemd-inhibit` child, plus an optional
 *  screensaver inhibit held by our own session-bus connection. */
class LinuxInhibitorHandle implements PowerInhibitorHandle {
	#child: Bun.Subprocess<"pipe", "ignore", "ignore"> | undefined;
	#screenSaver: DBusSessionConnection | undefined;
	#released = false;

	constructor(child: Bun.Subprocess<"pipe", "ignore", "ignore">, request: PowerInhibitorRequest) {
		this.#child = child;
		if (powerInhibitPlan(request.mode).display) void this.#inhibitScreenSaver(request);
	}

	async #inhibitScreenSaver(request: PowerInhibitorRequest): Promise<void> {
		const socketPath = parseDBusUnixPath(Bun.env.DBUS_SESSION_BUS_ADDRESS);
		if (!socketPath) return;
		let connection: DBusSessionConnection | undefined;
		try {
			connection = await DBusSessionConnection.open(socketPath);
			await connection.call({
				destination: SCREENSAVER_DESTINATION,
				path: SCREENSAVER_PATH,
				iface: SCREENSAVER_DESTINATION,
				member: "Inhibit",
				signature: "ss",
				args: [request.who, request.why],
			});
		} catch (error) {
			connection?.close();
			logger.debug("Screensaver inhibit unavailable", { error: String(error) });
			return;
		}
		// Release may have run while the handshake was in flight.
		if (this.#released) {
			connection.close();
			return;
		}
		this.#screenSaver = connection;
	}

	release(): void {
		if (this.#released) return;
		this.#released = true;
		const child = this.#child;
		this.#child = undefined;
		const screenSaver = this.#screenSaver;
		this.#screenSaver = undefined;
		// Dropping the bus connection is what revokes the screensaver cookie:
		// freedesktop screensaver implementations release a caller's
		// inhibitions when its unique bus name disappears.
		screenSaver?.close();
		if (!child) return;
		try {
			// Closing stdin is the graceful path (`cat` exits on EOF, which
			// closes logind's fd); kill covers a child that ignores EOF.
			child.stdin.end();
			child.kill();
		} catch (error) {
			logger.debug("Failed to release logind inhibitor", { error: String(error) });
		}
	}
}

/** systemd-logind inhibitor backend. */
export class LogindPowerInhibitorBackend implements PowerInhibitorBackend {
	readonly id = "logind";

	acquire(request: PowerInhibitorRequest): PowerInhibitorHandle | undefined {
		const inhibitBin = Bun.which("systemd-inhibit");
		const holderBin = Bun.which("cat");
		if (!inhibitBin || !holderBin) {
			logger.debug("logind inhibitor unavailable", { inhibitBin, holderBin });
			return undefined;
		}
		const plan = powerInhibitPlan(request.mode);
		// `sleep` is only added at the `system` level: a blocking `sleep` lock
		// also refuses user-initiated suspend (lid close), which must not be
		// the default behaviour.
		const what = plan.system ? "idle:sleep" : "idle";
		try {
			const child = Bun.spawn(
				[inhibitBin, `--what=${what}`, `--who=${request.who}`, `--why=${request.why}`, "--mode=block", holderBin],
				{ stdin: "pipe", stdout: "ignore", stderr: "ignore" },
			);
			return new LinuxInhibitorHandle(child, request);
		} catch (error) {
			logger.debug("Failed to acquire logind inhibitor", { error: String(error) });
			return undefined;
		}
	}
}
