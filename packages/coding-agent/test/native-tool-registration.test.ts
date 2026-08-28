import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SETTINGS_SCHEMA } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { BUILTIN_TOOLS, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BUILTIN_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/builtin-names";

const NATIVE_TOOL_NAMES = ["image_analyze", "cpp_static", "cpp_runtime", "binary_inspect", "firmware"] as const;

function session(): ToolSession {
	return { cwd: process.cwd(), settings: Settings.isolated() } as ToolSession;
}

describe("native tool suite registration", () => {
	it("registers every family as a discoverable builtin rather than an essential top-level tool", async () => {
		for (const name of NATIVE_TOOL_NAMES) {
			expect(BUILTIN_TOOL_NAMES).toContain(name);
			const tool = await BUILTIN_TOOLS[name](session());
			expect(tool?.name).toBe(name);
			expect(tool?.loadMode).toBe("discoverable");
		}
	});

	it("ships memory-safe defaults for vision and subagent admission", () => {
		expect(SETTINGS_SCHEMA["vision.modelDir"].default).toBe("~/.omp/models/vision");
		expect(SETTINGS_SCHEMA["vision.autoDownload"].default).toBe(true);
		expect(SETTINGS_SCHEMA["memory.embedWorkerIdleMinutes"].default).toBe(10);
		expect(SETTINGS_SCHEMA["task.minFreeMemMB"].default).toBe(1024);
	});
});
