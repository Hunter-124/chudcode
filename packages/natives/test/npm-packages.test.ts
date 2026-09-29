import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as fsx from "@chudware/utils/fsx";
import { buildLeafManifest, generateNpmPackages } from "../scripts/gen-npm-packages";

describe("generated native npm leaf packages", () => {
	it("builds an x64 leaf manifest that exposes all addon files without package exports", () => {
		const addonFiles = ["chud_natives.linux-x64-baseline.node", "chud_natives.linux-x64-modern.node"];
		const manifest = buildLeafManifest({
			tag: "linux-x64",
			os: "linux",
			cpu: "x64",
			files: addonFiles,
			version: "15.5.15",
		});

		expect(manifest.name).toBe("@chudware/natives-linux-x64");
		expect(manifest.version).toBe("15.5.15");
		expect(manifest.os).toEqual(["linux"]);
		expect(manifest.cpu).toEqual(["x64"]);
		expect(addonFiles).toContain(manifest.main.slice("./".length));
		expect(manifest.files).toEqual(["*.node", "README.md", "LICENSE", "THIRD-PARTY-NOTICES.txt"]);
		expect(manifest.author).toBe("Chudware");
		expect(manifest.license).toBe("MIT");
		expect(manifest.repository).toEqual({
			type: "git",
			url: "git+https://github.com/Hunter-124/chudcode.git",
			directory: "packages/natives",
		});
		expect("exports" in manifest).toBe(false);
	});

	it("generates every leaf package by copying present addon files", async () => {
		const packageDir = await fs.mkdtemp(path.join(os.tmpdir(), "chud-natives-npm-"));
		try {
			await fs.mkdir(path.join(packageDir, "native"));
			await fsx.write(path.join(packageDir, "package.json"), JSON.stringify({ version: "15.5.15" }));
			await Promise.all([
				fsx.write(path.join(packageDir, "LICENSE"), "MIT payload\n"),
				fsx.write(path.join(packageDir, "THIRD-PARTY-NOTICES.txt"), "Notice payload\n"),
			]);
			const addonFiles = [
				"chud_natives.linux-x64-baseline.node",
				"chud_natives.linux-x64-modern.node",
				"chud_natives.darwin-x64-baseline.node",
				"chud_natives.win32-x64-baseline.node",
			];
			for (const file of addonFiles) {
				await fsx.write(path.join(packageDir, "native", file), file);
			}

			const leaves = await generateNpmPackages({ packageDir });
			expect(leaves.map(leaf => leaf.tag)).toEqual(["linux-x64", "darwin-x64", "win32-x64"]);
			const linuxX64 = leaves.find(leaf => leaf.tag === "linux-x64");
			expect(linuxX64?.files).toEqual([
				"chud_natives.linux-x64-baseline.node",
				"chud_natives.linux-x64-modern.node",
			]);
			expect(await fsx.readText(path.join(packageDir, "npm/linux-x64/chud_natives.linux-x64-modern.node"))).toBe(
				"chud_natives.linux-x64-modern.node",
			);
			const manifest = await fsx.readJson(path.join(packageDir, "npm/linux-x64/package.json"));
			expect(manifest.main).toBe("./chud_natives.linux-x64-baseline.node");
			expect(manifest.files).toEqual(["*.node", "README.md", "LICENSE", "THIRD-PARTY-NOTICES.txt"]);
			expect(await fsx.readText(path.join(packageDir, "npm/linux-x64/LICENSE"))).toBe("MIT payload\n");
			expect(await fsx.readText(path.join(packageDir, "npm/linux-x64/THIRD-PARTY-NOTICES.txt"))).toBe(
				"Notice payload\n",
			);
			expect("exports" in manifest).toBe(false);
		} finally {
			await fs.rm(packageDir, { recursive: true, force: true });
		}
	});

	it("uses the repository notice when direct generation has only package-local licenses", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "chud-natives-npm-notice-"));
		const packageDir = path.join(root, "packages/natives");
		try {
			await fs.mkdir(path.join(packageDir, "native"), { recursive: true });
			await Promise.all([
				fsx.write(path.join(packageDir, "package.json"), JSON.stringify({ version: "15.5.15" })),
				fsx.write(path.join(packageDir, "native/chud_natives.darwin-x64-baseline.node"), "darwin"),
				fsx.write(path.join(packageDir, "LICENSE"), "MIT payload\n"),
				fsx.write(path.join(root, "THIRD-PARTY-NOTICES.txt"), "Repository notice\n"),
			]);

			await generateNpmPackages({ packageDir, tags: ["darwin-x64"] });
			expect(await fsx.readText(path.join(packageDir, "npm/darwin-x64/THIRD-PARTY-NOTICES.txt"))).toBe(
				"Repository notice\n",
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("reports missing leaves during dry runs without writing generated packages", async () => {
		const packageDir = await fs.mkdtemp(path.join(os.tmpdir(), "chud-natives-npm-dry-"));
		const logSpy = spyOn(console, "log").mockImplementation(() => {});
		try {
			await fs.mkdir(path.join(packageDir, "native"));
			await fsx.write(path.join(packageDir, "package.json"), JSON.stringify({ version: "15.5.15" }));
			await fsx.write(path.join(packageDir, "native/chud_natives.darwin-x64-baseline.node"), "darwin");

			const leaves = await generateNpmPackages({ packageDir, dryRun: true });
			expect(leaves.filter(leaf => leaf.missing).map(leaf => leaf.tag)).toEqual(["linux-x64", "win32-x64"]);
			expect(await fsx.exists(path.join(packageDir, "npm/darwin-x64/package.json"))).toBe(false);
		} finally {
			logSpy.mockRestore();
			await fs.rm(packageDir, { recursive: true, force: true });
		}
	});
});
