import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadExtensions } from "@chudware/coding-agent/extensibility/extensions/loader";
import { loadLegacyPiModule } from "@chudware/coding-agent/extensibility/plugins/legacy-pi-compat";
import { TempDir } from "@chudware/utils";
import * as fsx from "@chudware/utils/fsx";

describe("Extension Loader Graph Read Dedup", () => {
	let tempDir: TempDir;
	let reads: Map<string, number>;
	let readSpy: Mock<typeof fsx.readText>;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-ext-dedup-");
		reads = new Map<string, number>();

		const realReadText = fsx.readText;
		readSpy = spyOn(fsx, "readText").mockImplementation((file: fsx.PathLike) => {
			if (typeof file === "string") {
				const key = fs.existsSync(file) ? fs.realpathSync(file) : file;
				reads.set(key, (reads.get(key) ?? 0) + 1);
			}
			return realReadText(file);
		});
	});

	afterEach(() => {
		readSpy?.mockRestore();
		tempDir?.removeSync();
	});

	it("should read each extension module from disk exactly once", async () => {
		const cwd = tempDir.absolute();
		const extDir = path.join(cwd, "ext");
		fs.mkdirSync(extDir, { recursive: true });

		// Deduplication is depth-independent; a moderate chain catches repeated traversal without making fixture I/O the test.
		const numModules = 16;
		for (let i = 0; i < numModules; i++) {
			const modPath = path.join(extDir, `mod-${i}.ts`);
			let content = `export const v${i} = ${i};\n`;
			if (i < numModules - 1) {
				content += `import "./mod-${i + 1}.ts";\n`;
			}
			fs.writeFileSync(modPath, content, "utf-8");
		}

		const entryPath = path.join(extDir, "index.ts");
		const entryContent = `import "./mod-0.ts";
export default function(chud) {
    const { Type } = chud.typebox;
    chud.registerTool({
        name: "dedup-tool",
        label: "dedup-tool",
        description: "Test tool",
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });
}
`;
		fs.writeFileSync(entryPath, entryContent, "utf-8");

		const result = await loadExtensions([entryPath], cwd);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions[0].tools.has("dedup-tool")).toBe(true);

		const checkReadCount = (filePath: string) => {
			const real = fs.existsSync(filePath) ? fs.realpathSync(filePath) : filePath;
			expect(reads.get(real) ?? 0).toBe(1);
		};

		checkReadCount(entryPath);
		for (let i = 0; i < numModules; i++) {
			checkReadCount(path.join(extDir, `mod-${i}.ts`));
		}
	});

	it("should read graph modules skipped by the initial import from disk at import time", async () => {
		const cwd = tempDir.absolute();
		const extDir = path.join(cwd, "ext");
		fs.mkdirSync(extDir, { recursive: true });

		const lazyPath = path.join(extDir, "lazy.ts");
		fs.writeFileSync(lazyPath, `export const value = "before";\n`, "utf-8");

		// The fixture's dynamic import is the loading boundary under test: the
		// graph scan collects `./lazy.ts` at load time, but nothing imports it
		// until `readLazy()` runs.
		const entryPath = path.join(extDir, "index.ts");
		const entryContent = `export async function readLazy(): Promise<string> {
	const mod = await import("./lazy.ts");
	return mod.value;
}
`;
		fs.writeFileSync(entryPath, entryContent, "utf-8");

		const ns = (await loadLegacyPiModule(entryPath)) as { readLazy(): Promise<string> };

		// Edit the module after load but before its first import: the loader
		// must serve the on-disk content, not a stale load-time snapshot.
		fs.writeFileSync(lazyPath, `export const value = "after";\n`, "utf-8");

		expect(await ns.readLazy()).toBe("after");
	});
});
