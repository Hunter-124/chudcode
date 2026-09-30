import path from "node:path";
import { FileType, glob } from "@oh-my-pi/pi-natives";
import type { SearchQuery, SearchResult } from "../protocol";
import type { WorkspaceService } from "./workspace-service";
import { WorkspaceServiceError } from "./workspace-service";

const DEFAULT_MAX_RESULTS = 100;
const HARD_MAX_RESULTS = 1_000;
const MAX_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_PREVIEW_CHARS = 500;
const MAX_FALLBACK_CONTENT_BYTES = 1024 * 1024;

function abortError(): Error {
	const error = new Error("Workspace search was cancelled");
	error.name = "AbortError";
	return error;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError();
}

interface OutputProcess {
	readonly stdout: ReadableStream<Uint8Array>;
	readonly exited: Promise<number>;
	kill(): void;
}

async function collectProcessOutput(
	child: OutputProcess,
	maxBytes: number,
	signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; truncated: boolean; exitCode: number }> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	const onAbort = () => child.kill();
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const reader = child.stdout.getReader();
		while (true) {
			throwIfAborted(signal);
			const { done, value } = await reader.read();
			if (done) break;
			if (total + value.byteLength > maxBytes) {
				const remaining = maxBytes - total;
				if (remaining > 0) chunks.push(value.subarray(0, remaining));
				total = maxBytes;
				truncated = true;
				child.kill();
				break;
			}
			chunks.push(value);
			total += value.byteLength;
		}
		const exitCode = await child.exited;
		throwIfAborted(signal);
		const bytes = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return { bytes, truncated, exitCode };
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}

async function gitIgnoredPaths(rootPath: string, relativePaths: readonly string[]): Promise<Set<string> | undefined> {
	if (relativePaths.length === 0) return new Set();
	let child: Bun.Subprocess<"pipe", "pipe", "ignore">;
	try {
		child = Bun.spawn(["git", "-C", rootPath, "check-ignore", "--no-index", "--stdin", "-z"], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "ignore",
		});
	} catch {
		return undefined;
	}
	try {
		child.stdin.write(`${relativePaths.join("\0")}\0`);
		child.stdin.end();
	} catch (error) {
		// A non-repository or missing git executable can exit before stdin is sent.
		if ((error as NodeJS.ErrnoException).code !== "EPIPE") throw error;
		await child.exited;
		return undefined;
	}
	const output = await collectProcessOutput(child, MAX_PROCESS_OUTPUT_BYTES);
	if (output.exitCode !== 0 && output.exitCode !== 1) return undefined;
	return new Set(
		new TextDecoder()
			.decode(output.bytes)
			.split("\0")
			.filter(Boolean)
			.map(value => value.split(path.sep).join("/")),
	);
}

export async function checkIgnoredPaths(rootPath: string, relativePaths: readonly string[]): Promise<Set<string>> {
	const normalized = relativePaths.map(value => value.split(path.sep).join("/"));
	const gitResult = await gitIgnoredPaths(rootPath, normalized);
	if (gitResult) return gitResult;

	const visible = await glob({
		pattern: "**/*",
		path: rootPath,
		hidden: true,
		gitignore: true,
		includeNodeModules: true,
	});
	const visiblePaths = new Set(visible.matches.map(match => match.path.split(path.sep).join("/")));
	return new Set(normalized.filter(relativePath => !visiblePaths.has(relativePath)));
}

export interface WorkspaceSearchOptions {
	maxResults?: number;
	maxOutputBytes?: number;
}

export class WorkspaceSearch {
	private readonly maxResults: number;
	private readonly maxOutputBytes: number;

	constructor(
		private readonly workspace: WorkspaceService,
		options: WorkspaceSearchOptions = {},
	) {
		const requestedResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
		this.maxResults = Number.isFinite(requestedResults)
			? Math.min(HARD_MAX_RESULTS, Math.max(1, Math.trunc(requestedResults)))
			: DEFAULT_MAX_RESULTS;
		const requestedOutput = options.maxOutputBytes ?? MAX_PROCESS_OUTPUT_BYTES;
		this.maxOutputBytes = Number.isFinite(requestedOutput)
			? Math.min(MAX_PROCESS_OUTPUT_BYTES, Math.max(1024, Math.trunc(requestedOutput)))
			: MAX_PROCESS_OUTPUT_BYTES;
	}

	async search(query: SearchQuery, signal?: AbortSignal): Promise<SearchResult[]> {
		throwIfAborted(signal);
		if (query.kind === "symbols") {
			throw new WorkspaceServiceError(
				"INVALID_OPERATION",
				"Symbol search is provided by the LSP service, not workspace search",
			);
		}
		const requestedLimit = query.maxResults ?? this.maxResults;
		const limit = Number.isFinite(requestedLimit)
			? Math.min(this.maxResults, Math.max(1, Math.trunc(requestedLimit)))
			: this.maxResults;
		if (query.kind === "content" && query.text.length === 0) return [];
		try {
			return query.kind === "files"
				? await this.searchFilesWithRipgrep(query.text, limit, query.includeIgnored ?? false, signal)
				: await this.searchContentWithRipgrep(query.text, limit, query.includeIgnored ?? false, signal);
		} catch (error) {
			if ((error as Error).name === "AbortError") throw error;
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return query.kind === "files"
				? this.searchFilesFallback(query.text, limit, query.includeIgnored ?? false, signal)
				: this.searchContentFallback(query.text, limit, query.includeIgnored ?? false, signal);
		}
	}

	private spawnRipgrep(args: string[]): Bun.Subprocess<"ignore", "pipe", "ignore"> {
		return Bun.spawn(["rg", ...args], {
			cwd: this.workspace.rootPath,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
		});
	}

	private async searchFilesWithRipgrep(
		text: string,
		limit: number,
		includeIgnored: boolean,
		signal?: AbortSignal,
	): Promise<SearchResult[]> {
		const args = ["--files", "--null", "--hidden", "--no-require-git", "--glob=!.git/**"];
		if (includeIgnored) args.push("--no-ignore");
		const output = await collectProcessOutput(this.spawnRipgrep(args), this.maxOutputBytes, signal);
		if (output.exitCode !== 0 && output.exitCode !== 1 && !output.truncated)
			throw new Error(`ripgrep exited with ${output.exitCode}`);
		const needle = text.toLocaleLowerCase();
		const paths = new TextDecoder().decode(output.bytes).split("\0").filter(Boolean);
		const results: SearchResult[] = [];
		for (const relativePath of paths) {
			const normalized = relativePath.split(path.sep).join("/");
			const index = normalized.toLocaleLowerCase().indexOf(needle);
			if (needle && index < 0) continue;
			const absolute = await this.workspace.resolve(normalized);
			results.push({
				uri: this.workspace.uriForPath(absolute),
				preview: normalized.slice(0, MAX_PREVIEW_CHARS),
				score: needle ? Math.max(0, 1 - index / Math.max(normalized.length, 1)) : 0,
			});
			if (results.length >= limit) break;
		}
		return results;
	}

	private async searchContentWithRipgrep(
		text: string,
		limit: number,
		includeIgnored: boolean,
		signal?: AbortSignal,
	): Promise<SearchResult[]> {
		const args = ["--json", "--fixed-strings", "--hidden", "--no-require-git", "--glob=!.git/**"];
		if (includeIgnored) args.push("--no-ignore");
		args.push("--", text, ".");
		const output = await collectProcessOutput(this.spawnRipgrep(args), this.maxOutputBytes, signal);
		if (output.exitCode !== 0 && output.exitCode !== 1 && !output.truncated)
			throw new Error(`ripgrep exited with ${output.exitCode}`);
		const results: SearchResult[] = [];
		for (const line of new TextDecoder().decode(output.bytes).split("\n")) {
			if (!line) continue;
			let event: RipgrepEvent;
			try {
				event = JSON.parse(line) as RipgrepEvent;
			} catch {
				if (output.truncated) break;
				continue;
			}
			if (event.type !== "match" || !event.data?.path?.text || !event.data.lines?.text) continue;
			const relativePath = event.data.path.text.replace(/^\.\//, "");
			const absolute = await this.workspace.resolve(relativePath);
			const firstMatch = event.data.submatches?.[0];
			const preview = event.data.lines.text.replace(/[\r\n]+$/, "").slice(0, MAX_PREVIEW_CHARS);
			results.push({
				uri: this.workspace.uriForPath(absolute),
				line: event.data.line_number,
				column: firstMatch ? utf8ByteOffsetToColumn(event.data.lines.text, firstMatch.start) : 1,
				preview,
			});
			if (results.length >= limit) break;
		}
		return results;
	}

	private async discoverFallbackFiles(includeIgnored: boolean, signal?: AbortSignal): Promise<string[]> {
		const result = await glob({
			pattern: "**/*",
			path: this.workspace.rootPath,
			fileType: FileType.File,
			hidden: true,
			gitignore: !includeIgnored,
			includeNodeModules: true,
			signal,
		});
		throwIfAborted(signal);
		return result.matches.map(match => match.path.split(path.sep).join("/"));
	}

	private async searchFilesFallback(
		text: string,
		limit: number,
		includeIgnored: boolean,
		signal?: AbortSignal,
	): Promise<SearchResult[]> {
		const files = await this.discoverFallbackFiles(includeIgnored, signal);
		const needle = text.toLocaleLowerCase();
		const results: SearchResult[] = [];
		for (const relativePath of files) {
			throwIfAborted(signal);
			const index = relativePath.toLocaleLowerCase().indexOf(needle);
			if (needle && index < 0) continue;
			results.push({
				uri: this.workspace.uriForPath(path.join(this.workspace.rootPath, relativePath)),
				preview: relativePath.slice(0, MAX_PREVIEW_CHARS),
				score: needle ? Math.max(0, 1 - index / Math.max(relativePath.length, 1)) : 0,
			});
			if (results.length >= limit) break;
		}
		return results;
	}

	private async searchContentFallback(
		text: string,
		limit: number,
		includeIgnored: boolean,
		signal?: AbortSignal,
	): Promise<SearchResult[]> {
		const files = await this.discoverFallbackFiles(includeIgnored, signal);
		const results: SearchResult[] = [];
		for (const relativePath of files) {
			throwIfAborted(signal);
			const absolute = path.join(this.workspace.rootPath, relativePath);
			const bytes = new Uint8Array(
				await Bun.file(absolute)
					.slice(0, MAX_FALLBACK_CONTENT_BYTES + 1)
					.arrayBuffer(),
			);
			if (bytes.byteLength > MAX_FALLBACK_CONTENT_BYTES || bytes.includes(0)) continue;
			let contents: string;
			try {
				contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			} catch {
				continue;
			}
			for (const [index, line] of contents.split(/\r?\n/).entries()) {
				const column = line.indexOf(text);
				if (column < 0) continue;
				results.push({
					uri: this.workspace.uriForPath(absolute),
					line: index + 1,
					column: column + 1,
					preview: line.slice(0, MAX_PREVIEW_CHARS),
				});
				if (results.length >= limit) return results;
			}
		}
		return results;
	}
}

interface RipgrepEvent {
	type?: string;
	data?: {
		path?: { text?: string };
		lines?: { text?: string };
		line_number?: number;
		submatches?: Array<{ start: number; end: number }>;
	};
}

function utf8ByteOffsetToColumn(line: string, byteOffset: number): number {
	const bytes = new TextEncoder().encode(line);
	return new TextDecoder().decode(bytes.subarray(0, Math.min(byteOffset, bytes.byteLength))).length + 1;
}
