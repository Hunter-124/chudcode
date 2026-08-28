/**
 * Protocol handler for history:// URLs.
 *
 * Exposes agent transcripts as concise markdown. Live refs render from the
 * in-memory message array; parked refs (session disposed, sessionFile
 * retained) load read-only from the JSONL session file — no writer, no lock.
 *
 * Agents that are no longer in the `AgentRegistry` — one-shot helpers
 * unregistered after `finalizeSubagentLifecycle` (`keepAlive: false`, e.g. the
 * `eval` `agent()` bridge), agents released via the Agent Hub / vibe kill, or
 * any agent after a session resume — remain reachable: `resolve`, `complete`,
 * and the index all fall back to scanning artifacts dirs for `<id>.jsonl`,
 * mirroring how `agent://` reads `.md` outputs straight off disk.
 *
 * URL forms:
 * - history:// - Index of all registry + on-disk agents (id, status, kind, last activity)
 * - history://<agentId> - Concise markdown transcript of that agent
 * - history://<agentId>/images - Table of every image in the transcript (#, role,
 *   mime, bytes, path), resolved to an on-disk path so a reader can `read` the
 *   pixels directly — internal resources cannot carry binary content.
 * - history://<agentId>/images/<n> - The on-disk path of the Nth (1-based) image
 *   as plain text, mirroring `artifact://`'s `sourcePath` convention.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getBlobsDir, isEnoent } from "@oh-my-pi/pi-utils";
import type { AgentRef } from "../registry/agent-registry";
import { AgentRegistry } from "../registry/agent-registry";
import { ensurePersistedRoster } from "../registry/persisted-agents";
import { BlobStore, blobExtensionForImageMimeType, isBlobRef, parseBlobRef } from "../session/blob-store";
import { formatSessionHistoryMarkdown } from "../session/session-history-format";
import { collectSessionImages, type SessionImageRef } from "../session/session-images";
import { loadSessionMessagesReadOnly } from "../session/session-loader";
import { sessionFilesFromDisk } from "./registry-helpers";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, UrlCompletion } from "./types";

/** Humanize a last-activity timestamp as `Ns/Nm/Nh/Nd ago`. */
function formatAgo(timestamp: number): string {
	const diffMs = Math.max(0, Date.now() - timestamp);
	const secs = Math.floor(diffMs / 1000);
	if (secs < 60) return `${secs}s ago`;
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

/** One row of the history index — either a registered ref or a disk-only transcript. */
interface IndexEntry {
	id: string;
	status: string;
	kind: string;
	parent: string;
	lastActivity: string;
}

/**
 * A resolved agent's raw message array plus provenance, shared by the
 * transcript render and the `/images` routes so the message source (live
 * session, read-only session file, or disk-scanned fallback) is decided
 * exactly once per `resolve` call.
 */
interface ResolvedTranscript {
	messages: unknown[];
	notes: string[];
	sourcePath?: string;
	title: string;
}

/** One image resolved to an on-disk path (or `missing` when its blob is gone). */
interface ResolvedImagePath {
	image: SessionImageRef;
	path: string;
	bytes: number;
	missing: boolean;
}

/**
 * Handler for history:// URLs.
 *
 * Resolves agent ids against the global AgentRegistry, then falls back to
 * on-disk `.jsonl` transcripts, serving read-only history for live, parked,
 * and unregistered agents alike.
 */
export class HistoryProtocolHandler implements ProtocolHandler {
	readonly scheme = "history";
	readonly immutable = false;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const agentId = url.rawHost || url.hostname;

		if (!agentId) {
			const registry = AgentRegistry.global();
			const visible = registry.list().filter(ref => ref.kind !== "advisor");
			const content = await this.#renderIndex(visible);
			return {
				url: url.href,
				content,
				contentType: "text/markdown",
				size: Buffer.byteLength(content, "utf-8"),
			};
		}

		// Mirror agent://'s path-segment parsing (agent-protocol.ts): split the
		// pathname on "/", drop empty segments (leading/trailing slashes), and
		// best-effort decode each one so both schemes handle `/<path>` the same way.
		const urlPath = url.pathname;
		const hasSubPath = urlPath && urlPath !== "/" && urlPath !== "";
		const pathSegments = hasSubPath
			? urlPath
					.split("/")
					.filter(Boolean)
					.map(segment => {
						try {
							return decodeURIComponent(segment);
						} catch {
							return segment;
						}
					})
			: [];

		const resolved = await this.#resolveMessages(agentId, context);

		if (pathSegments.length === 0) {
			const content = formatSessionHistoryMarkdown(resolved.messages, { title: resolved.title });
			return {
				url: url.href,
				content,
				contentType: "text/markdown",
				size: Buffer.byteLength(content, "utf-8"),
				sourcePath: resolved.sourcePath,
				notes: resolved.notes,
			};
		}

		if (pathSegments[0] === "images") {
			const images = collectSessionImages(resolved.messages);

			if (pathSegments.length === 1) {
				const content = await this.#renderImagesListing(images);
				return {
					url: url.href,
					content,
					contentType: "text/markdown",
					size: Buffer.byteLength(content, "utf-8"),
					sourcePath: resolved.sourcePath,
					notes: resolved.notes,
				};
			}

			if (pathSegments.length === 2) {
				const raw = pathSegments[1]!;
				const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
				if (!Number.isInteger(n) || n < 1 || n > images.length) {
					const range = images.length > 0 ? `1-${images.length}` : "none (this transcript has no images)";
					throw new Error(
						`Invalid image index "${raw}" for history://${agentId}/images/<n>; valid range: ${range}`,
					);
				}
				const resolvedImage = await this.#resolveImagePath(images[n - 1]!, getBlobsDir());
				const content = resolvedImage.missing ? "(blob missing)" : resolvedImage.path;
				return {
					url: url.href,
					content,
					contentType: "text/plain",
					size: Buffer.byteLength(content, "utf-8"),
					sourcePath: resolvedImage.missing ? undefined : resolvedImage.path,
				};
			}
		}

		throw new Error(
			`Unknown history:// sub-path: /${pathSegments.join("/")}\n` +
				`Supported forms: history://<id>, history://<id>/images, history://<id>/images/<n>`,
		);
	}

	/**
	 * Resolve `agentId` to its raw message array plus provenance, shared
	 * verbatim by the transcript render (`resolve`'s no-sub-path branch) and
	 * the `/images` routes — the message source (live session, read-only
	 * session file, or disk-scanned fallback) is decided exactly once.
	 */
	async #resolveMessages(agentId: string, context?: ResolveContext): Promise<ResolvedTranscript> {
		const registry = AgentRegistry.global();
		// A caller resolving a possibly-parked id refreshes its own root's
		// persisted roster first: a same-named parked ref restored by another
		// root's scan must not be served (or listed as known) in its place.
		// The refresh is latched per root, so a settled roster never re-scans.
		let rootSessionFile: string | undefined;
		if (context?.sessionFile) {
			rootSessionFile = await ensurePersistedRoster(registry, context.sessionFile);
		}
		// On-disk fallbacks below scan the caller root's artifact directory
		// first, so a same-named transcript restored by another root's scan
		// never shadows this caller's own on-disk transcript.
		const preferredArtifactDir = rootSessionFile?.slice(0, -".jsonl".length);
		// Advisor transcripts are observability-only — surfaced in the Agent Hub, never
		// in the agent-facing roster. Hide them from lookup.
		const visible = registry.list().filter(ref => ref.kind !== "advisor");

		let ref = registry.get(agentId);
		if (ref?.kind === "advisor") ref = undefined;
		if (!ref) {
			// Case-insensitive fallback: agent ids are human-typed (e.g. AuthLoader).
			const lower = agentId.toLowerCase();
			ref = visible.find(candidate => candidate.id.toLowerCase() === lower);
		}

		if (!ref) {
			// Registry miss — the agent may have been unregistered or lost on resume.
			// Serve its transcript straight from disk if the session file persists.
			const disk = await this.#resolveFromDisk(agentId, preferredArtifactDir);
			if (disk) return disk;

			const known = visible.map(candidate => candidate.id);
			const knownStr = known.length > 0 ? known.join(", ") : "none";
			throw new Error(`Unknown agent: ${agentId}\nKnown agents: ${knownStr}\nList all with history://`);
		}

		const notes: string[] = [];
		let messages: unknown[];
		if (ref.session) {
			messages = ref.session.messages;
			notes.push("Source: live session");
		} else if (ref.sessionFile) {
			messages = await loadSessionMessagesReadOnly(ref.sessionFile);
			notes.push(`Source: session file (read-only, ${ref.status})`);
		} else {
			// No live session and no retained sessionFile — try the disk scan before
			// giving up, in case the transcript lingers under an artifacts dir.
			const disk = await this.#resolveFromDisk(ref.id, preferredArtifactDir);
			if (disk) return disk;
			throw new Error(`Agent ${ref.id} has no transcript: session is gone and no session file was retained`);
		}

		return { messages, notes, sourcePath: ref.sessionFile ?? undefined, title: `${ref.id} (${ref.status})` };
	}

	/**
	 * Load a transcript's raw messages for `agentId` from an on-disk `.jsonl`
	 * session file, matched case-insensitively. Returns `undefined` when no
	 * file is found. `preferredArtifactDir` — the caller root's artifact
	 * directory, when known — is scanned before every registry-derived dir, so
	 * a same-id transcript from another root cannot shadow the caller's own.
	 */
	async #resolveFromDisk(agentId: string, preferredArtifactDir?: string): Promise<ResolvedTranscript | undefined> {
		const files = await sessionFilesFromDisk(preferredArtifactDir);
		const lower = agentId.toLowerCase();
		let matchedId: string | undefined;
		let sessionFile: string | undefined;
		for (const [id, file] of files) {
			if (id === agentId || id.toLowerCase() === lower) {
				matchedId = id;
				sessionFile = file;
				if (id === agentId) break;
			}
		}
		if (!matchedId || !sessionFile) return undefined;
		const messages = await loadSessionMessagesReadOnly(sessionFile);
		return {
			messages,
			notes: ["Source: session file (read-only, unregistered)"],
			sourcePath: sessionFile,
			title: `${matchedId} (on disk)`,
		};
	}

	/**
	 * Render the `history://<id>/images` listing: one row per image, resolved
	 * to an on-disk path. A dead blob renders `(blob missing)` rather than
	 * failing the whole listing (one stale reference must not hide every
	 * other image).
	 */
	async #renderImagesListing(images: SessionImageRef[]): Promise<string> {
		if (images.length === 0) {
			return "No images in this transcript.\n";
		}
		const blobsDir = getBlobsDir();
		const resolved = await Promise.all(images.map(image => this.#resolveImagePath(image, blobsDir)));
		const lines: string[] = ["| # | role | mime | bytes | path |", "|---|---|---|---|---|"];
		for (const entry of resolved) {
			const bytes = entry.missing ? "—" : String(entry.bytes);
			const pathCell = entry.missing ? "(blob missing)" : entry.path;
			lines.push(`| ${entry.image.index} | ${entry.image.role} | ${entry.image.mimeType} | ${bytes} | ${pathCell} |`);
		}
		lines.push("", "Read an image with `read <path>` — internal resources cannot carry binary content.");
		return `${lines.join("\n")}\n`;
	}

	/**
	 * Resolve a single image to an on-disk path and byte size.
	 *
	 * `blob:sha256:<hash>` references resolve into the (process-global) blob
	 * store: the extension-suffixed display path is preferred when present on
	 * disk (so OS/`read` type-detection works), falling back to the canonical
	 * hashed path; a blob absent from disk entirely resolves as `missing`
	 * rather than throwing. Anything else is treated as inline base64 and
	 * materialized into the blob store (idempotent — content-addressed).
	 */
	async #resolveImagePath(image: SessionImageRef, blobsDir: string): Promise<ResolvedImagePath> {
		if (isBlobRef(image.data)) {
			const hash = parseBlobRef(image.data);
			if (!hash) return { image, path: "", bytes: 0, missing: true };

			const canonicalPath = path.join(blobsDir, hash);
			const extension = blobExtensionForImageMimeType(image.mimeType);
			const displayPath = extension ? `${canonicalPath}.${extension}` : canonicalPath;
			for (const candidate of displayPath === canonicalPath ? [canonicalPath] : [displayPath, canonicalPath]) {
				try {
					const stat = await fs.stat(candidate);
					return { image, path: candidate, bytes: stat.size, missing: false };
				} catch (err) {
					if (!isEnoent(err)) throw err;
				}
			}
			return { image, path: "", bytes: 0, missing: true };
		}

		const buffer = Buffer.from(image.data, "base64");
		const result = await new BlobStore(blobsDir).put(buffer, {
			extension: blobExtensionForImageMimeType(image.mimeType),
		});
		return { image, path: result.displayPath, bytes: buffer.length, missing: false };
	}

	async #renderIndex(refs: AgentRef[]): Promise<string> {
		const entries: IndexEntry[] = refs.map(ref => ({
			id: ref.id,
			status: ref.status,
			kind: ref.kind,
			parent: ref.parentId ?? "—",
			lastActivity: formatAgo(ref.lastActivity),
		}));
		// Merge on-disk transcripts for agents absent from the registry.
		const registered = new Set(refs.map(ref => ref.id));
		const disk = await sessionFilesFromDisk();
		for (const id of disk.keys()) {
			if (registered.has(id)) continue;
			entries.push({ id, status: "on disk", kind: "—", parent: "—", lastActivity: "—" });
		}

		const lines: string[] = ["# Agents", ""];
		if (entries.length === 0) {
			lines.push("No agents registered.");
			return `${lines.join("\n")}\n`;
		}
		lines.push("| id | status | kind | parent | last activity |", "|---|---|---|---|---|");
		for (const entry of entries) {
			lines.push(`| ${entry.id} | ${entry.status} | ${entry.kind} | ${entry.parent} | ${entry.lastActivity} |`);
		}
		lines.push("", "Read a transcript with `read history://<id>`.");
		return `${lines.join("\n")}\n`;
	}

	async complete(): Promise<UrlCompletion[]> {
		const completions: UrlCompletion[] = [];
		const seen = new Set<string>();
		for (const ref of AgentRegistry.global().list()) {
			if (ref.kind === "advisor") continue;
			seen.add(ref.id);
			completions.push({
				value: ref.id,
				description: `${ref.status} · ${ref.kind}${ref.parentId ? ` · parent ${ref.parentId}` : ""}`,
			});
		}
		const disk = await sessionFilesFromDisk();
		for (const id of disk.keys()) {
			if (seen.has(id)) continue;
			seen.add(id);
			completions.push({ value: id, description: "on disk" });
		}
		return completions;
	}
}
