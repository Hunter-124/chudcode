import { Console } from "node:console";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { quit } from "@oh-my-pi/pi-utils/postmortem";
import { declareWorkerHostEntry, isWorkerHostSelector } from "@oh-my-pi/pi-utils/worker-host";
import { PRODUCT_SEMVER } from "../../coding-agent/src/brand";
import { runCli } from "../../coding-agent/src/cli-runtime";
// Preserve Bun's ESM file-asset imports; its synchronous require bridge drops
// their attributes in source execution. This module graph has no top-level await.
import { runWorkbenchRuntime } from "./workbench-runtime";

async function workspaceArgument(args: string[]): Promise<string | undefined> {
	if (args.length === 1 && (args[0] === "--version" || args[0] === "--build-info")) return undefined;
	if (args.length !== 2 || args[0] !== "--workspace" || !args[1] || !path.isAbsolute(args[1])) {
		throw new Error("Usage: chudcode-service --workspace <absolute directory> | --version | --build-info");
	}
	const workspace = await fs.realpath(args[1]);
	if (!(await fs.stat(workspace)).isDirectory()) throw new Error("Workspace must be a directory");
	return workspace;
}

async function run(args: string[]): Promise<void> {
	// The extension owns stdout as a private readiness pipe. Runtime/extension
	// diagnostics belong on stderr, including direct writes by loaded extensions.
	const writeReady = process.stdout.write.bind(process.stdout);
	process.stdout.write = process.stderr.write.bind(process.stderr);
	const diagnostics = new Console({ stdout: process.stderr, stderr: process.stderr });
	Object.assign(console, diagnostics);

	const workspace = await workspaceArgument(args);
	if (workspace === undefined) {
		writeReady(
			args[0] === "--build-info"
				? `${JSON.stringify({ role: "chudcode-service", version: PRODUCT_SEMVER })}\n`
				: `${PRODUCT_SEMVER}\n`,
		);
		return;
	}
	await runWorkbenchRuntime(workspace, writeReady);
}

async function main(args: string[]): Promise<void> {
	// Reuse the compatibility CLI's worker dispatch rather than maintaining a
	// second selector table. The dispatcher installs worker inboxes synchronously
	// before its first await; importing it never starts a second executable.
	declareWorkerHostEntry();
	if (isWorkerHostSelector(args[0]) || (args.length === 1 && args[0] === "--smoke-test")) {
		await runCli(args);
		return;
	}
	await run(args);
	// Runtime background discovery can outlive disposal; the owning process
	// must not remain alive after its transport and child services are closed.
	await quit(0);
}

const args = process.argv.slice(2);
if (import.meta.main || process.env.PI_COMPILED === "true" || (!Bun.isMainThread && isWorkerHostSelector(args[0]))) {
	main(args).catch(error => {
		console.error(`Chudcode service failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		process.exit(1);
	});
}
