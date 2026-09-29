#!/usr/bin/env bun

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as fsx from "@chudware/utils/fsx";

export interface ChecksumEntry {
	name: string;
	sha256: string;
	size?: number;
}

export interface DesktopReleaseTarget {
	target: string;
	os: "linux" | "macos" | "windows";
	arch: "x64";
	file: string;
}

export interface ReleaseManifest {
	schemaVersion: 1;
	product: "Chudcode";
	productVersion: string;
	protocolVersions: { rpc: readonly [1, 2]; desktop: 1 };
	artifacts: Array<DesktopReleaseTarget & { sha256: string; size: number }>;
}

export const DESKTOP_RELEASE_TARGETS: readonly DesktopReleaseTarget[] = [
	{ target: "linux-x64", os: "linux", arch: "x64", file: "chudcode-desktop-linux-x64.tar.gz" },
	{ target: "macos-x64", os: "macos", arch: "x64", file: "chudcode-desktop-macos-x64.tar.gz" },
	{ target: "windows-x64", os: "windows", arch: "x64", file: "chudcode-desktop-windows-x64.zip" },
] as const;

const desktopFiles: Readonly<Record<string, true>> = Object.fromEntries(
	DESKTOP_RELEASE_TARGETS.map(target => [target.file, true] as const),
);
const desktopSidecars: Readonly<Record<string, true>> = Object.fromEntries(
	DESKTOP_RELEASE_TARGETS.map(target => [`${target.file}.sha256`, true] as const),
);

export function normalizeProductVersion(value: string): string {
	const normalized = value.replace(/^chudcode-v/, "").replace(/^v/, "");
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(normalized)) {
		throw new Error(`Invalid Chudcode product version: ${value}`);
	}
	return normalized;
}

export function formatChecksums(entries: readonly ChecksumEntry[]): string {
	return entries
		.slice()
		.sort((a, b) => a.name.localeCompare(b.name))
		.map(({ sha256, name }) => `${sha256}  ${name}\n`)
		.join("");
}

export function assertCompleteDesktopRelease(names: readonly string[]): void {
	const counts = new Map<string, number>();
	for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
	const suppliedDesktop = [...counts.keys()].filter(name => name.startsWith("chudcode-desktop-"));
	if (suppliedDesktop.length === 0) return;
	const missing = DESKTOP_RELEASE_TARGETS.map(target => target.file).filter(file => !counts.has(file));
	const unknown = suppliedDesktop.filter(file => !desktopFiles[file] && !desktopSidecars[file]);
	const duplicates = [...counts].filter(([file, count]) => desktopFiles[file] && count !== 1).map(([file]) => file);
	if (missing.length || unknown.length || duplicates.length) {
		throw new Error(
			`Desktop release must contain exactly the supported targets` +
				`${missing.length ? `; missing: ${missing.join(", ")}` : ""}` +
				`${unknown.length ? `; unknown: ${unknown.join(", ")}` : ""}` +
				`${duplicates.length ? `; duplicates: ${duplicates.join(", ")}` : ""}`,
		);
	}
}

export function buildReleaseManifest(entries: readonly ChecksumEntry[], productVersion: string): ReleaseManifest {
	assertCompleteDesktopRelease(entries.map(entry => entry.name));
	const byName = new Map(entries.map(entry => [entry.name, entry]));
	if (!DESKTOP_RELEASE_TARGETS.every(target => byName.has(target.file))) {
		throw new Error("Cannot build release-manifest.json without every supported desktop archive");
	}
	return {
		schemaVersion: 1,
		product: "Chudcode",
		productVersion: normalizeProductVersion(productVersion),
		protocolVersions: { rpc: [1, 2], desktop: 1 },
		artifacts: DESKTOP_RELEASE_TARGETS.map(target => {
			const entry = byName.get(target.file)!;
			if (entry.size === undefined) throw new Error(`Missing size for ${entry.name}`);
			return { ...target, sha256: entry.sha256, size: entry.size };
		}),
	};
}

export async function hashReleaseFile(assetPath: string): Promise<ChecksumEntry> {
	const hasher = crypto.createHash("sha256");
	for await (const chunk of Bun.file(assetPath).stream()) hasher.update(chunk);
	const stat = await fs.stat(assetPath);
	if (!stat.isFile()) throw new Error(`Release asset is not a regular file: ${assetPath}`);
	return { name: path.basename(assetPath), sha256: hasher.digest("hex"), size: stat.size };
}

export async function verifyReleaseManifest(
	manifestPath: string,
	releaseDirectory: string,
	productVersion: string,
): Promise<ReleaseManifest> {
	const parsed: unknown = JSON.parse(await fs.readFile(manifestPath, "utf8"));
	if (typeof parsed !== "object" || parsed === null) throw new Error("release-manifest.json is not an object");
	const manifest = parsed as Partial<ReleaseManifest>;
	const expectedVersion = normalizeProductVersion(productVersion);
	if (
		manifest.schemaVersion !== 1 ||
		manifest.product !== "Chudcode" ||
		manifest.productVersion !== expectedVersion ||
		manifest.protocolVersions?.desktop !== 1 ||
		manifest.protocolVersions?.rpc?.length !== 2 ||
		manifest.protocolVersions.rpc[0] !== 1 ||
		manifest.protocolVersions.rpc[1] !== 2
	) {
		throw new Error("release-manifest.json product or protocol version mismatch");
	}
	if (!Array.isArray(manifest.artifacts)) throw new Error("release-manifest.json has no artifact list");
	assertCompleteDesktopRelease(
		manifest.artifacts.map(artifact => (typeof artifact?.file === "string" ? artifact.file : "<invalid>")),
	);
	if (manifest.artifacts.length !== DESKTOP_RELEASE_TARGETS.length) {
		throw new Error("release-manifest.json does not contain exactly the supported artifacts");
	}
	for (const target of DESKTOP_RELEASE_TARGETS) {
		const artifact = manifest.artifacts.find(candidate => candidate.file === target.file);
		if (
			!artifact ||
			artifact.target !== target.target ||
			artifact.os !== target.os ||
			artifact.arch !== target.arch ||
			!Number.isSafeInteger(artifact.size) ||
			artifact.size < 1 ||
			!/^[0-9a-f]{64}$/.test(artifact.sha256)
		) {
			throw new Error(`release-manifest.json has invalid metadata for ${target.file}`);
		}
		const actual = await hashReleaseFile(path.join(releaseDirectory, target.file));
		if (actual.sha256 !== artifact.sha256 || actual.size !== artifact.size) {
			throw new Error(`release-manifest.json hash/size mismatch for ${target.file}`);
		}
	}
	return manifest as ReleaseManifest;
}

function parseArgs(argv: readonly string[]): { outFile: string; assetPaths: string[]; version?: string } {
	let version: string | undefined;
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--version") {
			version = argv[++i];
			if (!version) throw new Error("--version requires a value");
		} else if (arg.startsWith("--version=")) {
			version = arg.slice("--version=".length);
		} else {
			positional.push(arg);
		}
	}
	const [outFile, ...assetPaths] = positional;
	if (!outFile || assetPaths.length === 0)
		throw new Error("usage: ci-release-checksums.ts [--version <version>] <out-file> <asset>...");
	return { outFile, assetPaths, version };
}

async function main(): Promise<void> {
	const { outFile, assetPaths, version } = parseArgs(process.argv.slice(2));
	const entries = await Promise.all(assetPaths.map(hashReleaseFile));
	assertCompleteDesktopRelease(entries.map(entry => entry.name));

	const hasDesktopRelease = entries.some(entry => desktopFiles[entry.name]);
	if (hasDesktopRelease) {
		const manifestVersion = version ?? process.env.CHUDCODE_PRODUCT_VERSION ?? process.env.RELEASE_TAG;
		if (!manifestVersion)
			throw new Error("Desktop release checksums require --version (or CHUDCODE_PRODUCT_VERSION/RELEASE_TAG)");
		const manifestPath = path.join(path.dirname(outFile), "release-manifest.json");
		const manifest = buildReleaseManifest(entries, manifestVersion);
		await fsx.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
		entries.push(await hashReleaseFile(manifestPath));
	}

	await fsx.write(outFile, formatChecksums(entries));
	console.log(`Wrote ${entries.length} checksum(s) to ${outFile}`);
}

if (import.meta.main) await main();
