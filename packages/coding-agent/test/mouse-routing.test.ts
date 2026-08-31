import { describe, expect, test } from "bun:test";
import {
	OVERLAY_DOUBLE_CLICK_MS,
	type OverlayMouseEvent,
	OverlayMouseRouter,
} from "@chudware/coding-agent/modes/components/mouse-routing";

const CLICK = "\x1b[<0;15;8M";
const WHEEL_DOWN = "\x1b[<65;15;8M";

describe("shared overlay mouse routing", () => {
	test("agents, models, advisor, settings, and setup use identical local coordinates and double-click timing", () => {
		for (const overlay of ["agents", "models", "advisor", "settings", "setup"]) {
			let now = 1_000;
			const router = new OverlayMouseRouter(() => now);
			const received: OverlayMouseEvent[] = [];
			const route = {
				regions: [
					{
						id: `${overlay}-body`,
						rowStart: 5,
						rowCount: 8,
						colStart: 10,
						colCount: 20,
						onMouse: (event: OverlayMouseEvent) => {
							received.push(event);
						},
					},
				],
			};

			expect(router.route(CLICK, route)).toBe(true);
			now += OVERLAY_DOUBLE_CLICK_MS;
			expect(router.route(CLICK, route)).toBe(true);
			expect(received.map(event => [event.localRow, event.localCol, event.clickCount])).toEqual([
				[2, 4, 1],
				[2, 4, 2],
			]);
		}
	});

	test("wheel routing is hit-tested without entering the click sequence", () => {
		let now = 2_000;
		const router = new OverlayMouseRouter(() => now);
		const received: OverlayMouseEvent[] = [];
		const route = {
			regions: [
				{
					id: "models-body",
					rowStart: 5,
					rowCount: 8,
					colStart: 10,
					onMouse: (event: OverlayMouseEvent) => {
						received.push(event);
					},
				},
			],
		};

		router.route(CLICK, route);
		now += 100;
		router.route(WHEEL_DOWN, route);
		now += 100;
		router.route(CLICK, route);

		expect(received[1]?.wheel).toBe(1);
		expect(received[1]?.clickCount).toBe(0);
		expect(received[2]?.clickCount).toBe(2);
	});

	test("a same-coordinate click in another pane never completes a double-click", () => {
		let now = 3_000;
		const router = new OverlayMouseRouter(() => now);
		const clicks: Array<[string, number]> = [];
		const tabRegion = {
			id: "settings-tabs",
			rowStart: 0,
			rowCount: 10,
			colStart: 0,
			onMouse: (event: OverlayMouseEvent) => {
				clicks.push(["tabs", event.clickCount]);
			},
		};
		const contentRegion = {
			id: "settings-content",
			rowStart: 0,
			rowCount: 10,
			colStart: 0,
			onMouse: (event: OverlayMouseEvent) => {
				clicks.push(["content", event.clickCount]);
			},
		};

		router.route(CLICK, { regions: [tabRegion] });
		now += 10;
		router.route(CLICK, { regions: [contentRegion] });
		expect(clicks).toEqual([
			["tabs", 1],
			["content", 1],
		]);
	});

	test("reports outside every region fall through and malformed input is rejected", () => {
		const router = new OverlayMouseRouter();
		const outside: OverlayMouseEvent[] = [];
		const route = {
			regions: [
				{
					id: "advisor-list",
					rowStart: 0,
					rowCount: 2,
					colStart: 0,
					colCount: 2,
					onMouse: () => {
						throw new Error("out-of-bounds report reached region");
					},
				},
			],
			fallback: (event: OverlayMouseEvent) => {
				outside.push(event);
			},
		};

		expect(router.route(CLICK, route)).toBe(true);
		expect(outside).toHaveLength(1);
		expect(router.route("not-mouse", route)).toBe(false);
	});
});
