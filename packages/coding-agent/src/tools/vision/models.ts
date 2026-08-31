import { createHash } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	defaultVisionModelDir,
	getVisionManifest,
	resolveVisionSidecar,
	type VisionFailure,
	type VisionModelManifestEntry,
} from "./sidecar";

export interface EnsureVisionModelsOptions {
	binaryPath?: string;
	nativeDirs?: readonly string[];
	modelDir?: string;
	autoDownload?: boolean;
	signal?: AbortSignal;
}

export type EnsureVisionModelsResult = { ok: true; modelDir: string; paths: Record<string, string> } | VisionFailure;

interface VerifiedFile {
	size: number;
	mtimeMs: number;
	sha256: string;
}

const verifiedFiles = new Map<string, VerifiedFile>();

function expandHome(input: string): string {
	if (input === "~") return os.homedir();
	if (input.startsWith("~/") || input.startsWith("~\\")) return path.join(os.homedir(), input.slice(2));
	return input;
}

async function sha256File(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(filePath)) hash.update(chunk);
	return hash.digest("hex");
}

async function isVerifiedModel(filePath: string, expectedBytes: number, expectedSha256: string): Promise<boolean> {
	let stat: Stats;
	try {
		stat = await fs.stat(filePath);
	} catch {
		return false;
	}
	if (!stat.isFile() || (expectedBytes > 0 && stat.size !== expectedBytes)) return false;
	const cached = verifiedFiles.get(filePath);
	if (
		cached &&
		cached.size === stat.size &&
		cached.mtimeMs === stat.mtimeMs &&
		cached.sha256 === expectedSha256.toLowerCase()
	) {
		return true;
	}
	const sha256 = await sha256File(filePath);
	if (sha256 !== expectedSha256.toLowerCase()) return false;
	verifiedFiles.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, sha256 });
	return true;
}

async function downloadAndInstall(
	url: string,
	destination: string,
	expectedBytes: number,
	expectedSha256: string,
	signal?: AbortSignal,
): Promise<VisionFailure | null> {
	const partPath = `${destination}.part-${process.pid}-${crypto.randomUUID()}`;
	let handle: fs.FileHandle | undefined;
	try {
		const parsedUrl = new URL(url);
		if (parsedUrl.protocol !== "https:") {
			return { ok: false, reason: "model_download_failed", hint: `Refusing non-HTTPS model URL: ${url}` };
		}
		const response = await fetch(parsedUrl, { redirect: "follow", signal });
		if (!response.ok || !response.body) {
			return {
				ok: false,
				reason: "model_download_failed",
				hint: `Model download failed with HTTP ${response.status} from ${url}. Retry when the model host is reachable.`,
			};
		}
		if (new URL(response.url).protocol !== "https:") {
			return {
				ok: false,
				reason: "model_download_failed",
				hint: `Refusing model download redirected to a non-HTTPS URL: ${response.url}`,
			};
		}

		handle = await fs.open(partPath, "wx", 0o600);
		const reader = response.body.getReader();
		const hash = createHash("sha256");
		let bytes = 0;
		while (true) {
			signal?.throwIfAborted();
			const next = await reader.read();
			if (next.done) break;
			bytes += next.value.byteLength;
			if (expectedBytes > 0 && bytes > expectedBytes) {
				await reader.cancel("model exceeded manifest size").catch(() => {});
				return {
					ok: false,
					reason: "model_size_mismatch",
					hint: `Downloaded model exceeded its expected ${expectedBytes} bytes. The remote artifact may have changed; retry after updating chudcode.`,
				};
			}
			hash.update(next.value);
			let offset = 0;
			while (offset < next.value.byteLength) {
				const { bytesWritten } = await handle.write(next.value, offset, next.value.byteLength - offset);
				if (bytesWritten === 0) throw new Error(`Unable to write model part file ${partPath}`);
				offset += bytesWritten;
			}
		}
		await handle.sync();
		await handle.close();
		handle = undefined;

		if (expectedBytes > 0 && bytes !== expectedBytes) {
			return {
				ok: false,
				reason: "model_size_mismatch",
				hint: `Downloaded ${bytes} bytes but the manifest requires ${expectedBytes}. Retry the download.`,
			};
		}
		const actualSha256 = hash.digest("hex");
		if (actualSha256 !== expectedSha256.toLowerCase()) {
			return {
				ok: false,
				reason: "model_checksum_mismatch",
				hint: `Downloaded model checksum ${actualSha256} does not match ${expectedSha256}. The file was discarded; retry after updating chudcode.`,
			};
		}

		try {
			await fs.rename(partPath, destination);
		} catch (error) {
			// Another concurrent session may have completed the same atomic install.
			if (!(await isVerifiedModel(destination, expectedBytes, expectedSha256))) throw error;
			await fs.rm(partPath, { force: true });
		}
		const stat = await fs.stat(destination);
		verifiedFiles.set(destination, {
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			sha256: expectedSha256.toLowerCase(),
		});
		return null;
	} catch (error) {
		if (signal?.aborted) return { ok: false, reason: "aborted", hint: "Vision model download was cancelled." };
		return {
			ok: false,
			reason: "model_download_failed",
			hint: error instanceof Error ? error.message : String(error),
		};
	} finally {
		await handle?.close().catch(() => {});
		await fs.rm(partPath, { force: true }).catch(() => {});
	}
}

/** Discover, verify, and atomically install the requested chud-vision models. */
export async function ensureVisionModels(
	ids: string[],
	options: EnsureVisionModelsOptions = {},
): Promise<EnsureVisionModelsResult> {
	const uniqueIds = [...new Set(ids)];
	const modelDir = path.resolve(expandHome(options.modelDir?.trim() || defaultVisionModelDir()));
	if (uniqueIds.length === 0) return { ok: true, modelDir, paths: {} };

	const resolution = options.binaryPath
		? { ok: true as const, path: options.binaryPath, nativeDirs: [...(options.nativeDirs ?? [])] }
		: await resolveVisionSidecar();
	if (!resolution.ok) return resolution;

	let manifest: VisionModelManifestEntry[];
	try {
		manifest = await getVisionManifest(resolution.path, resolution.nativeDirs);
	} catch (error) {
		return {
			ok: false,
			reason: "manifest_unavailable",
			hint: error instanceof Error ? error.message : String(error),
		};
	}
	const byId = new Map(manifest.map(entry => [entry.id, entry]));
	const unknown = uniqueIds.filter(id => !byId.has(id));
	if (unknown.length > 0) {
		return {
			ok: false,
			reason: "model_unknown",
			hint: `The installed chud-vision does not advertise model id(s): ${unknown.join(", ")}. Update chudcode and chud-vision together.`,
		};
	}

	try {
		await fs.mkdir(modelDir, { recursive: true, mode: 0o700 });
		const paths: Record<string, string> = {};
		for (const id of uniqueIds) {
			if (options.signal?.aborted) {
				return { ok: false, reason: "aborted", hint: "Vision model provisioning was cancelled." };
			}
			const entry = byId.get(id)!;
			const destination = path.join(modelDir, entry.filename);
			if (!(await isVerifiedModel(destination, entry.bytes, entry.sha256))) {
				if (options.autoDownload === false) {
					return {
						ok: false,
						reason: "model_missing",
						hint: `chudcode will not download models; place ${entry.filename} at ${destination} or set vision.autoDownload=true`,
					};
				}
				const failure = await downloadAndInstall(entry.url, destination, entry.bytes, entry.sha256, options.signal);
				if (failure) return failure;
			}
			paths[id] = destination;
		}
		return { ok: true, modelDir, paths };
	} catch (error) {
		return {
			ok: false,
			reason: options.signal?.aborted ? "aborted" : "model_install_failed",
			hint: options.signal?.aborted
				? "Vision model provisioning was cancelled."
				: error instanceof Error
					? error.message
					: String(error),
		};
	}
}
