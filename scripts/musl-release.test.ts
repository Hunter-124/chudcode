import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as fsx from "@chudware/utils/fsx";

const repoRoot = path.join(import.meta.dir, "..");
const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function run(
	command: string[],
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(command, {
		cwd: repoRoot,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

async function writeExecutable(directory: string, name: string, content: string): Promise<void> {
	const file = path.join(directory, name);
	await fsx.write(file, content);
	await fs.chmod(file, 0o755);
}

describe("musl release artifacts", () => {
	test("selects the musl asset when the Linux host reports musl", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chudcode-musl-install-"));
		tempDirs.push(dir);
		const binDir = path.join(dir, "bin");
		const installDir = path.join(dir, "install");
		await fs.mkdir(binDir);
		await writeExecutable(binDir, "uname", '#!/bin/sh\n[ "$1" = "-s" ] && echo Linux || echo x86_64\n');
		await writeExecutable(binDir, "ldd", "#!/bin/sh\necho 'musl libc (x86_64)'\n");
		await writeExecutable(
			binDir,
			"curl",
			`#!/bin/sh
case "$*" in
  *api.github.com*) echo '{"tag_name":"v1.0.0","mentions_count":0}' ;;
  *) while [ "$#" -gt 0 ]; do
       [ "$1" = "-o" ] && { printf '%s\n' '#!/bin/sh' 'echo "chudcode v1.0.0"' > "$2"; exit 0; }
       shift
     done ;;
esac
`,
		);

		const result = await run(["sh", "scripts/install.sh", "--binary"], {
			...process.env,
			PATH: `${binDir}:${process.env.PATH ?? ""}`,
			HOME: dir,
			CHUDCODE_INSTALL_DIR: installDir,
		});

		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain("Using version: v1.0.0");
		expect(result.stdout).toContain("Downloading chudcode-linux-musl-x64...");
		expect(await fsx.readText(path.join(installDir, "chudcode"))).toBe('#!/bin/sh\necho "chudcode v1.0.0"\n');
	});
});
