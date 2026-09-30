import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import { type } from "@oh-my-pi/omptype";
import type { ToolSession } from ".";
import { probeTools } from "./analyzers/doctor";
import { GdbMiSession } from "./analyzers/gdb-mi";

const firmwareSchema = type({
	action: type.enumerated("status", "new_project", "build", "sim_run", "flash", "debug"),
	"dir?": type("string").describe("project directory, or parent directory for new_project"),
	"name?": type("string").describe("new project name"),
	"family?": type.enumerated("cortex-m", "esp32", "arduino"),
	"elf?": type("string").describe("ELF or flash image path"),
	"chip?": type("string").describe("probe-rs chip id, ESP chip id, or OpenOCD target config"),
	"machine?": type("string").describe("QEMU machine (default mps2-an385) or Renode .resc/.repl platform"),
	"expect?": type({
		uart_contains: type("string").describe("UART/semihosting substring to observe"),
		"within_ms?": type("number").describe("deadline from emulator launch"),
	})
		.array()
		.describe("timed UART assertions"),
	"timeout_s?": type("number").describe("subprocess timeout in seconds"),
	"debug_cmd?": type({
		op: type.enumerated("start", "halt", "continue", "step", "break", "read_mem", "stop"),
		"location?": type("string").describe("breakpoint symbol, file:line, or address"),
		"addr?": type("string").describe("memory address"),
		"len?": type("number").describe("memory byte count"),
	}).describe("persistent OpenOCD/GDB-MI operation"),
});

export type FirmwareParams = typeof firmwareSchema.infer;
type FirmwareFamily = "cortex-m" | "esp32" | "arduino";

type JsonObject = Record<string, unknown>;

interface FirmwareToolDetails {
	action: FirmwareParams["action"];
	result: JsonObject;
}

interface ProcessResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

interface DebugSession {
	openocd: Bun.Subprocess<"ignore", "pipe", "pipe">;
	gdb: GdbMiSession;
	port: number;
	elf: string;
	chip: string;
	stdout: { text: string };
	stderr: { text: string };
	pumps: Promise<void>[];
}

const OUTPUT_CAP = 64 * 1024;
const EXCERPT_CAP = 32 * 1024;
const OBSERVATION_WINDOW = 8 * 1024;
const MAX_DIAGNOSTICS = 100;
const MAX_ARTIFACTS_PER_KIND = 50;
const DEFAULT_BUILD_TIMEOUT_S = 300;
const DEFAULT_ACTION_TIMEOUT_S = 30;
const TEMPLATE_ROOT = path.join(import.meta.dir, "analyzers", "assets", "firmware-templates", "cortex-m");
const CORTEX_TEMPLATE_FILES = [
	"CMakeLists.txt",
	"cmake/arm-none-eabi-toolchain.cmake",
	"linker.ld",
	"src/main.c",
	"src/startup.c",
] as const;

const TOOL_HINTS: Record<string, string> = {
	cmake: "Install CMake (`sudo dnf install cmake` or `sudo apt install cmake`).",
	ninja: "Install Ninja (`sudo dnf install ninja-build` or `sudo apt install ninja-build`).",
	"arm-none-eabi-gcc":
		"Install the ARM cross-toolchain (`sudo dnf install arm-none-eabi-gcc-cs arm-none-eabi-newlib` or `sudo apt install gcc-arm-none-eabi`).",
	"arm-none-eabi-gdb": "Install ARM GDB (`sudo dnf install arm-none-eabi-gdb` or `sudo apt install gdb-multiarch`).",
	"idf.py": "Install ESP-IDF and source its export.sh so idf.py is on PATH.",
	"arduino-cli": "Install arduino-cli from https://arduino.github.io/arduino-cli/ and put it on PATH.",
	"qemu-system-arm": "Install QEMU ARM (`sudo dnf install qemu-system-arm` or `sudo apt install qemu-system-arm`).",
	renode: "Install Renode from https://renode.io/#downloads and put renode on PATH.",
	"probe-rs": "Install probe-rs with `cargo install probe-rs-tools`.",
	esptool: "Install esptool with `pip install esptool`.",
	openocd: "Install OpenOCD (`sudo dnf install openocd` or `sudo apt install openocd`).",
};

function toolHint(name: string): string {
	return TOOL_HINTS[name] ?? `Install ${name} and put it on PATH.`;
}

function jsonResult(action: FirmwareParams["action"], result: JsonObject): AgentToolResult<FirmwareToolDetails> {
	return {
		content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
		details: { action, result },
	};
}

function failure(reason: string, hint: string, extra: JsonObject = {}): JsonObject {
	return { ok: false, reason, hint, ...extra };
}

function boundedAppend(current: string, chunk: string, limit = OUTPUT_CAP): string {
	if (current.length >= limit) return current;
	const remaining = limit - current.length;
	if (chunk.length <= remaining) return current + chunk;
	return `${current}${chunk.slice(0, Math.max(0, remaining - 18))}\n…[truncated]`;
}

function excerpt(text: string): string {
	return text.length <= EXCERPT_CAP ? text : `${text.slice(0, EXCERPT_CAP - 18)}\n…[truncated]`;
}

function timeoutSeconds(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value <= 0) return fallback;
	return Math.min(value, 3600);
}

async function stopProcess(proc: Bun.Subprocess): Promise<void> {
	if (proc.exitCode !== null) return;
	try {
		proc.kill("SIGTERM");
	} catch {}
	await Promise.race([proc.exited.then(() => undefined), Bun.sleep(400)]);
	if (proc.exitCode === null) {
		try {
			proc.kill("SIGKILL");
		} catch {}
		await proc.exited.catch(() => undefined);
	}
}

async function readPipe(stream: ReadableStream<Uint8Array>, onChunk: (text: string) => void): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) onChunk(decoder.decode(value, { stream: true }));
		}
		onChunk(decoder.decode());
	} finally {
		reader.releaseLock();
	}
}

async function runProcess(options: {
	command: string[];
	cwd: string;
	timeoutMs: number;
	signal?: AbortSignal;
	onOutput?: (combined: string, elapsedMs: number) => void;
}): Promise<ProcessResult> {
	options.signal?.throwIfAborted();
	const started = performance.now();
	let stdout = "";
	let stderr = "";
	let observed = "";
	let timedOut = false;
	let stopping: Promise<void> | undefined;
	const proc = Bun.spawn(options.command, {
		cwd: options.cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const observeChunk = (chunk: string) => {
		const window = `${observed}${chunk}`;
		options.onOutput?.(window, performance.now() - started);
		observed = window.slice(-OBSERVATION_WINDOW);
	};
	const pumps = [
		readPipe(proc.stdout, chunk => {
			stdout = boundedAppend(stdout, chunk);
			observeChunk(chunk);
		}),
		readPipe(proc.stderr, chunk => {
			stderr = boundedAppend(stderr, chunk);
			observeChunk(chunk);
		}),
	];
	const terminate = () => {
		stopping ??= stopProcess(proc);
	};
	const timer = setTimeout(() => {
		timedOut = true;
		terminate();
	}, options.timeoutMs);
	const onAbort = () => terminate();
	options.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const exitCode = await proc.exited;
		await Promise.allSettled(pumps);
		if (stopping) await stopping;
		options.signal?.throwIfAborted();
		return { exitCode, stdout, stderr, timedOut };
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
		if (proc.exitCode === null) await stopProcess(proc);
	}
}

async function fileExists(file: string): Promise<boolean> {
	try {
		return (await fs.stat(file)).isFile();
	} catch {
		return false;
	}
}

function resolveInput(value: string | undefined, cwd: string, fallback = "."): string {
	return path.resolve(cwd, value ?? fallback);
}

function parseDiagnostics(text: string): JsonObject[] {
	const diagnostics: JsonObject[] = [];
	const pattern = /^(.+?):(\d+):(\d+):\s+(fatal error|error|warning):\s+(.+)$/;
	for (const line of text.split(/\r?\n/)) {
		const match = pattern.exec(line);
		if (!match) continue;
		diagnostics.push({
			file: match[1],
			line: Number(match[2]),
			col: Number(match[3]),
			severity: match[4] === "warning" ? "warning" : "error",
			message: match[5],
		});
		if (diagnostics.length >= MAX_DIAGNOSTICS) break;
	}
	return diagnostics;
}

async function collectArtifacts(root: string): Promise<{ elf: string[]; map: string[] }> {
	const collect = async (pattern: string): Promise<string[]> => {
		const files: string[] = [];
		for await (const file of new Bun.Glob(pattern).scan({ cwd: root, absolute: true, onlyFiles: true, dot: true })) {
			files.push(file);
			if (files.length >= MAX_ARTIFACTS_PER_KIND) break;
		}
		return files.sort();
	};
	const [elf, maps] = await Promise.all([collect("**/*.elf"), collect("**/*.map")]);
	return { elf, map: maps };
}

async function detectFamily(root: string): Promise<FirmwareFamily | null> {
	const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
	if (
		(await fileExists(path.join(root, "sdkconfig"))) ||
		(await fileExists(path.join(root, "main", "CMakeLists.txt"))) ||
		entries.some(entry => entry.name === "idf_component.yml")
	) {
		return "esp32";
	}
	if (entries.some(entry => entry.isFile() && entry.name.endsWith(".ino"))) return "arduino";
	if (
		(await fileExists(path.join(root, "CMakeLists.txt"))) &&
		(await fileExists(path.join(root, "cmake", "arm-none-eabi-toolchain.cmake")))
	) {
		return "cortex-m";
	}
	return null;
}

async function findFreePort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const server = net.createServer();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		if (!address || typeof address === "string") {
			server.close();
			reject(new Error("could not allocate a GDB server port"));
			return;
		}
		const port = address.port;
		server.close(error => (error ? reject(error) : resolve(port)));
	});
	return promise;
}

async function portIsOpen(port: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = net.createConnection({ host: "127.0.0.1", port });
	let settled = false;
	const done = (open: boolean) => {
		if (settled) return;
		settled = true;
		socket.destroy();
		resolve(open);
	};
	socket.setTimeout(150);
	socket.once("connect", () => done(true));
	socket.once("timeout", () => done(false));
	socket.once("error", () => done(false));
	return promise;
}

async function waitForPort(
	port: number,
	proc: Bun.Subprocess,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && proc.exitCode === null) {
		signal?.throwIfAborted();
		if (await portIsOpen(port)) return true;
		await Bun.sleep(100);
	}
	return false;
}

function openocdConfig(chip: string): string {
	if (chip.includes("/") || chip.endsWith(".cfg")) return chip;
	return `target/${chip}.cfg`;
}

export class FirmwareTool implements AgentTool<typeof firmwareSchema, FirmwareToolDetails> {
	readonly name = "firmware";
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const action = (args as Partial<FirmwareParams>).action;
		if (action === "status") return "read";
		if (action === "flash") {
			return {
				tier: "exec",
				policy: "prompt",
				override: true,
				reason: "Flashing writes firmware to attached physical hardware.",
			};
		}
		return "exec";
	};
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<FirmwareParams>;
		const lines = [`Action: ${params.action ?? "(missing)"}`];
		if (params.elf) lines.push(`Image: ${params.elf}`);
		if (params.chip) lines.push(`Chip/config: ${params.chip}`);
		return lines;
	};
	readonly label = "Firmware";
	readonly summary = "Create, build, emulate, flash, and debug embedded firmware";
	readonly description =
		"Generalized firmware orchestration for Cortex-M, ESP32, and Arduino projects. Use status first. Missing PATH tools return structured failures. sim_run evaluates timed UART output. debug keeps OpenOCD and GDB/MI alive across calls; stop it when finished. flash mutates physical hardware and always requires explicit approval.";
	readonly parameters = firmwareSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly concurrency = "exclusive";

	private debugSession: DebugSession | null = null;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: FirmwareParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<FirmwareToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<FirmwareToolDetails>> {
		try {
			let result: JsonObject;
			switch (params.action) {
				case "status":
					result = await this.status(signal);
					break;
				case "new_project":
					result = await this.newProject(params, signal);
					break;
				case "build":
					result = await this.build(params, signal);
					break;
				case "sim_run":
					result = await this.simRun(params, signal);
					break;
				case "flash":
					result = await this.flash(params, signal);
					break;
				case "debug":
					result = await this.debug(params, signal);
					break;
			}
			return jsonResult(params.action, result);
		} catch (error) {
			if (signal?.aborted) throw error;
			return jsonResult(
				params.action,
				failure("firmware_error", error instanceof Error ? error.message : String(error)),
			);
		}
	}

	private async status(signal?: AbortSignal): Promise<JsonObject> {
		const versionRegex = /\d+\.\d+(?:\.\d+)?(?:[-+~][\w.]+)?/;
		const probes = await probeTools(
			[
				{ name: "cmake", versionArgs: ["--version"], versionRegex },
				{ name: "ninja", versionArgs: ["--version"], versionRegex },
				{ name: "arm-none-eabi-gcc", versionArgs: ["--version"], versionRegex },
				{ name: "arm-none-eabi-gdb", versionArgs: ["--version"], versionRegex },
				{ name: "idf.py", versionArgs: ["--version"], versionRegex },
				{ name: "arduino-cli", versionArgs: ["version"], versionRegex },
				{ name: "qemu-system-arm", versionArgs: ["--version"], versionRegex },
				{ name: "renode", versionArgs: ["--version"], versionRegex },
				{ name: "probe-rs", versionArgs: ["--version"], versionRegex },
				{
					name: "esptool",
					command: Bun.which("esptool") ? "esptool" : "esptool.py",
					versionArgs: ["version"],
					versionRegex,
				},
				{ name: "openocd", versionArgs: ["--version"], versionRegex },
			],
			{ cwd: this.session.cwd, signal },
		);
		const found: Record<string, boolean> = {};
		for (const probe of probes) found[probe.name] = probe.found;
		const families = {
			"cortex-m": {
				can_build: Boolean(found.cmake && found["arm-none-eabi-gcc"]),
				can_emulate: Boolean(found["qemu-system-arm"] || found.renode),
				can_flash: Boolean(found["probe-rs"] || found.openocd),
				can_debug: Boolean(found.openocd && found["arm-none-eabi-gdb"]),
			},
			esp32: {
				can_build: Boolean(found["idf.py"]),
				can_emulate: false,
				can_flash: Boolean(found.esptool),
				can_debug: false,
			},
			arduino: {
				can_build: Boolean(found["arduino-cli"]),
				can_emulate: false,
				can_flash: false,
				can_debug: false,
			},
		};
		const tools = probes.map(probe => ({ ...probe, hint: toolHint(probe.name) }));
		const hints = tools.filter(tool => !tool.found).map(tool => tool.hint);
		return { ok: true, tools, families, hints };
	}

	private async newProject(params: FirmwareParams, signal?: AbortSignal): Promise<JsonObject> {
		const name = params.name;
		if (!name || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) {
			return failure("invalid_name", "name must be 1-64 ASCII letters, digits, underscores, or hyphens");
		}
		const family = params.family ?? "cortex-m";
		const parent = resolveInput(params.dir, this.session.cwd);
		const target = path.join(parent, name);
		if (
			await fs.stat(target).then(
				() => true,
				() => false,
			)
		) {
			return failure("project_exists", `Refusing to overwrite existing project path ${target}`);
		}
		await fs.mkdir(parent, { recursive: true });
		if (family === "cortex-m") {
			const staging = await fs.mkdtemp(path.join(parent, `.${name}.part-`));
			try {
				for (const relative of CORTEX_TEMPLATE_FILES) {
					const destination = path.join(staging, relative);
					await fs.mkdir(path.dirname(destination), { recursive: true });
					await fs.copyFile(path.join(TEMPLATE_ROOT, relative), destination);
				}
				const cmakePath = path.join(staging, "CMakeLists.txt");
				const cmake = await fs.readFile(cmakePath, "utf8");
				await fs.writeFile(cmakePath, cmake.replace("project(firmware C ASM)", `project(${name} C ASM)`));
				const sources = ["src/main.c", "src/startup.c"].map(file => path.join(target, file));
				const compileCommands = sources.map(file => ({
					directory: target,
					command: `arm-none-eabi-gcc -mcpu=cortex-m3 -mthumb -ffunction-sections -fdata-sections -Wall -Wextra -Og -g -c ${JSON.stringify(file)}`,
					file,
				}));
				await fs.writeFile(
					path.join(staging, "compile_commands.json"),
					`${JSON.stringify(compileCommands, null, 2)}\n`,
				);
				await fs.rename(staging, target);
			} catch (error) {
				await fs.rm(staging, { recursive: true, force: true });
				throw error;
			}
			return {
				ok: true,
				family,
				dir: target,
				files: [...CORTEX_TEMPLATE_FILES, "compile_commands.json"],
			};
		}
		if (family === "esp32") {
			if (!Bun.which("idf.py")) return failure("tool_missing", toolHint("idf.py"), { tool: "idf.py" });
			const run = await runProcess({
				command: ["idf.py", "create-project", name],
				cwd: parent,
				timeoutMs: timeoutSeconds(params.timeout_s, DEFAULT_ACTION_TIMEOUT_S) * 1000,
				signal,
			});
			if (run.timedOut) return failure("timeout", "idf.py create-project timed out and was terminated");
			if (run.exitCode !== 0) return failure("project_creation_failed", excerpt(`${run.stdout}${run.stderr}`));
			return { ok: true, family, dir: target, output_excerpt: excerpt(`${run.stdout}${run.stderr}`) };
		}
		if (!Bun.which("arduino-cli")) {
			return failure("tool_missing", toolHint("arduino-cli"), { tool: "arduino-cli" });
		}
		const run = await runProcess({
			command: ["arduino-cli", "sketch", "new", target],
			cwd: parent,
			timeoutMs: timeoutSeconds(params.timeout_s, DEFAULT_ACTION_TIMEOUT_S) * 1000,
			signal,
		});
		if (run.timedOut) return failure("timeout", "arduino-cli sketch new timed out and was terminated");
		if (run.exitCode !== 0) return failure("project_creation_failed", excerpt(`${run.stdout}${run.stderr}`));
		return { ok: true, family, dir: target, output_excerpt: excerpt(`${run.stdout}${run.stderr}`) };
	}

	private async build(params: FirmwareParams, signal?: AbortSignal): Promise<JsonObject> {
		const root = resolveInput(params.dir, this.session.cwd);
		const rootStat = await fs.stat(root).catch(() => null);
		if (!rootStat?.isDirectory()) return failure("project_missing", `Project directory does not exist: ${root}`);
		const family = await detectFamily(root);
		if (!family) {
			return failure(
				"unknown_project",
				"Expected an ESP-IDF project, an Arduino .ino sketch, or a Cortex-M CMakeLists.txt",
			);
		}
		const timeoutMs = timeoutSeconds(params.timeout_s, DEFAULT_BUILD_TIMEOUT_S) * 1000;
		let combined = "";
		let finalRun: ProcessResult;
		let commands: string[][];
		if (family === "cortex-m") {
			if (!Bun.which("cmake")) return failure("tool_missing", toolHint("cmake"), { tool: "cmake" });
			if (!Bun.which("arm-none-eabi-gcc")) {
				return failure("tool_missing", toolHint("arm-none-eabi-gcc"), { tool: "arm-none-eabi-gcc" });
			}
			const buildDir = path.join(root, "build");
			const configure = [
				"cmake",
				"-S",
				root,
				"-B",
				buildDir,
				"-DCMAKE_EXPORT_COMPILE_COMMANDS=ON",
				`-DCMAKE_TOOLCHAIN_FILE=${path.join(root, "cmake", "arm-none-eabi-toolchain.cmake")}`,
			];
			if (Bun.which("ninja")) configure.push("-G", "Ninja");
			commands = [configure, ["cmake", "--build", buildDir]];
			const configured = await runProcess({ command: configure, cwd: root, timeoutMs, signal });
			combined = boundedAppend(combined, `${configured.stdout}${configured.stderr}`);
			if (configured.timedOut) return failure("timeout", "CMake configure timed out and was terminated");
			if (configured.exitCode !== 0) {
				return failure("configure_failed", excerpt(combined), {
					family,
					command: configure,
					diagnostics: parseDiagnostics(combined),
				});
			}
			finalRun = await runProcess({ command: commands[1]!, cwd: root, timeoutMs, signal });
		} else if (family === "esp32") {
			if (!Bun.which("idf.py")) return failure("tool_missing", toolHint("idf.py"), { tool: "idf.py" });
			commands = [["idf.py", "-C", root, "build"]];
			finalRun = await runProcess({ command: commands[0]!, cwd: root, timeoutMs, signal });
		} else {
			if (!Bun.which("arduino-cli")) {
				return failure("tool_missing", toolHint("arduino-cli"), { tool: "arduino-cli" });
			}
			if (!params.chip) {
				return failure(
					"chip_required",
					"Arduino builds require chip to be an arduino-cli FQBN (for example arduino:avr:uno)",
				);
			}
			const buildDir = path.join(root, "build");
			commands = [["arduino-cli", "compile", "--fqbn", params.chip, "--output-dir", buildDir, root]];
			finalRun = await runProcess({ command: commands[0]!, cwd: root, timeoutMs, signal });
		}
		combined = boundedAppend(combined, `${finalRun.stdout}${finalRun.stderr}`);
		if (finalRun.timedOut) return failure("timeout", `${commands.at(-1)?.[0]} build timed out and was terminated`);
		const artifacts = await collectArtifacts(root);
		const diagnostics = parseDiagnostics(combined);
		if (finalRun.exitCode !== 0) {
			return failure("build_failed", excerpt(combined), {
				family,
				exit_code: finalRun.exitCode,
				commands,
				diagnostics,
				artifacts,
			});
		}
		return {
			ok: true,
			family,
			exit_code: finalRun.exitCode,
			commands,
			diagnostics,
			artifacts,
			output_excerpt: excerpt(combined),
		};
	}

	private async simRun(params: FirmwareParams, signal?: AbortSignal): Promise<JsonObject> {
		if (!params.elf) return failure("elf_required", "sim_run requires elf");
		const elf = resolveInput(params.elf, this.session.cwd);
		if (!(await fileExists(elf))) return failure("elf_missing", `Firmware image does not exist: ${elf}`);
		const machine = params.machine ?? "mps2-an385";
		const timeoutMs = timeoutSeconds(params.timeout_s, DEFAULT_ACTION_TIMEOUT_S) * 1000;
		const expectations = (params.expect ?? []).slice(0, 100).map(item => ({
			expect: item.uart_contains,
			within_ms: item.within_ms,
			pass: false,
			at_ms: null as number | null,
		}));
		for (const item of expectations) {
			if (!item.expect) return failure("invalid_expectation", "uart_contains must not be empty");
			if (item.expect.length > OBSERVATION_WINDOW / 2) {
				return failure("invalid_expectation", `uart_contains is limited to ${OBSERVATION_WINDOW / 2} characters`);
			}
			if (item.within_ms !== undefined && (!Number.isFinite(item.within_ms) || item.within_ms < 0)) {
				return failure("invalid_expectation", "within_ms must be a finite non-negative number");
			}
		}
		let command: string[];
		let backend: "qemu" | "renode";
		let temporaryScript: string | null = null;
		if (machine.startsWith("renode:") || machine.endsWith(".resc") || machine.endsWith(".repl")) {
			if (!Bun.which("renode")) return failure("emulator_missing", toolHint("renode"), { tool: "renode" });
			backend = "renode";
			const explicitResource = machine.startsWith("renode:");
			const spec = explicitResource ? machine.slice("renode:".length) : machine;
			if (!spec)
				return failure("platform_required", "renode: must be followed by a .resc/.repl path or resource name");
			const localSpec = resolveInput(spec, this.session.cwd);
			const localExists = await fileExists(localSpec);
			if (!localExists && !explicitResource) {
				return failure("platform_missing", `Renode script/platform does not exist: ${localSpec}`);
			}
			let script = localExists ? localSpec : spec;
			if (!script.endsWith(".resc") || !localExists || explicitResource) {
				temporaryScript = path.join(
					await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "chudcode-renode-")),
					"run.resc",
				);
				const runSeconds = Math.max(0.1, timeoutMs / 1000 - 0.25);
				const resource = localExists ? localSpec : spec;
				const platformCommand = spec.endsWith(".resc")
					? `include @${JSON.stringify(resource)}`
					: `mach create\nmachine LoadPlatformDescription @${JSON.stringify(resource)}`;
				await fs.writeFile(
					temporaryScript,
					`${platformCommand}\nsysbus LoadELF @${JSON.stringify(elf)}\nstart\nsleep ${runSeconds}\nquit\n`,
				);
				script = temporaryScript;
			}
			command = ["renode", "--disable-xwt", "--console", script];
		} else {
			if (!Bun.which("qemu-system-arm")) {
				return failure("emulator_missing", toolHint("qemu-system-arm"), { tool: "qemu-system-arm" });
			}
			backend = "qemu";
			command = [
				"qemu-system-arm",
				"-M",
				machine,
				"-semihosting",
				"-semihosting-config",
				"enable=on,target=native",
				"-nographic",
				"-no-reboot",
				"-kernel",
				elf,
			];
		}
		try {
			const run = await runProcess({
				command,
				cwd: path.dirname(elf),
				timeoutMs,
				signal,
				onOutput: (output, elapsedMs) => {
					for (const item of expectations) {
						if (item.at_ms === null && output.includes(item.expect)) item.at_ms = Math.round(elapsedMs);
					}
				},
			});
			for (const item of expectations) {
				item.pass = item.at_ms !== null && (item.within_ms === undefined || item.at_ms <= item.within_ms);
			}
			const output = `${run.stdout}${run.stderr}`;
			if (!run.timedOut && run.exitCode !== 0) {
				return failure("emulator_failed", excerpt(output), {
					backend,
					exit_code: run.exitCode,
					expectations,
				});
			}
			return {
				ok: true,
				backend,
				command,
				exit_code: run.exitCode,
				timed_out: run.timedOut,
				passed: expectations.every(item => item.pass),
				expectations,
				output_excerpt: excerpt(output),
			};
		} finally {
			if (temporaryScript) await fs.rm(path.dirname(temporaryScript), { recursive: true, force: true });
		}
	}

	private async flash(params: FirmwareParams, signal?: AbortSignal): Promise<JsonObject> {
		if (!params.elf) return failure("image_required", "flash requires elf to name the firmware image");
		if (!params.chip) return failure("chip_required", "flash requires chip (or an OpenOCD .cfg target)");
		const image = resolveInput(params.elf, this.session.cwd);
		if (!(await fileExists(image))) return failure("image_missing", `Firmware image does not exist: ${image}`);
		if (params.family === "arduino") {
			return failure(
				"flash_unsupported",
				"Arduino flashing needs a serial port/programmer parameter; this tool does not guess a physical target. Use arduino-cli upload explicitly.",
			);
		}
		const timeoutMs = timeoutSeconds(params.timeout_s, DEFAULT_BUILD_TIMEOUT_S) * 1000;
		let backend: "probe-rs" | "esptool" | "openocd";
		let command: string[];
		if (params.family !== "esp32" && Bun.which("probe-rs")) {
			backend = "probe-rs";
			command = ["probe-rs", "download", "--chip", params.chip, image];
		} else {
			const esptool = Bun.which("esptool") ? "esptool" : Bun.which("esptool.py") ? "esptool.py" : null;
			if ((params.family === "esp32" || /esp32/i.test(params.chip)) && esptool) {
				backend = "esptool";
				command = [esptool, "--chip", params.chip, "write_flash", "0x0", image];
			} else if (Bun.which("openocd")) {
				backend = "openocd";
				command = [
					"openocd",
					"-f",
					openocdConfig(params.chip),
					"-c",
					`program {${image.replace(/[{}\\]/g, "\\$&")}} verify reset exit`,
				];
			} else {
				return failure(
					"flasher_missing",
					params.family === "esp32"
						? toolHint("esptool")
						: `${toolHint("probe-rs")} OpenOCD is also supported as a fallback.`,
				);
			}
		}
		const run = await runProcess({ command, cwd: path.dirname(image), timeoutMs, signal });
		const output = `${run.stdout}${run.stderr}`;
		if (run.timedOut) return failure("timeout", `${backend} timed out and was terminated`, { backend });
		if (run.exitCode !== 0) {
			return failure("flash_failed", excerpt(output), { backend, exit_code: run.exitCode, command });
		}
		return { ok: true, backend, exit_code: run.exitCode, command, output_excerpt: excerpt(output) };
	}

	private async debug(params: FirmwareParams, signal?: AbortSignal): Promise<JsonObject> {
		const command = params.debug_cmd;
		if (!command) return failure("debug_command_required", "debug requires debug_cmd");
		if (command.op === "start") return this.startDebug(params, signal);
		if (command.op === "stop") return this.stopDebug();
		const active = this.debugSession;
		if (!active) return failure("no_debug_session", "Start a debug session first with debug_cmd.op=start");
		if (!active.gdb.alive || active.openocd.exitCode !== null) {
			const logs = excerpt(`${active.stdout.text}${active.stderr.text}${active.gdb.stderrExcerpt()}`);
			await this.stopDebug();
			return failure("debug_session_lost", logs || "OpenOCD or GDB exited unexpectedly; start a new session");
		}
		const timeoutMs = timeoutSeconds(params.timeout_s, DEFAULT_ACTION_TIMEOUT_S) * 1000;
		let miCommand: string;
		switch (command.op) {
			case "halt":
				miCommand = "-exec-interrupt";
				break;
			case "continue":
				miCommand = "-exec-continue";
				break;
			case "step":
				miCommand = "-exec-step-instruction";
				break;
			case "break":
				if (!command.location || /[\r\n]/.test(command.location)) {
					return failure("location_required", "break requires a single-line location");
				}
				miCommand = `-break-insert ${JSON.stringify(command.location)}`;
				break;
			case "read_mem": {
				if (!command.addr || /[\r\n\s]/.test(command.addr)) {
					return failure("address_required", "read_mem requires a single memory address");
				}
				const length = command.len ?? 16;
				if (!Number.isInteger(length) || length <= 0 || length > 65_536) {
					return failure("invalid_length", "read_mem len must be an integer from 1 to 65536");
				}
				miCommand = `-data-read-memory-bytes ${command.addr} ${length}`;
				break;
			}
			default:
				return failure("unsupported_debug_command", `Unsupported debug command ${command.op}`);
		}
		try {
			const records = await active.gdb.request(miCommand, timeoutMs);
			if (command.op === "halt" || command.op === "step") {
				records.push(await active.gdb.waitForStop(timeoutMs));
			}
			return { ok: true, op: command.op, records: records as unknown[] };
		} catch (error) {
			if (signal?.aborted) throw error;
			return failure("debug_command_failed", error instanceof Error ? error.message : String(error), {
				op: command.op,
				gdb_stderr: active.gdb.stderrExcerpt(),
			});
		}
	}

	private async startDebug(params: FirmwareParams, signal?: AbortSignal): Promise<JsonObject> {
		if (this.debugSession)
			return failure("debug_session_active", "Stop the current debug session before starting another");
		if (!params.elf) return failure("elf_required", "debug start requires elf");
		if (!params.chip) return failure("chip_required", "debug start requires chip or an OpenOCD target .cfg");
		if (!Bun.which("openocd")) return failure("tool_missing", toolHint("openocd"), { tool: "openocd" });
		if (!Bun.which("arm-none-eabi-gdb")) {
			return failure("tool_missing", toolHint("arm-none-eabi-gdb"), { tool: "arm-none-eabi-gdb" });
		}
		const elf = resolveInput(params.elf, this.session.cwd);
		if (!(await fileExists(elf))) return failure("elf_missing", `Firmware image does not exist: ${elf}`);
		const timeoutMs = timeoutSeconds(params.timeout_s, DEFAULT_ACTION_TIMEOUT_S) * 1000;
		const port = await findFreePort();
		const stdout = { text: "" };
		const stderr = { text: "" };
		const openocd = Bun.spawn(
			[
				"openocd",
				"-f",
				openocdConfig(params.chip),
				"-c",
				`tcl_port disabled; telnet_port disabled; gdb_port ${port}`,
			],
			{ cwd: path.dirname(elf), stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true },
		);
		const pumps = [
			readPipe(openocd.stdout, chunk => {
				stdout.text = boundedAppend(stdout.text, chunk, EXCERPT_CAP);
			}),
			readPipe(openocd.stderr, chunk => {
				stderr.text = boundedAppend(stderr.text, chunk, EXCERPT_CAP);
			}),
		];
		let ready = false;
		try {
			ready = await waitForPort(port, openocd, Math.min(timeoutMs, 10_000), signal);
		} catch (error) {
			await stopProcess(openocd);
			await Promise.allSettled(pumps);
			throw error;
		}
		if (!ready) {
			await stopProcess(openocd);
			await Promise.allSettled(pumps);
			return failure(
				"openocd_start_failed",
				excerpt(`${stdout.text}${stderr.text}`) || "OpenOCD did not open its GDB port",
			);
		}
		let gdb: GdbMiSession | undefined;
		try {
			gdb = await GdbMiSession.start({
				command: "arm-none-eabi-gdb",
				args: ["--quiet", "--interpreter=mi2", elf],
				cwd: path.dirname(elf),
				signal,
				timeoutMs,
			});
			await gdb.request(`-target-select remote 127.0.0.1:${port}`, timeoutMs);
		} catch (error) {
			await gdb?.close().catch(() => undefined);
			await stopProcess(openocd);
			await Promise.allSettled(pumps);
			if (signal?.aborted) throw error;
			return failure("gdb_start_failed", error instanceof Error ? error.message : String(error), {
				openocd_output: excerpt(`${stdout.text}${stderr.text}`),
			});
		}
		this.debugSession = { openocd, gdb, port, elf, chip: params.chip, stdout, stderr, pumps };
		return { ok: true, op: "start", port, elf, chip: params.chip };
	}

	private async stopDebug(): Promise<JsonObject> {
		const active = this.debugSession;
		if (!active) return { ok: true, op: "stop", stopped: false };
		this.debugSession = null;
		await active.gdb.close().catch(() => undefined);
		await stopProcess(active.openocd);
		await Promise.allSettled(active.pumps);
		return {
			ok: true,
			op: "stop",
			stopped: true,
			openocd_output: excerpt(`${active.stdout.text}${active.stderr.text}`),
			gdb_stderr: active.gdb.stderrExcerpt(),
		};
	}
}
