import type { InteractiveModeContext } from "../../modes/types";

export function refreshStatusLine(ctx: InteractiveModeContext): void {
	ctx.statusLine.invalidate();
	ctx.ui.requestRender();
}

export function formatTokenCount(value: number): string {
	return value.toLocaleString();
}
