import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@chudware/utils";
import * as fsx from "@chudware/utils/fsx";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const probeEntry = path.join(import.meta.dir, "fixtures", "cli-initial-title-probe.ts");
const hasPtyHarness =
	process.platform === "linux" && (await fsx.exists("/usr/bin/script")) && (await fsx.exists("/usr/bin/timeout"));

describe.skipIf(!hasPtyHarness)("CLI initial-message title generation", () => {
	test("generates a title for the positional initial message", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "chudcode-cli-title-"));
		const agentDir = path.join(root, "agent");
		const outputPath = path.join(root, "probe.json");
		try {
			await fs.mkdir(agentDir, { recursive: true });
			await fsx.write(
				path.join(agentDir, "config.yml"),
				"setupVersion: 1\nstartup:\n  setupWizard: false\n  showSplash: false\n  checkUpdate: false\nproviders:\n  tinyModel: online\n",
			);
			const command = [
				JSON.stringify(process.execPath),
				"--preload",
				JSON.stringify(probeEntry),
				JSON.stringify(cliEntry),
				"--no-session",
				"--model",
				"anthropic/claude-sonnet-4-5",
				JSON.stringify("implement X"),
			].join(" ");
			const proc = Bun.spawn(["timeout", "10s", "script", "-q", "-c", command, "/dev/null"], {
				cwd: repoRoot,
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					HOME: root,
					NO_COLOR: "1",
					CHUDCODE_TITLE_PROBE_PATH: outputPath,
					CHUDCODE_CODING_AGENT_DIR: agentDir,
					CHUDCODE_NO_TITLE: "",
					TERM: "xterm-256color",
				},
			});

			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).arrayBuffer(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);

			expect({ exitCode, stderr, stdoutBytes: stdout.byteLength }).toMatchObject({ exitCode: 0, stderr: "" });
			expect(await fsx.readText(outputPath)).toBe(
				JSON.stringify({ generatedFrom: "implement X", sessionName: "CLI Initial Title" }),
			);
		} finally {
			await removeWithRetries(root);
		}
	}, 15_000);
});
