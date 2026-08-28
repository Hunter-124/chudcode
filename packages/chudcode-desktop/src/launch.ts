import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, getProjectDir } from "@oh-my-pi/pi-utils";
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
	browser?: Partial<BrowserLauncherDependencies>;
}

export interface LaunchedDesktop {
	readonly url: string;
	readonly bootstrapUrl: string;
	readonly reused: boolean;
	stop(): Promise<void>;
}

interface Presence {
	url: string;
	bootstrapUrl: string;
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
				typeof value.bootstrapUrl === "string"
			) {
				return { url: value.url, bootstrapUrl: value.bootstrapUrl };
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await Bun.sleep(PRESENCE_RETRY_MS);
	}
	return undefined;
}

async function writePresence(filePath: string, presence: Presence): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const temporary = `${filePath}.${process.pid}.tmp`;
	await fs.writeFile(temporary, JSON.stringify(presence), { encoding: "utf8", mode: 0o600 });
	await fs.rename(temporary, filePath);
}

export async function launchDesktop(options: LaunchDesktopOptions = {}): Promise<LaunchedDesktop> {
	const cwd = path.resolve(options.cwd ?? getProjectDir());
	const runtimeDir = options.runtimeDir ?? path.join(getAgentDir(), "run", "chudcode-desktop");
	const presencePath = path.join(runtimeDir, PRESENCE_FILE);
	const deferred = new DeferredRuntimeHost();
	let server: DesktopServerHandle;
	try {
		server = await startDesktopServer({ cwd, runtimeDir, runtime: deferred });
	} catch (error) {
		if (!(error instanceof DesktopAlreadyRunningError)) throw error;
		const presence = await readPresence(presencePath);
		if (!presence) throw new Error("Chudcode is already running, but its desktop URL is unavailable");
		openDesktopBrowser(presence.bootstrapUrl, options.browser);
		return { url: presence.url, bootstrapUrl: presence.bootstrapUrl, reused: true, stop: async () => {} };
	}

	try {
		const runtime = await createDesktopRuntime({ cwd });
		const services = new ServiceRouter({ runtime });
		deferred.set(services);
		await services.openWorkspace(cwd);
		await writePresence(presencePath, { url: server.url, bootstrapUrl: server.bootstrapUrl });
		openDesktopBrowser(server.bootstrapUrl, options.browser);
	} catch (error) {
		await fs.rm(presencePath, { force: true });
		await server.stop();
		throw error;
	}
	let stopped = false;
	return {
		url: server.url,
		bootstrapUrl: server.bootstrapUrl,
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

if (import.meta.main) {
	const desktop = await launchDesktop();
	if (!desktop.reused) {
		let shuttingDown = false;
		const shutdown = async () => {
			if (shuttingDown) return;
			shuttingDown = true;
			await desktop.stop();
		};
		process.once("SIGINT", () => void shutdown());
		process.once("SIGTERM", () => void shutdown());
	}
}
