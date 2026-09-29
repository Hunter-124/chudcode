import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { $ } from "bun";
import { releaseBinaryName } from "../packages/coding-agent/src/brand";

const repoRoot = path.join(import.meta.dir, "..");

describe("release binary asset names", () => {
	it("builds supported release asset names recognized by the updater", async () => {
		const result = await $`bun scripts/ci-release-build-binaries.ts --dry-run`.cwd(repoRoot).quiet().nothrow();
		expect(result.exitCode).toBe(0);
		const built = [...result.text().matchAll(/outfile=(\S+)/g)].map(match => path.basename(match[1] ?? ""));

		// A rename on either side (asset prefix, os/arch spelling, .exe suffix)
		// strands every installed binary: it asks GitHub for a name no release
		// publishes and self-update fails with "has 0 assets named <name>".
		expect(built.toSorted()).toEqual(
			[
				{ platform: "darwin", arch: "x64" },
				{ platform: "linux", arch: "x64" },
				{ platform: "linux", arch: "x64", musl: true },
				{ platform: "win32", arch: "x64" },
			]
				.map(releaseBinaryName)
				.toSorted(),
		);
	});
});
