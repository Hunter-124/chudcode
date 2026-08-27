/**
 * Windows sleep inhibition via `SetThreadExecutionState` (kernel32).
 *
 * No new dependency: `bun:ffi`'s `dlopen` is already how this repo reaches
 * kernel32 (`src/eval/py/spawn-options.ts`, `pi-tui/src/terminal.ts`).
 *
 * Two Win32 details drive the shape of this file:
 *  - The execution-state request is **per thread** and is replaced, not stacked,
 *    by each call. Bun FFI calls run on the calling thread, so acquire/release
 *    must both happen on the JS main thread — which they do, since the session
 *    drives them. A single request/clear pair is therefore all that is needed.
 *  - The request dies with the process, so a crashed omp cannot leak it.
 */

import { dlopen, FFIType } from "bun:ffi";
import { logger } from "@oh-my-pi/pi-utils";
import {
	type PowerInhibitorBackend,
	type PowerInhibitorHandle,
	type PowerInhibitorRequest,
	powerInhibitPlan,
} from "./types";

/** EXECUTION_STATE flags from winbase.h. */
const ES_SYSTEM_REQUIRED = 0x0000_0001;
const ES_DISPLAY_REQUIRED = 0x0000_0002;
const ES_CONTINUOUS = 0x8000_0000;

/** The one kernel32 symbol this backend needs. */
interface Kernel32ExecutionState {
	SetThreadExecutionState: (flags: number) => number;
}

/** `null` once probing has failed, so a missing/blocked kernel32 is probed once. */
let cachedKernel32: Kernel32ExecutionState | null | undefined;

function loadKernel32(): Kernel32ExecutionState | null {
	if (cachedKernel32 !== undefined) return cachedKernel32;
	try {
		cachedKernel32 = dlopen("kernel32.dll", {
			SetThreadExecutionState: { args: [FFIType.u32], returns: FFIType.u32 },
		}).symbols;
	} catch (error) {
		logger.debug("SetThreadExecutionState unavailable", { error: String(error) });
		cachedKernel32 = null;
	}
	return cachedKernel32;
}

class WindowsInhibitorHandle implements PowerInhibitorHandle {
	#kernel32: Kernel32ExecutionState | undefined;

	constructor(kernel32: Kernel32ExecutionState) {
		this.#kernel32 = kernel32;
	}

	release(): void {
		const kernel32 = this.#kernel32;
		this.#kernel32 = undefined;
		if (!kernel32) return;
		try {
			// ES_CONTINUOUS with no requirement flags clears the standing request.
			kernel32.SetThreadExecutionState(ES_CONTINUOUS);
		} catch (error) {
			logger.debug("Failed to clear thread execution state", { error: String(error) });
		}
	}
}

/** Win32 execution-state backend. */
export class Win32PowerInhibitorBackend implements PowerInhibitorBackend {
	readonly id = "win32-execution-state";

	acquire(request: PowerInhibitorRequest): PowerInhibitorHandle | undefined {
		const kernel32 = loadKernel32();
		if (!kernel32) return undefined;
		const plan = powerInhibitPlan(request.mode);
		// ES_SYSTEM_REQUIRED covers both `idle` and `system`: Windows has no
		// separate "refuse explicit sleep" state, and a standing
		// ES_CONTINUOUS | ES_SYSTEM_REQUIRED is exactly "do not sleep".
		let flags = ES_CONTINUOUS | ES_SYSTEM_REQUIRED;
		if (plan.display) flags |= ES_DISPLAY_REQUIRED;
		try {
			// Returns the previous state, or 0 on failure.
			if (kernel32.SetThreadExecutionState(flags) === 0) {
				logger.debug("SetThreadExecutionState refused the request", { flags });
				return undefined;
			}
		} catch (error) {
			logger.debug("Failed to set thread execution state", { error: String(error) });
			return undefined;
		}
		return new WindowsInhibitorHandle(kernel32);
	}
}
