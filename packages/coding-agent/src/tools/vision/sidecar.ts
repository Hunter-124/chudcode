import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

export interface VisionFailure {
	ok: false;
	reason: string;
	hint: string;
}

export interface VisionSuccess {
	ok: true;
	[key: string]: unknown;
}

export type VisionResponse = VisionSuccess | VisionFailure;

export interface VisionModelManifestEntry {
	id: string;
	filename: string;
	sha256: string;
	url: string;
	bytes: number;
}

export type VisionBinaryResolution = { ok: true; path: string; nativeDirs: string[] } | VisionFailure;

export interface RunVisionOptions {
	binaryPath?: string;
	modelDir?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

const STDOUT_LIMIT = 8 * 1024 * 1024;
const STDERR_LIMIT = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MANIFEST_TIMEOUT_MS = 10_000;

async function isExecutable(candidate: string): Promise<boolean> {
	try {
		await fs.access(candidate, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
		return (await fs.stat(candidate)).isFile();
	} catch {
		return false;
	}
}

function nativeAddonDirectories(): string[] {
	const dirs: string[] = [];
	const require_ = createRequire(import.meta.url);
	try {
		dirs.push(path.dirname(require_.resolve("@oh-my-pi/pi-natives")));
	} catch {
		// The optional native package is not required for the sidecar.
	}
	try {
		const platformPackage = `@oh-my-pi/pi-natives-${process.platform}-${process.arch}`;
		dirs.push(path.dirname(require_.resolve(`${platformPackage}/package.json`)));
	} catch {
		// Workspace and compiled installs do not necessarily have a leaf package.
	}
	return [...new Set(dirs)];
}

/** Resolve the optional chud-vision binary without starting it. */
export async function resolveVisionSidecar(): Promise<VisionBinaryResolution> {
	const executableName = process.platform === "win32" ? "chud-vision.exe" : "chud-vision";
	const nativeDirs = nativeAddonDirectories();
	const explicit = process.env.CHUDCODE_VISION_BIN?.trim();
	if (explicit) {
		const resolved = path.isAbsolute(explicit) ? explicit : (Bun.which(explicit) ?? path.resolve(explicit));
		if (await isExecutable(resolved)) return { ok: true, path: resolved, nativeDirs };
		return {
			ok: false,
			reason: "sidecar_missing",
			hint: `CHUDCODE_VISION_BIN points to an unavailable executable: ${resolved}. Install chud-vision or correct CHUDCODE_VISION_BIN.`,
		};
	}

	const candidates = [
		...nativeDirs.map(dir => path.join(dir, executableName)),
		path.join(path.dirname(process.execPath), executableName),
	];
	for (const candidate of candidates) {
		if (await isExecutable(candidate)) return { ok: true, path: candidate, nativeDirs };
	}

	const fromPath = Bun.which(executableName);
	if (fromPath && (await isExecutable(fromPath))) return { ok: true, path: fromPath, nativeDirs };

	const devFallback = path.resolve(import.meta.dir, "../../../../../target/release", executableName);
	if (await isExecutable(devFallback)) return { ok: true, path: devFallback, nativeDirs };

	return {
		ok: false,
		reason: "sidecar_missing",
		hint: "chud-vision is not installed. Install the optional vision sidecar beside the chudcode executable, put it on PATH, or set CHUDCODE_VISION_BIN to its absolute path.",
	};
}

async function findOrtDylib(sidecarPath: string, nativeDirs: readonly string[]): Promise<string | undefined> {
	const explicit = process.env.CHUDCODE_ORT_DYLIB?.trim();
	if (explicit) return path.resolve(explicit);
	const direct = process.env.ORT_DYLIB_PATH?.trim();
	if (direct) return path.resolve(direct);

	const sidecarDirs = [path.dirname(sidecarPath)];
	try {
		sidecarDirs.push(path.dirname(await fs.realpath(sidecarPath)));
	} catch {
		// A disappearing sidecar is reported when spawning it.
	}
	const searchDirs = [...new Set([...sidecarDirs, ...nativeDirs])];

	for (const dir of searchDirs) {
		let entries: string[];
		try {
			entries = await fs.readdir(dir);
		} catch {
			continue;
		}
		const matches = entries
			.filter(name => name === "libonnxruntime.so" || name.startsWith("libonnxruntime.so."))
			.sort((a, b) => a.localeCompare(b));
		const selected = matches.at(-1);
		if (selected) return path.join(dir, selected);
	}
	return undefined;
}

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number, onOverflow: () => void): Promise<string> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	while (true) {
		const next = await reader.read();
		if (next.done) break;
		bytes += next.value.byteLength;
		if (bytes > limit) {
			onOverflow();
			await reader.cancel("vision sidecar output exceeded limit").catch(() => {});
			throw new Error(`vision sidecar output exceeded ${limit} bytes`);
		}
		chunks.push(next.value);
	}
	const combined = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(combined);
}

interface SpawnResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	timedOut: boolean;
}

async function spawnBounded(
	binaryPath: string,
	args: readonly string[],
	options: {
		stdin?: string;
		modelDir?: string;
		timeoutMs: number;
		signal?: AbortSignal;
		nativeDirs: readonly string[];
	},
): Promise<SpawnResult> {
	const ortDylib = await findOrtDylib(binaryPath, options.nativeDirs);
	const timeoutController = new AbortController();
	const timeout = setTimeout(() => timeoutController.abort(), options.timeoutMs);
	const combinedSignal = options.signal
		? AbortSignal.any([options.signal, timeoutController.signal])
		: timeoutController.signal;
	const env: Record<string, string | undefined> = {
		...process.env,
		...(ortDylib ? { ORT_DYLIB_PATH: ortDylib } : {}),
		...(options.modelDir ? { CHUDCODE_VISION_MODEL_DIR: options.modelDir } : {}),
	};

	let kill: (() => void) | undefined;
	const abort = () => kill?.();
	combinedSignal.addEventListener("abort", abort, { once: true });
	try {
		if (combinedSignal.aborted) {
			return { stdout: "", stderr: "", exitCode: -1, timedOut: timeoutController.signal.aborted };
		}
		const proc = Bun.spawn([binaryPath, ...args], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
			env,
		});
		kill = () => proc.kill();
		if (combinedSignal.aborted) kill();
		if (options.stdin !== undefined) proc.stdin.write(options.stdin);
		proc.stdin.end();

		const stdoutPromise = readBounded(proc.stdout, STDOUT_LIMIT, kill);
		const stderrPromise = readBounded(proc.stderr, STDERR_LIMIT, kill);
		const [exitCode, stdout, stderr] = await Promise.all([proc.exited, stdoutPromise, stderrPromise]);
		return { stdout, stderr, exitCode, timedOut: timeoutController.signal.aborted };
	} finally {
		clearTimeout(timeout);
		combinedSignal.removeEventListener("abort", abort);
	}
}

function validManifestEntry(value: unknown): value is VisionModelManifestEntry {
	if (!value || typeof value !== "object") return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.id === "string" &&
		typeof entry.filename === "string" &&
		typeof entry.sha256 === "string" &&
		/^[a-fA-F0-9]{64}$/.test(entry.sha256) &&
		typeof entry.url === "string" &&
		typeof entry.bytes === "number" &&
		Number.isSafeInteger(entry.bytes) &&
		entry.bytes >= 0
	);
}

const manifestCache = new Map<string, Promise<VisionModelManifestEntry[]>>();

/** Read and validate the sidecar's compiled-in model manifest. */
export function getVisionManifest(
	binaryPath: string,
	nativeDirs: readonly string[] = [],
): Promise<VisionModelManifestEntry[]> {
	let pending = manifestCache.get(binaryPath);
	if (pending) return pending;
	pending = (async () => {
		const result = await spawnBounded(binaryPath, ["--print-manifest"], {
			timeoutMs: MANIFEST_TIMEOUT_MS,
			nativeDirs,
		});
		if (result.timedOut) throw new Error("chud-vision --print-manifest timed out after 10 seconds");
		if (result.exitCode !== 0) {
			throw new Error(result.stderr.trim() || `chud-vision --print-manifest exited with code ${result.exitCode}`);
		}
		const parsed: unknown = JSON.parse(result.stdout.trim());
		if (!Array.isArray(parsed) || !parsed.every(validManifestEntry)) {
			throw new Error("chud-vision returned an invalid model manifest");
		}
		const ids = new Set<string>();
		for (const entry of parsed) {
			if (ids.has(entry.id)) throw new Error(`chud-vision manifest contains duplicate model id '${entry.id}'`);
			ids.add(entry.id);
			if (path.basename(entry.filename) !== entry.filename) {
				throw new Error(`chud-vision manifest contains unsafe filename '${entry.filename}'`);
			}
		}
		return parsed;
	})().catch(error => {
		manifestCache.delete(binaryPath);
		throw error;
	});
	manifestCache.set(binaryPath, pending);
	return pending;
}

/** Execute one bounded NDJSON request against a short-lived chud-vision process. */
export async function runVision(
	request: Record<string, unknown>,
	options: RunVisionOptions = {},
): Promise<VisionResponse> {
	const resolution = options.binaryPath
		? { ok: true as const, path: options.binaryPath, nativeDirs: nativeAddonDirectories() }
		: await resolveVisionSidecar();
	if (!resolution.ok) return resolution;

	try {
		const result = await spawnBounded(resolution.path, [], {
			stdin: `${JSON.stringify(request)}\n`,
			modelDir: options.modelDir,
			timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			signal: options.signal,
			nativeDirs: resolution.nativeDirs,
		});
		if (result.timedOut) {
			return {
				ok: false,
				reason: "timeout",
				hint: `chud-vision exceeded the ${Math.ceil((options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} second limit. Retry with a smaller image or verify ONNX Runtime is working.`,
			};
		}
		if (options.signal?.aborted) {
			return { ok: false, reason: "aborted", hint: "The vision request was cancelled." };
		}
		if (result.exitCode !== 0) {
			return {
				ok: false,
				reason: "sidecar_failed",
				hint: result.stderr.trim() || `chud-vision exited with code ${result.exitCode}`,
			};
		}
		const lines = result.stdout.split(/\r?\n/).filter(line => line.trim().length > 0);
		if (lines.length !== 1) {
			return {
				ok: false,
				reason: "invalid_response",
				hint: `chud-vision returned ${lines.length} response lines for one request; reinstall the matching sidecar version.`,
			};
		}
		const parsed: unknown = JSON.parse(lines[0]!);
		if (!parsed || typeof parsed !== "object" || typeof (parsed as Record<string, unknown>).ok !== "boolean") {
			return {
				ok: false,
				reason: "invalid_response",
				hint: "chud-vision returned a response without the required ok field; reinstall the matching sidecar version.",
			};
		}
		return parsed as VisionResponse;
	} catch (error) {
		if (options.signal?.aborted) return { ok: false, reason: "aborted", hint: "The vision request was cancelled." };
		return {
			ok: false,
			reason: "sidecar_failed",
			hint: error instanceof Error ? error.message : String(error),
		};
	}
}

export function defaultVisionModelDir(): string {
	return path.join(os.homedir(), ".chudcode", "models", "vision");
}
