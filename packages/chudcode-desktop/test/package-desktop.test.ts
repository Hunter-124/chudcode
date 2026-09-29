import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import {
	canonicalArchiveName,
	createDeterministicArchive,
	packageDesktop,
	TARGETS,
	validatePayloadTree,
} from "../../../scripts/package-chudcode-desktop";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

async function temporaryDirectory(prefix: string): Promise<string> {
	const directory = await fs.mkdtemp(path.join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

async function writeFile(filePath: string, content: string | Uint8Array, mode = 0o644): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content);
	await fs.chmod(filePath, mode);
}

function linuxExecutable(): Buffer {
	const binary = Buffer.alloc(64);
	binary.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
	binary.writeUInt16LE(62, 18);
	return binary;
}
function windowsExecutable(): Buffer {
	const binary = Buffer.alloc(128);
	binary.write("MZ", 0, "ascii");
	binary.writeUInt32LE(64, 0x3c);
	binary.write("PE\0\0", 64, "binary");
	binary.writeUInt16LE(0x8664, 68);
	return binary;
}

async function createPayload(root: string): Promise<void> {
	for (const executable of ["chud", "chudcode-desktop", "chudcode-gui"]) {
		await writeFile(path.join(root, executable), linuxExecutable(), 0o755);
	}
	await writeFile(path.join(root, "assets/appicon/16.png"), "icon");
	await writeFile(path.join(root, "VERSION"), "0.2.0\n");
	await writeFile(path.join(root, "NOTICE"), "notice\n");
	await writeFile(path.join(root, "THIRD-PARTY-NOTICES.txt"), "third parties\n");
	await writeFile(path.join(root, "web/index.html"), '<!doctype html><script src="app.js"></script>');
	await writeFile(path.join(root, "web/app.js"), "console.log('compiled')");
	await writeFile(path.join(root, "assets/fonts/ui.ttf"), "font");
	await writeFile(path.join(root, "assets/icons/atlas.json"), "{}\n");
	await writeFile(path.join(root, "assets/icons/atlas.png"), "png");
	await writeFile(path.join(root, "packaging/linux/chudcode.desktop"), "[Desktop Entry]\n");
}

async function createFixtureRepository(root: string): Promise<{ chud: string; desktop: string; gui: string }> {
	await writeFile(path.join(root, "packages/coding-agent/package.json"), '{"version":"18.0.8"}\n');
	await writeFile(
		path.join(root, "packages/chudcode-desktop/dist/web/index.html"),
		'<!doctype html><link rel="stylesheet" href="./index-current.css"><script src="./index-current.js"></script>',
	);
	await writeFile(
		path.join(root, "packages/chudcode-desktop/dist/web/index-current.js"),
		'const worker = new URL("./ts.worker-current.js", import.meta.url);',
	);
	await writeFile(
		path.join(root, "packages/chudcode-desktop/dist/web/index-current.css"),
		'@font-face{font-family:Monaco;src:url("./monaco-current.woff2")}',
	);
	await writeFile(path.join(root, "packages/chudcode-desktop/dist/web/ts.worker-current.js"), "self.onmessage=()=>{}");
	await writeFile(path.join(root, "packages/chudcode-desktop/dist/web/monaco-current.woff2"), "font");
	await writeFile(path.join(root, "packages/chudcode-desktop/dist/web/index-stale.js"), "stale");
	await writeFile(path.join(root, "packages/chudcode-desktop/dist/web/index-stale.css"), "stale");
	await writeFile(path.join(root, "NOTICE"), "notice\n");
	await writeFile(path.join(root, "THIRD-PARTY-NOTICES.txt"), "third parties\n");
	await writeFile(path.join(root, "assets/appicon/16.png"), "icon");
	await writeFile(path.join(root, "packaging/linux/chudcode.desktop"), "[Desktop Entry]\nExec=chudcode-desktop\n");
	const binaryDirectory = path.join(root, "inputs");
	const chud = path.join(binaryDirectory, "chud");
	const desktop = path.join(binaryDirectory, "chudcode-desktop");
	const gui = path.join(binaryDirectory, "chudcode-gui");
	for (const executable of [chud, desktop, gui]) await writeFile(executable, linuxExecutable(), 0o755);
	await writeFile(path.join(binaryDirectory, "assets/fonts/ui.ttf"), "font");
	await writeFile(path.join(binaryDirectory, "assets/icons/atlas.json"), "{}\n");
	return { chud, desktop, gui };
}

describe("desktop release payload", () => {
	it("uses canonical release archive names for supported desktop platforms", () => {
		expect(TARGETS.map(canonicalArchiveName)).toEqual([
			"chudcode-desktop-linux-x64.tar.gz",
			"chudcode-desktop-macos-x64.tar.gz",
			"chudcode-desktop-windows-x64.zip",
		]);
	});

	it("walks and approves every path in a complete payload", async () => {
		const root = await temporaryDirectory("desktop-payload-");
		await createPayload(root);
		const entries = await validatePayloadTree(root, "linux-x64");
		expect(entries.map(entry => entry.relative)).toEqual([
			"NOTICE",
			"THIRD-PARTY-NOTICES.txt",
			"VERSION",
			"assets/",
			"assets/appicon/",
			"assets/appicon/16.png",
			"assets/fonts/",
			"assets/fonts/ui.ttf",
			"assets/icons/",
			"assets/icons/atlas.json",
			"assets/icons/atlas.png",
			"chud",
			"chudcode-desktop",
			"chudcode-gui",
			"packaging/",
			"packaging/linux/",
			"packaging/linux/chudcode.desktop",
			"web/",
			"web/app.js",
			"web/index.html",
		]);
	});

	it("rejects source files and node_modules beneath every payload tree", async () => {
		for (const relative of [
			"web/private.ts",
			"assets/private.cpp",
			"packaging/linux/private.py",
			"web/node_modules/dependency/index.js",
			"assets/node_modules/dependency/data.json",
			"packaging/node_modules/dependency/data.json",
		]) {
			const root = await temporaryDirectory("desktop-guard-");
			await createPayload(root);
			await writeFile(path.join(root, relative), "forbidden");
			await expect(validatePayloadTree(root, "linux-x64")).rejects.toThrow(/forbidden source|source\/build noise/);
		}
	});

	it("rejects wrong-machine executables and symlinks", async () => {
		const wrongMachine = await temporaryDirectory("desktop-machine-");
		await createPayload(wrongMachine);
		const arm = linuxExecutable();
		arm.writeUInt16LE(183, 18);
		await writeFile(path.join(wrongMachine, "chudcode-gui"), arm, 0o755);
		await expect(validatePayloadTree(wrongMachine, "linux-x64")).rejects.toThrow(/expected linux-x64/);

		const linked = await temporaryDirectory("desktop-link-");
		await createPayload(linked);
		await fs.rm(path.join(linked, "web/app.js"));
		await fs.symlink("index.html", path.join(linked, "web/app.js"));
		await expect(validatePayloadTree(linked, "linux-x64")).rejects.toThrow(/symlink/);
	});

	it("creates byte-identical archives for identical inputs and epoch", async () => {
		const root = await temporaryDirectory("desktop-repeat-");
		await createPayload(root);
		const output = await temporaryDirectory("desktop-repeat-output-");
		const first = path.join(output, "first.tar.gz");
		const second = path.join(output, "second.tar.gz");
		const firstHash = await createDeterministicArchive(root, "linux-x64", first, 1_700_000_000);
		await fs.utimes(path.join(root, "web/index.html"), new Date(), new Date());
		const secondHash = await createDeterministicArchive(root, "linux-x64", second, 1_700_000_000);
		expect(secondHash).toBe(firstHash);
		expect(await fs.readFile(second)).toEqual(await fs.readFile(first));
	});

	it("creates byte-identical sorted Windows zip archives", async () => {
		const root = await temporaryDirectory("desktop-windows-");
		await createPayload(root);
		for (const executable of ["chud", "chudcode-desktop", "chudcode-gui"]) {
			await fs.rm(path.join(root, executable));
			await writeFile(path.join(root, `${executable}.exe`), windowsExecutable(), 0o755);
		}
		await fs.rm(path.join(root, "packaging/linux"), { recursive: true });
		await writeFile(path.join(root, "packaging/windows/install-layout.json"), "{}\n");
		await writeFile(path.join(root, "packaging/windows/chudcode-desktop.exe.manifest"), "<assembly/>\n");
		const output = await temporaryDirectory("desktop-windows-output-");
		const first = path.join(output, "first.zip");
		const second = path.join(output, "second.zip");
		const firstHash = await createDeterministicArchive(root, "windows-x64", first, 1_700_000_000);
		const secondHash = await createDeterministicArchive(root, "windows-x64", second, 1_700_000_000);
		expect(secondHash).toBe(firstHash);
		expect(await fs.readFile(second)).toEqual(await fs.readFile(first));
	});

	it("stages a flat source-free artifact from prebuilt inputs deterministically", async () => {
		const repoRoot = await temporaryDirectory("desktop-repo-");
		const inputs = await createFixtureRepository(repoRoot);
		const firstDirectory = await temporaryDirectory("desktop-out-one-");
		const secondDirectory = await temporaryDirectory("desktop-out-two-");
		const firstOutput = path.join(firstDirectory, canonicalArchiveName("linux-x64"));
		const secondOutput = path.join(secondDirectory, canonicalArchiveName("linux-x64"));
		const common = {
			target: "linux-x64" as const,
			gui: inputs.gui,
			chud: inputs.chud,
			desktop: inputs.desktop,
			repoRoot,
			epoch: 1_700_000_000,
		};
		const first = await packageDesktop({ ...common, output: firstOutput });
		const second = await packageDesktop({ ...common, output: secondOutput });
		expect(second.sha256).toBe(first.sha256);
		expect(await fs.readFile(secondOutput)).toEqual(await fs.readFile(firstOutput));
		const unpackedTar = gunzipSync(await fs.readFile(firstOutput));
		for (const required of [
			"web/index-current.js",
			"web/index-current.css",
			"web/ts.worker-current.js",
			"web/monaco-current.woff2",
		]) {
			expect(unpackedTar.includes(Buffer.from(required))).toBeTrue();
		}
		expect(unpackedTar.includes(Buffer.from("web/index-stale.js"))).toBeFalse();
		expect(unpackedTar.includes(Buffer.from("web/index-stale.css"))).toBeFalse();
	});
});
