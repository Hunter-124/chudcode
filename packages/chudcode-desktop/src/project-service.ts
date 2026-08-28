import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import type { RecentProject } from "./protocol";

const RECENT_SCHEMA_VERSION = 1;
const MAX_RECENT_PROJECTS = 20;
const CANCELLED_OUTPUT = "__CHUDCODE_CANCELLED__";
const WINDOWS_PICKER_SCRIPT = `param([string]$InitialPath = "")
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "Open a Chudcode project"
$dialog.ShowNewFolderButton = $true
if ($InitialPath -and [System.IO.Directory]::Exists($InitialPath)) {
    $dialog.SelectedPath = $InitialPath
}
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Out.WriteLine($dialog.SelectedPath)
} else {
    [Console]::Out.WriteLine("${CANCELLED_OUTPUT}")
}
`;
const MACOS_PICKER_SCRIPT = `on run argv
try
    if (count of argv) > 0 then
        set selectedFolder to choose folder with prompt "Open a Chudcode project" default location (POSIX file (item 1 of argv))
    else
        set selectedFolder to choose folder with prompt "Open a Chudcode project"
    end if
    return POSIX path of selectedFolder
on error number errorNumber
    if errorNumber is -128 then return "${CANCELLED_OUTPUT}"
    error number errorNumber
end try
end run`;

interface RecentStore {
	version: typeof RECENT_SCHEMA_VERSION;
	projects: RecentProject[];
}

export interface ProjectProcessResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface ProjectServiceOptions {
	dataDir?: string;
	platform?: NodeJS.Platform;
	now?: () => number;
	which?: (executable: string) => string | null;
	run?: (argv: readonly string[]) => Promise<ProjectProcessResult>;
}

export interface ProjectPickerResult {
	rootPath?: string;
	cancelled: boolean;
}

export interface ProjectController {
	recent(): Promise<RecentProject[]>;
	pick(initialPath?: string): Promise<ProjectPickerResult>;
	recordOpened(rootPath: string): Promise<void>;
}

export class ProjectServiceError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "ProjectServiceError";
	}
}

function isRecentProject(value: unknown): value is RecentProject {
	return (
		typeof value === "object" &&
		value !== null &&
		"rootPath" in value &&
		typeof value.rootPath === "string" &&
		"displayName" in value &&
		typeof value.displayName === "string" &&
		"lastOpenedMs" in value &&
		typeof value.lastOpenedMs === "number" &&
		Number.isFinite(value.lastOpenedMs)
	);
}

function parseStore(text: string): RecentStore | undefined {
	try {
		const value: unknown = JSON.parse(text);
		if (
			typeof value !== "object" ||
			value === null ||
			!("version" in value) ||
			value.version !== RECENT_SCHEMA_VERSION ||
			!("projects" in value) ||
			!Array.isArray(value.projects) ||
			!value.projects.every(isRecentProject)
		) {
			return undefined;
		}
		return { version: RECENT_SCHEMA_VERSION, projects: value.projects };
	} catch {
		return undefined;
	}
}

function withoutOutputNewline(value: string): string {
	return value.replace(/(?:\r?\n)+$/, "");
}

async function defaultRun(argv: readonly string[]): Promise<ProjectProcessResult> {
	const process = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	return { exitCode, stdout, stderr };
}

/** Durable recent-project storage and argv-only native project selection. */
export class ProjectService implements ProjectController {
	readonly dataDir: string;
	readonly recentFilePath: string;
	readonly #platform: NodeJS.Platform;
	readonly #now: () => number;
	readonly #which: (executable: string) => string | null;
	readonly #run: (argv: readonly string[]) => Promise<ProjectProcessResult>;
	#writeQueue: Promise<void> = Promise.resolve();

	constructor(options: ProjectServiceOptions = {}) {
		this.dataDir = path.resolve(options.dataDir ?? path.join(getAgentDir(), "chudcode-desktop"));
		this.recentFilePath = path.join(this.dataDir, "recent-projects.json");
		this.#platform = options.platform ?? process.platform;
		this.#now = options.now ?? Date.now;
		this.#which = options.which ?? (executable => Bun.which(executable));
		this.#run = options.run ?? defaultRun;
	}

	async recent(): Promise<RecentProject[]> {
		await this.#writeQueue;
		const store = await this.#loadStore();
		const available = await Promise.all(
			store.projects.map(async project =>
				(await this.#isAvailableDirectory(project.rootPath)) ? project : undefined,
			),
		);
		return available
			.filter((project): project is RecentProject => project !== undefined)
			.map(project => ({ ...project }));
	}

	async recordOpened(rootPath: string): Promise<void> {
		const operation = this.#writeQueue.then(async () => {
			const canonical = await this.#canonicalDirectory(rootPath);
			const store = await this.#loadStore();
			const identity = this.#identity(canonical);
			const projects = store.projects.filter(project => this.#identity(project.rootPath) !== identity);
			projects.unshift({
				rootPath: canonical,
				displayName: path.basename(canonical) || canonical,
				lastOpenedMs: this.#now(),
			});
			await this.#persist({ version: RECENT_SCHEMA_VERSION, projects: projects.slice(0, MAX_RECENT_PROJECTS) });
		});
		this.#writeQueue = operation.catch(() => {});
		await operation;
	}

	async pick(initialPath?: string): Promise<ProjectPickerResult> {
		let result: ProjectPickerResult;
		switch (this.#platform) {
			case "linux":
				result = await this.#pickLinux(initialPath);
				break;
			case "darwin":
				result = await this.#pickMacos(initialPath);
				break;
			case "win32":
			case "cygwin":
				result = await this.#pickWindows(initialPath);
				break;
			default:
				throw new ProjectServiceError(
					"PROJECT_PICKER_UNSUPPORTED",
					`Project picker is unavailable on ${this.#platform}`,
				);
		}
		if (result.cancelled || !result.rootPath) return { cancelled: true };
		return { rootPath: await this.#canonicalDirectory(result.rootPath), cancelled: false };
	}

	async #pickLinux(initialPath?: string): Promise<ProjectPickerResult> {
		const kdialog = this.#which("kdialog");
		if (kdialog) {
			const argv = [kdialog, "--getexistingdirectory"];
			if (initialPath !== undefined) argv.push(initialPath);
			try {
				return await this.#runChooser(argv);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		const zenity = this.#which("zenity");
		if (!zenity)
			throw new ProjectServiceError(
				"PROJECT_PICKER_UNAVAILABLE",
				"Install kdialog or zenity to choose a project directory",
			);
		const argv = [zenity, "--file-selection", "--directory", "--title", "Open a Chudcode project"];
		if (initialPath !== undefined) argv.push("--filename", initialPath);
		return await this.#runChooser(argv);
	}

	async #pickMacos(initialPath?: string): Promise<ProjectPickerResult> {
		const osascript = this.#which("osascript");
		if (!osascript) throw new ProjectServiceError("PROJECT_PICKER_UNAVAILABLE", "osascript is unavailable");
		const argv = [osascript, "-e", MACOS_PICKER_SCRIPT];
		if (initialPath !== undefined) argv.push("--", initialPath);
		return await this.#runChooser(argv, false);
	}

	async #pickWindows(initialPath?: string): Promise<ProjectPickerResult> {
		const powershell = this.#which("powershell.exe") ?? this.#which("powershell");
		if (!powershell) throw new ProjectServiceError("PROJECT_PICKER_UNAVAILABLE", "Windows PowerShell is unavailable");
		const scriptPath = path.join(this.dataDir, "pick-project.ps1");
		await this.#writeFixedScript(scriptPath, WINDOWS_PICKER_SCRIPT);
		return await this.#runChooser(
			[
				powershell,
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				scriptPath,
				"-InitialPath",
				initialPath ?? "",
			],
			false,
		);
	}

	async #runChooser(argv: readonly string[], exitOneIsCancel = true): Promise<ProjectPickerResult> {
		const result = await this.#run(argv);
		const output = withoutOutputNewline(result.stdout);
		if (result.exitCode === 0 && output === CANCELLED_OUTPUT) return { cancelled: true };
		if (exitOneIsCancel && result.exitCode === 1) return { cancelled: true };
		if (result.exitCode !== 0) {
			const detail = withoutOutputNewline(result.stderr) || `exit code ${result.exitCode}`;
			throw new ProjectServiceError("PROJECT_PICKER_FAILED", `Project picker failed: ${detail}`);
		}
		if (!output) throw new ProjectServiceError("PROJECT_PICKER_FAILED", "Project picker returned no directory");
		return { rootPath: output, cancelled: false };
	}

	async #canonicalDirectory(rootPath: string): Promise<string> {
		let canonical: string;
		try {
			canonical = await fs.realpath(path.resolve(rootPath));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				throw new ProjectServiceError("WORKSPACE_NOT_FOUND", `Project root does not exist: ${rootPath}`);
			}
			throw error;
		}
		const stats = await fs.stat(canonical);
		if (!stats.isDirectory())
			throw new ProjectServiceError("NOT_A_DIRECTORY", `Project root is not a directory: ${rootPath}`);
		return canonical;
	}

	async #isAvailableDirectory(rootPath: string): Promise<boolean> {
		try {
			return (await fs.stat(rootPath)).isDirectory();
		} catch {
			return false;
		}
	}

	#identity(rootPath: string): string {
		return this.#platform === "win32" || this.#platform === "cygwin" ? rootPath.toLowerCase() : rootPath;
	}

	async #loadStore(): Promise<RecentStore> {
		try {
			const parsed = parseStore(await fs.readFile(this.recentFilePath, "utf8"));
			if (parsed) return this.#normalizeStore(parsed);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const recovered = await this.#recoverTemporary();
		return recovered ?? { version: RECENT_SCHEMA_VERSION, projects: [] };
	}

	#normalizeStore(store: RecentStore): RecentStore {
		const ordered = store.projects;
		const projects: RecentProject[] = [];
		const identities = new Set<string>();
		for (const project of ordered) {
			const identity = this.#identity(project.rootPath);
			if (identities.has(identity)) continue;
			identities.add(identity);
			projects.push({ ...project });
			if (projects.length === MAX_RECENT_PROJECTS) break;
		}
		return { version: RECENT_SCHEMA_VERSION, projects };
	}

	async #recoverTemporary(): Promise<RecentStore | undefined> {
		let entries: Array<{ name: string; mtimeMs: number }>;
		try {
			entries = await Promise.all(
				(await fs.readdir(this.dataDir, { withFileTypes: true }))
					.filter(
						entry =>
							entry.isFile() && entry.name.startsWith("recent-projects.json.") && entry.name.endsWith(".tmp"),
					)
					.map(async entry => ({
						name: entry.name,
						mtimeMs: (await fs.stat(path.join(this.dataDir, entry.name))).mtimeMs,
					})),
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		entries.sort((left, right) => right.mtimeMs - left.mtimeMs);
		for (const entry of entries) {
			const temporary = path.join(this.dataDir, entry.name);
			let parsed: RecentStore | undefined;
			try {
				parsed = parseStore(await fs.readFile(temporary, "utf8"));
			} catch {
				continue;
			}
			if (!parsed) continue;
			const normalized = this.#normalizeStore(parsed);
			await this.#persist(normalized);
			await fs.rm(temporary, { force: true });
			return normalized;
		}
		return undefined;
	}

	async #persist(store: RecentStore): Promise<void> {
		await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
		const temporary = `${this.recentFilePath}.${process.pid}-${Date.now()}-${randomBytes(8).toString("hex")}.tmp`;
		let temporaryExists = false;
		try {
			const handle = await fs.open(temporary, "wx", 0o600);
			temporaryExists = true;
			try {
				await handle.writeFile(`${JSON.stringify(store)}\n`, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await fs.rename(temporary, this.recentFilePath);
			temporaryExists = false;
		} finally {
			if (temporaryExists) await fs.rm(temporary, { force: true });
		}
	}

	async #writeFixedScript(filePath: string, content: string): Promise<void> {
		try {
			if ((await fs.readFile(filePath, "utf8")) === content) return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
		const temporary = `${filePath}.${process.pid}-${randomBytes(8).toString("hex")}.tmp`;
		try {
			await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
			await fs.rename(temporary, filePath);
		} finally {
			await fs.rm(temporary, { force: true });
		}
	}
}
