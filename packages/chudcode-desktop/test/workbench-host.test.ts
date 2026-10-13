import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { PRODUCT_SEMVER } from "../../coding-agent/src/brand";
import type { DesktopEvent, DesktopFrame, DesktopMethod, DesktopRequestMap, DesktopResponse } from "../src/protocol";

type ServiceProcess = Bun.Subprocess<"pipe", "pipe", "pipe">;
interface Ready {
	type: "ready";
	protocol: 1;
	url: string;
	wsUrl: string;
	token: string;
}
interface Host {
	child: ServiceProcess;
	ready: Ready;
	remainingStdout: Promise<string>;
	stderr: Promise<string>;
}
const directories: string[] = [];
const children: ServiceProcess[] = [];
const sockets: WebSocket[] = [];

// These bounds fail a hung real subprocess/socket; they never delay a passing
// test. Fake clocks cannot advance Bun's separate child-process event loop.
async function deadline<T>(promise: Promise<T>, label: string, ms = 60_000): Promise<T> {
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => timeout.reject(new Error(`${label} timed out`)), ms);
	try {
		return await Promise.race([promise, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.close();
	for (const child of children.splice(0)) {
		if (child.exitCode === null) {
			child.kill("SIGTERM");
			try {
				await deadline(child.exited, "service cleanup", 10_000);
			} catch {
				child.kill("SIGKILL");
				await child.exited;
			}
		}
	}
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "workbench-host-")));
	directories.push(root);
	await fs.mkdir(path.join(root, "workspace"));
	await fs.writeFile(path.join(root, "workspace", "example.txt"), "before\n");
	return root;
}

function spawnService(root: string, args: string[]): ServiceProcess {
	const executable = process.env.CHUDCODE_WORKBENCH_TEST_SERVICE;
	const command = executable
		? [executable, ...args]
		: [process.execPath, path.resolve(import.meta.dir, "../src/workbench-host.ts"), ...args];
	// Deliberate allowlist: never read the developer's auth/profile, .env files,
	// provider credentials, native keychain configuration, or local model servers.
	const child = Bun.spawn(command, {
		cwd: root,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			PATH: process.env.PATH ?? "",
			SystemRoot: process.env.SystemRoot ?? "",
			HOME: root,
			USERPROFILE: root,
			APPDATA: path.join(root, "config"),
			LOCALAPPDATA: path.join(root, "data"),
			TEMP: root,
			TMPDIR: root,
			XDG_CONFIG_HOME: path.join(root, "config"),
			XDG_DATA_HOME: path.join(root, "data"),
			XDG_STATE_HOME: path.join(root, "state"),
			XDG_CACHE_HOME: path.join(root, "cache"),
			PI_CONFIG_DIR: path.join(root, "config"),
			PI_CODING_AGENT_DIR: path.join(root, "agent"),
			CHUDCODE_DESKTOP_PORT: "not-a-port",
			OLLAMA_BASE_URL: "http://127.0.0.1:9/v1",
			LM_STUDIO_BASE_URL: "http://127.0.0.1:9/v1",
			LLAMA_CPP_BASE_URL: "http://127.0.0.1:9/v1",
		},
	});
	children.push(child);
	return child;
}

function captureStderr(stream: ReadableStream<Uint8Array>): { done: Promise<string>; snapshot: () => string } {
	let text = "";
	const done = (async () => {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		try {
			for (;;) {
				const part = await reader.read();
				text = (text + decoder.decode(part.value, { stream: !part.done })).slice(-16_384);
				if (part.done) return text;
			}
		} finally {
			reader.releaseLock();
		}
	})();
	return { done, snapshot: () => text };
}

async function start(root: string): Promise<Host> {
	const child = spawnService(root, ["--workspace", path.join(root, "workspace")]);
	const diagnostics = captureStderr(child.stderr);
	const stderr = diagnostics.done;
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let stdoutEnded = false;
	try {
		while (!text.includes("\n")) {
			const part = await deadline(reader.read(), "service readiness");
			if (part.done) {
				stdoutEnded = true;
				throw new Error("Service exited without readiness");
			}
			text += decoder.decode(part.value, { stream: true });
			if (text.length > 65_536) throw new Error("Service readiness exceeded bound");
		}
	} catch (error) {
		if (stdoutEnded) {
			// EOF and stderr draining can arrive on separate event-loop turns.
			// Keep a broken stderr pipe from hiding the original startup failure.
			try {
				await deadline(stderr, "service startup stderr", 5_000);
			} catch {}
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`${message} (exit code: ${child.exitCode ?? "pending"})\nService stderr (last 16384 characters):\n${diagnostics.snapshot() || "(empty)"}`,
		);
	}
	const split = text.indexOf("\n");
	const ready = JSON.parse(text.slice(0, split)) as Ready;
	expect(ready.type).toBe("ready");
	expect(ready.protocol).toBe(1);
	expect(new URL(ready.url).hostname).toBe("127.0.0.1");
	expect(ready.wsUrl).toBe(`${ready.url.replace("http:", "ws:")}/ws`);
	expect(ready.token.length).toBeGreaterThanOrEqual(32);
	const remainingStdout = (async () => {
		let rest = text.slice(split + 1);
		for (;;) {
			const part = await reader.read();
			if (part.done) return rest + decoder.decode();
			rest += decoder.decode(part.value, { stream: true });
		}
	})();
	return { child, ready, remainingStdout, stderr };
}

class Probe {
	readonly socket: WebSocket;
	readonly opened: Promise<void>;
	readonly closed: Promise<void>;
	readonly welcome: Promise<Extract<DesktopEvent, { t: "welcome" }>>;
	readonly #requests = new Map<number, (response: DesktopResponse) => void>();
	#nextId = 0;

	constructor(ready: Ready) {
		this.socket = new WebSocket(ready.wsUrl, {
			headers: { Authorization: `Bearer ${ready.token}`, Origin: ready.url },
		});
		sockets.push(this.socket);
		const opened = Promise.withResolvers<void>();
		const closed = Promise.withResolvers<void>();
		const welcome = Promise.withResolvers<Extract<DesktopEvent, { t: "welcome" }>>();
		this.opened = opened.promise;
		this.closed = closed.promise;
		this.welcome = welcome.promise;
		this.socket.onopen = () => opened.resolve();
		this.socket.onerror = () => opened.reject(new Error("Service WebSocket connection failed"));
		this.socket.onclose = () => closed.resolve();
		this.socket.onmessage = event => {
			const frame = JSON.parse(String(event.data)) as DesktopFrame;
			if (frame.t === "welcome") welcome.resolve(frame);
			if (frame.t === "response") {
				this.#requests.get(frame.id)?.(frame);
				this.#requests.delete(frame.id);
			}
		};
	}

	async request<M extends DesktopMethod>(
		method: M,
		params: DesktopRequestMap[M]["params"],
	): Promise<DesktopResponse<M>> {
		const id = ++this.#nextId;
		const response = Promise.withResolvers<DesktopResponse>();
		this.#requests.set(id, response.resolve);
		this.socket.send(JSON.stringify({ t: "request", id, method, params }));
		const frame = await deadline(response.promise, method);
		expect(frame.method).toBe(method);
		return frame as DesktopResponse<M>;
	}
}

describe("real workbench service", () => {
	it("opens the real workspace, authenticates protocol v1, persists sessions/files, and tears down on owner EOF", async () => {
		const root = await fixture();
		const workspace = path.join(root, "workspace");
		const host = await start(root);
		const { ready } = host;
		expect((await fetch(`${ready.url}/ws`)).status).toBe(401);
		expect((await fetch(`${ready.url}/ws`, { headers: { Authorization: "Bearer incorrect" } })).status).toBe(401);
		expect(
			(
				await fetch(`${ready.url}/ws`, {
					headers: { Authorization: `Bearer ${ready.token}`, Origin: "https://attacker.example" },
				})
			).status,
		).toBe(403);
		expect(
			(
				await fetch(`${ready.url}/ws`, {
					headers: { Authorization: `Bearer ${ready.token}`, Host: "attacker.example" },
				})
			).status,
		).toBe(421);
		expect((await fetch(`${ready.url}/`, { headers: { Authorization: `Bearer ${ready.token}` } })).status).toBe(404);

		const probe = new Probe(ready);
		await deadline(probe.opened, "WebSocket open");
		const welcome = await deadline(probe.welcome, "session welcome");
		expect(welcome.protocol).toBe(1);
		expect(welcome.header.cwd).toBe(workspace);
		expect((await probe.request("runtime.hello", { protocol: 1 })).result).toEqual({
			protocol: 1,
			product: "Chudcode",
		});
		expect((await probe.request("runtime.hello", { protocol: 2 })).error?.code).toBe("PROTOCOL_MISMATCH");
		const recent = await probe.request("workspace.recent", {});
		expect(recent.result?.projects.some(project => project.rootPath === workspace)).toBe(true);
		const opened = await probe.request("workspace.open", { rootPath: workspace });
		const workspaceId = opened.result!.workspace.id;
		const uri = pathToFileURL(path.join(workspace, "example.txt")).href;
		const read = await probe.request("workspace.read", { workspaceId, uri });
		expect(read.result?.document.text).toBe("before\n");
		const written = await probe.request("workspace.write", {
			workspaceId,
			uri,
			text: "after\n",
			expectedSha256: read.result!.document.stamp.sha256,
		});
		expect(written.error).toBeUndefined();
		expect(await fs.readFile(path.join(workspace, "example.txt"), "utf8")).toBe("after\n");
		const created = await probe.request("session.new", { cwd: workspace });
		expect(created.error).toBeUndefined();
		expect(created.result!.session.cwd).toBe(workspace);
		const renamed = await probe.request("session.rename", {
			path: created.result!.session.path,
			title: "Workbench regression",
		});
		expect(renamed.result?.session.title).toBe("Workbench regression");
		const listed = await probe.request("session.list", { cwd: workspace });
		expect(listed.result?.sessions.some(session => session.path === created.result!.session.path)).toBe(true);

		host.child.stdin.end();
		expect(await deadline(host.child.exited, "EOF shutdown", 15_000)).toBe(0);
		await deadline(probe.closed, "WebSocket teardown", 5_000);
		expect(await host.remainingStdout).toBe("");
		expect((await host.stderr).includes(ready.token)).toBe(false);
		expect(await fs.readFile(created.result!.session.path, "utf8")).toContain("Workbench regression");
		await expect(fetch(`${ready.url}/ws`)).rejects.toThrow();
	}, 120_000);

	it("uses the real persisted catalog at zero tabs and recovers it after service restart", async () => {
		const root = await fixture();
		const workspace = path.join(root, "workspace");
		const host = await start(root);
		const probe = new Probe(host.ready);
		await deadline(probe.opened, "WebSocket open");
		await deadline(probe.welcome, "session welcome");
		const opened = await probe.request("workspace.open", { rootPath: workspace });
		const workspaceId = opened.result!.workspace.id;
		const created = await probe.request("session.new", { cwd: workspace });
		expect(created.error).toBeUndefined();
		const storedPath = created.result!.session.path;
		const tabs = await probe.request("session.tabs", {});
		for (const tab of tabs.result!.tabs) {
			expect((await probe.request("session.tab.close", { path: tab.path })).result?.closed).toBe(true);
		}
		expect((await probe.request("session.tabs", {})).result?.tabs).toEqual([]);
		const listed = await probe.request("session.list", { cwd: workspace });
		expect(listed.error).toBeUndefined();
		expect(listed.result?.sessions.some(session => session.path === storedPath)).toBe(true);
		expect(
			(await probe.request("session.rename", { path: storedPath, title: "Zero-tab recovery" })).result?.session
				.title,
		).toBe("Zero-tab recovery");
		expect((await probe.request("session.pin", { path: storedPath, pinned: true })).result?.session.pinned).toBe(
			true,
		);
		expect((await probe.request("graph.snapshot", { workspaceId, kind: "agent" })).error).toBeUndefined();
		expect((await probe.request("session.tabs", {})).result?.tabs).toEqual([]);
		const selected = await probe.request("session.select", { path: storedPath });
		expect(selected.error).toBeUndefined();
		expect(selected.result?.header.title).toBe("Zero-tab recovery");
		expect((await probe.request("session.tab.close", { path: storedPath })).result).toMatchObject({
			closed: true,
			tabs: [],
		});
		const fresh = await probe.request("session.new", { cwd: workspace });
		expect(fresh.error).toBeUndefined();
		expect(fresh.result!.session.path).not.toBe(storedPath);
		expect((await probe.request("session.delete", { path: fresh.result!.session.path })).result?.deleted).toBe(true);
		expect((await probe.request("session.tabs", {})).result?.tabs).toEqual([]);
		expect((await probe.request("session.list", { cwd: workspace })).result?.sessions).toContainEqual(
			expect.objectContaining({ path: storedPath, title: "Zero-tab recovery", pinned: true }),
		);
		host.child.stdin.end();
		expect(await deadline(host.child.exited, "EOF shutdown", 15_000)).toBe(0);
		await deadline(probe.closed, "WebSocket teardown", 5_000);
		expect(await host.remainingStdout).toBe("");
		expect((await host.stderr).includes(host.ready.token)).toBe(false);

		const restarted = await start(root);
		const recovered = new Probe(restarted.ready);
		await deadline(recovered.opened, "restarted WebSocket open");
		await deadline(recovered.welcome, "restarted session welcome");
		const restartedTabs = await recovered.request("session.tabs", {});
		for (const tab of restartedTabs.result!.tabs) {
			expect((await recovered.request("session.tab.close", { path: tab.path })).result?.closed).toBe(true);
		}
		expect((await recovered.request("session.tabs", {})).result?.tabs).toEqual([]);
		expect((await recovered.request("session.list", { cwd: workspace })).result?.sessions).toContainEqual(
			expect.objectContaining({ path: storedPath, title: "Zero-tab recovery", pinned: true }),
		);
		expect((await recovered.request("session.activate", { path: storedPath })).result?.tabs).toContainEqual(
			expect.objectContaining({ path: storedPath, active: true, title: "Zero-tab recovery" }),
		);
		restarted.child.stdin.end();
		expect(await deadline(restarted.child.exited, "restarted EOF shutdown", 15_000)).toBe(0);
		await deadline(recovered.closed, "restarted WebSocket teardown", 5_000);
		expect(await restarted.remainingStdout).toBe("");
		expect((await restarted.stderr).includes(restarted.ready.token)).toBe(false);
	}, 120_000);

	it("keeps aliases of a persisted session in one live tab and reopens them after close", async () => {
		const root = await fixture();
		const host = await start(root);
		const probe = new Probe(host.ready);
		await deadline(probe.opened, "WebSocket open");
		await deadline(probe.welcome, "session welcome");
		const created = await probe.request("session.new", { cwd: path.join(root, "workspace") });
		expect(created.error).toBeUndefined();
		const session = created.result!.session;
		let alias: string;
		if (process.platform === "win32") {
			// Code-OSS URIs and Bun's catalog can use different drive-letter case.
			const drive = session.path[0];
			alias = (drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase()) + session.path.slice(1);
		} else {
			const directory = path.join(root, "session-alias");
			await fs.symlink(path.dirname(session.path), directory);
			alias = path.join(directory, path.basename(session.path));
		}
		const before = (await probe.request("session.tabs", {})).result!.tabs;
		expect((await probe.request("session.tab.draft", { path: alias, dirty: true })).error).toBeUndefined();
		expect((await probe.request("session.tab.close", { path: session.path })).result).toMatchObject({
			closed: false,
			blockedReason: "dirty-draft",
		});
		const activated = await probe.request("session.activate", { path: alias });
		expect(activated.error).toBeUndefined();
		expect(activated.result!.tabs.map(tab => tab.path)).toEqual(before.map(tab => tab.path));
		expect(activated.result!.tabs.find(tab => tab.path === session.path)).toMatchObject({
			active: true,
			draftDirty: true,
		});
		await probe.request("session.tab.draft", { path: alias, dirty: false });
		expect((await probe.request("session.tab.close", { path: alias })).result?.closed).toBe(true);
		const reopened = await probe.request("session.select", { path: alias });
		expect(reopened.error).toBeUndefined();
		expect(reopened.result!.header.id).toBe(session.id);
		expect((await probe.request("session.tabs", {})).result!.tabs.map(tab => tab.path)).toEqual(
			before.map(tab => tab.path),
		);
		host.child.stdin.end();
		expect(await deadline(host.child.exited, "alias session EOF shutdown", 15_000)).toBe(0);
	}, 120_000);

	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		it(`closes the live service cleanly on ${signal}`, async () => {
			const host = await start(await fixture());
			const probe = new Probe(host.ready);
			await deadline(probe.opened, "WebSocket open");
			host.child.kill(signal);
			await deadline(host.child.exited, "signal shutdown", 15_000);
			await deadline(probe.closed, "WebSocket teardown", 5_000);
			expect(await host.remainingStdout).toBe("");
			expect((await host.stderr).includes(host.ready.token)).toBe(false);
			await expect(fetch(`${host.ready.url}/ws`)).rejects.toThrow();
		}, 120_000);
	}

	it("rejects malformed arguments and non-directory workspaces before service startup", async () => {
		const root = await fixture();
		for (const args of [
			[],
			["--workspace", "relative"],
			["--workspace"],
			["--unknown"],
			["--version", "extra"],
			["--build-info", "extra"],
			["--workspace", path.join(root, "workspace", "example.txt")],
			["--workspace", path.join(root, "missing")],
		]) {
			const child = spawnService(root, args);
			const stdout = new Response(child.stdout).text();
			const stderr = new Response(child.stderr).text();
			expect(await deadline(child.exited, "argument rejection")).toBe(1);
			expect(await stdout).toBe("");
			expect(await stderr).toContain("Chudcode service failed:");
		}
		await expect(fs.stat(path.join(root, "agent", "sessions"))).rejects.toThrow();
	}, 120_000);

	it("reports product version without launching a runtime", async () => {
		const root = await fixture();
		const child = spawnService(root, ["--version"]);
		const stdout = new Response(child.stdout).text();
		const stderr = new Response(child.stderr).text();
		expect(await deadline(child.exited, "version")).toBe(0);
		expect(await stdout).toBe(`${PRODUCT_SEMVER}\n`);
		expect(await stderr).toBe("");
		await expect(fs.stat(path.join(root, "agent", "sessions"))).rejects.toThrow();
	}, 120_000);

	it("reports binary role and product version without launching a runtime", async () => {
		const root = await fixture();
		const child = spawnService(root, ["--build-info"]);
		const stdout = new Response(child.stdout).text();
		const stderr = new Response(child.stderr).text();
		expect(await deadline(child.exited, "build info")).toBe(0);
		expect(JSON.parse(await stdout)).toEqual({ role: "chudcode-service", version: PRODUCT_SEMVER });
		expect(await stderr).toBe("");
		await expect(fs.stat(path.join(root, "agent", "sessions"))).rejects.toThrow();
	}, 120_000);
});
