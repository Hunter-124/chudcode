import { describe, expect, it } from "bun:test";
import { InternalUrlRouter } from "@chudware/coding-agent/internal-urls";

describe("ChudProtocolHandler", () => {
	it("treats chudcode://docs as the documentation root", async () => {
		const resource = await InternalUrlRouter.instance().resolve("chudcode://docs");

		expect(resource.content).toContain("# Documentation");
		expect(resource.content).toContain("tools/read.md");
	});

	it("resolves docs-prefixed documentation paths", async () => {
		const router = InternalUrlRouter.instance();
		const direct = await router.resolve("chudcode://tools/read.md");
		const prefixed = await router.resolve("chudcode://docs/tools/read.md");

		expect(prefixed.content).toBe(direct.content);
		expect(prefixed.content).toContain("# read");
	});
});
