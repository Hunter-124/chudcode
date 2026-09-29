import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import {
	assertCompleteDesktopRelease,
	buildReleaseManifest,
	DESKTOP_RELEASE_TARGETS,
	formatChecksums,
	hashReleaseFile,
	verifyReleaseManifest,
} from "./ci-release-checksums";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("release checksums", () => {
	it("sorts sha256sum-compatible entries", () => {
		expect(
			formatChecksums([
				{ name: "chudcode-z", sha256: "fff" },
				{ name: "chudcode-a", sha256: "000" },
			]),
		).toBe("000  chudcode-a\nfff  chudcode-z\n");
	});

	it("writes hashes for real files", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "chudcode-checksums-"));
		tempDirs.push(dir);
		const aPath = path.join(dir, "chudcode-a");
		const zPath = path.join(dir, "chudcode-z");
		const outPath = path.join(dir, "SHA256SUMS.txt");
		await Promise.all([writeFile(aPath, "abc"), writeFile(zPath, "")]);
		const result = await $`bun ${path.join(import.meta.dir, "ci-release-checksums.ts")} ${outPath} ${zPath} ${aPath}`
			.quiet()
			.nothrow();
		expect(result.exitCode).toBe(0);
		expect(await readFile(outPath, "utf8")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  chudcode-a\n" +
				"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  chudcode-z\n",
		);
	});

	it("refuses partial, duplicate, and invented desktop target sets", () => {
		expect(() => assertCompleteDesktopRelease([DESKTOP_RELEASE_TARGETS[0].file])).toThrow("missing:");
		expect(() =>
			assertCompleteDesktopRelease([
				...DESKTOP_RELEASE_TARGETS.map(target => target.file),
				DESKTOP_RELEASE_TARGETS[0].file,
			]),
		).toThrow("duplicates:");
		expect(() =>
			assertCompleteDesktopRelease([
				...DESKTOP_RELEASE_TARGETS.map(target => target.file),
				"chudcode-desktop-linux-riscv64.tar.gz",
			]),
		).toThrow("unknown:");
		expect(() =>
			assertCompleteDesktopRelease([
				...DESKTOP_RELEASE_TARGETS.map(target => target.file),
				...DESKTOP_RELEASE_TARGETS.map(target => `${target.file}.sha256`),
			]),
		).not.toThrow();
	});

	it("builds a deterministic supported-platform manifest with product and protocol versions", () => {
		const entries = DESKTOP_RELEASE_TARGETS.map((target, index) => ({
			name: target.file,
			sha256: index.toString(16).padStart(64, "0"),
			size: index + 10,
		}));
		const first = buildReleaseManifest(entries.slice().reverse(), "chudcode-v0.2.0");
		const second = buildReleaseManifest(entries, "0.2.0");
		expect(first).toEqual(second);
		expect(first.productVersion).toBe("0.2.0");
		expect(first.protocolVersions).toEqual({ rpc: [1, 2], desktop: 1 });
		expect(first.artifacts.map(artifact => artifact.target)).toEqual(["linux-x64", "macos-x64", "windows-x64"]);
	});

	it("verifies manifest metadata against every supported archive and fails closed on tampering", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "chudcode-manifest-"));
		tempDirs.push(dir);
		await Promise.all(
			DESKTOP_RELEASE_TARGETS.map((target, index) => writeFile(path.join(dir, target.file), `archive-${index}`)),
		);
		const entries = await Promise.all(
			DESKTOP_RELEASE_TARGETS.map(target => hashReleaseFile(path.join(dir, target.file))),
		);
		const manifest = buildReleaseManifest(entries, "v0.2.0");
		const manifestPath = path.join(dir, "release-manifest.json");
		await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
		await expect(verifyReleaseManifest(manifestPath, dir, "chudcode-v0.2.0")).resolves.toEqual(manifest);

		await writeFile(path.join(dir, DESKTOP_RELEASE_TARGETS[0].file), "tampered");
		await expect(verifyReleaseManifest(manifestPath, dir, "0.2.0")).rejects.toThrow("hash/size mismatch");
	});
});
