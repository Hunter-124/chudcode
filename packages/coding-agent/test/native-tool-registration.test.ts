import { describe, expect, it } from "bun:test";
import { Settings } from "../src/config/settings";
import { resolveBuiltinToolPlan, type ToolSession } from "../src/tools";

const nativeNames = ["image_analyze", "cpp_static", "cpp_runtime", "binary_inspect", "firmware"];

function session(restrictToolNames: boolean): ToolSession {
	return {
		cwd: process.cwd(),
		settings: Settings.isolated(),
		skipPythonPreflight: true,
		restrictToolNames,
	} as ToolSession;
}

describe("optional native tools admission", () => {
	it("offers the suite in an unrestricted session but does not grant it to a restricted CAD session", async () => {
		const offered = await resolveBuiltinToolPlan(session(false));
		for (const name of nativeNames) expect(offered.names).toContain(name);

		const restricted = await resolveBuiltinToolPlan(session(true), ["read", "bash"]);
		expect(restricted.names).toEqual(["read", "bash"]);
		const optedIn = await resolveBuiltinToolPlan(session(true), ["read", "firmware"]);
		expect(optedIn.names).toEqual(["read", "firmware"]);
	});
});
