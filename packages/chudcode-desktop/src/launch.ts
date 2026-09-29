import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, getProjectDir } from "@chudware/utils";
import { sleep } from "@chudware/utils/async";
import { PRODUCT_CLI_VERSION } from "../../coding-agent/src/brand";
import type { DesktopFrame, DesktopRequest } from "./protocol";
import { createDesktopRuntime, type DesktopFrameSink } from "./runtime";
import {
	DesktopAlreadyRunningError,
	type DesktopRuntimeHost,
	type DesktopServerHandle,
	startDesktopServer,
} from "./server";
import { ServiceRouter } from "./service-router";

const PRESENCE_FILE = "desktop-url.json";
const PRESENCE_RETRIES = 20;
const PRESENCE_RETRY_MS = 25;
const GUI_EXECUTABLE = process.platform === "win32" ? "chudcode-gui.exe" : "chudcode-gui";

const BROWSER_CANDIDATES: Record<NodeJS.Platform, readonly string[]> = {
	aix: [],
	android: ["chromium", "google-chrome"],
	darwin: [
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
		"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	],
	freebsd: ["chromium", "chrome"],
	haiku: ["chromium"],
	linux: [
		"chromium",
		"chromium-browser",
		"google-chrome-stable",
		"google-chrome",
		"brave-browser",
		"brave",
		"microsoft-edge-stable",
		"microsoft-edge",
	],
	openbsd: ["chromium", "chrome"],
	sunos: ["chromium", "google-chrome"],
	win32: ["chrome.exe", "msedge.exe", "brave.exe", "chromium.exe"],
	cygwin: ["chrome.exe", "msedge.exe", "brave.exe", "chromium.exe"],
	netbsd: ["chromium", "chrome"],
};

export interface BrowserProcess {
	readonly exited?: Promise<number>;
	unref?(): void;
}

export interface BrowserLauncherDependencies {
	platform?: NodeJS.Platform;
	which(executable: string): string | null;
	spawn(argv: string[]): BrowserProcess;
	print(line: string): void;
}

export interface BrowserLaunchResult {
	mode: "app" | "default";
	argv: string[];
}

export interface LaunchDesktopOptions {
	cwd?: string;
	runtimeDir?: string;
	webDist?: string;
	guiExecutable?: string;
	browser?: Partial<BrowserLauncherDependencies>;
	/** Attach the native `chudcode-gui` window instead of a browser tab. */
	client?: DesktopClientKind;
}

export type DesktopClientKind = "browser" | "gui";

export interface LaunchedDesktop {
	readonly url: string;
	readonly bootstrapUrl: string;
	readonly token: string;
	readonly reused: boolean;
	readonly clientProcess?: BrowserProcess;
	stop(): Promise<void>;
}

interface Presence {
	url: string;
	bootstrapUrl: string;
	token: string;
}

class DeferredRuntimeHost implements DesktopRuntimeHost {
	#runtime?: DesktopRuntimeHost;
	#disposed = false;

	set(runtime: DesktopRuntimeHost): void {
		if (this.#disposed) {
			void runtime.dispose();
			throw new Error("Desktop server stopped before runtime initialization completed");
		}
		if (this.#runtime) throw new Error("Desktop runtime was initialized twice");
		this.#runtime = runtime;
	}

	attach(client: DesktopFrameSink): void {
		if (!this.#runtime) {
			client.close(1012, "desktop runtime is starting");
			return;
		}
		this.#runtime.attach(client);
	}

	detach(client: DesktopFrameSink): void {
		this.#runtime?.detach(client);
	}

	async handleRequest(request: DesktopRequest): Promise<DesktopFrame> {
		if (!this.#runtime)
			return {
				t: "response",
				id: request.id,
				method: request.method,
				error: { code: "RUNTIME_STARTING", message: "Desktop runtime is starting" },
			} as DesktopFrame;
		return await this.#runtime.handleRequest(request);
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		await this.#runtime?.dispose();
	}
}

export function chromiumAppArgv(
	executable: string,
	url: string,
	platform: NodeJS.Platform = process.platform,
): string[] {
	const argv = [executable, `--app=${url}`];
	if (platform === "linux") argv.push("--class=chudcode");
	return argv;
}

export function defaultBrowserArgv(url: string, platform: NodeJS.Platform = process.platform): string[] {
	if (platform === "darwin") return ["open", url];
	if (platform === "win32" || platform === "cygwin") return ["rundll32.exe", "url.dll,FileProtocolHandler", url];
	return ["xdg-open", url];
}

function defaultBrowserDependencies(overrides: Partial<BrowserLauncherDependencies>): BrowserLauncherDependencies {
	return {
		platform: overrides.platform ?? process.platform,
		which: overrides.which ?? (executable => Bun.which(executable)),
		spawn:
			overrides.spawn ??
			(argv =>
				Bun.spawn(argv, {
					stdin: "ignore",
					stdout: "ignore",
					stderr: "ignore",
				})),
		print: overrides.print ?? (line => process.stdout.write(`${line}\n`)),
	};
}

/** Opens a local URL without ever evaluating a shell command string. */
export function openDesktopBrowser(
	url: string,
	overrides: Partial<BrowserLauncherDependencies> = {},
): BrowserLaunchResult {
	const dependencies = defaultBrowserDependencies(overrides);
	const platform = dependencies.platform ?? process.platform;
	for (const candidate of BROWSER_CANDIDATES[platform] ?? []) {
		const executable = candidate.includes(path.sep) ? candidate : dependencies.which(candidate);
		if (!executable) continue;
		const argv = chromiumAppArgv(executable, url, platform);
		try {
			dependencies.spawn(argv).unref?.();
			return { mode: "app", argv };
		} catch {}
	}
	const argv = defaultBrowserArgv(url, platform);
	dependencies.print(url);
	try {
		dependencies.spawn(argv).unref?.();
	} catch {}
	return { mode: "default", argv };
}

/** Derives the loopback WebSocket endpoint the native GUI connects to. */
export function desktopWebSocketUrl(httpUrl: string): string {
	const parsed = new URL(httpUrl);
	parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
	parsed.pathname = "/ws";
	parsed.search = "";
	parsed.hash = "";
	return parsed.toString();
}

/**
 * Launches the native `chudcode-gui` window against a running desktop server.
 * Packaged callers pass the validated adjacent executable explicitly; only
 * checkout source mode is allowed to resolve a developer build from PATH.
 */
export function openDesktopGui(
	url: string,
	token: string,
	overrides: Partial<BrowserLauncherDependencies> = {},
	executable?: string,
): { argv: string[]; process: BrowserProcess } {
	const dependencies = defaultBrowserDependencies(overrides);
	const resolvedExecutable = executable ?? dependencies.which(GUI_EXECUTABLE);
	if (!resolvedExecutable) {
		throw new Error(`${GUI_EXECUTABLE} was not found; build it or pass an adjacent packaged GUI`);
	}
	const argv = [resolvedExecutable, "--url", desktopWebSocketUrl(url), "--token", token];
	return { argv, process: dependencies.spawn(argv) };
}

async function readPresence(filePath: string): Promise<Presence | undefined> {
	for (let attempt = 0; attempt < PRESENCE_RETRIES; attempt += 1) {
		try {
			const value: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
			if (
				typeof value === "object" &&
				value !== null &&
				"url" in value &&
				typeof value.url === "string" &&
				"bootstrapUrl" in value &&
				typeof value.bootstrapUrl === "string" &&
				"token" in value &&
				typeof value.token === "string"
			) {
				return { url: value.url, bootstrapUrl: value.bootstrapUrl, token: value.token };
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await sleep(PRESENCE_RETRY_MS);
	}
	return undefined;
}

async function writePresence(filePath: string, presence: Presence): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const temporary = `${filePath}.${process.pid}.tmp`;
	await fs.writeFile(temporary, JSON.stringify(presence), { encoding: "utf8", mode: 0o600 });
	await fs.rename(temporary, filePath);
}

function attachClient(
	client: DesktopClientKind,
	url: string,
	bootstrapUrl: string,
	token: string,
	overrides: Partial<BrowserLauncherDependencies> | undefined,
	guiExecutable: string | undefined,
): BrowserProcess | undefined {
	if (client === "gui") return openDesktopGui(url, token, overrides, guiExecutable).process;
	openDesktopBrowser(bootstrapUrl, overrides);
	return undefined;
}

export interface DesktopLayout {
	readonly mode: "packaged" | "source";
	readonly root: string;
	readonly webDist: string;
	readonly guiExecutable: string;
}

async function requireFile(filePath: string, label: string): Promise<void> {
	let stat: Stats;
	try {
		stat = await fs.stat(filePath);
	} catch {
		throw new Error(`Packaged desktop is incomplete: missing adjacent ${label} at ${filePath}`);
	}
	if (!stat.isFile()) throw new Error(`Packaged desktop is incomplete: ${label} is not a file at ${filePath}`);
	if (process.platform !== "win32" && (stat.mode & 0o111) === 0 && label.includes("executable")) {
		throw new Error(`Packaged desktop is incomplete: ${label} is not executable at ${filePath}`);
	}
}

async function requireDirectory(directoryPath: string, label: string): Promise<void> {
	try {
		if ((await fs.stat(directoryPath)).isDirectory()) return;
	} catch {}
	throw new Error(`Packaged desktop is incomplete: missing adjacent ${label} at ${directoryPath}`);
}

/**
 * Resolves runtime files without consulting CHUDCODE_REPO or PATH in packaged
 * mode. Source mode is deliberately opt-in and only accepted in this checkout.
 */
export async function resolveDesktopLayout(
	options: { sourceMode?: boolean; executablePath?: string; sourceRoot?: string; guiExecutable?: string } = {},
): Promise<DesktopLayout> {
	if (options.sourceMode) {
		const root = path.resolve(options.sourceRoot ?? path.join(import.meta.dir, "../../.."));
		await requireFile(path.join(root, "package.json"), "checkout package.json");
		try {
			await fs.lstat(path.join(root, ".git"));
		} catch {
			throw new Error(`--source-mode requires a Chudcode checkout: ${root}`);
		}
		await requireFile(
			path.join(root, "packages", "chudcode-desktop", "src", "launch.ts"),
			"desktop source entrypoint",
		);
		const webDist = path.join(root, "packages", "chudcode-desktop", "dist", "web");
		await requireDirectory(webDist, "built web assets");
		const guiExecutable =
			options.guiExecutable ??
			(process.env.CHUDCODE_GUI_BIN?.length ? path.resolve(process.env.CHUDCODE_GUI_BIN) : null) ??
			Bun.which(GUI_EXECUTABLE);
		if (!guiExecutable) throw new Error(`Source mode requires a built ${GUI_EXECUTABLE}`);
		await requireFile(guiExecutable, "GUI executable");
		return { mode: "source", root, webDist, guiExecutable };
	}

	const root = path.dirname(path.resolve(options.executablePath ?? process.execPath));
	const executableSuffix = process.platform === "win32" ? ".exe" : "";
	const desktopExecutable = path.join(root, `chudcode-desktop${executableSuffix}`);
	const guiExecutable = path.join(root, `chudcode-gui${executableSuffix}`);
	await requireFile(desktopExecutable, "desktop executable");
	await requireFile(path.join(root, `chud${executableSuffix}`), "CLI executable");
	await requireFile(guiExecutable, "GUI executable");
	await requireDirectory(path.join(root, "web"), "web assets");
	await requireFile(path.join(root, "web", "index.html"), "web index");
	await requireDirectory(path.join(root, "assets"), "GUI assets");
	for (const notice of ["VERSION", "NOTICE", "THIRD-PARTY-NOTICES.txt"]) {
		await requireFile(path.join(root, notice), notice);
	}
	return { mode: "packaged", root, webDist: path.join(root, "web"), guiExecutable };
}

export async function readDesktopVersion(
	options: { sourceMode?: boolean; executablePath?: string } = {},
): Promise<string> {
	const versionPath = path.join(path.dirname(path.resolve(options.executablePath ?? process.execPath)), "VERSION");
	let version: unknown = PRODUCT_CLI_VERSION;
	if (!options.sourceMode) version = (await fs.readFile(versionPath, "utf8")).trim();
	if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
		throw new Error(`Invalid desktop version metadata at ${versionPath}`);
	}
	return version;
}

export async function launchDesktop(options: LaunchDesktopOptions = {}): Promise<LaunchedDesktop> {
	const cwd = path.resolve(options.cwd ?? getProjectDir());
	const runtimeDir = options.runtimeDir ?? path.join(getAgentDir(), "run", "chudcode-desktop");
	const presencePath = path.join(runtimeDir, PRESENCE_FILE);
	const client = options.client ?? "browser";
	const deferred = new DeferredRuntimeHost();
	let server: DesktopServerHandle;
	try {
		server = await startDesktopServer({ cwd, runtimeDir, runtime: deferred, webDist: options.webDist });
	} catch (error) {
		if (!(error instanceof DesktopAlreadyRunningError)) throw error;
		const presence = await readPresence(presencePath);
		if (!presence) throw new Error("Chudcode is already running, but its desktop URL is unavailable");
		const clientProcess = attachClient(
			client,
			presence.url,
			presence.bootstrapUrl,
			presence.token,
			options.browser,
			options.guiExecutable,
		);
		return {
			url: presence.url,
			bootstrapUrl: presence.bootstrapUrl,
			token: presence.token,
			reused: true,
			clientProcess,
			stop: async () => {},
		};
	}

	let clientProcess: BrowserProcess | undefined;
	try {
		const runtime = await createDesktopRuntime({ cwd });
		const services = new ServiceRouter({ runtime });
		deferred.set(services);
		await services.openWorkspace(cwd);
		await writePresence(presencePath, {
			url: server.url,
			bootstrapUrl: server.bootstrapUrl,
			token: server.token,
		});
		clientProcess = attachClient(
			client,
			server.url,
			server.bootstrapUrl,
			server.token,
			options.browser,
			options.guiExecutable,
		);
	} catch (error) {
		await fs.rm(presencePath, { force: true });
		await server.stop();
		throw error;
	}
	let stopped = false;
	return {
		url: server.url,
		bootstrapUrl: server.bootstrapUrl,
		token: server.token,
		clientProcess,
		reused: false,
		async stop() {
			if (stopped) return;
			stopped = true;
			try {
				await fs.rm(presencePath, { force: true });
			} finally {
				await server.stop();
			}
		},
	};
}

// Compiled Windows executables report `import.meta.main === false` (Bun keys
// the entry with backslashes but registers main with forward slashes; see
// packages/coding-agent/src/cli.ts). compile-binary.ts define-folds
// CHUDCODE_COMPILED, and a compiled binary's entry is the process entry.
if (import.meta.main || process.env.CHUDCODE_COMPILED === "true") {
	const sourceMode = process.argv.includes("--source-mode");
	if (process.argv.includes("--version")) {
		process.stdout.write(`${await readDesktopVersion({ sourceMode })}\n`);
	} else {
		const layout = await resolveDesktopLayout({ sourceMode });
		const desktop = await launchDesktop({
			client: process.argv.includes("--browser") ? "browser" : "gui",
			webDist: layout.webDist,
			guiExecutable: layout.guiExecutable,
		});
		let shuttingDown = false;
		const shutdown = async () => {
			if (shuttingDown) return;
			shuttingDown = true;
			await desktop.stop();
		};
		process.once("SIGINT", () => void shutdown());
		process.once("SIGTERM", () => void shutdown());
		if (desktop.clientProcess?.exited) {
			const exitCode = await desktop.clientProcess.exited;
			await shutdown();
			if (exitCode !== 0) process.exitCode = exitCode;
		}
	}
}
