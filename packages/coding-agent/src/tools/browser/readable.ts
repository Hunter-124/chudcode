import { logger } from "@chudware/utils";
import { type Document, type Element, parseHTML } from "@chudware/utils/dom";
import { Readability } from "@chudware/utils/readability";
import { htmlToBasicMarkdown } from "../../web/scrapers/types";

export type ReadableFormat = "text" | "markdown";

export interface ReadableResult {
	url: string;
	title?: string;
	byline?: string;
	excerpt?: string;
	contentLength: number;
	text?: string;
	markdown?: string;
}

export interface BrowserScrapeOptions {
	/** Output representation. Defaults to markdown. */
	format?: ReadableFormat;
	/** Optional CSS selector that scopes content and links to one rendered subtree. */
	selector?: string;
	/** Include resolved HTTP(S) links from the selected content. Defaults to true. */
	includeLinks?: boolean;
	/** Maximum returned content characters. Defaults to 200,000; hard-capped at 1,000,000. */
	maxChars?: number;
	/** Maximum returned links. Defaults to 200; hard-capped at 1,000. */
	maxLinks?: number;
}

export interface BrowserScrapeLink {
	text: string;
	href: string;
}

export interface BrowserScrapeResult {
	url: string;
	title?: string;
	byline?: string;
	excerpt?: string;
	canonicalUrl?: string;
	language?: string;
	format: ReadableFormat;
	content: string;
	contentLength: number;
	truncated: boolean;
	links?: BrowserScrapeLink[];
}

const DEFAULT_MAX_CHARS = 200_000;
const MAX_MAX_CHARS = 1_000_000;
const DEFAULT_MAX_LINKS = 200;
const MAX_MAX_LINKS = 1_000;

/** Trim to non-empty string or undefined. */
function normalize(text: string | null | undefined): string | undefined {
	const trimmed = text?.trim();
	return trimmed || undefined;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number, allowZero = false): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value)) return fallback;
	const minimum = allowZero ? 0 : 1;
	return Math.max(minimum, Math.min(Math.floor(value), maximum));
}

function resolveHttpUrl(raw: string | null | undefined, baseUrl: string): string | undefined {
	if (!raw) return undefined;
	try {
		const resolved = new URL(raw, baseUrl);
		return resolved.protocol === "http:" || resolved.protocol === "https:" ? resolved.href : undefined;
	} catch {
		return undefined;
	}
}

function extractLinks(root: Document | Element, baseUrl: string, maximum: number): BrowserScrapeLink[] {
	if (maximum === 0) return [];
	const links: BrowserScrapeLink[] = [];
	const seen = new Set<string>();
	for (const anchor of root.querySelectorAll("a[href]")) {
		const href = resolveHttpUrl(anchor.getAttribute("href"), baseUrl);
		if (!href || seen.has(href)) continue;
		seen.add(href);
		links.push({ text: normalize(anchor.textContent) ?? href, href });
		if (links.length >= maximum) break;
	}
	return links;
}

async function extractReadableFromDocument(
	document: Document,
	readabilityDocument: Document,
	url: string,
	format: ReadableFormat,
): Promise<ReadableResult | null> {
	// Readability consumes its input. Parse a second document so fallback
	// extraction, metadata, and link enumeration retain the rendered DOM.
	try {
		const article = new Readability(readabilityDocument).parse();
		if (article) {
			const result = await toReadableResult(url, format, article.textContent, article.content, {
				title: article.title,
				byline: article.byline,
				excerpt: article.excerpt,
				length: article.length,
			});
			if (result) return result;
		}
	} catch (error) {
		logger.debug("Readability extraction failed; using rendered DOM fallback", {
			url,
			error: error instanceof Error ? error.message : String(error),
		});
	}

	const candidates = [
		document.querySelector("[data-pagefind-body]"),
		document.querySelector("main article"),
		document.querySelector("article"),
		document.querySelector("main"),
		document.querySelector("[role='main']"),
		document.body,
	];
	for (const el of candidates) {
		if (!el) continue;
		const innerHTML = el.innerHTML?.trim();
		const textContent = el.textContent?.trim();
		if (!innerHTML || !textContent) continue;
		const result = await toReadableResult(url, format, textContent, innerHTML, {
			title: document.title,
			excerpt: textContent.slice(0, 240),
			length: textContent.length,
		});
		if (result) return result;
	}

	return null;
}

/**
 * Extract readable content from raw HTML.
 * Tries Readability (article-isolation scoring) first, then falls back to a
 * CSS selector chain over the untouched DOM.
 */
export async function extractReadableFromHtml(
	html: string,
	url: string,
	format: ReadableFormat,
): Promise<ReadableResult | null> {
	const document = parseHTML(html).document;
	return await extractReadableFromDocument(document, parseHTML(html).document, url, format);
}

/**
 * Extract a bounded, structured scrape from the rendered DOM snapshot.
 * This is intentionally deterministic and side-effect free: browser auth and
 * JavaScript rendering happen before the caller passes `page.content()` here.
 */
export async function scrapeRenderedHtml(
	html: string,
	url: string,
	options: BrowserScrapeOptions = {},
): Promise<BrowserScrapeResult | null> {
	const format = options.format ?? "markdown";
	const maxChars = boundedInteger(options.maxChars, DEFAULT_MAX_CHARS, MAX_MAX_CHARS);
	const maxLinks = boundedInteger(options.maxLinks, DEFAULT_MAX_LINKS, MAX_MAX_LINKS, true);
	const document = parseHTML(html).document;
	const selector = options.selector?.trim();
	const selected = selector ? document.querySelector(selector) : undefined;
	if (selector && !selected) return null;
	const root = selected ?? document;

	const readable = selected
		? await toReadableResult(url, format, selected.textContent, selected.innerHTML, {
				title: document.title,
				excerpt: selected.textContent?.slice(0, 240),
				length: selected.textContent?.length,
			})
		: await extractReadableFromDocument(document, parseHTML(html).document, url, format);
	if (!readable) return null;
	const fullContent = format === "markdown" ? readable.markdown : readable.text;
	if (!fullContent) return null;

	const content = fullContent.slice(0, maxChars);
	const canonicalUrl = resolveHttpUrl(document.querySelector("link[rel='canonical']")?.getAttribute("href"), url);
	const links = options.includeLinks === false ? undefined : extractLinks(root, url, maxLinks);
	return {
		url,
		title: readable.title,
		byline: readable.byline,
		excerpt: readable.excerpt,
		canonicalUrl,
		language: normalize(document.documentElement?.getAttribute("lang")),
		format,
		content,
		contentLength: fullContent.length,
		truncated: content.length < fullContent.length,
		links,
	};
}

/** Shared builder for both extraction paths. */
async function toReadableResult(
	url: string,
	format: ReadableFormat,
	textContent: string | null | undefined,
	htmlContent: string | null | undefined,
	meta: { title?: string | null; byline?: string | null; excerpt?: string | null; length?: number | null },
): Promise<ReadableResult | null> {
	const text = normalize(textContent);
	const markdown =
		format === "markdown" ? (normalize(await htmlToBasicMarkdown(htmlContent ?? "")) ?? text) : undefined;
	const normalizedText = format === "text" ? text : undefined;
	if (!normalizedText && !markdown) return null;
	return {
		url,
		title: normalize(meta.title),
		byline: normalize(meta.byline),
		excerpt: normalize(meta.excerpt),
		contentLength: meta.length ?? text?.length ?? markdown?.length ?? 0,
		text: normalizedText,
		markdown,
	};
}
