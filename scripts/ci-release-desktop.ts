#!/usr/bin/env bun
/** Check the authenticated manifest and extracted desktop payloads before publication. */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PRODUCT_SEMVER, PRODUCT_VERSION } from "../packages/coding-agent/src/brand";
import { DESKTOP_RELEASE_TARGETS, verifyReleaseManifest } from "./ci-release-checksums";
import { type DesktopTarget, validatePayloadTree } from "./package-chudcode-desktop";

async function run(command: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
	const child = Bun.spawn(command, { ...options, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (code !== 0) throw new Error(`Command failed: ${command.join(" ")} (${code}): ${stderr || stdout}`);
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
			// Run outside any source checkout and without the release runner's
			// credentials, configuration, sessions, or pre-existing runtime caches.
			const profile = path.join(extracted, ".verify-profile");
			const temporary = path.join(profile, "tmp");
			const runtime = path.join(profile, "runtime");
			await Promise.all(
				[temporary, runtime].map(directory => fs.mkdir(directory, { recursive: true, mode: 0o700 })),
			);
			const options = {
				cwd: profile,
				env: {
					PATH: process.env.PATH,
					SystemRoot: process.env.SystemRoot,
					WINDIR: process.env.WINDIR,
					ComSpec: process.env.ComSpec,
					PATHEXT: process.env.PATHEXT,
					HOME: profile,
					USERPROFILE: profile,
					APPDATA: path.join(profile, "config"),
					LOCALAPPDATA: path.join(profile, "data"),
					XDG_CONFIG_HOME: path.join(profile, "config"),
					XDG_DATA_HOME: path.join(profile, "data"),
					XDG_STATE_HOME: path.join(profile, "state"),
					XDG_CACHE_HOME: path.join(profile, "cache"),
					XDG_RUNTIME_DIR: runtime,
					TMPDIR: temporary,
					TMP: temporary,
					TEMP: temporary,
					PI_CODING_AGENT_DIR: path.join(profile, "agent"),
					PI_PACKAGE_DIR: path.join(profile, "packages"),
					PI_NOTIFICATIONS: "off",
					NO_COLOR: "1",
				},
			};
			const suffix = process.platform === "win32" ? ".exe" : "";
			const cli = path.join(extracted, `chud${suffix}`);
			const cliVersion = await run([cli, "--version"], options);
			if (cliVersion !== PRODUCT_VERSION) throw new Error(`${artifact.file} CLI version mismatch: ${cliVersion}`);
			const smokeOutput = await run([cli, "--smoke-test"], options);
			if (!smokeOutput.split(/\r?\n/).includes("smoke-test: ok"))
				throw new Error(`${artifact.file} bundled worker/assets smoke did not complete`);
			const desktopVersion = await run([path.join(extracted, `chudcode-desktop${suffix}`), "--version"], options);
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
