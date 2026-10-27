import { afterEach, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { $ } from "bun";

const script = path.join(import.meta.dir, "ci-native-handoff.ts");
const sourceSha = "a".repeat(40);
const controllerSha = "b".repeat(40);
const target = "linux-x64-baseline";
const filename = `pi_natives.${target}.node`;
const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function fixture(explicitSource: string | undefined) {
	const root = await mkdtemp(path.join(tmpdir(), "chudcode-native-handoff-"));
	tempDirs.push(root);
	const file = path.join(root, filename);
	await writeFile(file, "native handoff transport fixture");
	const environment: NodeJS.ProcessEnv = {
		...process.env,
		GITHUB_REPOSITORY: "Hunter-124/chudcode-ci",
		GITHUB_RUN_ID: "123",
		GITHUB_RUN_ATTEMPT: "1",
		GITHUB_SHA: controllerSha,
	};
	delete environment.CHUDCODE_SOURCE_SHA;
	if (explicitSource !== undefined) environment.CHUDCODE_SOURCE_SHA = explicitSource;
	return { root, file, environment };
}

it.each([
	["explicit controller source", sourceSha, sourceSha],
	["source-repository fallback", undefined, controllerSha],
])("preserves exact source provenance: %s", async (_label, explicitSource, expectedSha) => {
	const { root, file, environment } = await fixture(explicitSource);
	const published = await $`${process.execPath} ${script} publish --root ${root} --target ${target} --file ${file}`
		.env(environment)
		.quiet()
		.nothrow();
	expect(published.exitCode).toBe(0);
	const manifestPath = path.join(root, environment.GITHUB_REPOSITORY!, "123", expectedSha!, target, "manifest.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	expect(manifest.source_sha).toBe(expectedSha);
	expect(manifest.run_id).toBe("123");
	const output = path.join(root, "assembled");
	const assembled = await $`${process.execPath} ${script} assemble --root ${root} --targets ${target} --out ${output}`
		.env(environment)
		.quiet()
		.nothrow();
	expect(assembled.exitCode).toBe(0);
	expect(await readFile(path.join(output, `natives-${target}`, filename), "utf8")).toBe(
		"native handoff transport fixture",
	);
});

it("never assembles another source revision's handoff", async () => {
	const { root, file, environment } = await fixture(sourceSha);
	const published = await $`${process.execPath} ${script} publish --root ${root} --target ${target} --file ${file}`
		.env(environment)
		.quiet()
		.nothrow();
	expect(published.exitCode).toBe(0);
	const output = path.join(root, "assembled");
	const assembled = await $`${process.execPath} ${script} assemble --root ${root} --targets ${target} --out ${output}`
		.env({ ...environment, CHUDCODE_SOURCE_SHA: controllerSha })
		.quiet()
		.nothrow();
	expect(assembled.exitCode).toBe(1);
});

it.each(["", "not-a-source-sha"])("rejects malformed explicit source %j without falling back", async explicitSource => {
	const { root, file, environment } = await fixture(explicitSource);
	const published = await $`${process.execPath} ${script} publish --root ${root} --target ${target} --file ${file}`
		.env(environment)
		.quiet()
		.nothrow();
	expect(published.exitCode).toBe(1);
});
