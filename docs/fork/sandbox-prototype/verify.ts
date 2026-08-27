#!/usr/bin/env bun
/**
 * End-to-end proof that omp's real desktop backend (@oh-my-pi/pi-natives 18.0.6)
 * drives an isolated Xvfb seat: enumerate -> capture -> click -> type -> capture,
 * with the app's own window title as an independent oracle for input delivery.
 *
 * Requires DISPLAY pointing at a seat from ./seat.sh and WAYLAND_DISPLAY unset.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { DesktopWindow } from "@oh-my-pi/pi-natives";
import { createDesktopSession } from "@oh-my-pi/pi-natives/desktop";
const EVIDENCE = path.join(import.meta.dir, "evidence");
const APP_URL = `file://${path.join(import.meta.dir, "page.html")}`;

if (process.env.WAYLAND_DISPLAY) throw new Error("WAYLAND_DISPLAY is set; omp would pick the Wayland backend");
const display = process.env.DISPLAY;
if (!display || display === ":0") throw new Error(`refusing to run against DISPLAY=${display}`);

const step = (msg: string): void => console.log(`\n### ${msg}`);
const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

function save(name: string, capture: { data: Uint8Array }): string {
	const file = path.join(EVIDENCE, `${process.env.EV_PREFIX ?? ""}${name}`);
	fs.writeFileSync(file, capture.data);
	return file;
}

const session = createDesktopSession({ display: "all" });

step("capabilities on the isolated seat");
console.log(JSON.stringify(session.capabilities));

step(`launching brave-browser into ${display}`);
const profile = path.join(process.env.OMP_SEAT_DIR ?? "/tmp", "brave-profile");
const brave = Bun.spawn(
	[
		// setsid: survive this script so `seat.sh stop` has to reap it.
		"setsid",
		"brave-browser",
		"--ozone-platform=x11",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-session-crashed-bubble",
		`--user-data-dir=${profile}`,
		"--window-size=1280,800",
		"--window-position=0,0",
		`--app=${APP_URL}`,
	],
	{ stdout: "ignore", stderr: "ignore", env: { ...process.env } },
);
console.log(`brave pid=${brave.pid}`);

step("waiting for the window to appear in omp's window list");
let target: DesktopWindow | undefined;
for (let i = 0; i < 200; i++) {
	const windows = await session.listWindows();
	target = windows.find(w => w.title?.startsWith("OMP-SEAT"));
	if (target) break;
	await sleep(100);
}
if (!target) {
	console.log("windows seen:", JSON.stringify(await session.listWindows()));
	throw new Error("test window never appeared");
}
console.log(
	JSON.stringify({
		id: target.id,
		app: target.app,
		title: target.title,
		x: target.x,
		y: target.y,
		width: target.width,
		height: target.height,
	}),
);
await sleep(600); // let first paint settle

step("capture BEFORE (omp native X11 capture)");
const before = await session.capture("desktop");
console.log(
	`desktop capture: ${before.width}x${before.height} backend=${before.backend} displayServer=${before.displayServer} bytes=${before.data.byteLength}`,
);
console.log("saved:", save("05-before.png", before));
const winBefore = await session.capture(target.id);
console.log(`window capture: ${winBefore.width}x${winBefore.height} bytes=${winBefore.data.byteLength}`);
console.log("saved:", save("06-window-before.png", winBefore));

step("synthesizing a click on the button (XTEST at root, target=desktop)");
// Button occupies page px 200..600 x 200..400; the --app window has no toolbar,
// so page coords == window-relative coords.
const clickX = target.x + 400;
const clickY = target.y + 300;
console.log(`click at desktop (${clickX}, ${clickY})`);
await session.click("desktop", clickX, clickY);
await sleep(400);

const afterClick = (await session.listWindows()).find(w => w.id === target.id);
console.log(`title after click: ${JSON.stringify(afterClick?.title)}`);

step("synthesizing keystrokes (typeText + keyChord)");
await session.typeText("desktop", "omp-seat-ok");
await sleep(300);
await session.keyChord("desktop", ["Enter"]);
await sleep(400);
const afterType = (await session.listWindows()).find(w => w.id === target.id);
console.log(`title after typing: ${JSON.stringify(afterType?.title)}`);

step("capture AFTER");
const after = await session.capture("desktop");
console.log("saved:", save("07-after.png", after));
const winAfter = await session.capture(target.id);
console.log("saved:", save("08-window-after.png", winAfter));

step("pixel oracle: count state-marker colours across the whole capture");
/**
 * Offset-independent: Brave may add an infobar that shifts page content, so
 * count exact colour occurrences instead of sampling fixed coordinates.
 * red #CC2222 = untouched button, green #00CC44 = clicked, yellow #FFFF00 =
 * key event seen by the page.
 */
function colorCount(capture: { data: Uint8Array }, hex: string): number {
	const tmp = path.join(EVIDENCE, ".pixel.png");
	fs.writeFileSync(tmp, capture.data);
	const out = Bun.spawnSync([
		"magick",
		tmp,
		"-alpha",
		"off",
		"-fill",
		"black",
		"+opaque",
		hex,
		"-fill",
		"white",
		"-opaque",
		hex,
		"-format",
		"%[fx:int(mean*w*h+0.5)]",
		"info:",
	]);
	fs.rmSync(tmp, { force: true });
	return Number(new TextDecoder().decode(out.stdout).trim());
}
for (const [name, hex] of [
	["button-red   #CC2222", "#CC2222"],
	["button-green #00CC44", "#00CC44"],
	["probe-blue   #0000FF", "#0000FF"],
	["probe-yellow #FFFF00", "#FFFF00"],
] as const) {
	console.log(`${name}: before=${colorCount(before, hex)}px after=${colorCount(after, hex)}px`);
}

step("process isolation of the seat app (read while it is still alive)");
const environ = fs.readFileSync(`/proc/${brave.pid}/environ`, "utf8").split("\0");
console.log(
	`brave pid ${brave.pid}: DISPLAY=${environ.find(v => v.startsWith("DISPLAY="))?.slice(8)} ` +
		`WAYLAND_DISPLAY=${environ.some(v => v.startsWith("WAYLAND_DISPLAY=")) ? "SET!" : "<unset>"}`,
);
const ss = Bun.spawnSync(["ss", "-xp"]);
const perServer = new Map<string, number>();
for (const line of new TextDecoder().decode(ss.stdout).split("\n")) {
	const match = /@\/tmp\/\.X11-unix\/(X\d+).*users:\(\("([^"]+)",pid=(\d+)/.exec(line);
	if (!match) continue;
	const key = `${match[1]} served by ${match[2]} pid ${match[3]}`;
	perServer.set(key, (perServer.get(key) ?? 0) + 1);
}
for (const [key, count] of [...perServer].sort()) console.log(`  ${count} conns  ${key}`);

step("accessibility tree of the isolated seat (AT-SPI)");
try {
	const snapshot = await session.axSnapshot("desktop", { maxDepth: 3, maxNodes: 12 });
	console.log(JSON.stringify(snapshot).slice(0, 800));
} catch (error) {
	console.log("ax: ERROR", String(error));
}

step("verdict");
const titleOk = afterType?.title?.includes("clicks=1") && afterType.title.includes("omp-seat-ok<CR>");
console.log(titleOk ? "PASS: click and keystrokes reached the app inside the isolated seat" : "FAIL");

// Deliberately left running: `seat.sh stop` must reap it via the seat's process
// group, which is the teardown contract being proven.
await session.close();
process.exit(titleOk ? 0 : 1);
