import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { PRODUCT_SEMVER } from "../packages/coding-agent/src/brand";
import {
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

describe("formatChecksums", () => {
	it("hashes assets and writes a sorted checksum manifest", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "omp-release-checksums-"));
		tempDirs.push(dir);
		const aPath = path.join(dir, "omp-a");
		const zPath = path.join(dir, "omp-z");
		const outPath = path.join(dir, "SHA256SUMS.txt");
		await Promise.all([writeFile(aPath, "abc"), writeFile(zPath, "")]);

		const result = await $`bun ${path.join(import.meta.dir, "ci-release-checksums.ts")} ${outPath} ${zPath} ${aPath}`
			.quiet()
			.nothrow();

		expect(result.exitCode).toBe(0);
		expect(await readFile(outPath, "utf8")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  omp-a\n" +
				"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  omp-z\n",
		);
	});

	it("returns an empty string for no entries", () => {
		expect(formatChecksums([])).toBe("");
	});
});

it("rejects a tampered desktop archive even when its manifest has the right product version", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "chudcode-release-manifest-"));
	tempDirs.push(directory);
	for (const { file } of DESKTOP_RELEASE_TARGETS) await writeFile(path.join(directory, file), `archive:${file}`);
	const entries = await Promise.all(
		DESKTOP_RELEASE_TARGETS.map(({ file }) => hashReleaseFile(path.join(directory, file))),
	);
	const manifestPath = path.join(directory, "release-manifest.json");
	await writeFile(manifestPath, `${JSON.stringify(buildReleaseManifest(entries, PRODUCT_SEMVER), null, 2)}\n`);
	expect((await verifyReleaseManifest(manifestPath, directory, PRODUCT_SEMVER)).artifacts).toHaveLength(3);
	await writeFile(path.join(directory, DESKTOP_RELEASE_TARGETS[0].file), "tampered archive");
	await expect(verifyReleaseManifest(manifestPath, directory, PRODUCT_SEMVER)).rejects.toThrow(
		"Release hash/size mismatch",
	);
	await expect(verifyReleaseManifest(manifestPath, directory, "0.5.0")).rejects.toThrow(
		"product or protocol version mismatch",
	);
});
