#!/usr/bin/env bun
/** Generate SHA256SUMS.txt and the desktop installer's authenticated manifest. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PRODUCT_NAME, PRODUCT_RELEASE_TAG_PREFIX, PRODUCT_SEMVER } from "../packages/coding-agent/src/brand";

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
	product: string;
	productVersion: string;
	protocolVersions: { rpc: readonly [1, 2]; desktop: 1 };
	artifacts: Array<DesktopReleaseTarget & { sha256: string; size: number }>;
}

export const DESKTOP_RELEASE_TARGETS: readonly DesktopReleaseTarget[] = [
	{ target: "linux-x64", os: "linux", arch: "x64", file: "chudcode-desktop-linux-x64.tar.gz" },
	{ target: "macos-x64", os: "macos", arch: "x64", file: "chudcode-desktop-macos-x64.tar.gz" },
	{ target: "windows-x64", os: "windows", arch: "x64", file: "chudcode-desktop-windows-x64.zip" },
];

export function normalizeProductVersion(value: string): string {
	const normalized = value.replace(new RegExp(`^${PRODUCT_RELEASE_TAG_PREFIX}`), "").replace(/^v/, "");
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(normalized)) {
		throw new Error(`Invalid ${PRODUCT_NAME} product version: ${value}`);
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
	const required = DESKTOP_RELEASE_TARGETS.map(target => target.file);
	const supplied = names.filter(name => name.startsWith("chudcode-desktop-"));
	if (!supplied.length) return;
	const missing = required.filter(name => !supplied.includes(name));
	const unexpected = supplied.filter(
		name => !required.includes(name) && !required.includes(name.replace(/\.sha256$/, "")),
	);
	const duplicate = required.filter(name => supplied.filter(candidate => candidate === name).length > 1);
	if (missing.length || unexpected.length || duplicate.length) {
		throw new Error(
			`Desktop release must contain exactly the supported targets; missing: ${missing.join(", ")}; unexpected: ${unexpected.join(", ")}; duplicates: ${duplicate.join(", ")}`,
		);
	}
}

export function buildReleaseManifest(entries: readonly ChecksumEntry[], productVersion: string): ReleaseManifest {
	assertCompleteDesktopRelease(entries.map(entry => entry.name));
	const byName = new Map(entries.map(entry => [entry.name, entry]));
	return {
		schemaVersion: 1,
		product: PRODUCT_NAME,
		productVersion: normalizeProductVersion(productVersion),
		protocolVersions: { rpc: [1, 2], desktop: 1 },
		artifacts: DESKTOP_RELEASE_TARGETS.map(target => {
			const entry = byName.get(target.file);
			if (!entry || entry.size === undefined) throw new Error(`Missing size or hash for ${target.file}`);
			return { ...target, sha256: entry.sha256, size: entry.size };
		}),
	};
}

export async function hashReleaseFile(assetPath: string): Promise<ChecksumEntry> {
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(assetPath).stream()) hasher.update(chunk);
	const stat = await fs.stat(assetPath);
	if (!stat.isFile()) throw new Error(`Release asset is not a regular file: ${assetPath}`);
	return { name: path.basename(assetPath), sha256: hasher.digest("hex"), size: stat.size };
}

export async function verifyReleaseManifest(
	manifestPath: string,
	releaseDirectory: string,
	version: string,
): Promise<ReleaseManifest> {
	const manifest: ReleaseManifest = await Bun.file(manifestPath).json();
	if (
		manifest.schemaVersion !== 1 ||
		manifest.product !== PRODUCT_NAME ||
		manifest.productVersion !== normalizeProductVersion(version) ||
		manifest.protocolVersions?.desktop !== 1 ||
		manifest.protocolVersions?.rpc?.[0] !== 1 ||
		manifest.protocolVersions?.rpc?.[1] !== 2 ||
		!Array.isArray(manifest.artifacts) ||
		manifest.artifacts.length !== DESKTOP_RELEASE_TARGETS.length
	) {
		throw new Error("release-manifest.json product or protocol version mismatch");
	}
	assertCompleteDesktopRelease(manifest.artifacts.map(entry => entry.file));
	for (const target of DESKTOP_RELEASE_TARGETS) {
		const entry = manifest.artifacts.find(candidate => candidate.file === target.file);
		if (
			!entry ||
			entry.target !== target.target ||
			entry.os !== target.os ||
			entry.arch !== target.arch ||
			!Number.isSafeInteger(entry.size) ||
			entry.size < 1 ||
			!/^[a-f0-9]{64}$/.test(entry.sha256)
		) {
			throw new Error(`Invalid release metadata for ${target.file}`);
		}
		const actual = await hashReleaseFile(path.join(releaseDirectory, target.file));
		if (actual.sha256 !== entry.sha256 || actual.size !== entry.size)
			throw new Error(`Release hash/size mismatch for ${target.file}`);
	}
	return manifest;
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const versionIndex = argv.indexOf("--version");
	const version = versionIndex < 0 ? PRODUCT_SEMVER : argv.splice(versionIndex, 2)[1];
	if (!version) throw new Error("--version requires a value");
	const [outFile, ...assets] = argv;
	if (!outFile || !assets.length)
		throw new Error("usage: ci-release-checksums.ts <out-file> <asset>... [--version <version>]");
	const entries = await Promise.all(assets.map(hashReleaseFile));
	assertCompleteDesktopRelease(entries.map(entry => entry.name));
	if (entries.some(entry => DESKTOP_RELEASE_TARGETS.some(target => target.file === entry.name))) {
		const manifestPath = path.join(path.dirname(outFile), "release-manifest.json");
		await Bun.write(manifestPath, `${JSON.stringify(buildReleaseManifest(entries, version), null, 2)}\n`);
		entries.push(await hashReleaseFile(manifestPath));
	}
	await Bun.write(outFile, formatChecksums(entries));
	console.log(`Wrote ${entries.length} checksum(s) to ${outFile}`);
}

if (import.meta.main) await main();
