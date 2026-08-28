export interface BrowserFetchOptions {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	/** Maximum response bytes retained in memory. Defaults to 1 MiB; hard-capped at 5 MiB. */
	maxBytes?: number;
	redirect?: "follow" | "error" | "manual";
}

export interface BrowserFetchResult {
	url: string;
	status: number;
	statusText: string;
	ok: boolean;
	headers: Record<string, string>;
	body: string;
	bytes: number;
	truncated: boolean;
}

export interface NormalizedBrowserFetchOptions {
	method: string;
	headers: Record<string, string>;
	body?: string;
	maxBytes: number;
	redirect: "follow" | "error" | "manual";
}

const DEFAULT_MAX_BYTES = 1024 * 1024;
const MAX_MAX_BYTES = 5 * 1024 * 1024;

export function normalizeBrowserFetchOptions(options: BrowserFetchOptions = {}): NormalizedBrowserFetchOptions {
	const rawMaxBytes = options.maxBytes;
	const maxBytes =
		rawMaxBytes === undefined || !Number.isFinite(rawMaxBytes)
			? DEFAULT_MAX_BYTES
			: Math.max(1, Math.min(Math.floor(rawMaxBytes), MAX_MAX_BYTES));
	return {
		method: options.method?.trim().toUpperCase() || "GET",
		headers: { ...options.headers },
		body: options.body,
		maxBytes,
		redirect: options.redirect ?? "follow",
	};
}

/**
 * Runs in the page realm. Keeping this as a closure-free exported function lets
 * both Puppeteer and cmux serialize the exact same authenticated fetch path.
 */
export async function browserFetchInPage(
	url: string,
	options: NormalizedBrowserFetchOptions,
): Promise<BrowserFetchResult> {
	const response = await globalThis.fetch(url, {
		method: options.method,
		headers: options.headers,
		body: options.body,
		credentials: "include",
		redirect: options.redirect,
	});
	const headers: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		headers[key] = value;
	});

	const reader = response.body?.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	let truncated = false;
	if (reader) {
		while (bytes < options.maxBytes) {
			const next = await reader.read();
			if (next.done) break;
			const remaining = options.maxBytes - bytes;
			if (next.value.byteLength > remaining) {
				chunks.push(next.value.slice(0, remaining));
				bytes += remaining;
				truncated = true;
				await reader.cancel();
				break;
			}
			chunks.push(next.value);
			bytes += next.value.byteLength;
		}
		if (!truncated && bytes === options.maxBytes) {
			const next = await reader.read();
			if (!next.done) {
				truncated = true;
				await reader.cancel();
			}
		}
	}

	const joined = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		joined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return {
		url: response.url,
		status: response.status,
		statusText: response.statusText,
		ok: response.ok,
		headers,
		body: new TextDecoder().decode(joined),
		bytes,
		truncated,
	};
}
