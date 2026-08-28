import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { encodeTerminalDataBase64, TerminalService } from "../src/services/terminal-service";
import type { TerminalServiceEvent, TerminalServiceOptions } from "../src/services/terminal-types";

const createdDirectories: string[] = [];
const services: TerminalService[] = [];

function createWorkspace(): string {
	const directory = mkdtempSync(join(tmpdir(), "chudcode-terminal-"));
	createdDirectories.push(directory);
	return directory;
}

function eventBytes(events: readonly TerminalServiceEvent[], terminalId: string): Buffer {
	return Buffer.concat(
		events
			.filter(
				(event): event is Extract<TerminalServiceEvent, { t: "terminal-data" }> =>
					event.t === "terminal-data" && event.terminalId === terminalId,
			)
			.map(event => Buffer.from(event.dataBase64, "base64")),
	);
}

function eventOutput(events: readonly TerminalServiceEvent[], terminalId: string): string {
	return eventBytes(events, terminalId).toString("utf8");
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${message}`);
		await Bun.sleep(10);
	}
}

function createService(
	cwd: string,
	events: TerminalServiceEvent[],
	overrides: Partial<TerminalServiceOptions> = {},
): TerminalService {
	const service = new TerminalService({
		resolveWorkspace: workspaceId => ({ id: workspaceId, rootPath: cwd }),
		emit: event => {
			events.push(event);
		},
		shell: "/bin/sh",
		...overrides,
	});
	services.push(service);
	return service;
}

afterEach(async () => {
	await Promise.allSettled(services.splice(0).map(service => service.dispose()));
	for (const directory of createdDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const realPty = describe.skipIf(process.platform === "win32" || typeof Bun.Terminal !== "function");

describe("encodeTerminalDataBase64", () => {
	it("encodes the exact view and preserves a UTF-8 sequence split across chunks", () => {
		const backing = Uint8Array.from([0xff, 0xe2, 0x82, 0xac, 0xfe]);
		const chunks = [backing.subarray(1, 2), backing.subarray(2, 4)];
		const decoded = Buffer.concat(chunks.map(chunk => Buffer.from(encodeTerminalDataBase64(chunk), "base64")));

		expect([...decoded]).toEqual([0xe2, 0x82, 0xac]);
		expect(decoded.toString("utf8")).toBe("€");
	});
});

realPty("TerminalService real PTY", () => {
	it("provides a TTY with an allowlisted environment, workspace cwd, interactive input, and unchanged ANSI data", async () => {
		const cwd = createWorkspace();
		const events: TerminalServiceEvent[] = [];
		const service = createService(cwd, events, {
			inheritedEnvironment: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				USER: process.env.USER,
				LOGNAME: process.env.LOGNAME,
				LANG: process.env.LANG,
				CHUDCODE_APPROVED: "approved-value",
				CHUDCODE_SECRET: "must-not-leak",
			},
			environmentAllowlist: ["PATH", "HOME", "USER", "LOGNAME", "LANG", "CHUDCODE_APPROVED"],
		});
		const { terminalId } = await service.create({ workspaceId: "workspace", cols: 80, rows: 24 });

		expect(service.write({ terminalId, data: "stty -echo\n" })).toEqual({ accepted: true });
		const script = [
			"[ -t 0 ] && [ -t 1 ] && [ -t 2 ] && printf '%s_%s\\n' TTY TRUE",
			"printf 'CWD=%s\\n' \"$PWD\"",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell parameter expansion, not a JS placeholder.
			"printf 'APPROVED=%s\\n' \"${CHUDCODE_APPROVED-unset}\"",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell parameter expansion, not a JS placeholder.
			"printf 'SECRET=%s\\n' \"${CHUDCODE_SECRET-unset}\"",
			"printf '\\033[31m%s_%s\\033[0m\\n' ANSI RED",
			"printf '%s_%s_%s\\n' READY FOR INPUT; IFS= read -r answer; printf 'READ=%s\\n' \"$answer\"",
		].join("\n");
		expect(service.write({ terminalId, data: `${script}\n` })).toEqual({ accepted: true });
		await waitFor(() => eventOutput(events, terminalId).includes("READY_FOR_INPUT"), "shell input prompt");
		expect(service.write({ terminalId, data: "interactive-value\n" })).toEqual({ accepted: true });
		await waitFor(
			() => eventOutput(events, terminalId).includes("READ=interactive-value"),
			"interactive read result",
		);

		const output = eventOutput(events, terminalId);
		expect(output).toContain("TTY_TRUE");
		expect(output).toContain(`CWD=${cwd}`);
		expect(output).toContain("APPROVED=approved-value");
		expect(output).toContain("SECRET=unset");
		expect(output).not.toContain("must-not-leak");
		expect(output).toContain("\x1b[31mANSI_RED\x1b[0m");

		service.write({ terminalId, data: "exit\n" });
		await waitFor(
			() => events.some(event => event.t === "terminal-exit" && event.terminalId === terminalId),
			"terminal exit",
		);
		const naturalExit = events.find(
			(event): event is Extract<TerminalServiceEvent, { t: "terminal-exit" }> =>
				event.t === "terminal-exit" && event.terminalId === terminalId,
		);
		expect(naturalExit?.exitCode).toBe(0);
		expect(naturalExit && "signal" in naturalExit).toBe(false);
	});

	it("emits deliberately invalid UTF-8 output as the exact PTY bytes", async () => {
		const events: TerminalServiceEvent[] = [];
		const service = createService(createWorkspace(), events);
		const { terminalId } = await service.create({ workspaceId: "workspace", cols: 80, rows: 24 });
		service.write({ terminalId, data: "stty -echo; printf '\\001'\n" });
		await waitFor(() => eventBytes(events, terminalId).includes(1), "disabled terminal echo");
		events.length = 0;

		const begin = Buffer.from("BYTE_BEGIN");
		const end = Buffer.from("BYTE_END");

		service.write({
			terminalId,
			data: "printf 'BYTE_BEGIN'; printf '\\376\\377\\200'; printf 'BYTE_END'\n",
		});
		await waitFor(() => eventBytes(events, terminalId).indexOf(end) >= 0, "non-UTF8 PTY output");

		const output = eventBytes(events, terminalId);
		const payloadStart = output.indexOf(begin) + begin.byteLength;
		const payloadEnd = output.indexOf(end, payloadStart);
		expect(payloadStart).toBeGreaterThanOrEqual(begin.byteLength);
		expect([...output.subarray(payloadStart, payloadEnd)]).toEqual([0xfe, 0xff, 0x80]);
	});

	it("makes initial and changed terminal dimensions observable to the child", async () => {
		const events: TerminalServiceEvent[] = [];
		const service = createService(createWorkspace(), events);
		const { terminalId } = await service.create({ workspaceId: "workspace", cols: 41, rows: 13 });
		service.write({ terminalId, data: "stty -echo\nstty size\n" });
		await waitFor(() => /13 41\r?\n/.test(eventOutput(events, terminalId)), "initial PTY size");

		expect(service.resize({ terminalId, cols: 73, rows: 29 })).toEqual({});
		service.write({ terminalId, data: "stty size\n" });
		await waitFor(() => /29 73\r?\n/.test(eventOutput(events, terminalId)), "resized PTY size");
	});

	it("keeps multiple interactive terminals independent", async () => {
		const events: TerminalServiceEvent[] = [];
		const service = createService(createWorkspace(), events);
		const first = await service.create({ workspaceId: "workspace", cols: 80, rows: 24 });
		const second = await service.create({ workspaceId: "workspace", cols: 100, rows: 30 });
		expect(first.terminalId).not.toBe(second.terminalId);
		service.write({ terminalId: first.terminalId, data: "stty -echo; printf '%s_%s\\n' FIRST ONLY\n" });
		service.write({ terminalId: second.terminalId, data: "stty -echo; printf '%s_%s\\n' SECOND ONLY\n" });
		await waitFor(() => eventOutput(events, first.terminalId).includes("FIRST_ONLY"), "first terminal output");
		await waitFor(() => eventOutput(events, second.terminalId).includes("SECOND_ONLY"), "second terminal output");
		expect(eventOutput(events, first.terminalId)).not.toContain("SECOND_ONLY");
		expect(eventOutput(events, second.terminalId)).not.toContain("FIRST_ONLY");
	});

	it("closes the shell and descendants in separate job-control process groups", async () => {
		const events: TerminalServiceEvent[] = [];
		const service = createService(createWorkspace(), events, { closeGraceMs: 100, closeTimeoutMs: 1_500 });
		const { terminalId } = await service.create({ workspaceId: "workspace", cols: 80, rows: 24 });
		service.write({ terminalId, data: "stty -echo\nsleep 30 & printf 'CHILD_PID=%s\\n' \"$!\"\n" });
		await waitFor(() => /CHILD_PID=(\d+)/.test(eventOutput(events, terminalId)), "background child pid");
		const match = eventOutput(events, terminalId).match(/CHILD_PID=(\d+)/);
		const childPid = Number(match?.[1]);
		const child = Process.fromPid(childPid);
		expect(child).not.toBeNull();
		expect(child?.status()).toBe(ProcessStatus.Running);

		await service.close({ terminalId });
		await waitFor(() => child?.status() === ProcessStatus.Exited, "background process-tree exit", 3_000);
		expect(service.list()).toHaveLength(0);
		await waitFor(
			() => events.some(event => event.t === "terminal-exit" && event.terminalId === terminalId),
			"closed terminal exit event",
		);
		const closedExit = events.find(
			(event): event is Extract<TerminalServiceEvent, { t: "terminal-exit" }> =>
				event.t === "terminal-exit" && event.terminalId === terminalId,
		);
		expect(closedExit?.exitCode).toBeNull();
		expect(closedExit?.signal).toMatch(/^SIG/);
	});

	it("bounds output queued behind a backpressured event sink and terminates the producer on overflow", async () => {
		const cwd = createWorkspace();
		const events: TerminalServiceEvent[] = [];
		const gate = Promise.withResolvers<void>();
		let blocked = false;
		const service = new TerminalService({
			resolveWorkspace: workspaceId => ({ id: workspaceId, rootPath: cwd }),
			shell: "/bin/sh",
			maxBufferedOutputBytes: 4_096,
			closeGraceMs: 100,
			closeTimeoutMs: 1_500,
			emit: event => {
				events.push(event);
				if (event.t === "terminal-data" && !blocked) {
					blocked = true;
					return gate.promise;
				}
			},
		});
		services.push(service);
		const { terminalId } = await service.create({ workspaceId: "workspace", cols: 80, rows: 24 });
		await waitFor(() => blocked, "initial backpressured terminal data");
		service.write({ terminalId, data: "yes 0123456789abcdef\n" });
		await waitFor(() => service.list().length === 0 || service.list()[0]?.closing === true, "overflow teardown");
		const snapshot = service.list()[0];
		if (snapshot) expect(snapshot.bufferedOutputBytes).toBeLessThanOrEqual(4_096);

		gate.resolve();
		await waitFor(
			() => events.some(event => event.t === "error" && event.code === "TERMINAL_OUTPUT_OVERFLOW"),
			"overflow event",
		);
		const deliveredBytes = events.reduce(
			(total, event) =>
				total +
				(event.t === "terminal-data" && event.terminalId === terminalId
					? Buffer.from(event.dataBase64, "base64").byteLength
					: 0),
			0,
		);
		expect(deliveredBytes).toBeLessThanOrEqual(4_096);
	});
});
