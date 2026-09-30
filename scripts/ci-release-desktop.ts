#!/usr/bin/env bun
/** Check the authenticated manifest and extracted desktop payloads before publication. */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PRODUCT_SEMVER, PRODUCT_VERSION } from "../packages/coding-agent/src/brand";
import { DESKTOP_RELEASE_TARGETS, verifyReleaseManifest } from "./ci-release-checksums";
import { type DesktopTarget, validatePayloadTree } from "./package-chudcode-desktop";

async function run(command: string[]): Promise<string> {
	const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (code !== 0) throw new Error(`Command failed: ${command.join(" ")} (${code}): ${stderr}`);
	return stdout.trim();
}

export async function verifyDesktopArchive(archivePath: string, version = PRODUCT_SEMVER): Promise<void> {
	const archive = path.resolve(archivePath);
	const artifact = DESKTOP_RELEASE_TARGETS.find(target => target.file === path.basename(archive));
	if (!artifact) throw new Error(`Unsupported desktop release archive: ${archive}`);
	const hostTarget = `${process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
	const extracted = await fs.mkdtemp(path.join(os.tmpdir(), "chudcode-desktop-verify-"));
	try {
		if (archive.endsWith(".zip")) {
			if (process.platform === "win32") {
				await run([
					path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"),
					"-xf",
					archive,
					"-C",
					extracted,
				]);
			} else await run(["unzip", "-q", archive, "-d", extracted]);
		} else await run(["tar", "-xzf", archive, "-C", extracted]);
		await validatePayloadTree(extracted, artifact.target as DesktopTarget);
		const payloadVersion = (await Bun.file(path.join(extracted, "VERSION")).text()).trim();
		if (payloadVersion !== version) throw new Error(`${artifact.file} VERSION mismatch: ${payloadVersion}`);
		for (const notice of ["LICENSE", "NOTICE", "THIRD-PARTY-NOTICES.txt"]) {
			if (!(await Bun.file(path.join(extracted, notice)).text()).trim())
				throw new Error(`${artifact.file} omits ${notice}`);
		}
		if (hostTarget === artifact.target) {
			const suffix = process.platform === "win32" ? ".exe" : "";
			const cliVersion = await run([path.join(extracted, `chud${suffix}`), "--version"]);
			if (cliVersion !== PRODUCT_VERSION) throw new Error(`${artifact.file} CLI version mismatch: ${cliVersion}`);
			const desktopVersion = await run([path.join(extracted, `chudcode-desktop${suffix}`), "--version"]);
			if (desktopVersion !== version)
				throw new Error(`${artifact.file} desktop version mismatch: ${desktopVersion}`);
		}
	} finally {
		await fs.rm(extracted, { recursive: true, force: true });
	}
}

export async function verifyDesktopRelease(
	directory: string,
	manifestPath: string,
	version = PRODUCT_SEMVER,
): Promise<void> {
	await verifyReleaseManifest(manifestPath, directory, version);
	for (const artifact of DESKTOP_RELEASE_TARGETS) {
		await verifyDesktopArchive(path.join(directory, artifact.file), version);
	}
}

if (import.meta.main) {
	const [first, second] = process.argv.slice(2);
	if (first === "--archive" && second) await verifyDesktopArchive(second);
	else if (first && second) await verifyDesktopRelease(first, second);
	else throw new Error("usage: ci-release-desktop.ts <desktop-directory> <manifest-path> | --archive <archive>");
}
