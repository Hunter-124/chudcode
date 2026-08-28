import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@chudware/chudtype";
import type * as TypeBox from "@chudware/chudtype/typebox";
import * as zod from "@chudware/chudtype/zod";
import * as piCodingAgent from "@chudware/coding-agent";
import { GreenCommand } from "@chudware/coding-agent/extensibility/custom-commands/bundled/ci-green";
import type { CustomCommandAPI } from "@chudware/coding-agent/extensibility/custom-commands/types";
import type { HookCommandContext } from "@chudware/coding-agent/extensibility/hooks/types";
import * as git from "@chudware/coding-agent/utils/git";

afterEach(() => {
	vi.restoreAllMocks();
});

function createApi(): CustomCommandAPI {
	return {
		cwd: "/tmp/test",
		exec: async () => ({
			stdout: "",
			stderr: "",
			code: 0,
			killed: false,
		}),
		typebox: {} as unknown as typeof TypeBox,
		arktype: Object.assign(Function.prototype.bind.call(type, undefined) as typeof type, type, { type }),
		zod,
		chud: piCodingAgent,
	};
}

describe("GreenCommand", () => {
	it("includes tag instructions when HEAD has a tag", async () => {
		vi.spyOn(git.ref, "tags").mockResolvedValue(["v0.1.0-alpha2"]);
		const command = new GreenCommand(createApi());

		const result = await command.execute([], {} as HookCommandContext);

		expect(result).toContain("v0.1.0-alpha2");
		expect(result).not.toContain("timeouts due to the harnesses");
	});

	it("omits tag instructions when HEAD is not tagged", async () => {
		vi.spyOn(git.ref, "tags").mockResolvedValue([]);
		const command = new GreenCommand(createApi());

		const result = await command.execute([], {} as HookCommandContext);

		expect(result).not.toContain("v0.1.0-alpha2");
	});
});
