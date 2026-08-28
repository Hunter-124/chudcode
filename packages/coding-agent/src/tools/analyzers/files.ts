import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export async function exists(file: string): Promise<boolean> {
	try {
		await fs.access(file);
		return true;
	} catch {
		return false;
	}
}

export async function readTextBounded(file: string, maxBytes = 32 * 1024 * 1024): Promise<string> {
	const stat = await fs.stat(file);
	if (stat.size > maxBytes) throw new Error(`Analyzer output is ${stat.size} bytes; limit is ${maxBytes}`);
	return fs.readFile(file, "utf8");
}

export async function makeTempDir(prefix = "chud-analyzer-"): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function removeTempDir(directory: string): Promise<void> {
	await fs.rm(directory, { recursive: true, force: true });
}

export async function globFiles(cwd: string, pattern: string, limit = 10_000): Promise<string[]> {
	const output: string[] = [];
	const glob = new Bun.Glob(pattern);
	for await (const entry of glob.scan({ cwd, onlyFiles: true, dot: true })) {
		output.push(path.resolve(cwd, entry));
		if (output.length >= limit) break;
	}
	return output.sort();
}

export async function discoverCompileCommands(cwd: string, explicit?: string): Promise<string | undefined> {
	if (explicit) {
		const resolved = path.resolve(cwd, explicit);
		return (await exists(resolved)) ? resolved : undefined;
	}
	const direct = path.join(cwd, "compile_commands.json");
	if (await exists(direct)) return direct;
	const matches = await globFiles(cwd, "build*/compile_commands.json", 100);
	return matches[0];
}

function field(value: unknown, key: string): unknown {
	return value !== null && typeof value === "object" && key in value ? Reflect.get(value, key) : undefined;
}

export async function compileCommandFiles(file: string): Promise<string[]> {
	let document: unknown;
	try {
		document = JSON.parse(await readTextBounded(file));
	} catch {
		return [];
	}
	if (!Array.isArray(document)) return [];
	const files = new Set<string>();
	for (const entry of document) {
		const name = field(entry, "file");
		const directory = field(entry, "directory");
		if (typeof name !== "string") continue;
		files.add(path.resolve(typeof directory === "string" ? directory : path.dirname(file), name));
		if (files.size >= 100_000) break;
	}
	return [...files].sort();
}
