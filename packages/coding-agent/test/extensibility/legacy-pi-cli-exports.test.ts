import { describe, expect, it } from "bun:test";
import { CONFIG_DIR_NAME, parseArgs } from "@chudware/coding-agent/extensibility/legacy-chudcode-agent-shim";

describe("legacy shim CLI exports", () => {
	it("re-exports parseArgs and CONFIG_DIR_NAME from the legacy package root", () => {
		expect(CONFIG_DIR_NAME).toBe(".chudcode");
		expect(parseArgs(["hello"]).messages).toEqual(["hello"]);
	});
});
