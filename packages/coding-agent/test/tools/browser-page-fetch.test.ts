import { describe, expect, it } from "bun:test";
import { normalizeBrowserFetchOptions } from "@chudware/coding-agent/tools/browser";

describe("browser page fetch", () => {
	it("normalizes request methods and bounds retained response bytes", () => {
		expect(normalizeBrowserFetchOptions({ method: " post ", maxBytes: Number.POSITIVE_INFINITY })).toMatchObject({
			method: "POST",
			maxBytes: 1024 * 1024,
			redirect: "follow",
		});
		expect(normalizeBrowserFetchOptions({ maxBytes: 99 * 1024 * 1024 }).maxBytes).toBe(5 * 1024 * 1024);
		expect(normalizeBrowserFetchOptions({ maxBytes: -1 }).maxBytes).toBe(1);
	});

	it("copies headers so caller mutations cannot alter an in-flight request", () => {
		const headers = { accept: "application/json" };
		const normalized = normalizeBrowserFetchOptions({ headers });
		headers.accept = "text/html";
		expect(normalized.headers).toEqual({ accept: "application/json" });
	});
});
