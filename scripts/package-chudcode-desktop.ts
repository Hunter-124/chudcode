#!/usr/bin/env bun

import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { compileCodingAgent } from "../packages/coding-agent/scripts/compile-binary";
import { PRODUCT_SEMVER } from "../packages/coding-agent/src/brand";

export const TARGETS = ["linux-x64", "macos-x64", "windows-x64"] as const;
export type DesktopTarget = (typeof TARGETS)[number];

interface TargetSpec {
	platform: "linux" | "darwin" | "win32";
	arch: "x64";
	bunTarget: Bun.Build.CompileTarget;
	archive: "tar.gz" | "zip";
	exe: string;
}

const TARGET_SPEC: Record<DesktopTarget, TargetSpec> = {
	"linux-x64": { platform: "linux", arch: "x64", bunTarget: "bun-linux-x64-baseline", archive: "tar.gz", exe: "" },
	"macos-x64": { platform: "darwin", arch: "x64", bunTarget: "bun-darwin-x64", archive: "tar.gz", exe: "" },
	"windows-x64": {
		platform: "win32",
		arch: "x64",
		bunTarget: "bun-windows-x64-baseline",
		archive: "zip",
		exe: ".exe",
	},
};

const SOURCE_EXTENSIONS: Record<string, true> = {
	".c": true,
	".cc": true,
	".cpp": true,
	".cxx": true,
	".h": true,
	".hh": true,
	".hpp": true,
	".hxx": true,
	".m": true,
	".mm": true,
	".py": true,
	".pyc": true,
	".pyo": true,
	".rs": true,
	".ts": true,
	".tsx": true,
	".jsx": true,
	".map": true,
};
const NOISE_SEGMENTS: Record<string, true> = {
	".git": true,
	".github": true,
	".cache": true,
	".idea": true,
	".vscode": true,
	__pycache__: true,
	node_modules: true,
	src: true,
	test: true,
	tests: true,
};
const TOP_LEVEL_COMMON = [
	"VERSION",
	"LICENSE",
	"NOTICE",
	"THIRD-PARTY-NOTICES.txt",
	"assets",
	"web",
	"packaging",
] as const;

export interface PayloadEntry {
	absolute: string;
	relative: string;
	kind: "file" | "directory";
	mode: number;
	size: number;
}

export interface PackageDesktopOptions {
	target: DesktopTarget;
	gui: string;
	output: string;
	chud?: string;
	desktop?: string;
	guiAssets?: string;
	web?: string;
	version?: string;
	epoch?: number;
	repoRoot?: string;
}

export interface PackageDesktopResult {
	archive: string;
	sha256: string;
	target: DesktopTarget;
	version: string;
}

export function canonicalArchiveName(target: DesktopTarget): string {
	const extension = TARGET_SPEC[target].archive === "zip" ? "zip" : "tar.gz";
	return `chudcode-desktop-${target}.${extension}`;
}

function assertTarget(value: string): asserts value is DesktopTarget {
	if (!(TARGETS as readonly string[]).includes(value)) {
		throw new Error(`Unsupported desktop target ${JSON.stringify(value)}; expected one of ${TARGETS.join(", ")}`);
	}
}

function parseEpoch(value: string | undefined): number {
	if (!value) return 0;
	if (!/^\d+$/.test(value)) throw new Error("SOURCE_DATE_EPOCH must be a non-negative integer");
	const epoch = Number(value);
	if (!Number.isSafeInteger(epoch)) throw new Error("SOURCE_DATE_EPOCH is outside the safe integer range");
	return epoch;
}

async function pathKind(filePath: string): Promise<"file" | "directory"> {
	let stat: Stats;
	try {
		stat = await fs.lstat(filePath);
	} catch {
		throw new Error(`Required packaging input is missing: ${filePath}`);
	}
	if (stat.isSymbolicLink()) throw new Error(`Packaging inputs may not be symlinks: ${filePath}`);
	if (stat.isFile()) return "file";
	if (stat.isDirectory()) return "directory";
	throw new Error(`Packaging inputs must be regular files or directories: ${filePath}`);
}

function comparePaths(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

async function copyFile(source: string, destination: string, mode: number): Promise<void> {
	if ((await pathKind(source)) !== "file") throw new Error(`Expected a regular file: ${source}`);
	await fs.mkdir(path.dirname(destination), { recursive: true });
	await fs.copyFile(source, destination);
	await fs.chmod(destination, mode);
}

async function copyTree(source: string, destination: string): Promise<void> {
	if ((await pathKind(source)) !== "directory") throw new Error(`Expected a directory: ${source}`);
	await fs.mkdir(destination, { recursive: true, mode: 0o755 });
	const names = (await fs.readdir(source)).sort(comparePaths);
	for (const name of names) {
		const sourcePath = path.join(source, name);
		const destinationPath = path.join(destination, name);
		const kind = await pathKind(sourcePath);
		if (kind === "directory") await copyTree(sourcePath, destinationPath);
		else await copyFile(sourcePath, destinationPath, 0o644);
	}
}
/**
 * Copies only the asset closure reachable from the current web index. Bun uses
 * content-hashed filenames, so blindly copying a reused dist directory would
 * leak every previous generation into the release.
 */
export async function stageWebBundle(source: string, destination: string): Promise<readonly string[]> {
	if ((await pathKind(source)) !== "directory") throw new Error(`Expected a web bundle directory: ${source}`);
	const files = (await collectEntries(source)).filter(entry => entry.kind === "file");
	const byRelative = new Map(files.map(entry => [entry.relative, entry]));
	if (!byRelative.has("index.html")) throw new Error(`Desktop web bundle has no index.html: ${source}`);
	const selected = new Set<string>(["index.html"]);
	const queue = ["index.html"];
	for (let index = 0; index < queue.length; index += 1) {
		const relative = queue[index];
		if (!relative) continue;
		const entry = byRelative.get(relative);
		if (!entry) throw new Error(`Desktop web bundle references a missing asset: ${relative}`);
		const extension = path.posix.extname(relative).toLowerCase();
		if (![".html", ".js", ".css", ".json", ".svg"].includes(extension)) continue;
		const content = await fs.readFile(entry.absolute, "utf8");
		for (const candidate of files) {
			if (selected.has(candidate.relative)) continue;
			if (
				content.includes(candidate.relative) ||
				content.includes(`./${candidate.relative}`) ||
				content.includes(path.posix.basename(candidate.relative))
			) {
				selected.add(candidate.relative);
				queue.push(candidate.relative);
			}
		}
	}
	await fs.rm(destination, { recursive: true, force: true });
	for (const relative of [...selected].sort(comparePaths)) {
		const entry = byRelative.get(relative);
		if (!entry) throw new Error(`Desktop web closure lost required asset: ${relative}`);
		await copyFile(entry.absolute, path.join(destination, relative), 0o644);
	}
	return [...selected].sort(comparePaths);
}

async function collectEntries(root: string): Promise<PayloadEntry[]> {
	const entries: PayloadEntry[] = [];
	async function visit(directory: string, relativeDirectory: string): Promise<void> {
		const names = (await fs.readdir(directory)).sort(comparePaths);
		for (const name of names) {
			const absolute = path.join(directory, name);
			const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
			const stat = await fs.lstat(absolute);
			if (stat.isSymbolicLink()) throw new Error(`Payload contains a symlink: ${relative}`);
			if (stat.isDirectory()) {
				entries.push({ absolute, relative: `${relative}/`, kind: "directory", mode: 0o755, size: 0 });
				await visit(absolute, relative);
			} else if (stat.isFile()) {
				entries.push({ absolute, relative, kind: "file", mode: stat.mode & 0o777, size: stat.size });
			} else {
				throw new Error(`Payload contains a non-regular entry: ${relative}`);
			}
		}
	}
	await visit(root, "");
	return entries.sort((left, right) => comparePaths(left.relative, right.relative));
}

// NTFS has no POSIX permission bits: Node reports every file as 0o666/0o444,
// so on a Windows host the archive modes come from the payload contract
// instead (declared executables 0o755, everything else 0o644).
const HOST_HAS_POSIX_MODES = process.platform !== "win32";

function executableNames(target: DesktopTarget): string[] {
	const suffix = TARGET_SPEC[target].exe;
	return [`chud${suffix}`, `chudcode-desktop${suffix}`, `chudcode-gui${suffix}`];
}

export async function validatePayloadTree(root: string, target: DesktopTarget): Promise<readonly PayloadEntry[]> {
	assertTarget(target);
	const expectedTop = new Set<string>([...TOP_LEVEL_COMMON, ...executableNames(target)]);
	const topNames = (await fs.readdir(root)).sort();
	for (const expected of expectedTop) {
		if (!topNames.includes(expected)) throw new Error(`Payload is missing required path: ${expected}`);
	}
	for (const actual of topNames) {
		if (!expectedTop.has(actual)) throw new Error(`Payload contains unexpected top-level path: ${actual}`);
	}

	for (const executable of executableNames(target)) {
		const stat = await fs.lstat(path.join(root, executable));
		if (!stat.isFile() || stat.isSymbolicLink())
			throw new Error(`Payload executable is not a regular file: ${executable}`);
		if (HOST_HAS_POSIX_MODES && (stat.mode & 0o111) === 0) {
			throw new Error(`Payload executable does not have an executable mode: ${executable}`);
		}
		await assertExecutableTarget(path.join(root, executable), target);
	}
	if ((await pathKind(path.join(root, "web/index.html"))) !== "file")
		throw new Error("Payload web index is not a file");
	for (const required of ["assets/fonts", "assets/icons", "assets/appicon", `packaging/${target.split("-")[0]}`]) {
		if ((await pathKind(path.join(root, required))) !== "directory") {
			throw new Error(`Payload required directory is not a directory: ${required}`);
		}
	}
	const metadata = target.startsWith("linux-")
		? ["packaging/linux/chudcode.desktop"]
		: target.startsWith("macos-")
			? ["packaging/macos/Info.plist"]
			: ["packaging/windows/install-layout.json", "packaging/windows/chudcode-desktop.exe.manifest"];
	for (const required of metadata) {
		if ((await pathKind(path.join(root, required))) !== "file")
			throw new Error(`Payload metadata is not a file: ${required}`);
	}

	const executables = new Set(executableNames(target));
	const entries = (await collectEntries(root)).map(entry =>
		HOST_HAS_POSIX_MODES || entry.kind !== "file"
			? entry
			: { ...entry, mode: executables.has(entry.relative) ? 0o755 : 0o644 },
	);
	for (const entry of entries) {
		const relative = entry.relative.replace(/\/$/, "");
		const segments = relative.split("/");
		for (const segment of segments) {
			const normalizedSegment = segment.toLowerCase();
			if (NOISE_SEGMENTS[normalizedSegment] || normalizedSegment === ".ds_store" || segment.endsWith("~")) {
				throw new Error(`Payload contains forbidden source/build noise: ${entry.relative}`);
			}
		}
		if (entry.kind === "file") {
			const extension = path.posix.extname(relative).toLowerCase();
			if (SOURCE_EXTENSIONS[extension]) {
				throw new Error(`Payload contains forbidden source file: ${entry.relative}`);
			}
			if (extension === ".js" && !relative.startsWith("web/")) {
				throw new Error(`Payload contains JavaScript outside compiled web assets: ${entry.relative}`);
			}
		}
	}
	return entries;
}

function writeString(buffer: Buffer, offset: number, width: number, value: string): void {
	const encoded = Buffer.from(value);
	if (encoded.length > width) throw new Error(`Tar field is too long: ${value}`);
	encoded.copy(buffer, offset);
}

function writeOctal(buffer: Buffer, offset: number, width: number, value: number): void {
	const encoded = Math.trunc(value)
		.toString(8)
		.padStart(width - 1, "0");
	if (encoded.length >= width) throw new Error(`Tar numeric field is too large: ${value}`);
	writeString(buffer, offset, width - 1, encoded);
	buffer[offset + width - 1] = 0;
}

function splitTarPath(relative: string): { name: string; prefix: string } {
	const value = relative.replace(/\/$/, "");
	if (Buffer.byteLength(value) <= 100) return { name: value, prefix: "" };
	for (let index = value.lastIndexOf("/"); index > 0; index = value.lastIndexOf("/", index - 1)) {
		const prefix = value.slice(0, index);
		const name = value.slice(index + 1);
		if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
	}
	throw new Error(`Payload path is too long for deterministic ustar: ${relative}`);
}

function tarHeader(entry: PayloadEntry, epoch: number): Buffer {
	const header = Buffer.alloc(512);
	const names = splitTarPath(entry.relative);
	writeString(header, 0, 100, names.name);
	writeOctal(header, 100, 8, entry.mode);
	writeOctal(header, 108, 8, 0);
	writeOctal(header, 116, 8, 0);
	writeOctal(header, 124, 12, entry.size);
	writeOctal(header, 136, 12, epoch);
	header.fill(0x20, 148, 156);
	header[156] = entry.kind === "directory" ? 0x35 : 0x30;
	writeString(header, 257, 6, "ustar");
	writeString(header, 263, 2, "00");
	writeString(header, 345, 155, names.prefix);
	let checksum = 0;
	for (const byte of header) checksum += byte;
	const checksumText = checksum.toString(8).padStart(6, "0");
	writeString(header, 148, 6, checksumText);
	header[154] = 0;
	header[155] = 0x20;
	return header;
}

async function createTarGz(entries: readonly PayloadEntry[], epoch: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for (const entry of entries) {
		chunks.push(tarHeader(entry, epoch));
		if (entry.kind === "file") {
			const body = await fs.readFile(entry.absolute);
			chunks.push(body);
			const padding = (512 - (body.length % 512)) % 512;
			if (padding) chunks.push(Buffer.alloc(padding));
		}
	}
	chunks.push(Buffer.alloc(1024));
	const gzip = gzipSync(Buffer.concat(chunks), { level: 9 });
	gzip.fill(0, 4, 8);
	gzip[9] = 0xff;
	return gzip;
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let index = 0; index < table.length; index += 1) {
		let value = index;
		for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		table[index] = value >>> 0;
	}
	return table;
})();

function crc32(buffer: Buffer): number {
	let value = 0xffffffff;
	for (const byte of buffer) value = (CRC_TABLE[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
	return (value ^ 0xffffffff) >>> 0;
}

function dosTime(epoch: number): { date: number; time: number } {
	const date = new Date(Math.max(epoch * 1000, Date.UTC(1980, 0, 1)));
	const year = Math.min(2107, Math.max(1980, date.getUTCFullYear()));
	return {
		date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
		time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
	};
}

async function createZip(entries: readonly PayloadEntry[], epoch: number): Promise<Buffer> {
	const localChunks: Buffer[] = [];
	const centralChunks: Buffer[] = [];
	let offset = 0;
	const timestamp = dosTime(epoch);
	for (const entry of entries) {
		const name = Buffer.from(entry.relative);
		const body = entry.kind === "file" ? await fs.readFile(entry.absolute) : Buffer.alloc(0);
		const crc = crc32(body);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x800, 6);
		local.writeUInt16LE(timestamp.time, 10);
		local.writeUInt16LE(timestamp.date, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(body.length, 22);
		local.writeUInt16LE(name.length, 26);
		localChunks.push(local, name, body);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE((3 << 8) | 20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0x800, 8);
		central.writeUInt16LE(timestamp.time, 12);
		central.writeUInt16LE(timestamp.date, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(body.length, 20);
		central.writeUInt32LE(body.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE((entry.mode << 16) | (entry.kind === "directory" ? 0x10 : 0), 38);
		central.writeUInt32LE(offset, 42);
		centralChunks.push(central, name);
		offset += local.length + name.length + body.length;
	}
	const centralDirectory = Buffer.concat(centralChunks);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralDirectory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...localChunks, centralDirectory, end]);
}

export async function createDeterministicArchive(
	payloadRoot: string,
	target: DesktopTarget,
	output: string,
	epoch = parseEpoch(process.env.SOURCE_DATE_EPOCH),
): Promise<string> {
	if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("Archive epoch must be a non-negative safe integer");
	const entries = await validatePayloadTree(payloadRoot, target);
	const archive =
		TARGET_SPEC[target].archive === "zip" ? await createZip(entries, epoch) : await createTarGz(entries, epoch);
	await fs.mkdir(path.dirname(output), { recursive: true });
	await fs.writeFile(output, archive);
	return createHash("sha256").update(archive).digest("hex");
}

async function run(command: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const subprocess = Bun.spawn(command, { cwd, env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
	const exitCode = await subprocess.exited;
	if (exitCode !== 0) throw new Error(`Command failed (${exitCode}): ${command.join(" ")}`);
}

async function transformersVersion(): Promise<string> {
	const manifest: unknown = createRequire(import.meta.url)("@huggingface/transformers/package.json");
	if (
		typeof manifest !== "object" ||
		manifest === null ||
		!("version" in manifest) ||
		typeof manifest.version !== "string"
	) {
		throw new Error("@huggingface/transformers package manifest has no string version");
	}
	return manifest.version;
}

async function buildWeb(repoRoot: string, output: string): Promise<void> {
	await fs.rm(output, { recursive: true, force: true });
	const result = await Bun.build({
		entrypoints: [path.join(repoRoot, "packages/chudcode-desktop/src/web/index.html")],
		outdir: output,
		target: "browser",
		minify: true,
		sourcemap: "none",
		throw: false,
	});
	if (!result.success) throw new Error(`Desktop web build failed:\n${result.logs.map(log => log.message).join("\n")}`);
}

async function compileStandalone(
	repoRoot: string,
	entrypoint: string,
	output: string,
	target: TargetSpec,
): Promise<void> {
	const needsAdhocCodesign = target.platform === "darwin" && process.platform === "darwin";
	await compileCodingAgent({
		repoRoot,
		entrypoint,
		outfile: output,
		transformersVersion: await transformersVersion(),
		target: target.bunTarget,
		minifyIdentifiers: true,
		skipBuiltinCodesign: needsAdhocCodesign,
	});
	if (needsAdhocCodesign) await run(["codesign", "--force", "--sign", "-", output], repoRoot);
	await fs.chmod(output, 0o755);
}

async function buildExecutables(
	repoRoot: string,
	target: DesktopTarget,
	outputDirectory: string,
	buildCli: boolean,
): Promise<{ chud?: string; desktop: string; web: string }> {
	const spec = TARGET_SPEC[target];
	const web = path.join(outputDirectory, "web");
	await fs.mkdir(outputDirectory, { recursive: true });
	await buildWeb(repoRoot, web);
	try {
		// Like the standalone CLI build, embed the real dashboard and HTML-export
		// assets before compiling either executable's coding-agent dependency graph.
		await run(["bun", "run", "gen:stats"], repoRoot);
		await run(["bun", "run", "gen:tool-views"], repoRoot);
		await run(["bun", "run", "gen:native"], repoRoot, {
			...process.env,
			TARGET_PLATFORM: spec.platform,
			TARGET_ARCH: spec.arch,
		});
		const desktop = path.join(outputDirectory, `chudcode-desktop${spec.exe}`);
		await compileStandalone(repoRoot, path.join(repoRoot, "packages/chudcode-desktop/src/launch.ts"), desktop, spec);
		let chud: string | undefined;
		if (buildCli) {
			chud = path.join(outputDirectory, `chud${spec.exe}`);
			await compileStandalone(repoRoot, path.join(repoRoot, "packages/coding-agent/src/cli.ts"), chud, spec);
		}
		return { chud, desktop, web };
	} finally {
		try {
			await run(["bun", "run", "gen:native:reset"], repoRoot);
		} finally {
			await run(["bun", "run", "gen:stats:reset"], repoRoot);
		}
	}
}

async function stagePlatformMetadata(
	repoRoot: string,
	target: DesktopTarget,
	destination: string,
	version: string,
): Promise<void> {
	const platform = target.split("-")[0] as "linux" | "macos" | "windows";
	const targetDirectory = path.join(destination, "packaging", platform);
	await fs.mkdir(targetDirectory, { recursive: true });
	if (platform === "linux") {
		await copyFile(
			path.join(repoRoot, "packaging/linux/chudcode.desktop"),
			path.join(targetDirectory, "chudcode.desktop"),
			0o644,
		);
	} else if (platform === "windows") {
		for (const name of ["install-layout.json", "chudcode-desktop.exe.manifest"]) {
			await copyFile(path.join(repoRoot, "packaging/windows", name), path.join(targetDirectory, name), 0o644);
		}
	} else {
		const template = await fs.readFile(path.join(repoRoot, "packaging/macos/Info.plist"), "utf8");
		const bundleVersion = version.split(/[+-]/, 1)[0] ?? version;
		const rendered = template
			.replace(/(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]*(<\/string>)/, `$1${version}$2`)
			.replace(/(<key>CFBundleVersion<\/key>\s*<string>)[^<]*(<\/string>)/, `$1${bundleVersion}$2`);

		await fs.writeFile(path.join(targetDirectory, "Info.plist"), rendered);
		await fs.chmod(path.join(targetDirectory, "Info.plist"), 0o644);
	}
}
async function assertExecutableTarget(filePath: string, target: DesktopTarget): Promise<void> {
	if ((await pathKind(filePath)) !== "file") throw new Error(`Executable input is not a file: ${filePath}`);
	const spec = TARGET_SPEC[target];
	const handle = await fs.open(filePath, "r");
	try {
		const prefix = Buffer.alloc(4096);
		const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
		const data = prefix.subarray(0, bytesRead);
		let actualPlatform: TargetSpec["platform"] | undefined;
		let actualArch: TargetSpec["arch"] | "arm64" | undefined;
		if (data.length >= 20 && data.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
			actualPlatform = "linux";
			const machine = data[5] === 2 ? data.readUInt16BE(18) : data.readUInt16LE(18);
			if (machine === 62) actualArch = "x64";
			else if (machine === 183) actualArch = "arm64";
		} else if (data.length >= 64 && data[0] === 0x4d && data[1] === 0x5a) {
			actualPlatform = "win32";
			const peOffset = data.readUInt32LE(0x3c);
			const machineHeader = Buffer.alloc(6);
			const read = await handle.read(machineHeader, 0, machineHeader.length, peOffset);
			if (read.bytesRead === machineHeader.length && machineHeader.subarray(0, 4).equals(Buffer.from("PE\0\0"))) {
				const machine = machineHeader.readUInt16LE(4);
				if (machine === 0x8664) actualArch = "x64";
				else if (machine === 0xaa64) actualArch = "arm64";
			}
		} else if (data.length >= 8) {
			const littleMagic = data.readUInt32LE(0);
			const bigMagic = data.readUInt32BE(0);
			if (littleMagic === 0xfeedfacf || bigMagic === 0xfeedfacf) {
				actualPlatform = "darwin";
				const cpuType = littleMagic === 0xfeedfacf ? data.readUInt32LE(4) : data.readUInt32BE(4);
				if (cpuType === 0x01000007) actualArch = "x64";
				else if (cpuType === 0x0100000c) actualArch = "arm64";
			}
		}
		if (actualPlatform !== spec.platform || actualArch !== spec.arch) {
			throw new Error(
				`Executable ${filePath} is ${actualPlatform ?? "unknown"}-${actualArch ?? "unknown"}, expected ${spec.platform}-${spec.arch}`,
			);
		}
	} finally {
		await handle.close();
	}
}

export async function packageDesktop(options: PackageDesktopOptions): Promise<PackageDesktopResult> {
	assertTarget(options.target);
	const repoRoot = path.resolve(options.repoRoot ?? path.join(import.meta.dir, ".."));
	const version = options.version ?? PRODUCT_SEMVER;
	if (!version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
		throw new Error(`Invalid desktop release version: ${JSON.stringify(version)}`);
	}
	const epoch = options.epoch ?? parseEpoch(process.env.SOURCE_DATE_EPOCH);
	if (!Number.isSafeInteger(epoch) || epoch < 0)
		throw new Error("Desktop package epoch must be a non-negative safe integer");
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "chudcode-desktop-package-"));
	try {
		const buildDirectory = path.join(temporary, "build");
		let chud = options.chud ? path.resolve(options.chud) : undefined;
		let desktop = options.desktop ? path.resolve(options.desktop) : undefined;
		let web = options.web ? path.resolve(options.web) : path.join(repoRoot, "packages/chudcode-desktop/dist/web");
		if (!chud || !desktop) {
			const built = await buildExecutables(repoRoot, options.target, buildDirectory, !chud);
			chud ??= built.chud;
			desktop ??= built.desktop;
			web = built.web;
		}
		if (!chud || !desktop) throw new Error("Desktop packaging did not produce both standalone executables");
		await assertExecutableTarget(chud, options.target);
		await assertExecutableTarget(desktop, options.target);
		await assertExecutableTarget(path.resolve(options.gui), options.target);
		if (options.desktop && (await pathKind(web).catch(() => null)) !== "directory") {
			throw new Error("Prebuilt --desktop packaging requires packages/chudcode-desktop/dist/web");
		}

		const payload = path.join(temporary, "payload");
		await fs.mkdir(payload, { recursive: true });
		const spec = TARGET_SPEC[options.target];
		await copyFile(chud, path.join(payload, `chud${spec.exe}`), 0o755);
		await copyFile(desktop, path.join(payload, `chudcode-desktop${spec.exe}`), 0o755);
		await copyFile(path.resolve(options.gui), path.join(payload, `chudcode-gui${spec.exe}`), 0o755);
		await stageWebBundle(web, path.join(payload, "web"));
		await copyTree(
			path.resolve(options.guiAssets ?? path.join(path.dirname(options.gui), "assets")),
			path.join(payload, "assets"),
		);
		await copyTree(path.join(repoRoot, "assets/appicon"), path.join(payload, "assets/appicon"));
		await copyFile(path.join(repoRoot, "LICENSE"), path.join(payload, "LICENSE"), 0o644);
		await copyFile(path.join(repoRoot, "NOTICE"), path.join(payload, "NOTICE"), 0o644);
		await copyFile(
			path.join(repoRoot, "THIRD-PARTY-NOTICES.txt"),
			path.join(payload, "THIRD-PARTY-NOTICES.txt"),
			0o644,
		);
		await fs.writeFile(path.join(payload, "VERSION"), `${version}\n`);
		await fs.chmod(path.join(payload, "VERSION"), 0o644);
		await stagePlatformMetadata(repoRoot, options.target, payload, version);
		const output = path.resolve(options.output);
		if (path.basename(output) !== canonicalArchiveName(options.target)) {
			throw new Error(`Output filename must be canonical: ${canonicalArchiveName(options.target)}`);
		}
		const sha256 = await createDeterministicArchive(payload, options.target, output, epoch);
		return { archive: output, sha256, target: options.target, version };
	} finally {
		await fs.rm(temporary, { recursive: true, force: true });
	}
}

function readFlag(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index >= 0) {
		const value = args[index + 1];
		if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
		return value;
	}
	return args.find(argument => argument.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.includes("--build-only")) {
		const inferred = `${process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux"}-${process.arch}`;
		assertTarget(inferred);
		const repoRoot = path.resolve(path.join(import.meta.dir, ".."));
		const output = path.resolve(readFlag(args, "--output") ?? path.join(repoRoot, "packages/chudcode-desktop/dist"));
		await fs.rm(output, { recursive: true, force: true });
		await buildExecutables(repoRoot, inferred, output, false);
		return;
	}
	const targetValue = readFlag(args, "--target");
	if (!targetValue) throw new Error("--target is required");
	assertTarget(targetValue);
	const gui = readFlag(args, "--gui");
	if (!gui) throw new Error("--gui is required");
	const output = readFlag(args, "--output");
	if (!output) throw new Error("--output is required");
	const result = await packageDesktop({
		target: targetValue,
		gui,
		output,
		chud: readFlag(args, "--chud"),
		desktop: readFlag(args, "--desktop"),
		guiAssets: readFlag(args, "--gui-assets"),
		web: readFlag(args, "--web"),
		version: readFlag(args, "--version"),
		epoch: readFlag(args, "--epoch") ? parseEpoch(readFlag(args, "--epoch")) : undefined,
	});
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.main) await main();
