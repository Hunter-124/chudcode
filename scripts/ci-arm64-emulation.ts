#!/usr/bin/env bun
/**
 * Linux arm64 CI lane on the private x86_64 `cc-linux-chudcode` runner.
 *
 * Usage:
 *   bun scripts/ci-arm64-emulation.ts verify-host
 *   bun scripts/ci-arm64-emulation.ts install-bun --cache <dir>
 *   bun scripts/ci-arm64-emulation.ts consume --bun <arm64 bun>
 *
 * Execution is real aarch64 code under qemu-user: the guest kernel's
 * `qemu-aarch64` binfmt_misc handler runs every aarch64 ELF exec'd on the
 * runner, including child processes and re-execs, and QEMU_LD_PREFIX points it
 * at the GNU aarch64 cross sysroot (ld-linux-aarch64.so.1, libc, libgcc_s).
 * This is emulated ARM Linux, not native Apple silicon or ARM hardware
 * evidence.
 *
 * `verify-host` fails unless that handler and sysroot exist. Bazel's Rust
 * tests (`--config=linux-arm64-qemu`, see .bazelrc) run only after it; their
 * test binaries themselves run under Bazel's pinned qemu-aarch64
 * (bazel/toolchains/qemu/qemu_user.bzl) because the runner's Ubuntu 8.2.2
 * emulator crashes on concurrent /proc/self/maps reads, while aarch64 children
 * they spawn still use this binfmt handler.
 *
 * `install-bun` installs the official bun-linux-aarch64 build of the Bun
 * version CI pins, verified against the SHA-256 published in that release's
 * SHASUMS256.txt, into the runner's own tool cache, and prints the binary path.
 * x64 Bun cannot dlopen an aarch64 addon; the addon needs an aarch64 runtime.
 *
 * `consume` requires packages/natives/native to hold exactly the aarch64
 * `pi_natives.linux-arm64.node` (installed from this run's same-runner
 * handoff), proves the arm64 Bun loads that file and re-execs itself as an
 * aarch64 child, then runs the real packages/natives test suite on it.
 *
 * Every download and child process has a hard budget (scripts/ci-deadline.ts:
 * own process group, SIGTERM then SIGKILL, exit 124 on expiry); nothing is
 * retried.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DEADLINE_EXIT_CODE, runWithDeadline } from "./ci-deadline";

const repoRoot = path.join(import.meta.dir, "..");
const nativeDir = path.join(repoRoot, "packages", "natives", "native");
const ARM64_ADDON = "pi_natives.linux-arm64.node";

/** Must match BUN_VERSION in .github/workflows/ci.yml. */
const BUN_VERSION = "1.4.0";
/** bun-linux-aarch64.zip in https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/SHASUMS256.txt */
const BUN_ARM64_ZIP_SHA256 = "4b1a332ee861983eb93bcfe6f770fff94e3e31b2c388bdaea3c8ed35e58eed0e";
const BUN_ARM64_ASSET = "bun-linux-aarch64";

const BINFMT_ENTRY = "/proc/sys/fs/binfmt_misc/qemu-aarch64";
const SYSROOT = "/usr/aarch64-linux-gnu";
const SYSROOT_LOADER = path.join(SYSROOT, "lib", "ld-linux-aarch64.so.1");

/** ELF e_machine for AArch64. */
const EM_AARCH64 = 183;

/** Hard budgets in seconds; together they stay inside the job's 45 min cap. */
const DOWNLOAD_BUDGET_SECONDS = 180;
const UNZIP_BUDGET_SECONDS = 60;
const PROBE_BUDGET_SECONDS = 120;
const NATIVES_SUITE_BUDGET_SECONDS = 600;

function fail(message: string): never {
	throw new Error(message);
}

async function elfMachine(file: string): Promise<number | null> {
	const handle = await fs.open(file, "r");
	try {
		const header = Buffer.alloc(20);
		const { bytesRead } = await handle.read(header, 0, header.length, 0);
		if (bytesRead < header.length || header.readUInt32BE(0) !== 0x7f454c46) return null;
		// EI_DATA 1 = little-endian; e_machine is at offset 18.
		return header[5] === 1 ? header.readUInt16LE(18) : header.readUInt16BE(18);
	} finally {
		await handle.close();
	}
}

async function requireAarch64Elf(file: string, what: string): Promise<void> {
	const machine = await elfMachine(file);
	if (machine !== EM_AARCH64) fail(`${what} ${file} is not an aarch64 ELF (e_machine=${machine ?? "not ELF"})`);
}

async function verifyHost(): Promise<void> {
	if (process.platform !== "linux" || os.arch() !== "x64") {
		fail(`the emulated arm64 lane runs on a linux-x64 host, not ${process.platform}-${os.arch()}`);
	}
	let entry: string;
	try {
		entry = await fs.readFile(BINFMT_ENTRY, "utf8");
	} catch {
		fail(`${BINFMT_ENTRY} is missing: the qemu-aarch64 binfmt_misc handler is not registered in this kernel`);
	}
	const lines = entry.split("\n");
	if (lines[0]?.trim() !== "enabled") fail(`${BINFMT_ENTRY} is not enabled`);
	const interpreter = lines
		.find(line => line.startsWith("interpreter "))
		?.slice("interpreter ".length)
		.trim();
	const flags =
		lines
			.find(line => line.startsWith("flags:"))
			?.slice("flags:".length)
			.trim() ?? "";
	if (!interpreter) fail(`${BINFMT_ENTRY} names no interpreter`);
	// With F the kernel opened the interpreter at registration and it need not
	// be visible inside sandboxes; without F it must exist on this filesystem.
	if (!flags.includes("F")) await fs.access(interpreter, fs.constants.X_OK);
	try {
		await fs.access(SYSROOT_LOADER, fs.constants.R_OK);
	} catch {
		fail(`${SYSROOT_LOADER} is missing: install the GNU aarch64 cross sysroot (libc6-arm64-cross)`);
	}
	await requireAarch64Elf(SYSROOT_LOADER, "sysroot loader");
	if (process.env.QEMU_LD_PREFIX !== SYSROOT) fail(`QEMU_LD_PREFIX must be ${SYSROOT}`);
	console.log(`binfmt qemu-aarch64: interpreter=${interpreter} flags=${flags || "(none)"}; sysroot=${SYSROOT}`);
}

async function sha256(file: string): Promise<string> {
	const hash = crypto.createHash("sha256");
	for await (const chunk of Bun.file(file).stream()) hash.update(chunk);
	return hash.digest("hex");
}

async function run(argv: string[], seconds: number, cwd = repoRoot): Promise<void> {
	const { code } = await runWithDeadline(argv, { seconds, cwd });
	if (code === DEADLINE_EXIT_CODE) fail(`${argv.join(" ")} exceeded its ${seconds}s budget`);
	if (code !== 0) fail(`${argv.join(" ")} exited with ${code}`);
}

async function installBun(cacheRoot: string): Promise<void> {
	if (process.env.BUN_VERSION && process.env.BUN_VERSION !== BUN_VERSION) {
		fail(`workflow BUN_VERSION ${process.env.BUN_VERSION} does not match the pinned arm64 Bun ${BUN_VERSION}`);
	}
	const installDir = path.join(
		cacheRoot,
		`bun-v${BUN_VERSION}-${BUN_ARM64_ASSET}-${BUN_ARM64_ZIP_SHA256.slice(0, 16)}`,
	);
	const binary = path.join(installDir, "bun");
	try {
		await requireAarch64Elf(binary, "cached arm64 Bun");
		console.log(binary);
		return;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}

	await fs.mkdir(cacheRoot, { recursive: true });
	const staging = await fs.mkdtemp(path.join(cacheRoot, ".staging-"));
	try {
		const zip = path.join(staging, `${BUN_ARM64_ASSET}.zip`);
		const url = `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${BUN_ARM64_ASSET}.zip`;
		const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_BUDGET_SECONDS * 1000) });
		if (!response.ok) fail(`downloading ${url} failed: HTTP ${response.status}`);
		// The same signal also bounds the body stream written here.
		await Bun.write(zip, response);
		const actual = await sha256(zip);
		if (actual !== BUN_ARM64_ZIP_SHA256)
			fail(`${url} SHA-256 ${actual} does not match pinned ${BUN_ARM64_ZIP_SHA256}`);
		const extracted = path.join(staging, "extracted");
		await run(["unzip", "-q", zip, "-d", extracted], UNZIP_BUDGET_SECONDS);
		const staged = path.join(staging, "install");
		await fs.mkdir(staged);
		await fs.rename(path.join(extracted, BUN_ARM64_ASSET, "bun"), path.join(staged, "bun"));
		await fs.chmod(path.join(staged, "bun"), 0o755);
		await requireAarch64Elf(path.join(staged, "bun"), "downloaded arm64 Bun");
		try {
			await fs.rename(staged, installDir);
		} catch (err) {
			// A concurrent job on this runner installed the same verified bytes first.
			if ((err as NodeJS.ErrnoException).code !== "ENOTEMPTY" && (err as NodeJS.ErrnoException).code !== "EEXIST") {
				throw err;
			}
		}
	} finally {
		await fs.rm(staging, { recursive: true, force: true });
	}
	await requireAarch64Elf(binary, "installed arm64 Bun");
	console.log(binary);
}

/**
 * Runs inside the arm64 Bun: the facts `consume` asserts before the suite.
 * Importing index.js loads the addon through the product loader.
 */
function probeSource(): string {
	return `
import { spawnSync } from "node:child_process";
import ${JSON.stringify(path.join(nativeDir, "index.js"))};
import { nativeAddonStatus } from ${JSON.stringify(path.join(nativeDir, "loader-state.js"))};
const child = spawnSync(process.execPath, ["-e", "process.stdout.write(process.arch)"], { encoding: "utf8" });
console.log(JSON.stringify({
	arch: process.arch,
	platform: process.platform,
	version: Bun.version,
	childArch: child.status === 0 ? child.stdout : \`exit \${child.status}: \${child.stderr}\`,
	addon: nativeAddonStatus(),
}));
`;
}

async function consume(bun: string): Promise<void> {
	await requireAarch64Elf(bun, "arm64 Bun");
	const addons = (await fs.readdir(nativeDir)).filter(name => name.endsWith(".node"));
	if (addons.length !== 1 || addons[0] !== ARM64_ADDON) {
		fail(
			`${nativeDir} must contain only ${ARM64_ADDON} for the arm64 consumer, found: ${addons.join(", ") || "none"}`,
		);
	}
	const addon = path.join(nativeDir, ARM64_ADDON);
	await requireAarch64Elf(addon, "native addon");

	// Executed directly, never through an explicit qemu command: the kernel's
	// binfmt handler is what runs this binary and every child it spawns.
	const probe = await runWithDeadline([bun, "-e", probeSource()], {
		seconds: PROBE_BUDGET_SECONDS,
		cwd: repoRoot,
		stdout: "pipe",
	});
	if (probe.timedOut) fail(`arm64 Bun probe exceeded its ${PROBE_BUDGET_SECONDS}s budget`);
	if (probe.code !== 0) fail(`arm64 Bun probe exited with ${probe.code}`);
	const facts = JSON.parse(probe.stdout.trim().split("\n").at(-1) ?? "{}");
	console.log(`arm64 probe: ${JSON.stringify(facts)}`);
	if (facts.arch !== "arm64" || facts.platform !== "linux") fail(`probe ran as ${facts.platform}-${facts.arch}`);
	if (facts.version !== BUN_VERSION) fail(`probe ran Bun ${facts.version}, expected ${BUN_VERSION}`);
	if (facts.childArch !== "arm64") fail(`arm64 Bun child re-exec failed: ${facts.childArch}`);
	if (facts.addon?.path !== addon) fail(`arm64 Bun loaded ${facts.addon?.path ?? "no addon"}, expected ${addon}`);
	if (facts.addon?.stale !== false) fail(`loaded addon version ${facts.addon?.version} is not this checkout's build`);

	await run([bun, "test"], NATIVES_SUITE_BUDGET_SECONDS, path.join(repoRoot, "packages", "natives"));
}

function option(argv: string[], name: string): string {
	const index = argv.indexOf(name);
	const value = index >= 0 ? argv[index + 1] : undefined;
	if (!value || value.startsWith("--")) fail(`missing ${name} <value>`);
	return path.resolve(value);
}

async function main(): Promise<void> {
	const [command, ...rest] = process.argv.slice(2);
	switch (command) {
		case "verify-host":
			return verifyHost();
		case "install-bun":
			return installBun(option(rest, "--cache"));
		case "consume":
			return consume(option(rest, "--bun"));
		default:
			fail("usage: ci-arm64-emulation.ts verify-host | install-bun --cache <dir> | consume --bun <arm64 bun>");
	}
}

if (import.meta.main) {
	main().catch(err => {
		console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	});
}
