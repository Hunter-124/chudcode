import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PRODUCT_SEMVER, PRODUCT_VERSION, releaseBinaryName } from "../src/brand";
import {
	downloadVerifiedBinary,
	getLatestRelease,
	parseReportedVersion,
	replaceBinaryForUpdate,
	resolveGitHubTokenForTest,
	resolveReleaseBinaryAsset,
	updateViaBinaryAt,
} from "../src/cli/update-cli";

const tag = "chudcode-v0.4.1";
const name = "chudcode-linux-x64";
const browserUrl = `https://github.com/Hunter-124/chudcode/releases/download/${tag}/${name}`;
const apiUrl = "https://api.github.com/repos/Hunter-124/chudcode/releases/assets/72";
const binary = "verified release image";
const digest = `sha256:${Bun.SHA256.hash(binary, "hex")}`;
const dirs: string[] = [];

function release(overrides: Record<string, unknown> = {}) {
	return {
		tag_name: tag,
		draft: false,
		prerelease: false,
		assets: [
			{
				name,
				state: "uploaded",
				size: Buffer.byteLength(binary),
				digest,
				browser_download_url: browserUrl,
				url: apiUrl,
				...overrides,
			},
		],
	};
}

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chud-update-test-"));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("Chudcode GitHub release update", () => {
	it("resolves the latest stable from the private repository with auth, never npm or upstream", async () => {
		const requests: string[] = [];
		const latest = await getLatestRelease({
			githubToken: "test-private-token",
			fetchImpl: async (input, init) => {
				requests.push(String(input));
				expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-private-token");
				return Response.json(release());
			},
		});
		expect(latest).toEqual({ tag, version: "0.4.1" });
		expect(requests).toEqual(["https://api.github.com/repos/Hunter-124/chudcode/releases/latest"]);
	});

	it("selects a published namespaced prerelease only on canary and rejects unrelated tags", async () => {
		const latest = await getLatestRelease({
			channel: "canary",
			githubToken: "test-private-token",
			fetchImpl: async input => {
				expect(String(input)).toContain("/releases?per_page=30");
				return Response.json([
					{ ...release(), draft: true },
					{ ...release(), tag_name: "v18.4.4" },
					{ ...release(), prerelease: true },
				]);
			},
		});
		expect(latest).toEqual({ tag, version: "0.4.1" });
		await expect(
			getLatestRelease({
				githubToken: "test-private-token",
				fetchImpl: async () => Response.json({ ...release(), prerelease: true }),
			}),
		).rejects.toThrow("No published stable release");
	});

	it("requires auth or reports a private repository rather than an empty release", async () => {
		await expect(
			getLatestRelease({ githubToken: "", fetchImpl: async () => new Response("", { status: 404 }) }),
		).rejects.toThrow("private releases");
		expect(
			await resolveGitHubTokenForTest({
				envToken: "env-token",
				ghPath: "/fake/gh",
				runGhAuthToken: async () => "gh-token",
			}),
		).toBe("env-token");
		expect(
			await resolveGitHubTokenForTest({ envToken: "", ghPath: "/fake/gh", runGhAuthToken: async () => "gh-token" }),
		).toBe("gh-token");
	});

	it("validates the release digest, tag, and API asset origin before downloading", () => {
		expect(resolveReleaseBinaryAsset(release(), tag, name)).toEqual({
			url: apiUrl,
			size: Buffer.byteLength(binary),
			digest,
		});
		expect(() => resolveReleaseBinaryAsset(release({ url: "https://attacker.example/binary" }), tag, name)).toThrow(
			"unexpected API URL",
		);
		expect(() => resolveReleaseBinaryAsset(release({ digest: null }), tag, name)).toThrow("no digest");
		expect(() =>
			resolveReleaseBinaryAsset(release({ browser_download_url: "https://attacker.example/binary" }), tag, name),
		).toThrow("unexpected download URL");
		expect(() => resolveReleaseBinaryAsset({ ...release(), prerelease: true }, tag, name)).toThrow("prerelease");
		expect(() => resolveReleaseBinaryAsset(release(), "chudcode-v0.4.2", name)).toThrow("tag mismatch");
	});

	it("fetches private API assets with a bearer token and deletes a digest-mismatched download", async () => {
		const targetPath = path.join(await tempDir(), name);
		const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
			expect(String(input)).toBe(apiUrl);
			expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-private-token");
			expect(new Headers(init?.headers).get("Accept")).toBe("application/octet-stream");
			return new Response(binary);
		};
		await downloadVerifiedBinary({
			url: apiUrl,
			targetPath,
			expectedSize: Buffer.byteLength(binary),
			expectedDigest: digest,
			githubToken: "test-private-token",
			fetchImpl,
		});
		expect(await Bun.file(targetPath).text()).toBe(binary);
		await expect(
			downloadVerifiedBinary({
				url: apiUrl,
				targetPath,
				expectedSize: Buffer.byteLength(binary),
				expectedDigest: `sha256:${"0".repeat(64)}`,
				githubToken: "test-private-token",
				fetchImpl,
			}),
		).rejects.toThrow("digest mismatch");
		expect(await Bun.file(targetPath).exists()).toBe(false);
	});

	it("refuses to replace scripts and rolls back a binary whose version is wrong", async () => {
		const dir = await tempDir();
		const targetPath = path.join(dir, "chud");
		await Bun.write(targetPath, "#!/bin/sh\necho 'Chudcode v0.4.0'\n");
		await fs.chmod(targetPath, 0o755);
		await expect(
			updateViaBinaryAt(targetPath, "0.4.1", {
				validateExistingTarget: true,
				githubToken: "test-private-token",
				fetchImpl: async () => {
					throw new Error("must not fetch");
				},
			}),
		).rejects.toThrow("shebang script");
		const tempPath = path.join(dir, "chud.new");
		await Bun.write(targetPath, "old-image");
		await Bun.write(tempPath, "bad-new-image");
		await expect(
			replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath: path.join(dir, "chud.bak"),
				expectedVersion: "0.4.1",
				verifyInstalledVersion: async () => ({ ok: false, actual: "0.4.0", path: targetPath }),
			}),
		).rejects.toThrow("restored previous chud binary");
		expect(await Bun.file(targetPath).text()).toBe("old-image");
	});

	it("parses exactly the version printed by the release CLI, not upstream or malformed output", () => {
		expect(parseReportedVersion(PRODUCT_VERSION)).toBe(PRODUCT_SEMVER);
		expect(parseReportedVersion("Chudcode v0.4.1-canary.1")).toBe("0.4.1-canary.1");
		expect(parseReportedVersion("omp/18.4.4")).toBeUndefined();
		expect(parseReportedVersion("Chudcode v0.4.0 (based on omp 18.0.8)")).toBeUndefined();
		expect(releaseBinaryName({ platform: "win32", arch: "x64" })).toBe("chudcode-windows-x64.exe");
		expect(() => releaseBinaryName({ platform: "linux", arch: "arm64" })).toThrow("Unsupported release architecture");
		expect(() => releaseBinaryName({ platform: "linux", arch: "x64", musl: true })).toThrow(
			"No musl Linux release binary",
		);
	});
});
