import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { $ } from "bun";
import { resolveCrossBuild } from "../packages/coding-agent/scripts/build-binary";
import { releaseBinaryName } from "../packages/coding-agent/src/brand";

const repoRoot = path.join(import.meta.dir, "..");

describe("release binary asset names", () => {
	it("builds exactly the asset names the updater downloads", async () => {
		const result = await $`bun scripts/ci-release-build-binaries.ts --dry-run`.cwd(repoRoot).quiet().nothrow();
		expect(result.exitCode).toBe(0);
		const built = [...result.text().matchAll(/outfile=(\S+)/g)].map(match => path.basename(match[1] ?? ""));

		// A rename on either side (asset prefix, os/arch spelling, .exe suffix)
		// strands every installed binary: it asks GitHub for a name no release
		// publishes and self-update fails with "has 0 assets named <name>".
		expect(built.toSorted()).toEqual(
			[
				{ platform: "darwin", arch: "arm64" },
				{ platform: "darwin", arch: "x64" },
				{ platform: "linux", arch: "arm64" },
				{ platform: "linux", arch: "x64" },
				{ platform: "linux", arch: "arm64", musl: true },
				{ platform: "linux", arch: "x64", musl: true },
				{ platform: "win32", arch: "arm64" },
				{ platform: "win32", arch: "x64" },
			]
				.map(releaseBinaryName)
				.toSorted(),
		);
	});
});

describe("Windows release binary target", () => {
	it("builds the generic Windows release asset with the baseline runtime", async () => {
		const result = await $`bun scripts/ci-release-build-binaries.ts --dry-run --targets win32-x64`
			.cwd(repoRoot)
			.quiet()
			.nothrow();
		expect(result.exitCode).toBe(0);
		const output = result.text();

		expect(output).toContain("Building packages/coding-agent/binaries/chudcode-windows-x64.exe...");
		expect(output).toContain(
			"DRY RUN Bun.build target=bun-windows-x64-baseline outfile=packages/coding-agent/binaries/chudcode-windows-x64.exe",
		);
		expect(output).toContain("external=fastembed,onnxruntime-node");
		expect(output).not.toContain("bun-windows-x64-modern");
	});

	it("builds the Windows ARM64 CLI used by the canonical desktop archive", async () => {
		const result = await $`bun scripts/ci-release-build-binaries.ts --dry-run --targets win32-arm64`
			.cwd(repoRoot)
			.quiet()
			.nothrow();
		expect(result.exitCode).toBe(0);
		expect(result.text()).toContain(
			"DRY RUN Bun.build target=bun-windows-arm64 outfile=packages/coding-agent/binaries/chudcode-windows-arm64.exe",
		);
	});

	it("uses the baseline runtime for local Windows cross-build aliases", () => {
		expect(resolveCrossBuild("win32-x64")).toEqual({
			id: "win32-x64",
			platform: "win32",
			arch: "x64",
			target: "bun-windows-x64-baseline",
		});
		expect(resolveCrossBuild("windows-x64")).toEqual({
			id: "windows-x64",
			platform: "win32",
			arch: "x64",
			target: "bun-windows-x64-baseline",
		});
	});
});
