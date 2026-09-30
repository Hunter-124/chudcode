import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { type } from "@oh-my-pi/omptype";
import type { ToolSession } from ".";
import { parseClangTidy } from "./analyzers/clang-tidy-parse";
import { missingTool, probeTools } from "./analyzers/doctor";
import {
	compileCommandFiles,
	discoverCompileCommands,
	exists,
	globFiles,
	makeTempDir,
	readTextBounded,
	removeTempDir,
} from "./analyzers/files";
import { type AnalyzerFinding, capFindings, normalizeSeverity } from "./analyzers/findings";
import { commandFailure, runCommand } from "./analyzers/process";
import { parseSarif } from "./analyzers/sarif";
import type { OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { toolResult } from "./tool-result";

const cppStaticSchema = type({
	action: "'doctor' | 'cppcheck' | 'tidy' | 'analyze' | 'iwyu' | 'infer'",
	"paths?": "string[]",
	"compile_commands?": "string",
	"checks?": "string",
	"max_findings?": "number",
});

export type CppStaticParams = typeof cppStaticSchema.infer;

interface CppStaticDetails {
	action: CppStaticParams["action"];
	response: Record<string, unknown>;
	meta?: OutputMeta;
}

function field(value: unknown, key: string): unknown {
	return value !== null && typeof value === "object" && key in value ? Reflect.get(value, key) : undefined;
}

function jsonResult(
	action: CppStaticParams["action"],
	response: Record<string, unknown>,
): AgentToolResult<CppStaticDetails> {
	return toolResult<CppStaticDetails>({ action, response })
		.text(JSON.stringify(response, null, 2))
		.done();
}

function invalid(reason: string, hint: string): Record<string, unknown> {
	return { ok: false, reason, hint };
}

function selectFiles(files: string[], requested: string[] | undefined, cwd: string): string[] {
	if (!requested || requested.length === 0) return files.slice(0, 10_000);
	const targets = requested.map(entry => path.resolve(cwd, entry));
	return files
		.filter(file => targets.some(target => file === target || file.startsWith(`${target}${path.sep}`)))
		.slice(0, 10_000);
}

function parseIwyu(output: string): AnalyzerFinding[] {
	const findings: AnalyzerFinding[] = [];
	let file = "<unknown>";
	let mode: "add" | "remove" | undefined;
	for (const line of output.split(/\r?\n/)) {
		const header = /^(.*) should (add|remove) these lines:$/.exec(line);
		if (header) {
			file = header[1]!;
			mode = header[2] as "add" | "remove";
			continue;
		}
		if (line.startsWith("The full include-list")) {
			mode = undefined;
			continue;
		}
		if (!mode || !line.trim()) continue;
		const lineNumber = /lines?\s+(\d+)/.exec(line)?.[1];
		findings.push({
			tool: "include-what-you-use",
			rule: `iwyu-${mode}`,
			severity: "warning",
			file,
			line: lineNumber ? Number(lineNumber) : 1,
			message: line.trim().replace(/^-\s*/, ""),
		});
		if (findings.length >= 10_000) break;
	}
	return findings;
}

function parseInfer(input: string): AnalyzerFinding[] {
	let document: unknown;
	try {
		document = JSON.parse(input);
	} catch {
		return [];
	}
	if (!Array.isArray(document)) return [];
	const findings: AnalyzerFinding[] = [];
	for (const report of document) {
		const source = field(report, "source_location");
		const file = field(source, "file") ?? field(report, "file");
		const line = field(source, "line") ?? field(report, "line");
		const column = field(source, "column") ?? field(report, "column");
		findings.push({
			tool: "infer",
			rule: String(field(report, "bug_type") ?? "unknown"),
			severity: normalizeSeverity(field(report, "severity")),
			file: String(file ?? "<unknown>"),
			line: Math.max(1, Number(line) || 1),
			...(Number(column) > 0 ? { col: Number(column) } : {}),
			message: String(field(report, "qualifier") ?? field(report, "bug_type_hum") ?? "Infer finding"),
		});
		if (findings.length >= 10_000) break;
	}
	return findings;
}

export class CppStaticTool implements AgentTool<typeof cppStaticSchema, CppStaticDetails> {
	readonly name = "cpp_static";
	readonly approval = "read" as const;
	readonly label = "C/C++ Static Analysis";
	readonly summary = "Run bounded C/C++ static analyzers and normalize their findings";
	readonly description =
		"Runs PATH-installed cppcheck, clang-tidy, CodeChecker, include-what-you-use, or Infer. Use doctor first. Results use one bounded finding schema; no analyzer is bundled.";
	readonly parameters = cppStaticSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: CppStaticParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<CppStaticDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<CppStaticDetails>> {
		try {
			const response = await this.#execute(params, signal);
			return jsonResult(params.action, response);
		} catch (error) {
			return jsonResult(params.action, {
				ok: false,
				reason: "analyzer_error",
				hint: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async #execute(params: CppStaticParams, signal?: AbortSignal): Promise<Record<string, unknown>> {
		if (params.action === "doctor") {
			const tools = await probeTools(
				[
					{ name: "cppcheck", versionArgs: ["--version"], versionRegex: /Cppcheck\s+([\w.-]+)/i },
					{ name: "clang-tidy", versionArgs: ["--version"], versionRegex: /version\s+([\w.-]+)/i },
					{ name: "CodeChecker", versionArgs: ["version"], versionRegex: /CodeChecker.*?([0-9]+(?:\.[0-9]+)+)/i },
					{
						name: "iwyu_tool.py",
						command: Bun.which("iwyu_tool.py") ? "iwyu_tool.py" : "iwyu_tool",
						versionArgs: ["--help"],
						versionRegex: /(include-what-you-use)/i,
					},
					{ name: "infer", versionArgs: ["--version"], versionRegex: /Infer version\s+([\w.-]+)/i },
				],
				{ cwd: this.session.cwd, signal, session: this.session },
			);
			return { ok: true, tools };
		}
		if (params.action === "cppcheck") return this.#cppcheck(params, signal);
		const compileCommands = await discoverCompileCommands(this.session.cwd, params.compile_commands);
		if (!compileCommands) {
			return invalid(
				"compile_commands_missing",
				"Generate compile_commands.json with cmake -DCMAKE_EXPORT_COMPILE_COMMANDS=ON, or pass compile_commands.",
			);
		}
		switch (params.action) {
			case "tidy":
				return this.#tidy(params, compileCommands, signal);
			case "analyze":
				return this.#codeChecker(params, compileCommands, signal);
			case "iwyu":
				return this.#iwyu(params, compileCommands, signal);
			case "infer":
				return this.#infer(params, compileCommands, signal);
		}
	}

	async #cppcheck(params: CppStaticParams, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const executable = Bun.which("cppcheck");
		if (!executable) return missingTool("cppcheck", "Install cppcheck 2.16 or newer and ensure cppcheck is on PATH.");
		const compileCommands =
			params.compile_commands || !params.paths || params.paths.length === 0
				? await discoverCompileCommands(this.session.cwd, params.compile_commands)
				: undefined;
		if (!compileCommands && (!params.paths || params.paths.length === 0)) {
			return invalid(
				"input_missing",
				"Pass paths, or generate compile_commands.json with CMAKE_EXPORT_COMPILE_COMMANDS=ON.",
			);
		}
		const temp = await makeTempDir("chud-cppcheck-");
		try {
			const sarifPath = path.join(temp, "cppcheck.sarif");
			const args = [
				executable,
				"--enable=warning,style,performance,portability",
				"--output-format=sarif",
				`--output-file=${sarifPath}`,
				...(compileCommands
					? [`--project=${compileCommands}`]
					: params.paths!.slice(0, 10_000).map(entry => path.resolve(this.session.cwd, entry))),
			];
			const result = await runCommand(args, {
				cwd: this.session.cwd,
				signal,
				timeoutMs: 5 * 60_000,
				session: this.session,
				artifactType: "cppcheck",
			});
			if (!(await exists(sarifPath)))
				return commandFailure(result, undefined, "cppcheck did not produce SARIF output.");
			const findings = parseSarif(await readTextBounded(sarifPath), "cppcheck");
			return {
				ok: true,
				...capFindings(findings, params.max_findings),
				exit_code: result.exitCode,
				timed_out: result.timedOut,
				artifacts: result.artifacts,
			};
		} finally {
			await removeTempDir(temp);
		}
	}

	async #tidy(
		params: CppStaticParams,
		compileCommands: string,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const executable = Bun.which("clang-tidy");
		if (!executable) return missingTool("clang_tidy", "Install LLVM clang-tidy and ensure clang-tidy is on PATH.");
		const allFiles = await compileCommandFiles(compileCommands);
		const files = selectFiles(allFiles, params.paths, this.session.cwd);
		if (files.length === 0) return invalid("no_source_files", "No compile database entries matched paths.");
		const repoConfig = path.join(this.session.cwd, ".clang-tidy");
		const defaultConfig = path.join(import.meta.dir, "analyzers", "assets", "clang-tidy-default");
		const configArgs = (await exists(repoConfig)) ? [] : [`--config-file=${defaultConfig}`];
		const checksArgs = params.checks ? [`--checks=${params.checks}`] : [];
		const batches: string[][] = [];
		for (let index = 0; index < files.length; index += 50) batches.push(files.slice(index, index + 50));
		const findings: AnalyzerFinding[] = [];
		const artifacts: string[] = [];
		const exitCodes: number[] = [];
		let cursor = 0;
		let timedOutBatches = 0;
		const jobs = Math.min(batches.length, Math.max(1, Math.floor(os.availableParallelism() / 2)));
		await Promise.all(
			Array.from({ length: jobs }, async () => {
				for (;;) {
					const index = cursor++;
					const batch = batches[index];
					if (!batch) break;
					const result = await runCommand(
						[executable, "-p", path.dirname(compileCommands), ...configArgs, ...checksArgs, ...batch],
						{
							cwd: this.session.cwd,
							signal,
							timeoutMs: 5 * 60_000,
							session: this.session,
							artifactType: "clang-tidy",
						},
					);
					exitCodes.push(result.exitCode);
					if (result.timedOut) timedOutBatches++;
					const parsed = parseClangTidy(`${result.stdout}\n${result.stderr}`);
					if (findings.length < 10_000) findings.push(...parsed.slice(0, 10_000 - findings.length));
					if (result.artifacts) artifacts.push(...result.artifacts);
				}
			}),
		);
		if (findings.length === 0 && exitCodes.some(code => code !== 0)) {
			return invalid(
				"tool_failed",
				"clang-tidy failed before producing parseable diagnostics; inspect its artifact output.",
			);
		}
		return {
			ok: true,
			...capFindings(findings, params.max_findings),
			files_analyzed: files.length,
			exit_codes: exitCodes.slice(0, 200),
			timed_out_batches: timedOutBatches,
			artifacts: artifacts.slice(0, 20),
		};
	}

	async #codeChecker(
		params: CppStaticParams,
		compileCommands: string,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const executable = Bun.which("CodeChecker");
		if (!executable)
			return missingTool("codechecker", "Install with pipx install codechecker and ensure CodeChecker is on PATH.");
		const temp = await makeTempDir("chud-codechecker-");
		try {
			const reports = path.join(temp, "reports");
			const sarifOutput = path.join(temp, "sarif");
			const analyze = await runCommand(
				[executable, "analyze", compileCommands, "-o", reports, "--analyzers", "clangsa"],
				{
					cwd: this.session.cwd,
					signal,
					timeoutMs: 10 * 60_000,
					session: this.session,
					artifactType: "codechecker-analyze",
				},
			);
			if (analyze.exitCode !== 0) return commandFailure(analyze, undefined, "CodeChecker analyze failed.");
			const parsed = await runCommand([executable, "parse", reports, "--export", "sarif", "-o", sarifOutput], {
				cwd: this.session.cwd,
				signal,
				timeoutMs: 5 * 60_000,
				session: this.session,
				artifactType: "codechecker-parse",
			});
			if (parsed.exitCode !== 0) return commandFailure(parsed, undefined, "CodeChecker SARIF export failed.");
			const candidates = [
				...new Set([
					sarifOutput,
					...(await globFiles(temp, "**/*.sarif", 100)),
					...(await globFiles(temp, "**/*.json", 100)),
				]),
			].slice(0, 100);
			const findings: AnalyzerFinding[] = [];
			for (const candidate of candidates) {
				try {
					const parsedFindings = parseSarif(await readTextBounded(candidate), "CodeChecker");
					if (findings.length < 10_000) findings.push(...parsedFindings.slice(0, 10_000 - findings.length));
				} catch {
					// Skip non-SARIF files in CodeChecker's output directory.
				}
			}
			return {
				ok: true,
				...capFindings(findings, params.max_findings),
				artifacts: [...(analyze.artifacts ?? []), ...(parsed.artifacts ?? [])].slice(0, 20),
			};
		} finally {
			await removeTempDir(temp);
		}
	}

	async #iwyu(
		params: CppStaticParams,
		compileCommands: string,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const executable = Bun.which("iwyu_tool.py") ?? Bun.which("iwyu_tool");
		if (!executable) return missingTool("iwyu", "Install include-what-you-use and ensure iwyu_tool.py is on PATH.");
		const args = [executable, "-p", path.dirname(compileCommands), ...(params.paths ?? []).slice(0, 10_000)];
		const result = await runCommand(args, {
			cwd: this.session.cwd,
			signal,
			timeoutMs: 5 * 60_000,
			session: this.session,
			artifactType: "iwyu",
		});
		const findings = parseIwyu(`${result.stdout}\n${result.stderr}`);
		if (result.exitCode !== 0 && findings.length === 0)
			return commandFailure(result, undefined, "iwyu_tool.py failed.");
		return {
			ok: true,
			...capFindings(findings, params.max_findings),
			exit_code: result.exitCode,
			timed_out: result.timedOut,
			artifacts: result.artifacts,
		};
	}

	async #infer(
		params: CppStaticParams,
		compileCommands: string,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const executable = Bun.which("infer");
		if (!executable) return missingTool("infer", "Install Infer and ensure infer is on PATH.");
		const temp = await makeTempDir("chud-infer-");
		try {
			const results = path.join(temp, "infer-out");
			const run = await runCommand(
				[executable, "run", "--results-dir", results, "--compilation-database", compileCommands],
				{
					cwd: this.session.cwd,
					signal,
					timeoutMs: 10 * 60_000,
					session: this.session,
					artifactType: "infer",
				},
			);
			const report = path.join(results, "report.json");
			if (!(await exists(report)))
				return commandFailure(run, undefined, "Infer did not produce infer-out/report.json.");
			const findings = parseInfer(await readTextBounded(report));
			return {
				ok: true,
				...capFindings(findings, params.max_findings),
				exit_code: run.exitCode,
				timed_out: run.timedOut,
				artifacts: run.artifacts,
			};
		} finally {
			await removeTempDir(temp);
		}
	}
}
