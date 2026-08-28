/**
 * Manual end-to-end smoke for the relay: replicates the omp browser tool's
 * connection pattern against a live relay + extension.
 *
 * The tool opens TWO puppeteer connections per driven tab — the supervisor
 * (`puppeteer.connect({browserURL})`) and a tab worker
 * (`puppeteer.connect({browserWSEndpoint})`, adopts that target by id). This
 * smoke creates its own temporary tab, exercises evaluate/navigation/screenshot,
 * an extra CDP session, and Target.createTarget/closeTarget, then removes every
 * tab it created. It never navigates an existing user tab.
 *
 * Usage: bun scripts/smoke.ts [relay-url]
 */
import type { Browser, Page, Target } from "puppeteer-core";
import puppeteer from "puppeteer-core";

const relayUrl = Bun.argv[2] ?? "http://127.0.0.1:9224";

/** Puppeteer keeps the CDP target id on an internal field; same access the omp tab supervisor uses (`targetIdForPage`). */
function targetIdOf(target: Target): string {
	// Internal puppeteer field, not on the public type.
	const raw = target as unknown as { _targetId: string };
	return raw._targetId;
}

function step(name: string): void {
	console.log(`\n== ${name}`);
}

let supervisor: Browser | undefined;
let worker: Browser | undefined;
let ownedPage: Page | undefined;
try {
	step("supervisor: connect via browserURL");
	supervisor = await puppeteer.connect({ browserURL: relayUrl, defaultViewport: null, protocolTimeout: 20_000 });
	console.log("version:", await supervisor.version());

	step("supervisor: create isolated smoke target");
	const existingPages = await supervisor.pages();
	ownedPage = await supervisor.newPage();
	await ownedPage.setContent('<title>Relay Smoke Page</title><main><h1 id="hero">Relay bridge online</h1></main>');
	const targetId = targetIdOf(ownedPage.target());
	const wsEndpoint = supervisor.wsEndpoint();
	console.log("existing pages untouched:", existingPages.length, "target:", targetId);

	step("worker: second connection via browserWSEndpoint");
	worker = await puppeteer.connect({
		browserWSEndpoint: wsEndpoint,
		defaultViewport: null,
		protocolTimeout: 20_000,
	});
	const workerTarget = await worker.waitForTarget(target => targetIdOf(target) === targetId, { timeout: 10_000 });
	const page = await workerTarget.page();
	if (!page) throw new Error("worker could not adopt smoke page");

	step("worker: evaluate on isolated tab");
	console.log("title:", await page.title());
	// String form: the callback body runs in the page; a function literal would need the DOM lib.
	console.log("hero:", await page.evaluate(`document.querySelector("#hero")?.textContent ?? "(no hero)"`));

	step("worker: extra CDP session (screenshot path)");
	const session = await page.createCDPSession();
	const frameTree = (await session.send("Page.getFrameTree")) as { frameTree: { frame: { url: string } } };
	console.log("frame url:", frameTree.frameTree.frame.url);
	await session.detach();

	step("worker: navigate isolated tab");
	await page.goto("https://example.com/?relay-smoke", { waitUntil: "load", timeout: 20_000 });
	console.log("navigated:", page.url(), "/", await page.title());

	step("worker: screenshot");
	const shot = await page.screenshot({ type: "png" });
	console.log("screenshot bytes:", shot.byteLength);

	step("supervisor: second createTarget + closeTarget");
	const fresh = await supervisor.newPage();
	await fresh.goto("about:blank");
	console.log("new page url:", fresh.url());
	await fresh.close();
	console.log("closed");

	console.log("\nSMOKE OK");
} finally {
	step("cleanup");
	await worker?.disconnect().catch(() => undefined);
	if (ownedPage && !ownedPage.isClosed()) await ownedPage.close().catch(() => undefined);
	await supervisor?.disconnect().catch(() => undefined);
}
process.exit(0);
