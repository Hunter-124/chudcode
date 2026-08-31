import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { openDesktopGui, readDesktopVersion, resolveDesktopLayout } from "../src/launch";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

async function temporaryDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(tmpdir(), "desktop-launch-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function writeFile(filePath: string, content = "fixture", mode = 0o644): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content);
	await fs.chmod(filePath, mode);
}

async function createPackagedLayout(root: string): Promise<string> {
	for (const executable of ["chud", "chudcode-desktop", "chudcode-gui"]) {
		await writeFile(path.join(root, executable), executable, 0o755);
	}
	await writeFile(path.join(root, "web/index.html"), "<!doctype html>");
	await writeFile(path.join(root, "assets/fonts/ui.ttf"));
	await writeFile(path.join(root, "VERSION"), "0.2.0\n");
	await writeFile(path.join(root, "NOTICE"));
	await writeFile(path.join(root, "THIRD-PARTY-NOTICES.txt"));
	return path.join(root, "chudcode-desktop");
}

describe("desktop launcher layout", () => {
	it("resolves every packaged component strictly beside the executable", async () => {
		const root = await temporaryDirectory();
		const executablePath = await createPackagedLayout(root);
		const layout = await resolveDesktopLayout({ executablePath });
		expect(layout).toEqual({
			mode: "packaged",
			root,
			webDist: path.join(root, "web"),
			guiExecutable: path.join(root, "chudcode-gui"),
		});
		expect(await readDesktopVersion({ executablePath })).toBe("0.2.0");
	});
	it("fails closed instead of consulting PATH when an adjacent component is missing", async () => {
		const root = await temporaryDirectory();
		const executablePath = await createPackagedLayout(root);
		await fs.rm(path.join(root, "chudcode-gui"));
		await expect(resolveDesktopLayout({ executablePath })).rejects.toThrow(/missing adjacent GUI executable/);
	});

	it("allows source mode only for an explicit checkout with built assets", async () => {
		const root = await temporaryDirectory();
		const gui = path.join(root, "build/chudcode-gui");
		await writeFile(path.join(root, "package.json"), "{}\n");
		await writeFile(path.join(root, ".git/HEAD"), "ref: refs/heads/main\n");
		await writeFile(path.join(root, "packages/chudcode-desktop/src/launch.ts"));
		await writeFile(path.join(root, "packages/chudcode-desktop/dist/web/index.html"), "<!doctype html>");
		await writeFile(gui, "gui", 0o755);
		const layout = await resolveDesktopLayout({ sourceMode: true, sourceRoot: root, guiExecutable: gui });
		expect(layout.mode).toBe("source");
		expect(layout.webDist).toBe(path.join(root, "packages/chudcode-desktop/dist/web"));

		const notCheckout = await temporaryDirectory();
		await writeFile(path.join(notCheckout, "package.json"), "{}\n");
		await expect(
			resolveDesktopLayout({ sourceMode: true, sourceRoot: notCheckout, guiExecutable: gui }),
		).rejects.toThrow(/--source-mode requires a Chudcode checkout/);
	});

	it("passes the explicit adjacent GUI path directly to spawn", () => {
		const calls: string[][] = [];
		const process = { exited: Promise.resolve(0) };
		const result = openDesktopGui(
			"http://127.0.0.1:4321",
			"token",
			{
				which: () => {
					throw new Error("PATH must not be consulted");
				},
				spawn: argv => {
					calls.push(argv);
					return process;
				},
				print: () => {},
			},
			"/opt/chudcode/chudcode-gui",
		);
		expect(result.process).toBe(process);
		expect(calls).toEqual([["/opt/chudcode/chudcode-gui", "--url", "ws://127.0.0.1:4321/ws", "--token", "token"]]);
	});
});
