import { $flag } from "@chudware/utils";
import type { ToolSession } from ".";

export interface EvalBackendsAllowance {
	python: boolean;
	js: boolean;
	ruby: boolean;
	julia: boolean;
}

/** Read per-backend allowance from settings (py/js default on; rb/jl opt-in, default off). */
export function readEvalBackendsAllowance(session: ToolSession): EvalBackendsAllowance {
	return {
		python: session.settings.get("eval.py") ?? true,
		js: session.settings.get("eval.js") ?? true,
		ruby: session.settings.get("eval.rb") ?? false,
		julia: session.settings.get("eval.jl") ?? false,
	};
}

/**
 * Materialize the active eval backend allowance: CHUDCODE_PY / CHUDCODE_JS / CHUDCODE_RB / CHUDCODE_JL
 * env flags override the per-key settings; otherwise settings win (py/js default
 * on, rb/jl default off).
 */
export function resolveEvalBackends(session: ToolSession): EvalBackendsAllowance {
	const settings = readEvalBackendsAllowance(session);
	return {
		python: $flag("CHUDCODE_PY", settings.python),
		js: $flag("CHUDCODE_JS", settings.js),
		ruby: $flag("CHUDCODE_RB", settings.ruby),
		julia: $flag("CHUDCODE_JL", settings.julia),
	};
}
