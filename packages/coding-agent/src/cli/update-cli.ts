/**
 * Check and install Chudcode's authenticated GitHub release binaries.
 * The product is not published to npm or Homebrew.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { $env, $which, APP_NAME, compareVersions, isEnoent } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { $ } from "bun";
import {
	PRODUCT_CLI_NAME,
	PRODUCT_NAME,
	PRODUCT_RELEASE_REPO,
	PRODUCT_RELEASE_TAG_PREFIX,
	PRODUCT_SEMVER,
	releaseBinaryName,
} from "../brand";
import { settings } from "../config/settings";
import { theme } from "@oh-my-pi/pi-tui/theme";
import {
	isTimeoutError,
	isUnsupportedProxyError,
	unsupportedProxyMessage,
	withTimeoutSignal,
} from "../utils/fetch-timeout";

import { cfgUpdateChannel } from "../modes/settings";

const REPO = PRODUCT_RELEASE_REPO;
const NIX_STORE_DIR = "/nix/store";
const GITHUB_API = "https://api.github.com";
const RELEASE_METADATA_TIMEOUT_MS = 30_000;
const BINARY_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

export type UpdateChannel = "stable" | "canary";

export interface ReleaseInfo {
	tag: string;
	version: string;
}
export interface ReleaseBinaryAsset {
	url: string;
	size: number;
	digest: string;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type GitHubCliTokenRunner = (ghPath: string) => Promise<string | undefined>;

async function readGitHubCliToken(ghPath: string): Promise<string | undefined> {
	try {
		const result = await $`${ghPath} auth token --hostname github.com`.quiet().nothrow();
		if (result.exitCode !== 0) return undefined;
		const token = result.text().trim();
		return token.length > 0 ? token : undefined;
	} catch {
		return undefined;
	}
}

async function resolveGitHubToken(
	options: {
		envToken?: string;
		ghPath?: string | null;
		runGhAuthToken?: GitHubCliTokenRunner;
	} = {},
): Promise<string | undefined> {
	const envToken = options.envToken ?? ($env.GITHUB_TOKEN || $env.GH_TOKEN);
	if (envToken) return envToken;

	const ghPath = options.ghPath === null ? undefined : (options.ghPath ?? $which("gh"));
	if (!ghPath) return undefined;

	const token = await (options.runGhAuthToken ?? readGitHubCliToken)(ghPath);
	return token?.trim() || undefined;
}

/** Test hook for the GitHub credential precedence without invoking a real CLI. */
export async function resolveGitHubTokenForTest(
	options: {
		envToken?: string;
		ghPath?: string | null;
		runGhAuthToken?: GitHubCliTokenRunner;
	} = {},
): Promise<string | undefined> {
	return resolveGitHubToken(options);
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Select and validate the binary asset from GitHub release metadata.
 *
 * Draft releases are always rejected. Prereleases are rejected unless
 * `options.allowPrerelease` is set, which the canary channel passes: canary
 * GitHub releases are published as prereleases, and the exact-tag match below
 * still pins the download to the specific requested version.
 */
export function resolveReleaseBinaryAsset(
	release: unknown,
	expectedTag: string,
	binaryName: string,
	options: { allowPrerelease?: boolean } = {},
): ReleaseBinaryAsset {
	if (!isRecord(release)) {
		throw new Error("Invalid GitHub release metadata");
	}
	if (release.tag_name !== expectedTag) {
		throw new Error(`GitHub release tag mismatch: expected ${expectedTag}`);
	}
	if (release.draft !== false) {
		throw new Error(`GitHub release ${expectedTag} is a draft, not a published release`);
	}
	if (release.prerelease !== false && !options.allowPrerelease) {
		throw new Error(`GitHub release ${expectedTag} is a prerelease; only canary updates install prerelease assets`);
	}
	if (!Array.isArray(release.assets)) {
		throw new Error(`GitHub release ${expectedTag} has no asset list`);
	}

	const matches = release.assets.filter(asset => isRecord(asset) && asset.name === binaryName);
	if (matches.length !== 1) {
		throw new Error(`GitHub release ${expectedTag} has ${matches.length} assets named ${binaryName}`);
	}

	const asset = matches[0];
	if (!isRecord(asset) || asset.state !== "uploaded") {
		throw new Error(`GitHub release asset ${binaryName} is not fully uploaded`);
	}
	if (typeof asset.size !== "number" || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
		throw new Error(`GitHub release asset ${binaryName} has an invalid size`);
	}
	if (typeof asset.digest !== "string") {
		throw new Error(`GitHub release asset ${binaryName} has no digest`);
	}
	const digest = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest)?.[1];
	if (!digest) {
		throw new Error(`GitHub release asset ${binaryName} has an unsupported digest`);
	}

	const expectedUrl = `https://github.com/${REPO}/releases/download/${expectedTag}/${binaryName}`;
	if (asset.browser_download_url !== expectedUrl) {
		throw new Error(`GitHub release asset ${binaryName} has an unexpected download URL`);
	}
	const apiUrl = `${GITHUB_API}/repos/${REPO}/releases/assets/`;
	if (
		typeof asset.url !== "string" ||
		!asset.url.startsWith(apiUrl) ||
		!/^\d+$/.test(asset.url.slice(apiUrl.length))
	) {
		throw new Error(`GitHub release asset ${binaryName} has an unexpected API URL`);
	}
	return { url: asset.url, size: asset.size, digest: `sha256:${digest.toLowerCase()}` };
}

async function getReleaseBinaryAsset(
	expectedVersion: string,
	binaryName: string,
	fetchImpl: Fetch = fetch,
	githubToken?: string,
	allowPrerelease = false,
): Promise<ReleaseBinaryAsset> {
	const tag = `${PRODUCT_RELEASE_TAG_PREFIX}${expectedVersion}`;
	const resolvedGitHubToken = githubToken ?? (await resolveGitHubToken());
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	if (resolvedGitHubToken) headers.Authorization = `Bearer ${resolvedGitHubToken}`;

	let response: Response;
	try {
		response = await fetchImpl(`${GITHUB_API}/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`, {
			headers,
			signal: withTimeoutSignal(RELEASE_METADATA_TIMEOUT_MS),
		});
	} catch (err) {
		if (isTimeoutError(err)) {
			throw new Error("Timed out fetching GitHub release metadata after 30s", { cause: err });
		}
		if (isUnsupportedProxyError(err)) throw new Error(unsupportedProxyMessage(), { cause: err });
		throw err;
	}
	if (response.status === 404 && !resolvedGitHubToken) throw new Error(privateReleaseAuthHint());
	if (response.status === 403 || response.status === 429) {
		throw new Error("GitHub API rate limit exceeded; retry later or set GITHUB_TOKEN or GH_TOKEN");
	}
	if (!response.ok) {
		throw new Error(`Failed to fetch GitHub release metadata: ${response.statusText}`);
	}

	return resolveReleaseBinaryAsset(await response.json(), tag, binaryName, { allowPrerelease });
}

function privateReleaseAuthHint(): string {
	return `Cannot read private releases for ${REPO}; run gh auth login or set GITHUB_TOKEN or GH_TOKEN.`;
}

export interface VerifiedBinaryDownloadOptions {
	url: string;
	targetPath: string;
	expectedSize: number;
	expectedDigest: string;
	fetchImpl?: Fetch;
	/** Bearer token for this private repository's API asset endpoint. */
	githubToken?: string;
}

/**
 * Download a binary and verify its GitHub-reported size and SHA-256 digest.
 */
export async function downloadVerifiedBinary(options: VerifiedBinaryDownloadOptions): Promise<void> {
	const fetchImpl = options.fetchImpl ?? fetch;
	await unlinkIfExists(options.targetPath);

	let response: Response;
	try {
		response = await fetchImpl(options.url, {
			redirect: "follow",
			headers: {
				Accept: "application/octet-stream",
				...(options.githubToken ? { Authorization: `Bearer ${options.githubToken}` } : {}),
			},
			signal: withTimeoutSignal(BINARY_DOWNLOAD_TIMEOUT_MS),
		});
	} catch (err) {
		if (isTimeoutError(err)) {
			throw new Error("Timed out downloading release binary after 15 minutes", { cause: err });
		}
		if (isUnsupportedProxyError(err)) throw new Error(unsupportedProxyMessage(), { cause: err });
		throw err;
	}
	if (!response.ok || !response.body) {
		throw new Error(`Download failed: ${response.statusText}`);
	}

	const hash = new Bun.SHA256();
	let size = 0;
	const verifier = new Transform({
		transform(chunk, _encoding, callback) {
			size += chunk.byteLength;
			if (size > options.expectedSize) {
				callback(
					new Error(
						`Downloaded binary size mismatch: expected ${options.expectedSize} bytes, received at least ${size}`,
					),
				);
				return;
			}
			hash.update(chunk);
			callback(null, chunk);
		},
	});

	try {
		await pipeline(response.body, verifier, fs.createWriteStream(options.targetPath, { mode: 0o600 }));
		const digest = `sha256:${hash.digest("hex")}`;
		if (size !== options.expectedSize) {
			throw new Error(`Downloaded binary size mismatch: expected ${options.expectedSize} bytes, received ${size}`);
		}
		if (digest !== options.expectedDigest) {
			throw new Error(`Downloaded binary digest mismatch: expected ${options.expectedDigest}, received ${digest}`);
		}
		await fs.promises.chmod(options.targetPath, 0o755);
	} catch (err) {
		await unlinkIfExists(options.targetPath);
		if (isTimeoutError(err)) {
			throw new Error("Timed out downloading release binary after 15 minutes", { cause: err });
		}
		if (isUnsupportedProxyError(err)) throw new Error(unsupportedProxyMessage(), { cause: err });
		throw err;
	}
}

/** Result from running the installed binary and parsing its reported version. */
export interface InstalledVersionVerification {
	ok: boolean;
	actual?: string;
	path?: string;
}

/** Paths and verifier used while replacing a downloaded binary update. */
export interface BinaryReplacementOptions {
	targetPath: string;
	tempPath: string;
	backupPath: string;
	expectedVersion: string;
	verifyInstalledVersion: (expectedVersion: string) => Promise<InstalledVersionVerification>;
}

/** GitHub, not npm, is the authority for this product's binary-only releases. */
export async function getLatestRelease(
	options: { timeoutMs?: number; channel?: UpdateChannel; fetchImpl?: Fetch; githubToken?: string } = {},
): Promise<ReleaseInfo> {
	const channel = options.channel ?? "stable";
	const timeoutMs = options.timeoutMs ?? RELEASE_METADATA_TIMEOUT_MS;
	const token = options.githubToken ?? (await resolveGitHubToken());
	const endpoint = channel === "canary" ? "releases?per_page=30" : "releases/latest";
	let response: Response;
	try {
		response = await (options.fetchImpl ?? fetch)(`${GITHUB_API}/repos/${REPO}/${endpoint}`, {
			headers: {
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
			signal: withTimeoutSignal(timeoutMs),
		});
	} catch (err) {
		if (isTimeoutError(err))
			throw new Error(`Timed out fetching release info after ${Math.round(timeoutMs / 1000)}s`, { cause: err });
		if (isUnsupportedProxyError(err)) throw new Error(unsupportedProxyMessage(), { cause: err });
		throw err;
	}
	if (response.status === 404 && !token) throw new Error(privateReleaseAuthHint());
	if (response.status === 403 || response.status === 429)
		throw new Error("GitHub API rate limit exceeded; retry later or set GITHUB_TOKEN or GH_TOKEN");
	if (!response.ok) throw new Error(`Failed to fetch release info for ${REPO}: HTTP ${response.status}`);
	const data: unknown = await response.json();
	const candidates = Array.isArray(data) ? data : [data];
	for (const entry of candidates) {
		if (!isRecord(entry) || entry.draft !== false || typeof entry.prerelease !== "boolean") continue;
		if (channel === "stable" && entry.prerelease) continue;
		const tag = entry.tag_name;
		if (typeof tag !== "string" || !tag.startsWith(PRODUCT_RELEASE_TAG_PREFIX)) continue;
		const version = tag.slice(PRODUCT_RELEASE_TAG_PREFIX.length);
		if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) continue;
		return { version, tag };
	}
	throw new Error(`No published ${channel} release found for ${REPO}`);
}

/** Refuse to modify another manager's immutable installation or a source script. */
function resolveUpdateTarget(): { path: string; validateExistingTarget: boolean } {
	const launcher = $which(PRODUCT_CLI_NAME);
	if (!launcher) throw new Error(`Could not resolve ${PRODUCT_CLI_NAME} binary in PATH`);
	const binaryPath = fs.realpathSync.native(launcher);
	if (binaryPath === NIX_STORE_DIR || binaryPath.startsWith(`${NIX_STORE_DIR}${path.sep}`)) {
		throw new Error("This installation is managed by Nix; update its flake input or profile.");
	}
	return { path: binaryPath, validateExistingTarget: true };
}

function isMuslLinux(): boolean {
	if (process.platform !== "linux") return false;
	if (fs.existsSync("/etc/alpine-release")) return true;
	try {
		const result = Bun.spawnSync(["ldd", "--version"], { stdout: "pipe", stderr: "pipe" });
		return /\bmusl\b/i.test(`${result.stdout}\n${result.stderr}`);
	} catch {
		return false;
	}
}

const PRODUCT_VERSION_PATTERN = new RegExp(`^${PRODUCT_NAME} v(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)$`);

/** Parse only this product's exact version line, including prerelease suffixes. */
export function parseReportedVersion(output: string): string | undefined {
	return PRODUCT_VERSION_PATTERN.exec(output)?.[1];
}

async function reportedVersionAtPath(binaryPath: string): Promise<string | undefined> {
	try {
		const result = await $`${binaryPath} --version`.quiet().nothrow();
		if (result.exitCode !== 0) return undefined;
		return parseReportedVersion(result.text().trim());
	} catch {
		return undefined;
	}
}

/**
 * Run a specific binary and check if it reports the expected version.
 */
async function verifyBinaryAtPath(binaryPath: string, expectedVersion: string): Promise<InstalledVersionVerification> {
	const actual = await reportedVersionAtPath(binaryPath);
	return { ok: actual === expectedVersion, actual, path: binaryPath };
}

async function validateExistingUpdateTarget(targetPath: string): Promise<void> {
	let hasShebang = false;
	try {
		hasShebang = (await Bun.file(targetPath).slice(0, 2).text()) === "#!";
	} catch {}

	if (!hasShebang && (await reportedVersionAtPath(targetPath)) !== undefined) return;

	const reason = hasShebang
		? "is a shebang script, not a Chudcode binary"
		: "does not report a Chudcode version when run directly";
	throw new Error(`Refusing to replace ${targetPath}: ${reason}. Reinstall with: ${installerHint()}`);
}

function printVerifiedVersion(expectedVersion: string, binaryPath?: string): void {
	const icon = theme?.status?.success ?? "✔";
	const location = binaryPath ? ` at ${binaryPath}` : "";
	console.log(chalk.green(`\n${icon} Updated to ${expectedVersion}${location}`));
}

function formatVerificationFailure(result: InstalledVersionVerification, expectedVersion: string): string {
	if (result.actual) {
		return `${APP_NAME} at ${result.path} still reports ${result.actual} (expected ${expectedVersion})`;
	}
	return `could not verify updated version${result.path ? ` at ${result.path}` : ""}`;
}

async function unlinkIfExists(filePath: string): Promise<void> {
	try {
		await fs.promises.unlink(filePath);
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
}

/**
 * Remove a backup binary without letting the removal abort a completed update.
 *
 * On Windows the executable that was just moved aside is still mapped as the
 * running process image, so unlinking it fails with EPERM/EACCES until this
 * process exits (issue #845). On macOS the same unlink would instead succeed
 * while breaking the live process's TCC permission attribution — macOS
 * resolves grants against the executable's on-disk image path — so a `.bak`
 * still mapped by any process is retained for a later sweep. The replacement
 * and verification already succeeded by the time we get here, so every error
 * is swallowed; the leftover is reclaimed by {@link sweepStaleUpdateArtifacts}
 * on the next update once it is no longer in use. Returns whether the file is
 * gone.
 */
async function removeBackupBestEffort(filePath: string): Promise<boolean> {
	// macOS only, `.bak` only: a `.new` temp file is a download in progress,
	// never an installed image, and Windows/Linux locking is already handled by
	// the swallow below — so both stay ungated.
	if (process.platform === "darwin" && filePath.endsWith(".bak")) {
		// `/usr/sbin/lsof -t` prints the PIDs holding the file; exit 1 with
		// empty stdout and stderr is the only result that proves the file is
		// unused. Live users, a missing lsof, or diagnostics on stderr all
		// retain the file for a later sweep.
		let provenUnused = false;
		try {
			const result = await $`/usr/sbin/lsof -t -- ${filePath}`.quiet().nothrow();
			provenUnused = result.exitCode === 1 && result.stdout.length === 0 && result.stderr.length === 0;
		} catch {
			// lsof missing or failed to spawn — retain conservatively.
		}
		if (!provenUnused) return false;
	}
	try {
		await fs.promises.unlink(filePath);
		return true;
	} catch (err) {
		return isEnoent(err);
	}
}

/**
 * Best-effort removal of binary-update leftovers from earlier runs.
 *
 * Each self-update writes to `<binary>.<timestamp>.<pid>.new` and moves the
 * previous executable to `<binary>.<timestamp>.<pid>.bak` before swapping the
 * new one in. On Windows a backup cannot be deleted while the updating process
 * is alive (it is the running process image), so it is left for a later run to
 * reclaim once its owning process has exited. On macOS the sweep must also
 * spare a backup that any process still maps as its executable image —
 * unlinking it would break the live process's TCC permission attribution — so
 * a live image survives until its process exits. A `.new` temp file only
 * survives a hard kill mid-download; it is reaped once older than the download
 * window,
 * which a live download cannot exceed without timing out and cleaning up after
 * itself — so a concurrent run's in-progress temp is never deleted. Legacy
 * fixed `<binary>.bak` / `<binary>.new` names (from before suffixes were made
 * unique) are matched too, so users upgrading from a buggy release get the
 * orphaned files cleaned up.
 */
export async function sweepStaleUpdateArtifacts(targetPath: string): Promise<void> {
	const dir = path.dirname(targetPath);
	const base = path.basename(targetPath);
	let entries: string[];
	try {
		entries = await fs.promises.readdir(dir);
	} catch {
		return;
	}
	const now = Date.now();
	for (const entry of entries) {
		if (!entry.startsWith(`${base}.`)) continue;
		const suffix = entry.endsWith(".bak") ? ".bak" : entry.endsWith(".new") ? ".new" : undefined;
		if (!suffix) continue;
		// Legacy "<base><suffix>" → empty middle; new "<base>.<timestamp>.<pid><suffix>"
		// → dot-separated numeric run. Anything else is an unrelated file.
		const middle = entry.slice(base.length + 1, entry.length - suffix.length);
		if (middle.length > 0 && !/^\d+(\.\d+)*$/.test(middle)) continue;
		const full = path.join(dir, entry);
		if (suffix === ".new") {
			// A temp file may belong to a concurrent update still downloading, so
			// only reap ones older than the download window.
			let mtimeMs: number;
			try {
				mtimeMs = (await fs.promises.stat(full)).mtimeMs;
			} catch {
				continue;
			}
			if (now - mtimeMs < BINARY_DOWNLOAD_TIMEOUT_MS) continue;
		}
		await removeBackupBestEffort(full);
	}
}

/**
 * Atomically replace the installed binary and roll back if version verification fails.
 */
export async function replaceBinaryForUpdate(options: BinaryReplacementOptions): Promise<InstalledVersionVerification> {
	let backupReady = false;
	try {
		// `backupPath` is unique per attempt (see updateViaBinaryAt), so this rename
		// never has to overwrite — or unlink — a possibly-locked leftover from an
		// earlier run. Renaming the running executable itself is permitted on
		// Windows; only deleting its still-mapped image is not.
		await fs.promises.rename(options.targetPath, options.backupPath);
		backupReady = true;
		await fs.promises.rename(options.tempPath, options.targetPath);

		const verification = await options.verifyInstalledVersion(options.expectedVersion);
		if (!verification.ok) {
			throw new Error(
				`${formatVerificationFailure(verification, options.expectedVersion)}; restored previous ${APP_NAME} binary`,
			);
		}

		backupReady = false;
		// Swap done and verified. On Windows the backup is still the running
		// process image and cannot be unlinked until this process exits, and on
		// macOS unlinking the still-mapped backup would break the live image's
		// TCC permission attribution, so either way a failure here must NOT fail
		// an otherwise-successful update.
		await removeBackupBestEffort(options.backupPath);
		return verification;
	} catch (err) {
		if (backupReady) {
			await unlinkIfExists(options.targetPath);
			await fs.promises.rename(options.backupPath, options.targetPath);
		}
		await unlinkIfExists(options.tempPath);
		throw err;
	}
}

// Monotonic within this process so two updates started in the same millisecond
// (same pid, same `Date.now()`) still get distinct temp/backup paths. Kept
// numeric so the artifact sweep's `\d+(\.\d+)*` matcher still reclaims them.
let updateAttemptSeq = 0;

/**
 * Download a release binary to a target path, replacing an existing file.
 */
export async function updateViaBinaryAt(
	targetPath: string,
	expectedVersion: string,
	options: {
		binaryName?: string;
		fetchImpl?: Fetch;
		githubToken?: string;
		allowPrerelease?: boolean;
		/** Refuse replacing a script or another product's executable. */
		validateExistingTarget?: boolean;
		verifyInstalledVersion?: (version: string) => Promise<InstalledVersionVerification>;
	} = {},
): Promise<void> {
	if (options.validateExistingTarget) await validateExistingUpdateTarget(targetPath);
	const binaryName =
		options.binaryName ??
		releaseBinaryName({
			platform: process.platform,
			arch: process.arch,
			musl: isMuslLinux(),
		});
	const githubToken = options.githubToken ?? (await resolveGitHubToken());
	if (!githubToken) throw new Error(privateReleaseAuthHint());
	// Unique per attempt so two overlapping `omp update` runs never share a temp
	// or backup path. A fixed temp name (`<binary>.new`) let the second run's
	// pre-download unlink delete the first run's still-downloading temp file; the
	// first kept writing to its open fd (size + digest still passed), then chmod
	// hit the missing path and the update aborted (issue #8434). The backup needs
	// the same uniqueness: a stale backup from an earlier update may still be
	// locked (the previous process image on Windows), so a fixed name would force
	// the move-aside rename to overwrite it. pid, timestamp, and a process-local
	// counter keep two updates started in the same millisecond from colliding.
	const attempt = `${Date.now()}.${process.pid}.${updateAttemptSeq++}`;
	const tempPath = `${targetPath}.${attempt}.new`;
	const backupPath = `${targetPath}.${attempt}.bak`;
	const asset = await getReleaseBinaryAsset(
		expectedVersion,
		binaryName,
		options.fetchImpl,
		githubToken,
		options.allowPrerelease,
	);
	console.log(chalk.dim(`Downloading ${binaryName}…`));
	await downloadVerifiedBinary({
		url: asset.url,
		targetPath: tempPath,
		expectedSize: asset.size,
		expectedDigest: asset.digest,
		fetchImpl: options.fetchImpl,
		githubToken,
	});
	console.log(chalk.dim(`Verified ${asset.digest}`));

	// Serialize the target swap and stale-artifact sweep per target so two
	// overlapping `omp update` runs never replace the same binary concurrently
	// or reclaim each other's live backup/temp files. The download above writes
	// to a unique temp path and is safe to overlap; only the swap is shared.
	const verification = await withFileLock(targetPath, async () => {
		console.log(chalk.dim("Installing update..."));
		const result = await replaceBinaryForUpdate({
			targetPath,
			tempPath,
			backupPath,
			expectedVersion,
			verifyInstalledVersion: options.verifyInstalledVersion ?? (version => verifyBinaryAtPath(targetPath, version)),
		});
		// Binary-only releases never involve an npm or Homebrew installer.
		// Reclaim backups from earlier updates whose owning process has since exited.
		await sweepStaleUpdateArtifacts(targetPath);
		return result;
	});
	printVerifiedVersion(expectedVersion, verification.path ?? targetPath);
	console.log(chalk.dim(`Restart ${APP_NAME} to use the new version`));
}

/** Private repository source install for recovery after a failed binary swap. */
function installerHint(): string {
	return `gh repo clone ${REPO} && sh chudcode/install.sh`;
}

/** Persisted channel, or undefined when settings are unavailable (SDK/test embedding without `Settings.init()`). */
function readPersistedChannel(): UpdateChannel | undefined {
	try {
		return cfgUpdateChannel.get(settings);
	} catch {
		return undefined;
	}
}

/** Persist an explicit channel switch; tolerated as a no-op when settings are unavailable. */
function persistChannel(channel: UpdateChannel): void {
	try {
		cfgUpdateChannel.set(settings, channel);
	} catch {
		// Outside a CLI host the explicit flag still applied for this run.
	}
}

/**
 * Run the update command.
 */
export async function runUpdateCommand(opts: {
	force: boolean;
	check: boolean;
	channel?: UpdateChannel;
}): Promise<void> {
	console.log(chalk.dim(`Current version: ${PRODUCT_NAME} v${PRODUCT_SEMVER}`));
	const persistedChannel = readPersistedChannel() ?? "stable";
	const channel = opts.channel ?? persistedChannel;
	const isChannelSwitch = opts.channel !== undefined && opts.channel !== persistedChannel;
	if (channel === "canary") console.log(chalk.dim("Current channel: canary"));

	// Check for updates
	let release: ReleaseInfo;
	try {
		release = await getLatestRelease({ channel });
	} catch (err) {
		console.error(chalk.red(`Failed to check for updates: ${err}`));
		process.exit(1);
	}

	const comparison = compareVersions(release.version, PRODUCT_SEMVER);

	if (comparison <= 0 && !opts.force && !isChannelSwitch) {
		const icon = theme?.status?.success ?? "✔";
		console.log(chalk.green(`${icon} Already up to date`));
		return;
	}

	if (isChannelSwitch) {
		console.log(
			chalk.yellow(
				`Switching to ${channel} ${release.version}${comparison <= 0 ? ` (downgrade from ${PRODUCT_SEMVER})` : ""}`,
			),
		);
	} else if (comparison > 0) {
		console.log(chalk.cyan(`New version available: ${release.version}`));
	} else {
		console.log(chalk.yellow(`Forcing reinstall of ${release.version}`));
	}

	if (opts.check) {
		// Just check, don't install
		return;
	}

	try {
		const target = resolveUpdateTarget();
		await updateViaBinaryAt(target.path, release.version, {
			allowPrerelease: channel === "canary",
			validateExistingTarget: target.validateExistingTarget,
		});
		if (opts.channel) persistChannel(channel);
	} catch (err) {
		console.error(chalk.red(`Update failed: ${err}`));
		process.exit(1);
	}
}

/**
 * Print update command help.
 */
export function printUpdateHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} update`)} - Check for and install updates

${chalk.bold("Usage:")}
  ${APP_NAME} update [options]

${chalk.bold("Options:")}
  -c, --check     Check for updates without installing
  -f, --force     Force reinstall even if up to date
  -l, --plugins   Update installed plugins
  --canary        Switch to the canary channel and update
  --stable        Switch back to the stable channel

${chalk.bold("Examples:")}
  ${APP_NAME} update              Update to latest version
  ${APP_NAME} update --check      Check if updates are available
  ${APP_NAME} update --force      Force reinstall
  ${APP_NAME} update -l           Update installed plugins
  ${APP_NAME} update --canary    Switch to the canary channel and update
`);
}
