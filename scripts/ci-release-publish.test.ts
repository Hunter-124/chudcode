import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as fsx from "@chudware/utils/fsx";
import {
	legalPayloadFiles,
	npmDistTag,
	packages,
	prepareNativeCorePackage,
	rewriteManifest,
	stageLegalPayloads,
} from "./ci-release-publish";

describe("npm dist-tags", () => {
	it("routes canaries while rejecting other prereleases", () => {
		expect(npmDistTag("0.13.0-canary.2")).toBe("canary");
		expect(npmDistTag("0.13.0")).toBe("latest");
		expect(() => npmDistTag("0.13.0-rc.1")).toThrow("Unsupported prerelease version");
	});
});

describe("published legal payloads", () => {
	it("selects the exact payload for MIT packages", () => {
		expect(legalPayloadFiles("MIT")).toEqual(["LICENSE", "THIRD-PARTY-NOTICES.txt"]);
		expect(() => legalPayloadFiles("MIT OR Apache-2.0")).toThrow("Unsupported package license: MIT OR Apache-2.0");
		expect(() => legalPayloadFiles(undefined)).toThrow("Unsupported package license: <missing>");
	});

	it("stages missing legal files without replacing package-local text", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "chudcode-publish-legal-"));
		const pkgDir = path.join(root, "package");
		await fs.mkdir(pkgDir);
		try {
			await Promise.all([
				fsx.write(path.join(root, "LICENSE"), "root MIT\n"),
				fsx.write(path.join(root, "THIRD-PARTY-NOTICES.txt"), "notices\n"),
				fsx.write(path.join(pkgDir, "LICENSE"), "package MIT\n"),
			]);

			const files = await stageLegalPayloads(pkgDir, "MIT", true, root);
			expect(files).toEqual(["LICENSE", "THIRD-PARTY-NOTICES.txt"]);
			expect(await fsx.readText(path.join(pkgDir, "LICENSE"))).toBe("package MIT\n");
			expect(await fsx.readText(path.join(pkgDir, "THIRD-PARTY-NOTICES.txt"))).toBe("notices\n");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("lists every legal file explicitly in the native core package", async () => {
		const pkgDir = await fs.mkdtemp(path.join(os.tmpdir(), "chudcode-native-core-"));
		try {
			await fsx.write(
				path.join(pkgDir, "package.json"),
				JSON.stringify({
					name: "@chudware/natives",
					version: "15.5.15",
					license: "MIT",
				}),
			);
			const manifest = await prepareNativeCorePackage(pkgDir, false);
			expect(manifest.files).toEqual([
				"native/index.js",
				"native/index.d.ts",
				"native/clipboard.js",
				"native/clipboard.d.ts",
				"native/desktop.js",
				"native/desktop.d.ts",
				"native/desktop-adapter.js",
				"native/desktop-adapter.d.ts",
				"native/loader-state.js",
				"native/loader-state.d.ts",
				"native/embedded-addon.js",
				"README.md",
				"LICENSE",
				"THIRD-PARTY-NOTICES.txt",
			]);
		} finally {
			await fs.rm(pkgDir, { recursive: true, force: true });
		}
	});
});

describe("published manifest topology", () => {
	it("repoints chudtype runtime entries to dist/js with a bun source condition", async () => {
		const pkg = packages.find(entry => entry.dir === "packages/chudtype");
		if (!pkg) throw new Error("chudtype missing from publish set");
		expect(pkg.publishJs).toBe(true);

		const manifest = await rewriteManifest(pkg, false);
		expect(manifest.main).toBe("./dist/js/index.js");
		expect(manifest.types).toBe("./dist/types/index.d.ts");
		expect(manifest.files).toContain("dist/js");
		expect(manifest.files).toContain("dist/types");
		// `src` must stay packed — the `bun` condition resolves into it.
		expect(manifest.files).toContain("src");
		expect(manifest.exports).toEqual({
			".": {
				types: "./dist/types/index.d.ts",
				bun: "./src/index.ts",
				default: "./dist/js/index.js",
			},
			"./*": {
				types: "./dist/types/*.d.ts",
				bun: "./src/*.ts",
				default: "./dist/js/*.js",
			},
			"./*.js": {
				types: "./dist/types/*.d.ts",
				bun: "./src/*.ts",
				default: "./dist/js/*.js",
			},
		});
	});

	it("keeps source-runtime packages on src with only types repointed", async () => {
		const pkg = packages.find(entry => entry.dir === "packages/utils");
		if (!pkg) throw new Error("utils missing from publish set");

		const manifest = await rewriteManifest(pkg, false);
		expect(manifest.files).toEqual(expect.arrayContaining(["LICENSE", "THIRD-PARTY-NOTICES.txt"]));
		expect(manifest.main).toBe("./src/index.ts");
		expect(manifest.exports).toEqual({
			".": {
				types: "./dist/types/index.d.ts",
				import: "./src/index.ts",
			},
			"./*": {
				types: "./dist/types/*.d.ts",
				import: "./src/*.ts",
			},
			"./*.js": "./src/*.ts",
			"./ar": {
				types: "./dist/types/ar/index.d.ts",
				import: "./src/ar/index.ts",
			},
		});
	});
});
