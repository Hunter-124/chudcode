import { routeSgrMouseInput, type SgrMouseEvent } from "@chudware/tui";

export const OVERLAY_DOUBLE_CLICK_MS = 500;

export interface OverlayMouseEvent extends SgrMouseEvent {
	/** Coordinates translated into the matched region. */
	localRow: number;
	localCol: number;
	/** 1 for a click, 2 for the second click at the same target within the double-click window, 0 otherwise. */
	clickCount: 0 | 1 | 2;
}

export interface OverlayMouseRegion {
	/** Stable target identity used to keep double-clicks from leaking between panes. */
	id: string;
	rowStart: number;
	rowCount: number;
	colStart?: number;
	colCount?: number;
	onMouse: (event: OverlayMouseEvent) => boolean | void;
}

export interface OverlayMouseRoute {
	regions: readonly OverlayMouseRegion[];
	/** Optional catch-all for reports outside every region. */
	fallback?: (event: OverlayMouseEvent) => boolean | void;
	/** Consume valid SGR reports outside all regions instead of leaking raw bytes into keyboard handlers. */
	consumeOutside?: boolean;
}
export type OverlayMouseRouteFactory = () => OverlayMouseRoute;

interface LastClick {
	regionId: string;
	row: number;
	col: number;
	at: number;
}

/**
 * Shared SGR router for fullscreen overlays. It owns decoding, rectangular
 * hit-testing, local-coordinate translation, and deterministic double-click
 * classification so every overlay treats the same terminal report alike.
 */
export class OverlayMouseRouter {
	#lastClick: LastClick | undefined;
	readonly #now: () => number;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	route(data: string, route: OverlayMouseRoute | OverlayMouseRouteFactory): boolean {
		return routeSgrMouseInput(data, event => this.routeEvent(event, typeof route === "function" ? route() : route));
	}

	routeEvent(event: SgrMouseEvent, route: OverlayMouseRoute): boolean {
		for (const region of route.regions) {
			const colStart = region.colStart ?? 0;
			const inside =
				region.rowCount > 0 &&
				event.row >= region.rowStart &&
				event.row < region.rowStart + region.rowCount &&
				event.col >= colStart &&
				(region.colCount === undefined || event.col < colStart + region.colCount);
			if (!inside) continue;
			return region.onMouse(this.#translate(event, region)) !== false;
		}
		if (!route.fallback) return route.consumeOutside ?? false;
		return route.fallback(this.#translate(event)) !== false;
	}

	#translate(event: SgrMouseEvent, region?: OverlayMouseRegion): OverlayMouseEvent {
		let clickCount: 0 | 1 | 2 = 0;
		if (event.leftClick) {
			const now = this.#now();
			const regionId = region?.id ?? "fallback";
			const last = this.#lastClick;
			const isDouble =
				last !== undefined &&
				last.regionId === regionId &&
				last.row === event.row &&
				last.col === event.col &&
				now - last.at <= OVERLAY_DOUBLE_CLICK_MS;
			clickCount = isDouble ? 2 : 1;
			this.#lastClick = isDouble ? undefined : { regionId, row: event.row, col: event.col, at: now };
		}
		return {
			...event,
			localRow: event.row - (region?.rowStart ?? 0),
			localCol: event.col - (region?.colStart ?? 0),
			clickCount,
		};
	}
}
