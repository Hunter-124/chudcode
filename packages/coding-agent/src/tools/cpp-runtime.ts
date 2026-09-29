import * as fs from "node:fs/promises";
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
import { parseDhatJson } from "./analyzers/dhat-json";
import { missingTool, probeTools } from "./analyzers/doctor";
import { exists, globFiles, makeTempDir, readTextBounded, removeTempDir } from "./analyzers/files";
import { GdbMiSession } from "./analyzers/gdb-mi";
import { commandFailure, runCommand } from "./analyzers/process";
import { parseSanitizerOutput, type SanitizerReport } from "./analyzers/sanitizer-parse";
import { parseValgrindXml } from "./analyzers/valgrind-xml";
import type { OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { toolResult } from "./tool-result";

const buildSchema = type({
	system: "'cmake' | 'make' | 'none'",
	dir: "string",
	"target?": "string",
});
const runSchema = type({
	cmd: "string",
	"args?": "string[]",
	"cwd?": "string",
	"env?": { "[string]": "string" },
	"timeout_s?": "number",
});
const sanitizerSchema = type.enumerated("address", "undefined", "thread", "memory");
const cppRuntimeSchema = type({
	action:
		"'doctor' | 'sanitize' | 'memcheck' | 'dhat' | 'massif' | 'callgrind' | 'heaptrack' | 'perf' | 'rr_record' | 'rr_replay'",
	"build?": buildSchema,
	"run?": runSchema,
	"sanitizers?": sanitizerSchema.array(),
	"top?": "number",
});

export type CppRuntimeParams = typeof cppRuntimeSchema.infer;

interface CppRuntimeDetails {
	action: CppRuntimeParams["action"];
	response: Record<string, unknown>;
	meta?: OutputMeta;
}

interface PreparedRun {
	[key: string]: unknown;
	ok: true;
	cwd: string;
	build_results: Array<{ command: string[]; exit_code: number; artifacts?: string[] }>;
}

interface RuntimeFailure {
	[key: string]: unknown;
	ok: false;
	reason: string;
	hint: string;
	exit_code?: number;
	stderr_excerpt?: string;
	artifacts?: string[];
}

function jsonResult(
	action: CppRuntimeParams["action"],
	response: Record<string, unknown>,
): AgentToolResult<CppRuntimeDetails> {
	return toolResult<CppRuntimeDetails>({ action, response })
		.text(JSON.stringify(response, null, 2))
		.done();
}

function invalid(reason: string, hint: string): RuntimeFailure {
	return { ok: false, reason, hint };
}

function timeoutMs(params: CppRuntimeParams): number {
	return Math.max(1, Math.min(3600, Math.trunc(params.run?.timeout_s ?? 300))) * 1000;
}

function topLimit(params: CppRuntimeParams): number {
	return Math.max(1, Math.min(200, Math.trunc(params.top ?? 20)));
}

async function symbolizeSanitizerReports(
	reports: SanitizerReport[],
	binary: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<void> {
	const addr2line = Bun.which("addr2line");
	if (!addr2line || !(await exists(binary))) return;
	const frames = reports
		.flatMap(report => report.frames)
		.filter(frame => !frame.file && frame.address)
		.slice(0, 500);
	const addresses = [...new Set(frames.map(frame => frame.address!))];
	if (addresses.length === 0) return;
	const resolved = await runCommand([addr2line, "-Cfpe", binary, ...addresses], {
		cwd,
		signal,
		timeoutMs: 30_000,
	});
	if (resolved.exitCode !== 0) return;
	const locations = new Map<string, { function?: string; file?: string; line?: number }>();
	for (const [index, line] of resolved.stdout.split(/\r?\n/).entries()) {
		const address = addresses[index];
		if (!address) break;
		const match = /^(.*?) at (.*):(\d+)(?: \(.+\))?$/.exec(line);
		if (!match) continue;
		locations.set(address, {
			...(match[1] !== "??" ? { function: match[1] } : {}),
			...(match[2] !== "??" ? { file: match[2] } : {}),
			line: Number(match[3]),
		});
	}
	for (const frame of frames) {
		const location = locations.get(frame.address!);
		if (!location) continue;
		if (location.function) frame.function = location.function;
		if (location.file) frame.file = location.file;
		if (location.line) frame.line = location.line;
	}
}

function parseMassif(output: string): Record<string, unknown> {
	const snapshots: Array<Record<string, number>> = [];
	let current: Record<string, number> | undefined;
	for (const line of output.split(/\r?\n/)) {
		const pair = /^([a-z_]+)=(\d+)$/.exec(line);
		if (!pair) continue;
		if (pair[1] === "snapshot") {
			current = { snapshot: Number(pair[2]) };
			snapshots.push(current);
		} else if (current) current[pair[1]!] = Number(pair[2]);
	}
	let peak: Record<string, number> | undefined;
	let peakBytes = -1;
	for (const snapshot of snapshots) {
		const bytes = (snapshot.mem_heap_B ?? 0) + (snapshot.mem_heap_extra_B ?? 0) + (snapshot.mem_stacks_B ?? 0);
		if (bytes > peakBytes) {
			peak = snapshot;
			peakBytes = bytes;
		}
	}
	return { snapshots: snapshots.length, peak_bytes: Math.max(0, peakBytes), peak_snapshot: peak };
}

function parseCallgrind(output: string, top: number): Array<{ events: number; function: string }> {
	const functions: Array<{ events: number; function: string }> = [];
	for (const line of output.split(/\r?\n/)) {
		const match = /^\s*([\d,]+)\s+(?:\([^)]*\)\s+)?(.+\S)\s*$/.exec(line);
		if (!match) continue;
		const events = Number(match[1]!.replaceAll(",", ""));
		if (!Number.isFinite(events)) continue;
		functions.push({ events, function: match[2]! });
		if (functions.length >= 10_000) break;
	}
	return functions.sort((left, right) => right.events - left.events).slice(0, top);
}

function parseHeaptrack(output: string, top: number): Array<Record<string, unknown>> {
	const allocators: Array<Record<string, unknown>> = [];
	for (const block of output.split(/\r?\n\s*\r?\n/)) {
		if (!/allocation functions|allocated in/i.test(block)) continue;
		const calls = /([\d,]+)\s+calls? to allocation functions/i.exec(block)?.[1];
		const bytes = /([\d.]+\s*[KMGT]?B)\s+(?:peak consumption|allocated)/i.exec(block)?.[1];
		const from = /\bfrom\s*\r?\n\s*([^\r\n]+)/i.exec(block)?.[1];
		allocators.push({
			...(calls ? { calls: Number(calls.replaceAll(",", "")) } : {}),
			...(bytes ? { bytes } : {}),
			...(from ? { function: from.trim() } : {}),
			excerpt: block.trim().slice(0, 2000),
		});
		if (allocators.length >= 1000) break;
	}
	return allocators.slice(0, top);
}

async function parsePerfSymbols(file: string, top: number): Promise<Array<{ symbol: string; samples: number }>> {
	const counts = new Map<string, number>();
	const reader = Bun.file(file).stream().getReader();
	const decoder = new TextDecoder();
	let carry = "";
	let matches = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done || matches >= 100_000) break;
			const text = carry + decoder.decode(value, { stream: true });
			const cutoff = Math.max(0, text.length - 512);
			const ready = text.slice(0, cutoff);
			carry = text.slice(cutoff);
			for (const match of ready.matchAll(/"(?:symbol|sym)"\s*:\s*"((?:\\.|[^"\\])*)"/g)) {
				let symbol = match[1]!;
				try {
					const parsed: unknown = JSON.parse(`"${symbol}"`);
					if (typeof parsed === "string") symbol = parsed;
				} catch {
					// Retain raw escaped symbol.
				}
				const previous = counts.get(symbol);
				if (previous !== undefined) counts.set(symbol, previous + 1);
				else if (counts.size < 20_000) counts.set(symbol, 1);
				matches++;
			}
		}
		carry += decoder.decode();
		for (const match of carry.matchAll(/"(?:symbol|sym)"\s*:\s*"((?:\\.|[^"\\])*)"/g)) {
			const symbol = match[1]!;
			const previous = counts.get(symbol);
			if (previous !== undefined) counts.set(symbol, previous + 1);
			else if (counts.size < 20_000) counts.set(symbol, 1);
		}
	} finally {
		reader.releaseLock();
	}
	return [...counts.entries()]
		.map(([symbol, samples]) => ({ symbol, samples }))
		.sort((left, right) => right.samples - left.samples)
		.slice(0, top);
}

export class CppRuntimeTool implements AgentTool<typeof cppRuntimeSchema, CppRuntimeDetails> {
	readonly name = "cpp_runtime";
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const action =
			args !== null && typeof args === "object" && "action" in args ? Reflect.get(args, "action") : undefined;
		return action === "doctor" ? "read" : "exec";
	};
	readonly label = "C/C++ Runtime Analysis";
	readonly summary = "Build, execute, debug, and profile native programs with bounded analyzers";
	readonly description =
		"Runs sanitizer builds, Valgrind tools, heaptrack, perf, and rr through PATH-only subprocesses. All non-doctor actions execute target code and require exec approval.";
	readonly parameters = cppRuntimeSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly concurrency = "exclusive";

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: CppRuntimeParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<CppRuntimeDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<CppRuntimeDetails>> {
		try {
			const response = await this.#execute(params, signal);
			return jsonResult(params.action, response);
		} catch (error) {
			return jsonResult(params.action, {
				ok: false,
				reason: "runtime_analyzer_error",
				hint: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async #execute(params: CppRuntimeParams, signal?: AbortSignal): Promise<Record<string, unknown>> {
		if (params.action === "doctor") {
			const tools = await probeTools(
				[
					{ name: "cmake", versionArgs: ["--version"], versionRegex: /cmake version\s+([\w.-]+)/i },
					{ name: "make", versionArgs: ["--version"], versionRegex: /GNU Make\s+([\w.-]+)/i },
					{ name: "clang", versionArgs: ["--version"], versionRegex: /clang version\s+([\w.-]+)/i },
					{ name: "valgrind", versionArgs: ["--version"], versionRegex: /valgrind-([\w.-]+)/i },
					{ name: "callgrind_annotate", versionArgs: ["--version"], versionRegex: /valgrind-([\w.-]+)/i },
					{ name: "heaptrack", versionArgs: ["--version"], versionRegex: /heaptrack\s+([\w.-]+)/i },
					{ name: "heaptrack_print", versionArgs: ["--version"], versionRegex: /heaptrack\s+([\w.-]+)/i },
					{ name: "perf", versionArgs: ["--version"], versionRegex: /perf version\s+([\w.-]+)/i },
					{ name: "rr", versionArgs: ["--version"], versionRegex: /rr version\s+([\w.-]+)/i },
					{ name: "gdb", versionArgs: ["--version"], versionRegex: /GNU gdb.*?([0-9]+(?:\.[0-9]+)+)/i },
				],
				{ cwd: this.session.cwd, signal, session: this.session },
			);
			return { ok: true, tools };
		}
		if (!params.run) return invalid("run_missing", "run.cmd is required for runtime analyzer actions.");
		switch (params.action) {
			case "sanitize":
				return this.#sanitize(params, signal);
			case "memcheck":
			case "dhat":
			case "massif":
			case "callgrind":
				return this.#valgrind(params, signal);
			case "heaptrack":
				return this.#heaptrack(params, signal);
			case "perf":
				return this.#perf(params, signal);
			case "rr_record":
				return this.#rrRecord(params, signal);
			case "rr_replay":
				return this.#rrReplay(params, signal);
		}
	}

	async #prepareBuild(
		params: CppRuntimeParams,
		sanitize: boolean,
		signal?: AbortSignal,
	): Promise<PreparedRun | RuntimeFailure> {
		const build = params.build;
		if (!build || build.system === "none") {
			return { ok: true, cwd: path.resolve(this.session.cwd, params.run?.cwd ?? "."), build_results: [] };
		}
		const buildExecutable = Bun.which(build.system);
		if (!buildExecutable) {
			return missingTool(
				build.system,
				`Install ${build.system} and ensure it is on PATH before requesting a ${build.system} build.`,
			);
		}
		const directory = path.resolve(this.session.cwd, build.dir);
		const flags = `-fsanitize=${(params.sanitizers ?? ["address", "undefined"]).join(",")} -fno-omit-frame-pointer -g -O1`;
		const results: PreparedRun["build_results"] = [];
		if (build.system === "cmake") {
			const output = path.join(directory, sanitize ? ".chud-san" : ".chud-build");
			if (sanitize) await fs.rm(output, { recursive: true, force: true });
			await fs.mkdir(output, { recursive: true });
			const configureArgs = [buildExecutable, "-S", directory, "-B", output, "-DCMAKE_BUILD_TYPE=Debug"];
			const env: Record<string, string> = {};
			if (sanitize) {
				configureArgs.splice(1, 0, "-C", path.join(import.meta.dir, "analyzers", "assets", "sanitizers.cmake"));
				env.CHUD_SAN = (params.sanitizers ?? ["address", "undefined"]).join(",");
				env.CC = "clang";
				env.CXX = "clang++";
			}
			const configured = await runCommand(configureArgs, {
				cwd: directory,
				env,
				signal,
				timeoutMs: timeoutMs(params),
				session: this.session,
				artifactType: "runtime-build",
			});
			results.push({ command: configured.command, exit_code: configured.exitCode, artifacts: configured.artifacts });
			if (configured.exitCode !== 0) return commandFailure(configured, "build_failed", "CMake configure failed.");
			const built = await runCommand(
				[buildExecutable, "--build", output, ...(build.target ? ["--target", build.target] : [])],
				{
					cwd: directory,
					signal,
					timeoutMs: timeoutMs(params),
					session: this.session,
					artifactType: "runtime-build",
				},
			);
			results.push({ command: built.command, exit_code: built.exitCode, artifacts: built.artifacts });
			if (built.exitCode !== 0) return commandFailure(built, "build_failed", "CMake build failed.");
			return { ok: true, cwd: path.resolve(output, params.run?.cwd ?? "."), build_results: results };
		}
		const makeEnv = sanitize
			? {
					CC: "clang",
					CXX: "clang++",
					CFLAGS: flags,
					CXXFLAGS: flags,
					LDFLAGS: `-fsanitize=${(params.sanitizers ?? ["address", "undefined"]).join(",")}`,
				}
			: {};
		const built = await runCommand(
			[buildExecutable, "-B", "-C", directory, ...(build.target ? [build.target] : [])],
			{
				cwd: directory,
				env: makeEnv,
				signal,
				timeoutMs: timeoutMs(params),
				session: this.session,
				artifactType: "runtime-build",
			},
		);
		results.push({ command: built.command, exit_code: built.exitCode, artifacts: built.artifacts });
		if (built.exitCode !== 0) return commandFailure(built, "build_failed", "Make build failed.");
		return { ok: true, cwd: path.resolve(directory, params.run?.cwd ?? "."), build_results: results };
	}

	async #sanitize(params: CppRuntimeParams, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const sanitizers = params.sanitizers ?? ["address", "undefined"];
		if (sanitizers.length === 0) return invalid("sanitizers_missing", "Select at least one sanitizer.");
		if (sanitizers.includes("thread") && sanitizers.includes("memory")) {
			return invalid("incompatible_sanitizers", "thread and memory sanitizers cannot be combined.");
		}
		if (sanitizers.includes("address") && (sanitizers.includes("thread") || sanitizers.includes("memory"))) {
			return invalid(
				"incompatible_sanitizers",
				"thread and memory sanitizers cannot be combined with address sanitizer.",
			);
		}
		if (params.build && params.build.system !== "none" && !Bun.which("clang")) {
			return missingTool("clang", "Install clang to build sanitizer-instrumented code.");
		}
		const prepared = await this.#prepareBuild(params, true, signal);
		if (!prepared.ok) return prepared;
		const temp = await makeTempDir("chud-sanitizer-");
		try {
			const run = await runCommand([params.run!.cmd, ...(params.run!.args ?? [])], {
				cwd: prepared.cwd,
				env: {
					...params.run!.env,
					ASAN_OPTIONS: `log_path=${path.join(temp, "asan")}:halt_on_error=0`,
					UBSAN_OPTIONS: "print_stacktrace=1",
				},
				signal,
				timeoutMs: timeoutMs(params),
				session: this.session,
				artifactType: "sanitizer",
			});
			let reportsText = `${run.stderr}\n${run.stdout}`;
			for (const log of await globFiles(temp, "asan*", 100)) {
				if (reportsText.length >= 4 * 1024 * 1024) break;
				reportsText += `\n${await readTextBounded(log, 2 * 1024 * 1024)}`;
			}
			const reports = parseSanitizerOutput(reportsText).slice(0, 100);
			const binary = path.isAbsolute(params.run!.cmd)
				? params.run!.cmd
				: path.resolve(prepared.cwd, params.run!.cmd);
			await symbolizeSanitizerReports(reports, binary, prepared.cwd, signal);
			return {
				ok: true,
				reports,
				exit_code: run.exitCode,
				timed_out: run.timedOut,
				build_results: prepared.build_results,
				artifacts: run.artifacts,
			};
		} finally {
			await removeTempDir(temp);
		}
	}

	async #valgrind(params: CppRuntimeParams, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const executable = Bun.which("valgrind");
		if (!executable) return missingTool("valgrind", "Install Valgrind 3.26 or newer and ensure valgrind is on PATH.");
		const prepared = await this.#prepareBuild(params, false, signal);
		if (!prepared.ok) return prepared;
		const temp = await makeTempDir("chud-valgrind-");
		try {
			const tool = params.action;
			const output = path.join(temp, `${tool}.out`);
			const toolArgs =
				tool === "memcheck"
					? ["--tool=memcheck", "--xml=yes", `--xml-file=${output}`]
					: tool === "dhat"
						? ["--tool=dhat", `--dhat-out-file=${output}`]
						: tool === "massif"
							? ["--tool=massif", `--massif-out-file=${output}`]
							: ["--tool=callgrind", `--callgrind-out-file=${output}`];
			const run = await runCommand([executable, ...toolArgs, params.run!.cmd, ...(params.run!.args ?? [])], {
				cwd: prepared.cwd,
				env: params.run!.env,
				signal,
				timeoutMs: timeoutMs(params),
				session: this.session,
				artifactType: `valgrind-${tool}`,
			});
			if (!(await exists(output)))
				return commandFailure(run, undefined, `Valgrind ${tool} did not produce its output file.`);
			const raw = await readTextBounded(output);
			if (tool === "memcheck") {
				return {
					ok: true,
					errors: parseValgrindXml(raw).slice(0, 100),
					exit_code: run.exitCode,
					timed_out: run.timedOut,
					artifacts: run.artifacts,
				};
			}
			if (tool === "dhat") {
				return {
					ok: true,
					allocation_points: parseDhatJson(raw, topLimit(params)),
					exit_code: run.exitCode,
					timed_out: run.timedOut,
					artifacts: run.artifacts,
				};
			}
			if (tool === "massif") {
				return {
					ok: true,
					...parseMassif(raw),
					exit_code: run.exitCode,
					timed_out: run.timedOut,
					artifacts: run.artifacts,
				};
			}
			const annotate = Bun.which("callgrind_annotate");
			if (!annotate) return missingTool("callgrind_annotate", "Install Valgrind's callgrind_annotate utility.");
			const report = await runCommand([annotate, "--auto=yes", output], {
				cwd: prepared.cwd,
				signal,
				timeoutMs: timeoutMs(params),
				session: this.session,
				artifactType: "callgrind-annotate",
			});
			if (report.exitCode !== 0) return commandFailure(report, undefined, "callgrind_annotate failed.");
			return {
				ok: true,
				functions: parseCallgrind(report.stdout, topLimit(params)),
				exit_code: run.exitCode,
				timed_out: run.timedOut || report.timedOut,
				artifacts: [...(run.artifacts ?? []), ...(report.artifacts ?? [])].slice(0, 20),
			};
		} finally {
			await removeTempDir(temp);
		}
	}

	async #heaptrack(params: CppRuntimeParams, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const executable = Bun.which("heaptrack");
		const printer = Bun.which("heaptrack_print");
		if (!executable || !printer)
			return missingTool("heaptrack", "Install heaptrack and ensure heaptrack plus heaptrack_print are on PATH.");
		const prepared = await this.#prepareBuild(params, false, signal);
		if (!prepared.ok) return prepared;
		const temp = await makeTempDir("chud-heaptrack-");
		try {
			const prefix = path.join(temp, "heaptrack");
			const run = await runCommand([executable, "-o", prefix, params.run!.cmd, ...(params.run!.args ?? [])], {
				cwd: prepared.cwd,
				env: params.run!.env,
				signal,
				timeoutMs: timeoutMs(params),
				session: this.session,
				artifactType: "heaptrack",
			});
			const data = (await globFiles(temp, "heaptrack*", 20)).find(candidate => candidate !== prefix) ?? prefix;
			if (!(await exists(data))) return commandFailure(run, undefined, "heaptrack did not produce a data file.");
			const report = await runCommand([printer, data], {
				cwd: prepared.cwd,
				signal,
				timeoutMs: timeoutMs(params),
				session: this.session,
				artifactType: "heaptrack-print",
			});
			if (report.exitCode !== 0) return commandFailure(report, undefined, "heaptrack_print failed.");
			return {
				ok: true,
				allocators: parseHeaptrack(report.stdout, topLimit(params)),
				exit_code: run.exitCode,
				timed_out: run.timedOut || report.timedOut,
				artifacts: [...(run.artifacts ?? []), ...(report.artifacts ?? [])].slice(0, 20),
			};
		} finally {
			await removeTempDir(temp);
		}
	}

	async #perf(params: CppRuntimeParams, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const executable = Bun.which("perf");
		if (!executable)
			return missingTool("perf", "Install Linux perf matching the running kernel and ensure perf is on PATH.");
		const prepared = await this.#prepareBuild(params, false, signal);
		if (!prepared.ok) return prepared;
		const temp = await makeTempDir("chud-perf-");
		try {
			const data = path.join(temp, "perf.data");
			const json = path.join(temp, "perf.json");
			const run = await runCommand(
				[executable, "record", "-g", "-o", data, "--", params.run!.cmd, ...(params.run!.args ?? [])],
				{
					cwd: prepared.cwd,
					env: params.run!.env,
					signal,
					timeoutMs: timeoutMs(params),
					session: this.session,
					artifactType: "perf-record",
				},
			);
			if (!(await exists(data))) {
				return commandFailure(
					run,
					undefined,
					"perf record failed to produce perf.data; check perf_event_paranoid permissions.",
				);
			}
			const converted = await runCommand([executable, "data", "convert", "-i", data, "--to-json", json], {
				cwd: prepared.cwd,
				signal,
				timeoutMs: timeoutMs(params),
				session: this.session,
				artifactType: "perf-convert",
			});
			if (converted.exitCode !== 0 || !(await exists(json))) {
				return commandFailure(
					converted,
					undefined,
					"perf data convert --to-json failed; install a perf build with JSON conversion support.",
				);
			}
			return {
				ok: true,
				symbols: await parsePerfSymbols(json, topLimit(params)),
				exit_code: run.exitCode,
				timed_out: run.timedOut || converted.timedOut,
				artifacts: [...(run.artifacts ?? []), ...(converted.artifacts ?? [])].slice(0, 20),
			};
		} finally {
			await removeTempDir(temp);
		}
	}

	async #rrRecord(params: CppRuntimeParams, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const executable = Bun.which("rr");
		if (!executable) return missingTool("rr", "Install rr and ensure rr is on PATH.");
		const probeTemp = await makeTempDir("chud-rr-probe-");
		try {
			const probe = await runCommand(
				[executable, "record", "-n", "-o", path.join(probeTemp, "trace"), "/bin/true"],
				{
					cwd: this.session.cwd,
					signal,
					timeoutMs: 30_000,
					session: this.session,
					artifactType: "rr-probe",
				},
			);
			if (probe.exitCode !== 0) {
				return {
					ok: false,
					reason: "cpu_unsupported",
					hint: `rr cannot record on this host. Check PMU virtualization and perf_event_paranoid. ${probe.stderr.slice(-4000)}`,
				};
			}
		} finally {
			await removeTempDir(probeTemp);
		}
		const prepared = await this.#prepareBuild(params, false, signal);
		if (!prepared.ok) return prepared;
		const parent = await makeTempDir("chud-rr-");
		const trace = path.join(parent, "trace");
		const record = await runCommand(
			[executable, "record", "-o", trace, "--", params.run!.cmd, ...(params.run!.args ?? [])],
			{
				cwd: prepared.cwd,
				env: params.run!.env,
				signal,
				timeoutMs: timeoutMs(params),
				session: this.session,
				artifactType: "rr-record",
			},
		);
		if (record.exitCode !== 0 || !(await exists(trace))) {
			await removeTempDir(parent);
			return commandFailure(record, undefined, "rr record failed.");
		}
		return { ok: true, trace, exit_code: record.exitCode, timed_out: record.timedOut, artifacts: record.artifacts };
	}

	async #rrReplay(params: CppRuntimeParams, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const executable = Bun.which("rr");
		if (!executable) return missingTool("rr", "Install rr and ensure rr is on PATH.");
		const trace = path.resolve(this.session.cwd, params.run!.cmd);
		if (!(await exists(trace))) return invalid("trace_missing", `rr trace does not exist: ${trace}`);
		const session = await GdbMiSession.start({
			command: executable,
			args: ["replay", trace, "--", "--interpreter=mi2"],
			cwd: params.run!.cwd ? path.resolve(this.session.cwd, params.run!.cwd) : this.session.cwd,
			env: params.run!.env,
			signal,
			timeoutMs: timeoutMs(params),
		});
		try {
			const continued = await session.request("-exec-continue", timeoutMs(params));
			const stopped = await session.waitForStop(timeoutMs(params));
			const backtrace = await session.request(`-stack-list-frames 0 ${topLimit(params) - 1}`, timeoutMs(params));
			return {
				ok: true,
				stop_reason: stopped.results?.reason ?? stopped.class ?? "stopped",
				stop: stopped,
				backtrace: backtrace.slice(0, 200),
				continue_records: continued.slice(0, 50),
				stderr_excerpt: session.stderrExcerpt(),
			};
		} finally {
			await session.close();
		}
	}
}
