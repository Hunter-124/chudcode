import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BinaryInspectTool } from "@oh-my-pi/pi-coding-agent/tools/binary-inspect";
import { CppRuntimeTool } from "@oh-my-pi/pi-coding-agent/tools/cpp-runtime";

const temporaryDirectories: string[] = [];
const hasSanitizerToolchain = Boolean(Bun.which("clang") && Bun.which("cmake") && Bun.which("addr2line"));
const hasReadelf = Boolean(Bun.which("readelf"));

function session(cwd: string): ToolSession {
	return { cwd, settings: Settings.isolated() } as ToolSession;
}

function jsonResult(result: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
	const text = result.content.find(block => block.type === "text")?.text;
	if (!text) throw new Error("tool returned no JSON text content");
	return JSON.parse(text) as Record<string, unknown>;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("native analyzer tools", () => {
	it.skipIf(!hasSanitizerToolchain)("builds, executes, parses, and symbolizes a heap-use-after-free", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "chudcode-analyzer-uaf-"));
		temporaryDirectories.push(root);
		await fs.writeFile(
			path.join(root, "CMakeLists.txt"),
			"cmake_minimum_required(VERSION 3.20)\nproject(uaf C)\nadd_executable(uaf uaf.c)\n",
		);
		await fs.writeFile(
			path.join(root, "uaf.c"),
			'#include <stdlib.h>\n#include <stdio.h>\nint main(void){int *p=malloc(sizeof *p);*p=7;free(p);printf("%d\\n",*p);}\n',
		);

		const tool = new CppRuntimeTool(session(root));
		const response = jsonResult(
			await tool.execute("sanitize-smoke", {
				action: "sanitize",
				build: { system: "cmake", dir: "." },
				run: { cmd: "./uaf", timeout_s: 30 },
				sanitizers: ["address"],
			}),
		);
		expect(response.ok).toBe(true);
		const reports = response.reports as Array<{
			kind: string;
			summary: string;
			frames: Array<{ file?: string; line?: number }>;
		}>;
		expect(reports[0]?.kind).toBe("AddressSanitizer");
		expect(reports[0]?.summary).toContain("heap-use-after-free");
		expect(reports[0]?.frames.some(frame => frame.file?.endsWith("uaf.c") && (frame.line ?? 0) > 0)).toBe(true);
	});

	it.skipIf(!hasReadelf)("returns structured ELF sections", async () => {
		const tool = new BinaryInspectTool(session(process.cwd()));
		const response = jsonResult(
			await tool.execute("sections-smoke", { action: "sections", path: process.execPath, top: 10 }),
		);
		expect(response.ok).toBe(true);
		expect(Array.isArray(response.sections)).toBe(true);
		expect((response.sections as unknown[]).length).toBeGreaterThan(0);
	});
});
