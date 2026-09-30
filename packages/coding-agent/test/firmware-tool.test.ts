import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { FirmwareTool } from "@oh-my-pi/pi-coding-agent/tools/firmware";

const temporaryDirectories: string[] = [];

function tool(cwd: string): FirmwareTool {
	return new FirmwareTool({ cwd, settings: Settings.isolated() } as ToolSession);
}

function jsonResult(result: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
	const text = result.content.find(block => block.type === "text")?.text;
	if (!text) throw new Error("firmware tool returned no JSON text content");
	return JSON.parse(text) as Record<string, unknown>;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("firmware tool", () => {
	it("reports a healthy capability matrix even when optional toolchains are absent", async () => {
		const response = jsonResult(await tool(process.cwd()).execute("status", { action: "status" }));
		expect(response.ok).toBe(true);
		expect(response.families).toMatchObject({
			"cortex-m": {
				can_build: expect.any(Boolean),
				can_emulate: expect.any(Boolean),
				can_flash: expect.any(Boolean),
			},
			esp32: { can_build: expect.any(Boolean), can_emulate: false },
			arduino: { can_build: expect.any(Boolean), can_emulate: false },
		});
	});

	it("creates an atomic Cortex-M project with compile commands enabled", async () => {
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "chudcode-firmware-"));
		temporaryDirectories.push(parent);
		const response = jsonResult(
			await tool(parent).execute("new-project", {
				action: "new_project",
				family: "cortex-m",
				name: "hello",
				dir: ".",
			}),
		);
		expect(response).toMatchObject({ ok: true, family: "cortex-m", dir: path.join(parent, "hello") });
		const cmake = await fs.readFile(path.join(parent, "hello", "CMakeLists.txt"), "utf8");
		expect(cmake).toContain("CMAKE_EXPORT_COMPILE_COMMANDS ON");
		expect(JSON.parse(await fs.readFile(path.join(parent, "hello", "compile_commands.json"), "utf8"))).toHaveLength(
			2,
		);
	});

	it("always prompts before flashing physical hardware", () => {
		expect(tool(process.cwd()).approval({ action: "flash" })).toMatchObject({
			tier: "exec",
			policy: "prompt",
			override: true,
		});
	});
});
