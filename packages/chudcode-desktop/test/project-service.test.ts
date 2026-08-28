import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { type ProjectProcessResult, ProjectService, ProjectServiceError } from "../src/project-service";
import type { DesktopFrame, DesktopRequest, WorkspaceDescriptor } from "../src/protocol";
import type { DesktopFrameSink } from "../src/runtime";
import type { DesktopRuntimeHost } from "../src/server";
import { type RoutedLsp, type RoutedTerminal, type RoutedWorkspace, ServiceRouter } from "../src/service-router";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "chudcode-project-service-"));
	temporaryRoots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

function processResult(exitCode: number, stdout = "", stderr = ""): ProjectProcessResult {
	return { exitCode, stdout, stderr };
}

function assertNoShell(argvs: readonly (readonly string[])[]): void {
	for (const argv of argvs) {
		expect(["sh", "bash", "cmd.exe"].includes(path.basename(argv[0] ?? "").toLowerCase())).toBeFalse();
		expect(argv).not.toContain("-c");
		expect(argv).not.toContain("-Command");
	}
}

describe("ProjectService recent projects", () => {
	it("canonicalizes, deduplicates, orders, and caps durable recents at twenty", async () => {
		const root = await temporaryRoot();
		const dataDir = path.join(root, "agent-data");
		const projectRoots = await Promise.all(
			Array.from({ length: 21 }, async (_, index) => {
				const projectRoot = path.join(root, `project-${index.toString().padStart(2, "0")}`);
				await fs.mkdir(projectRoot);
				return projectRoot;
			}),
		);
		const alias = path.join(root, "project-alias");
		await fs.symlink(projectRoots[0], alias, "dir");
		let clock = 100;
		const service = new ProjectService({ dataDir, now: () => ++clock });

		for (const projectRoot of projectRoots) await service.recordOpened(projectRoot);
		await service.recordOpened(alias);

		const projects = await service.recent();
		expect(projects).toHaveLength(20);
		expect(projects[0]).toEqual({
			rootPath: await fs.realpath(projectRoots[0]),
			displayName: "project-00",
			lastOpenedMs: 122,
		});
		expect(projects.slice(1).map(project => project.rootPath)).toEqual(
			(
				await Promise.all(
					projectRoots
						.slice(2)
						.reverse()
						.map(projectRoot => fs.realpath(projectRoot)),
				)
			).slice(0, 19),
		);
		expect(new Set(projects.map(project => project.rootPath)).size).toBe(20);

		const stored = JSON.parse(await fs.readFile(service.recentFilePath, "utf8")) as { projects: unknown[] };
		expect(stored.projects).toHaveLength(20);
		expect((await fs.readdir(dataDir)).filter(name => name.endsWith(".tmp"))).toEqual([]);
	});

	it("retains missing roots on disk while omitting them from the protocol result", async () => {
		const root = await temporaryRoot();
		const projectRoot = path.join(root, "removed-project");
		await fs.mkdir(projectRoot);
		const service = new ProjectService({ dataDir: path.join(root, "data"), now: () => 42 });
		await service.recordOpened(projectRoot);
		await fs.rm(projectRoot, { recursive: true });

		expect(await service.recent()).toEqual([]);
		const stored = JSON.parse(await fs.readFile(service.recentFilePath, "utf8")) as {
			projects: Array<{ rootPath: string }>;
		};
		expect(stored.projects.map(project => project.rootPath)).toEqual([projectRoot]);
	});

	it("recovers a complete atomic temporary when the primary is corrupt", async () => {
		const root = await temporaryRoot();
		const projectRoot = path.join(root, "recoverable");
		const dataDir = path.join(root, "data");
		await fs.mkdir(projectRoot);
		await fs.mkdir(dataDir);
		const recentFile = path.join(dataDir, "recent-projects.json");
		await fs.writeFile(recentFile, "{truncated");
		await fs.writeFile(
			`${recentFile}.interrupted.tmp`,
			JSON.stringify({
				version: 1,
				projects: [{ rootPath: projectRoot, displayName: "recoverable", lastOpenedMs: 7 }],
			}),
		);
		const service = new ProjectService({ dataDir });

		expect(await service.recent()).toEqual([{ rootPath: projectRoot, displayName: "recoverable", lastOpenedMs: 7 }]);
		expect(JSON.parse(await fs.readFile(recentFile, "utf8"))).toEqual({
			version: 1,
			projects: [{ rootPath: projectRoot, displayName: "recoverable", lastOpenedMs: 7 }],
		});
		expect((await fs.readdir(dataDir)).filter(name => name.endsWith(".tmp"))).toEqual([]);
	});
});

describe("ProjectService native chooser", () => {
	it("uses kdialog first, falls back to zenity only when unavailable, and keeps hostile paths in argv", async () => {
		const root = await temporaryRoot();
		const hostile = path.join(root, "project;$(touch injected) 'quoted'");
		await fs.mkdir(hostile);
		const argvs: string[][] = [];
		let kdialogAttempted = false;
		const service = new ProjectService({
			dataDir: path.join(root, "data"),
			platform: "linux",
			which: executable => `/usr/bin/${executable}`,
			run: async argv => {
				argvs.push([...argv]);
				if (!kdialogAttempted) {
					kdialogAttempted = true;
					const error = new Error("not found") as NodeJS.ErrnoException;
					error.code = "ENOENT";
					throw error;
				}
				return processResult(0, `${hostile}\n`);
			},
		});

		expect(await service.pick(hostile)).toEqual({ rootPath: await fs.realpath(hostile), cancelled: false });
		expect(argvs[0]).toEqual(["/usr/bin/kdialog", "--getexistingdirectory", hostile]);
		expect(argvs[1]).toEqual([
			"/usr/bin/zenity",
			"--file-selection",
			"--directory",
			"--title",
			"Open a Chudcode project",
			"--filename",
			hostile,
		]);
		assertNoShell(argvs);
	});

	it("distinguishes Linux cancellation from chooser errors without invoking a fallback", async () => {
		const root = await temporaryRoot();
		const cancelledArgvs: string[][] = [];
		const cancelled = new ProjectService({
			dataDir: path.join(root, "cancelled-data"),
			platform: "linux",
			which: executable => `/usr/bin/${executable}`,
			run: async argv => {
				cancelledArgvs.push([...argv]);
				return processResult(1);
			},
		});
		expect(await cancelled.pick(root)).toEqual({ cancelled: true });
		expect(cancelledArgvs).toHaveLength(1);
		expect(cancelledArgvs[0]?.[0]).toBe("/usr/bin/kdialog");

		const failed = new ProjectService({
			dataDir: path.join(root, "failed-data"),
			platform: "linux",
			which: executable => (executable === "kdialog" ? null : "/usr/bin/zenity"),
			run: async () => processResult(2, "", "display unavailable\n"),
		});
		try {
			await failed.pick(root);
			throw new Error("expected chooser failure");
		} catch (error) {
			expect(error).toBeInstanceOf(ProjectServiceError);
			expect((error as ProjectServiceError).code).toBe("PROJECT_PICKER_FAILED");
			expect(error).toHaveProperty("message", "Project picker failed: display unavailable");
		}
	});

	it("passes macOS initial paths as osascript argv and recognizes the script cancellation sentinel", async () => {
		const root = await temporaryRoot();
		const hostile = path.join(root, "initial; say hacked");
		const argvs: string[][] = [];
		const service = new ProjectService({
			dataDir: path.join(root, "data"),
			platform: "darwin",
			which: executable => `/usr/bin/${executable}`,
			run: async argv => {
				argvs.push([...argv]);
				return processResult(0, "__CHUDCODE_CANCELLED__\n");
			},
		});

		expect(await service.pick(hostile)).toEqual({ cancelled: true });
		expect(argvs[0]?.slice(-2)).toEqual(["--", hostile]);
		expect(argvs[0]?.slice(0, 2)).toEqual(["/usr/bin/osascript", "-e"]);
		assertNoShell(argvs);
	});

	it("uses a fixed PowerShell script file and passes hostile Windows input only as an argument", async () => {
		const root = await temporaryRoot();
		const selected = path.join(root, "selected project");
		const hostile = `C:\\projects\\x'; Remove-Item C:\\ -Recurse; 'y`;
		await fs.mkdir(selected);
		const argvs: string[][] = [];
		const dataDir = path.join(root, "data");
		const service = new ProjectService({
			dataDir,
			platform: "win32",
			which: executable =>
				executable === "powershell.exe" ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" : null,
			run: async argv => {
				argvs.push([...argv]);
				const scriptIndex = argv.indexOf("-File") + 1;
				expect(scriptIndex).toBeGreaterThan(0);
				expect(await fs.readFile(argv[scriptIndex]!, "utf8")).toContain("FolderBrowserDialog");
				return processResult(0, `${selected}\r\n`);
			},
		});

		expect(await service.pick(hostile)).toEqual({ rootPath: await fs.realpath(selected), cancelled: false });
		expect(argvs[0]).toContain("-File");
		expect(argvs[0]).not.toContain("-Command");
		expect(argvs[0]?.slice(-2)).toEqual(["-InitialPath", hostile]);
		expect(await fs.readFile(path.join(dataDir, "pick-project.ps1"), "utf8")).not.toContain(hostile);
		assertNoShell(argvs);
	});
});

class RouterRuntime implements DesktopRuntimeHost {
	attach(_client: DesktopFrameSink): void {}
	detach(_client: DesktopFrameSink): void {}
	async handleRequest(_request: DesktopRequest): Promise<DesktopFrame> {
		throw new Error("unexpected core request");
	}
	async dispose(): Promise<void> {}
}

const routerLsp: RoutedLsp = {
	openWorkspace: async () => {},
	closeWorkspace: async () => {},
	openDocument: async () => "typescript",
	changeDocument: async () => {},
	saveDocument: async () => {},
	closeDocument: async () => {},
	requestFromProtocol: async () => undefined,
	shutdown: async () => {},
};

const routerTerminal: RoutedTerminal = {
	create: async () => ({ terminalId: "terminal" }),
	write: () => ({ accepted: true }),
	resize: () => ({}),
	close: async () => ({}),
	dispose: async () => {},
};

function routedWorkspace(rootPath: string): RoutedWorkspace {
	const descriptor: WorkspaceDescriptor = { id: "workspace-good", rootPath, displayName: path.basename(rootPath) };
	return {
		id: descriptor.id,
		rootPath,
		descriptor,
		rootUri: () => pathToFileURL(rootPath).href,
		list: async () => [],
		read: async () => {
			throw new Error("unused");
		},
		write: async () => {
			throw new Error("unused");
		},
		stat: async () => {
			throw new Error("unused");
		},
		create: async () => {
			throw new Error("unused");
		},
		rename: async () => {
			throw new Error("unused");
		},
		copy: async () => {
			throw new Error("unused");
		},
		remove: async () => false,
		reveal: async () => false,
	};
}

describe("ServiceRouter project recording", () => {
	it("records a recent project only after the canonical workspace has opened successfully", async () => {
		const root = await temporaryRoot();
		const canonicalRoot = await fs.realpath(root);
		const recorded: string[] = [];
		const projects = {
			recent: async () => [],
			pick: async () => ({ cancelled: true }),
			recordOpened: async (rootPath: string) => {
				recorded.push(rootPath);
			},
		};
		const router = new ServiceRouter({
			runtime: new RouterRuntime(),
			projects,
			registry: { list: () => [], onChange: () => () => {} },
			workspaceFactory: async requested => {
				if (requested === "failed") throw new Error("open failed");
				return routedWorkspace(canonicalRoot);
			},
			watcherFactory: () => ({ start: async () => {}, close: () => {} }),
			searchFactory: () => ({ search: async () => [] }),
			gitFactory: {
				discover: async () => {
					throw new Error("unused");
				},
				init: async () => {
					throw new Error("unused");
				},
			},
			terminalFactory: () => routerTerminal,
			lsp: routerLsp,
		});

		const failed = await router.handleRequest({
			t: "request",
			id: 1,
			method: "workspace.open",
			params: { rootPath: "failed" },
		});
		expect(failed).toMatchObject({ t: "response", error: { message: "open failed" } });
		expect(recorded).toEqual([]);
		const opened = await router.handleRequest({
			t: "request",
			id: 2,
			method: "workspace.open",
			params: { rootPath: root },
		});
		expect(opened).toMatchObject({ t: "response", result: { workspace: { rootPath: canonicalRoot } } });
		expect(recorded).toEqual([canonicalRoot]);
		await router.dispose();
	});
});
