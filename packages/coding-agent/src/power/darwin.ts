/**
 * macOS sleep inhibition, wrapping `pi-natives`' `MacOSPowerAssertion` in the
 * cross-platform backend contract. Behaviour is unchanged from before this
 * module existed: `idle` → `-i`, `display` → `-i -d`, `system` → `-i -d -s -u`.
 */

import { MacOSPowerAssertion } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import {
	type PowerInhibitorBackend,
	type PowerInhibitorHandle,
	type PowerInhibitorRequest,
	powerInhibitPlan,
} from "./types";

class MacOSInhibitorHandle implements PowerInhibitorHandle {
	#assertion: MacOSPowerAssertion | undefined;

	constructor(assertion: MacOSPowerAssertion) {
		this.#assertion = assertion;
	}

	release(): void {
		const assertion = this.#assertion;
		this.#assertion = undefined;
		if (!assertion) return;
		try {
			assertion.stop();
		} catch (error) {
			logger.debug("Failed to release macOS power assertion", { error: String(error) });
		}
	}
}

/** macOS power-assertion backend. */
export class MacOSPowerInhibitorBackend implements PowerInhibitorBackend {
	readonly id = "macos-power-assertion";

	acquire(request: PowerInhibitorRequest): PowerInhibitorHandle | undefined {
		const plan = powerInhibitPlan(request.mode);
		try {
			return new MacOSInhibitorHandle(
				MacOSPowerAssertion.start({
					reason: request.why,
					idle: plan.idle,
					display: plan.display,
					system: plan.system,
					// `caffeinate -u` declares the user active; only meaningful
					// alongside a full system-sleep block.
					user: plan.system,
				}),
			);
		} catch (error) {
			logger.debug("Failed to acquire macOS power assertion", { error: String(error) });
			return undefined;
		}
	}
}
