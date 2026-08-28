/**
 * ArkType compatibility facade — `@chudware/chudtype/ark`.
 *
 * Lets code written against arktype keep its imports and names while running
 * on the chudtype lazy-JIT runtime: swap `from "arktype"` for
 * `from "@chudware/chudtype/ark"` and nothing else changes. New code should
 * import `@chudware/chudtype` directly.
 *
 * Compatibility affordance: `ArkError` / `ArkErrors` alias `ChudError` /
 * `ChudErrors`. All schema builders, including recursive `scope()`, are
 * re-exported unchanged.
 */
import { ChudError, ChudErrors } from "./errors";

export * from "./index";

export const ArkError = ChudError;
export type ArkError = ChudError;
export const ArkErrors = ChudErrors;
export type ArkErrors = ChudErrors;
