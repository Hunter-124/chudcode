import { Effort } from "../effort";

export type CursorVariantToken = "extra-high" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type CursorVariantEffort = Effort | "off";

export interface CursorModelVariant {
	/** Logical model id shared by every effort and service-tier sibling. */
	baseId: string;
	/** Literal suffix token, retained for catalog-family safety checks. */
	token: CursorVariantToken;
	/** Explicit reasoning selection encoded by the upstream id. */
	effort: CursorVariantEffort;
	/** Whether an infix `-thinking` token explicitly selects the reasoning deployment. */
	thinking: boolean;
	/** Whether the id selects Cursor's distinct Fast service-tier lane. */
	fast: boolean;
	/** Exact opaque id advertised by Cursor and required by AgentService.Run. */
	wireModelId: string;
}

const CURSOR_VARIANT_ID_PATTERN = /^(.+?)-(extra-high|none|minimal|low|medium|high|xhigh|max)(-fast)?$/;
const CURSOR_EFFORT_BY_TOKEN: Readonly<Record<string, CursorVariantEffort | undefined>> = {
	"extra-high": Effort.XHigh,
	none: "off",
	minimal: Effort.Minimal,
	low: Effort.Low,
	medium: Effort.Medium,
	high: Effort.High,
	xhigh: Effort.XHigh,
	max: Effort.Max,
};

/** Parse a Cursor effort/fast sibling id without changing its opaque wire value. */
export function parseCursorModelVariant(modelId: string): CursorModelVariant | undefined {
	const match = CURSOR_VARIANT_ID_PATTERN.exec(modelId);
	if (!match) return undefined;
	const parsedBaseId = match[1];
	if (!parsedBaseId) return undefined;
	const thinking = parsedBaseId.endsWith("-thinking");
	const baseId = thinking ? parsedBaseId.slice(0, -"-thinking".length) : parsedBaseId;
	const token = match[2] as CursorVariantToken | undefined;
	const effort = CURSOR_EFFORT_BY_TOKEN[token ?? ""];
	if (!baseId || !token || !effort) return undefined;
	return {
		baseId,
		thinking,
		effort,
		fast: match[3] !== undefined,
		token,
		wireModelId: modelId,
	};
}

/** Logical row id for a parsed variant; Fast remains a distinct service-tier row. */
export function cursorVariantLaneId(variant: CursorModelVariant): string {
	return `${variant.baseId}${variant.fast ? "-fast" : ""}`;
}
