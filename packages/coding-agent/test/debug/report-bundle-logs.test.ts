import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createReportBundle } from "@chudware/coding-agent/debug/report-bundle";
import { getConfigRootDir, getLogsDir, removeWithRetries, setAgentDir } from "@chudware/utils";
import * as fsx from "@chudware/utils/fsx";

const originalAgentDir = process.env.CHUDCODE_CODING_AGENT_DIR;
const originalXdgStateHome = process.env.XDG_STATE_HOME;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
let cleanupRoot: string | undefined;

afterEach(async () => {
	if (originalXdgStateHome === undefined) {
		delete process.env.XDG_STATE_HOME;
	} else {
		process.env.XDG_STATE_HOME = originalXdgStateHome;
	}
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.CHUDCODE_CODING_AGENT_DIR;
	}
	if (cleanupRoot) {
		await removeWithRetries(cleanupRoot);
		cleanupRoot = undefined;
	}
});

describe("report bundle logs", () => {
	it("collects every same-day PID log, not only the current process", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chudcode-report-logs-"));
		const xdgStateHome = path.join(cleanupRoot, "state");
		await fs.mkdir(path.join(xdgStateHome, "chudcode"), { recursive: true });
		process.env.XDG_STATE_HOME = xdgStateHome;
		setAgentDir(fallbackAgentDir);

		const logsDir = getLogsDir();
		await fs.mkdir(logsDir, { recursive: true });
		const today = new Date().toISOString().slice(0, 10);
		const crashedName = `chudcode.${today}.4242.log`;
		const rotatedName = `${crashedName}.1`;
		const currentName = `chudcode.${today}.${process.pid}.log`;
		await fsx.write(path.join(logsDir, crashedName), '{"pid":4242,"message":"fatal in crashed pid"}\n');
		await fs.utimes(path.join(logsDir, crashedName), 1, 1);
		await fsx.write(path.join(logsDir, rotatedName), '{"pid":4242,"message":"earlier rotated crash output"}\n');
		await fs.utimes(path.join(logsDir, rotatedName), 0, 0);
		await fsx.write(path.join(logsDir, currentName), '{"pid":0,"message":"later invocation"}\n');
		await fs.utimes(path.join(logsDir, currentName), 2, 2);

		const result = await createReportBundle({ sessionFile: undefined });

		expect(result.files).toContain("logs.txt");
		const archive = new Bun.Archive(await fsx.readBytes(result.path));
		const files = await archive.files();
		const logsText = (await files.get("logs.txt")?.text()) ?? "";
		expect(logsText).toContain(crashedName);
		expect(logsText).toContain("fatal in crashed pid");
		expect(logsText).toContain(rotatedName);
		expect(logsText).toContain("earlier rotated crash output");
		expect(logsText).toContain(currentName);
		expect(logsText).toContain("later invocation");
		expect(logsText.indexOf(crashedName)).toBeLessThan(logsText.indexOf(currentName));
	});
});
