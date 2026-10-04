#!/usr/bin/env bun
/**
 * Same-runner native addon handoff for CI test jobs.
 *
 * Usage:
 *   bun scripts/ci-native-handoff.ts publish  --root <dir> --target <target> --file <addon.node>
 *   bun scripts/ci-native-handoff.ts assemble --root <dir> --targets "<target>..." --out <dir>
 *
 * Every job that runs this is pinned to the single private `cc-linux-chudcode`
 * runner, so producers publish into that runner's own storage instead of
 * GitHub artifact storage. Handoffs live under
 * `<root>/<repository>/<run_id>/<source sha>/`:
 *
 *   objects/<target>.attempt-<n>.<uuid>/{<addon>,manifest.json}
 *   <target> -> objects/<target>.attempt-<n>.<uuid>
 *
 * `publish` stages the addon and its manifest (exact target, repository,
 * run_id, source sha, producer attempt, file name, byte count, SHA-256) in a
 * private directory, renames it into `objects/`, then atomically swaps the
 * `<target>` symlink. A re-run producer in the same run publishes a new object
 * and repoints the symlink; earlier objects are retained.
 *
 * `assemble` resolves each requested target only inside the current
 * repository/run/sha directory, copies the published bytes into
 * `<out>/natives-<target>/<addon>` (the layout `bazel-natives.ts --source`
 * consumes) and verifies the copy against the manifest. A missing target or
 * any mismatch fails; there is no fallback to other runs, other source
 * revisions or GitHub artifacts. A failed-job re-run may consume a prior
 * successful producer attempt of the same run; its attempt is reported.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ADDON_OUTPUTS } from "./bazel-natives";

const MANIFEST = "manifest.json";
const SCHEMA = 1;

interface RunContext {
	repository: string;
	runId: string;
	sourceSha: string;
	attempt: number;
	/** `<root>/<repository>/<run_id>/<source sha>` */
	dir: string;
}

interface HandoffManifest {
	schema: number;
	repository: string;
	run_id: string;
	source_sha: string;
	producer_attempt: number;
	target: string;
	file: string;
	bytes: number;
	sha256: string;
}

function requireEnv(name: string, pattern: RegExp): string {
	const value = Bun.env[name]?.trim() ?? "";
	if (!pattern.test(value)) throw new Error(`${name} is missing or malformed: ${JSON.stringify(value)}`);
	return value;
}

function runContext(root: string): RunContext {
	const repository = requireEnv("GITHUB_REPOSITORY", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
	const runId = requireEnv("GITHUB_RUN_ID", /^[0-9]+$/);
	const sourceSha = requireEnv("GITHUB_SHA", /^[0-9a-f]{40}$/);
	return {
		repository,
		runId,
		sourceSha,
		attempt: Number(requireEnv("GITHUB_RUN_ATTEMPT", /^[1-9][0-9]*$/)),
		dir: path.join(path.resolve(root), repository, runId, sourceSha),
	};
}

function addonFile(target: string): string {
	const file = ADDON_OUTPUTS[target];
	if (!file) throw new Error(`Unknown native addon target ${JSON.stringify(target)}`);
	return file;
}

async function digest(file: string): Promise<{ bytes: number; sha256: string }> {
	const hasher = new Bun.CryptoHasher("sha256");
	let bytes = 0;
	for await (const chunk of Bun.file(file).stream()) {
		hasher.update(chunk);
		bytes += chunk.byteLength;
	}
	return { bytes, sha256: hasher.digest("hex") };
}

async function publish(root: string, target: string, source: string): Promise<void> {
	const ctx = runContext(root);
	const { dir } = ctx;
	const file = addonFile(target);
	if (path.basename(source) !== file) {
		throw new Error(`Addon ${source} does not match target ${target} (expected ${file})`);
	}
	const objects = path.join(dir, "objects");
	await fs.mkdir(objects, { recursive: true, mode: 0o700 });

	const objectName = `${target}.attempt-${ctx.attempt}.${crypto.randomUUID()}`;
	const staging = path.join(objects, `.staging-${objectName}`);
	await fs.mkdir(staging, { mode: 0o700 });
	const staged = path.join(staging, file);
	await fs.copyFile(source, staged, fs.constants.COPYFILE_EXCL);
	const { bytes, sha256 } = await digest(staged);
	if (bytes === 0) throw new Error(`Addon ${source} is empty`);
	const manifest: HandoffManifest = {
		schema: SCHEMA,
		repository: ctx.repository,
		run_id: ctx.runId,
		source_sha: ctx.sourceSha,
		producer_attempt: ctx.attempt,
		target,
		file,
		bytes,
		sha256,
	};
	await fs.writeFile(path.join(staging, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
	await fs.rename(staging, path.join(objects, objectName));

	const link = path.join(dir, `.link-${objectName}`);
	await fs.symlink(path.join("objects", objectName), link);
	await fs.rename(link, path.join(dir, target));
	console.log(`published ${target} attempt ${ctx.attempt}: ${bytes} bytes sha256 ${sha256} → ${dir}`);
}

function checkManifest(manifest: HandoffManifest, ctx: RunContext, target: string): void {
	const expected: Partial<HandoffManifest> = {
		schema: SCHEMA,
		repository: ctx.repository,
		run_id: ctx.runId,
		source_sha: ctx.sourceSha,
		target,
		file: addonFile(target),
	};
	for (const [key, value] of Object.entries(expected)) {
		const actual = manifest[key as keyof HandoffManifest];
		if (actual !== value) {
			throw new Error(
				`Handoff manifest for ${target} has ${key}=${JSON.stringify(actual)}, expected ${JSON.stringify(value)}`,
			);
		}
	}
	if (
		!Number.isInteger(manifest.producer_attempt) ||
		manifest.producer_attempt < 1 ||
		manifest.producer_attempt > ctx.attempt
	) {
		throw new Error(`Handoff manifest for ${target} has invalid producer_attempt ${manifest.producer_attempt}`);
	}
	if (!Number.isInteger(manifest.bytes) || manifest.bytes <= 0 || !/^[0-9a-f]{64}$/.test(manifest.sha256)) {
		throw new Error(`Handoff manifest for ${target} has an invalid byte count or digest`);
	}
}

async function assemble(root: string, targets: string[], out: string): Promise<void> {
	if (targets.length === 0) throw new Error("At least one native addon target is required");
	const ctx = runContext(root);
	const { dir } = ctx;
	for (const target of targets) {
		const file = addonFile(target);
		let object: string;
		try {
			object = await fs.realpath(path.join(dir, target));
		} catch {
			throw new Error(`No published native handoff for ${target} in ${dir}`);
		}
		if (path.dirname(object) !== path.join(await fs.realpath(dir), "objects")) {
			throw new Error(`Native handoff for ${target} points outside ${dir}/objects: ${object}`);
		}
		const manifest = JSON.parse(await fs.readFile(path.join(object, MANIFEST), "utf8")) as HandoffManifest;
		checkManifest(manifest, ctx, target);

		const destDir = path.join(path.resolve(out), `natives-${target}`);
		const dest = path.join(destDir, file);
		await fs.mkdir(destDir, { recursive: true });
		const temp = `${dest}.tmp-${process.pid}`;
		await fs.copyFile(path.join(object, file), temp);
		const { bytes, sha256 } = await digest(temp);
		if (bytes !== manifest.bytes || sha256 !== manifest.sha256) {
			await fs.rm(temp, { force: true });
			throw new Error(
				`Native handoff ${target} bytes do not match its manifest: ${bytes} bytes sha256 ${sha256}, ` +
					`expected ${manifest.bytes} bytes sha256 ${manifest.sha256}`,
			);
		}
		await fs.rename(temp, dest);
		console.log(
			`verified ${target} from producer attempt ${manifest.producer_attempt} of run ${ctx.runId}: ` +
				`${bytes} bytes sha256 ${sha256} → ${dest}`,
		);
	}
}

function parseArgs(argv: string[]): { command: string; options: Map<string, string> } {
	const [command, ...rest] = argv;
	const options = new Map<string, string>();
	for (let i = 0; i < rest.length; i += 2) {
		const key = rest[i];
		const value = rest[i + 1];
		if (!key?.startsWith("--") || value === undefined) throw new Error(`Malformed argument list: ${rest.join(" ")}`);
		options.set(key.slice(2), value);
	}
	return { command: command ?? "", options };
}

function option(options: Map<string, string>, name: string): string {
	const value = options.get(name);
	if (!value) throw new Error(`--${name} is required`);
	return value;
}

async function main(): Promise<void> {
	const { command, options } = parseArgs(process.argv.slice(2));
	if (command === "publish") {
		await publish(option(options, "root"), option(options, "target"), option(options, "file"));
	} else if (command === "assemble") {
		const targets = option(options, "targets").split(/\s+/).filter(Boolean);
		await assemble(option(options, "root"), targets, option(options, "out"));
	} else {
		throw new Error(
			'Usage: ci-native-handoff.ts publish --root <dir> --target <target> --file <addon> | assemble --root <dir> --targets "<target>..." --out <dir>',
		);
	}
}

if (import.meta.main) {
	try {
		await main();
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
