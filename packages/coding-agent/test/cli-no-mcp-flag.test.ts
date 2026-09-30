import { describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { applyToolAllowlist } from "@oh-my-pi/pi-coding-agent/tools/builtin-names";

describe("RPC launch capability controls", () => {
	it("parses --no-mcp without consuming the next argument", () => {
		const parsed = parseArgs(["--mode", "rpc", "--no-mcp", "--no-lsp", "--tools", "read,bash,task"]);
		expect(parsed.mode).toBe("rpc");
		expect(parsed.noMcp).toBe(true);
		expect(parsed.noLsp).toBe(true);
		expect(parsed.tools).toEqual(["read", "bash", "task"]);
	});

	it("clamps built-ins without stripping host, custom and MCP tools requested by a child", () => {
		expect(
			applyToolAllowlist(["read", "edit", "make_box", "mcp__cad_measure", "custom_tool"], ["read", "bash"]),
		).toEqual(["read", "make_box", "mcp__cad_measure", "custom_tool"]);
		expect(applyToolAllowlist(undefined, ["bash", "read", "bash"])).toEqual(["bash", "read"]);
		expect(applyToolAllowlist(["edit", "make_box"], [])).toEqual(["make_box"]);
	});
});
