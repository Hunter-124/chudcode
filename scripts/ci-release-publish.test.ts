import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as fsx from "@chudware/utils/fsx";
import {
	isCanonicalCliVersionOutput,
	legalPayloadFiles,
	npmDistTag,
	packages,
	prepareNativeCorePackage,
	rewriteManifest,
	stageLegalPayloads,
	verifyDesktopPayload,
} from "./ci-release-publish";

describe("npm dist-tags", () => {
	it("routes canaries while rejecting other prereleases", () => {
		expect(npmDistTag("0.13.0-canary.2")).toBe("canary");
		expect(npmDistTag("0.13.0")).toBe("latest");
		expect(() => npmDistTag("0.13.0-rc.1")).toThrow("Unsupported prerelease version");
	});
});

describe("desktop executable versions", () => {
	it("accepts only the canonical CLI product version and documented OMP provenance", () => {
		expect(isCanonicalCliVersionOutput("Chudcode v0.2.0", "0.2.0")).toBe(true);
		expect(isCanonicalCliVersionOutput("Chudcode v0.2.0 (based on omp 18.0.8)", "chudcode-v0.2.0")).toBe(true);
		expect(isCanonicalCliVersionOutput("Chudcode v0.2.1 (based on omp 18.0.8)", "0.2.0")).toBe(false);
		expect(isCanonicalCliVersionOutput("Chudcode v0.2.0 (based on omp 18.0.8) modified", "0.2.0")).toBe(false);
		expect(isCanonicalCliVersionOutput("Other v0.2.0 (based on omp 18.0.8)", "0.2.0")).toBe(false);
		expect(isCanonicalCliVersionOutput("Chudcode v0.2.0 (based on omp nope)", "0.2.0")).toBe(false);
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

const desktopNoticeTokens = [
	"GLFW",
	"ImGui",
	"IXWebSocket",
	"libvterm",
	"stb_image",
	"Rubik",
	"JetBrains Mono",
	"Monaco",
	"xterm.js",
	"Bun",
];

async function createLinuxDesktopPayload(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "chudcode-desktop-payload-"));
	await Promise.all([
		fs.mkdir(path.join(root, "web"), { recursive: true }),
		fs.mkdir(path.join(root, "assets", "fonts"), { recursive: true }),
		fs.mkdir(path.join(root, "assets", "icons"), { recursive: true }),
		fs.mkdir(path.join(root, "assets", "appicon"), { recursive: true }),
		fs.mkdir(path.join(root, "packaging", "linux"), { recursive: true }),
	]);
	await Promise.all([
		fs.copyFile("/bin/true", path.join(root, "chud")),
		fs.copyFile("/bin/true", path.join(root, "chudcode-desktop")),
		fs.copyFile("/bin/true", path.join(root, "chudcode-gui")),
		fs.writeFile(path.join(root, "VERSION"), "0.2.0\n"),
		fs.writeFile(path.join(root, "NOTICE"), "Chudcode notice\n"),
		fs.writeFile(path.join(root, "THIRD-PARTY-NOTICES.txt"), desktopNoticeTokens.join("\n")),
		fs.writeFile(path.join(root, "web", "index.html"), "<!doctype html>"),
		fs.writeFile(path.join(root, "assets", "fonts", "font.ttf"), "font"),
		fs.writeFile(path.join(root, "assets", "icons", "icon.png"), "icon"),
		fs.writeFile(path.join(root, "assets", "appicon", "icon.png"), "appicon"),
		fs.writeFile(path.join(root, "packaging", "linux", "chudcode.desktop"), "[Desktop Entry]\n"),
	]);
	await Promise.all(["chud", "chudcode-desktop", "chudcode-gui"].map(name => fs.chmod(path.join(root, name), 0o755)));
	return root;
}

describe("desktop release publication gate", () => {
	it("accepts a complete source-free payload and rejects version, notice, source, and architecture tampering", async () => {
		const root = await createLinuxDesktopPayload();
		try {
			await verifyDesktopPayload(root, "linux-x64", "chudcode-v0.2.0");

			await fs.writeFile(path.join(root, "VERSION"), "0.2.1\n");
			await expect(verifyDesktopPayload(root, "linux-x64", "0.2.0")).rejects.toThrow("VERSION mismatch");
			await fs.writeFile(path.join(root, "VERSION"), "0.2.0\n");

			await fs.writeFile(path.join(root, "THIRD-PARTY-NOTICES.txt"), "GLFW\n");
			await expect(verifyDesktopPayload(root, "linux-x64", "0.2.0")).rejects.toThrow("notices omit");
			await fs.writeFile(path.join(root, "THIRD-PARTY-NOTICES.txt"), desktopNoticeTokens.join("\n"));

			await fs.writeFile(path.join(root, "web", "leaked-source.ts"), "export {};\n");
			await expect(verifyDesktopPayload(root, "linux-x64", "0.2.0")).rejects.toThrow("forbidden source file");
			await fs.rm(path.join(root, "web", "leaked-source.ts"));

			await expect(verifyDesktopPayload(root, "macos-x64", "0.2.0")).rejects.toThrow(
				/architecture|machine|target|expected/i,
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
