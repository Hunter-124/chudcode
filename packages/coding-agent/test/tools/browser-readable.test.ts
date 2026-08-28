import { describe, expect, it } from "bun:test";
import { extractReadableFromHtml, scrapeRenderedHtml } from "@oh-my-pi/pi-coding-agent/tools/browser";

describe("browser readable extraction", () => {
	it("extracts markdown content from article-style pages", async () => {
		const html = `<!doctype html>
			<html>
				<head><title>Docs</title></head>
				<body>
					<article>
						<h1>Responses API</h1>
						<p>The Responses API stores output only when you opt in.</p>
					</article>
				</body>
			</html>`;

		const result = await extractReadableFromHtml(html, "https://example.com/docs", "markdown");

		expect(result).not.toBeNull();
		expect(result?.title).toBe("Docs");
		expect(result?.markdown).toContain("Responses API");
		expect(result?.markdown).toContain("stores output only when you opt in");
	});

	it("extracts docs-style main content", async () => {
		const html = `<!doctype html>
			<html>
				<head><title>Reference</title></head>
				<body>
					<div class="app-shell">
						<nav>Navigation</nav>
						<main data-pagefind-body>
							<section>
								<h1>Apps SDK</h1>
								<p>Build once, run in many places.</p>
							</section>
						</main>
					</div>
				</body>
			</html>`;

		const result = await extractReadableFromHtml(html, "https://developers.openai.com/apps-sdk/reference", "text");

		expect(result).not.toBeNull();
		expect(result?.title).toBe("Reference");
		expect(result?.text).toContain("Apps SDK");
		expect(result?.text).toContain("Build once, run in many places");
	});

	it("returns a bounded rendered scrape with scoped links and metadata", async () => {
		const html = `<!doctype html>
			<html lang="en">
				<head>
					<title>Private docs</title>
					<link rel="canonical" href="/docs/canonical">
				</head>
				<body>
					<nav><a href="/outside">Outside</a></nav>
					<main id="content">
						<h1>Authenticated dashboard</h1>
						<p>Rendered after sign-in.</p>
						<a href="/account">Account</a>
						<a href="https://example.com/account">Duplicate account</a>
					</main>
				</body>
			</html>`;

		const result = await scrapeRenderedHtml(html, "https://example.com/docs/live", {
			selector: "#content",
			maxChars: 24,
		});

		expect(result).not.toBeNull();
		expect(result?.canonicalUrl).toBe("https://example.com/docs/canonical");
		expect(result?.language).toBe("en");
		expect(result?.content).toHaveLength(24);
		expect(result?.truncated).toBe(true);
		expect(result?.contentLength).toBeGreaterThan(24);
		expect(result?.links).toEqual([{ text: "Account", href: "https://example.com/account" }]);
		expect(result?.content).not.toContain("Outside");
	});

	it("can omit links while preserving complete rendered content", async () => {
		const html = `<!doctype html><html><body><main><p>Runtime content.</p><a href="/next">Next</a></main></body></html>`;

		const result = await scrapeRenderedHtml(html, "https://example.com/app", {
			format: "text",
			includeLinks: false,
		});

		expect(result?.content).toContain("Runtime content");
		expect(result?.truncated).toBe(false);
		expect(result?.links).toBeUndefined();
	});
});
