#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as module from "node:module";
import * as path from "node:path";
import * as localBuild from "../../coding-agent/scripts/build-binary";
import * as compiler from "../../coding-agent/scripts/compile-binary";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const codingAgent = path.join(repoRoot, "packages", "coding-agent");

async function runCommand(command: string[], env: NodeJS.ProcessEnv = Bun.env): Promise<void> {
	const child = Bun.spawn(command, { cwd: codingAgent, env, stdout: "inherit", stderr: "inherit" });
	const status = await child.exited;
	if (status !== 0) throw new Error(`Command failed (${status}): ${command.join(" ")}`);
}

async function main(): Promise<void> {
	let output: string | undefined;
	let target: string | undefined;
	const args = Bun.argv.slice(2);
	for (let index = 0; index < args.length; index += 1) {
		const option = args[index];
		if (option === "--help") {
			console.log(
				"Usage: bun packages/chudcode-workbench/scripts/build-engine.ts --output <directory> [--target linux-x64|macos-x64|windows-x64]",
			);
			return;
		}
		if (option !== "--output" && option !== "--target") throw new Error(`Unknown engine build option: ${option}`);
		const value = args[++index];
		if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
		if (option === "--output") {
			if (output) throw new Error("Duplicate --output");
			output = path.resolve(value);
		} else {
			if (target) throw new Error("Duplicate --target");
			target = value;
		}
	}
	if (!output) throw new Error("--output is required");
	const cross = localBuild.resolveCrossBuild(target === "macos-x64" ? "darwin-x64" : target);
	const windows = cross ? cross.platform === "win32" : process.platform === "win32";
	const suffix = windows ? ".exe" : "";
	const sign =
		process.platform === "darwin" &&
		(!cross || cross.platform === "darwin") &&
		Bun.env.BUN_NO_CODESIGN_MACHO_BINARY !== "1";
	const manifest: unknown = module.createRequire(import.meta.url)("@huggingface/transformers/package.json");
	if (
		typeof manifest !== "object" ||
		manifest === null ||
		!("version" in manifest) ||
		typeof manifest.version !== "string"
	)
		throw new Error("Transformers.js installed manifest is missing its version");
	await fs.mkdir(output, { recursive: true });
	try {
		await runCommand(["bun", "--cwd=../stats", "run", "gen:stats"]);
		await runCommand(["bun", "--cwd=../collab-web", "run", "gen:tool-views"]);
		try {
			await runCommand(
				["bun", "--cwd=../natives", "run", "gen:native"],
				cross ? { ...Bun.env, TARGET_PLATFORM: cross.platform, TARGET_ARCH: cross.arch } : Bun.env,
			);
			for (const [entrypoint, name] of [
				[path.join(codingAgent, "src", "cli.ts"), `chud${suffix}`],
				[
					path.join(repoRoot, "packages", "chudcode-desktop", "src", "workbench-host.ts"),
					`chudcode-service${suffix}`,
				],
			] as const) {
				const outfile = path.join(output, name);
				await compiler.compileCodingAgent({
					repoRoot,
					entrypoint,
					outfile,
					transformersVersion: manifest.version,
					target: cross?.target,
					executablePath: Bun.env.BUN_COMPILE_EXECUTABLE_PATH || undefined,
					skipBuiltinCodesign: sign,
				});
				if (sign)
					await runCommand([
						"codesign",
						"--force",
						"--sign",
						"-",
						"--entitlements",
						path.join(repoRoot, "scripts", "macos-entitlements.plist"),
						outfile,
					]);
				console.log(`Built ${outfile}`);
			}
		} finally {
			await runCommand(["bun", "--cwd=../natives", "run", "gen:native:reset"]);
		}
	} finally {
		await runCommand(["bun", "--cwd=../stats", "run", "gen:stats:reset"]);
	}
}

if (import.meta.main) await main();
