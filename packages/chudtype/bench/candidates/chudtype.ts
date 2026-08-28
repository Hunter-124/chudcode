/** Pipeline: `type(def)` compiles lazily; each call returns data or ChudErrors directly. */
import { ChudErrors, type } from "../../src";
import type { Candidate } from "../candidate";
import type { Def } from "../ir";

export const omptypeCandidate: Candidate = {
	name: "chudtype",
	type(def: Def) {
		// Runtime-generated benchmark definitions cannot preserve the const generic.
		return type(def as never);
	},
	allows(def: Def) {
		const schema = type(def as never);
		return (value: unknown) => schema.allows(value);
	},
	isErrors: result => result instanceof ChudErrors,
	summary: result => (result instanceof ChudErrors ? result.summary : ""),
};
