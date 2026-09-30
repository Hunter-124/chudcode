import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { type } from "@oh-my-pi/omptype";
import type { ToolSession } from ".";
import { missingTool, probeTools } from "./analyzers/doctor";
import { exists } from "./analyzers/files";
import { commandFailure, runCommand } from "./analyzers/process";
import type { OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { toolResult } from "./tool-result";

const binaryInspectSchema = type({
	action: "'doctor' | 'headers' | 'sections' | 'symbols' | 'deps' | 'disasm' | 'functions' | 'strings' | 'size'",
	"path?": "string",
	"symbol?": "string",
	"baseline?": "string",
	"min_len?": "number",
	"top?": "number",
});

export type BinaryInspectParams = typeof binaryInspectSchema.infer;

interface BinaryInspectDetails {
	action: BinaryInspectParams["action"];
	response: Record<string, unknown>;
	meta?: OutputMeta;
}

function field(value: unknown, key: string): unknown {
	return value !== null && typeof value === "object" && key in value ? Reflect.get(value, key) : undefined;
}

function jsonResult(
	action: BinaryInspectParams["action"],
	response: Record<string, unknown>,
): AgentToolResult<BinaryInspectDetails> {
	return toolResult<BinaryInspectDetails>({ action, response })
		.text(JSON.stringify(response, null, 2))
		.done();
}

function limit(params: BinaryInspectParams, fallback = 100): number {
	return Math.max(1, Math.min(2000, Math.trunc(params.top ?? fallback)));
}

function parseHeaders(output: string): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const line of output.split(/\r?\n/)) {
		const match = /^\s*([^:]+):\s*(.*?)\s*$/.exec(line);
		if (!match) continue;
		const key = match[1]!
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_|_$/g, "");
		if (key && Object.keys(headers).length < 100) headers[key] = match[2]!;
	}
	return headers;
}

function parseSections(output: string, top: number): Array<Record<string, unknown>> {
	const sections: Array<Record<string, unknown>> = [];
	const pattern =
		/^\s*\[\s*(\d+)\]\s+(\S+)\s+(\S+)\s+([0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s+(\S+)\s*(\S*)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/;
	for (const line of output.split(/\r?\n/)) {
		const match = pattern.exec(line);
		if (!match) continue;
		sections.push({
			index: Number(match[1]),
			name: match[2],
			type: match[3],
			address: `0x${match[4]}`,
			offset: Number.parseInt(match[5]!, 16),
			size: Number.parseInt(match[6]!, 16),
			entry_size: Number.parseInt(match[7]!, 16),
			flags: match[8],
			link: Number(match[9]),
			info: Number(match[10]),
			alignment: Number(match[11]),
		});
		if (sections.length >= top) break;
	}
	return sections;
}

function parseSymbols(output: string, top: number): Array<Record<string, unknown>> {
	const symbols: Array<Record<string, unknown>> = [];
	for (const line of output.split(/\r?\n/)) {
		const match = /^([0-9a-fA-F]+)\s+([A-Za-z?])\s+(.+)$/.exec(line.trim());
		if (!match) continue;
		symbols.push({ address: `0x${match[1]}`, type: match[2], name: match[3] });
		if (symbols.length >= top) break;
	}
	return symbols;
}

function parseDependencies(output: string, top: number): Array<Record<string, unknown>> {
	const dependencies: Array<Record<string, unknown>> = [];
	for (const line of output.split(/\r?\n/)) {
		const text = line.trim();
		if (!text) continue;
		let match = /^(\S+)\s+=>\s+(\S+)(?:\s+\((0x[0-9a-fA-F]+)\))?$/.exec(text);
		if (match) {
			dependencies.push({
				name: match[1],
				path: match[2],
				...(match[3] ? { address: match[3] } : {}),
				found: match[2] !== "not",
			});
		} else {
			match = /^(\S+)\s+\((0x[0-9a-fA-F]+)\)$/.exec(text);
			if (match) dependencies.push({ name: match[1], address: match[2], found: true });
			else if (/=>\s+not found$/.test(text)) dependencies.push({ name: text.split(/\s+/)[0], found: false });
		}
		if (dependencies.length >= top) break;
	}
	return dependencies;
}

function parseCsv(input: string, top: number): Array<Record<string, string>> {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	for (let index = 0; index < input.length; index++) {
		const char = input[index]!;
		if (char === '"') {
			if (quoted && input[index + 1] === '"') {
				cell += '"';
				index++;
			} else quoted = !quoted;
		} else if (char === "," && !quoted) {
			row.push(cell);
			cell = "";
		} else if ((char === "\n" || char === "\r") && !quoted) {
			if (char === "\r" && input[index + 1] === "\n") index++;
			row.push(cell);
			if (row.some(value => value.length > 0)) rows.push(row);
			row = [];
			cell = "";
		} else cell += char;
	}
	if (cell || row.length > 0) {
		row.push(cell);
		rows.push(row);
	}
	const header = rows.shift() ?? [];
	return rows.slice(0, top).map(values => {
		const object: Record<string, string> = {};
		for (let index = 0; index < Math.min(header.length, values.length); index++)
			object[header[index]!] = values[index]!;
		return object;
	});
}

export class BinaryInspectTool implements AgentTool<typeof binaryInspectSchema, BinaryInspectDetails> {
	readonly name = "binary_inspect";
	readonly approval = "read" as const;
	readonly label = "Binary Inspection";
	readonly summary = "Inspect native binary layout, symbols, dependencies, disassembly, strings, and size";
	readonly description =
		"Uses PATH-installed binutils, rizin, and bloaty through bounded subprocesses. All actions are read-only and return structured capped results.";
	readonly parameters = binaryInspectSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: BinaryInspectParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<BinaryInspectDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<BinaryInspectDetails>> {
		try {
			const response = await this.#execute(params, signal);
			return jsonResult(params.action, response);
		} catch (error) {
			return jsonResult(params.action, {
				ok: false,
				reason: "binary_inspect_error",
				hint: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async #execute(params: BinaryInspectParams, signal?: AbortSignal): Promise<Record<string, unknown>> {
		if (params.action === "doctor") {
			const tools = await probeTools(
				[
					{ name: "readelf", versionArgs: ["--version"], versionRegex: /GNU readelf.*?([0-9]+(?:\.[0-9]+)+)/i },
					{ name: "nm", versionArgs: ["--version"], versionRegex: /GNU nm.*?([0-9]+(?:\.[0-9]+)+)/i },
					{ name: "ldd", versionArgs: ["--version"], versionRegex: /ldd.*?([0-9]+(?:\.[0-9]+)+)/i },
					{ name: "objdump", versionArgs: ["--version"], versionRegex: /GNU objdump.*?([0-9]+(?:\.[0-9]+)+)/i },
					{ name: "rizin", versionArgs: ["-v"], versionRegex: /rizin\s+([\w.-]+)/i },
					{ name: "strings", versionArgs: ["--version"], versionRegex: /GNU strings.*?([0-9]+(?:\.[0-9]+)+)/i },
					{ name: "bloaty", versionArgs: ["--version"], versionRegex: /Bloaty.*?([0-9]+(?:\.[0-9]+)+)/i },
				],
				{ cwd: this.session.cwd, signal, session: this.session },
			);
			return { ok: true, tools };
		}
		if (!params.path) return { ok: false, reason: "path_missing", hint: "path is required for this action." };
		const binary = path.resolve(this.session.cwd, params.path);
		if (!(await exists(binary)))
			return { ok: false, reason: "binary_missing", hint: `Binary does not exist: ${binary}` };
		switch (params.action) {
			case "headers":
				return this.#readelf(params, binary, "-hW", signal);
			case "sections":
				return this.#readelf(params, binary, "-SW", signal);
			case "symbols":
				return this.#symbols(params, binary, signal);
			case "deps":
				return this.#deps(params, binary, signal);
			case "disasm":
				return this.#disasm(params, binary, signal);
			case "functions":
				return this.#functions(params, binary, signal);
			case "strings":
				return this.#strings(params, binary, signal);
			case "size":
				return this.#size(params, binary, signal);
		}
	}

	async #readelf(
		params: BinaryInspectParams,
		binary: string,
		flag: "-hW" | "-SW",
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const executable = Bun.which("readelf");
		if (!executable) return missingTool("readelf", "Install GNU binutils and ensure readelf is on PATH.");
		const result = await runCommand([executable, flag, binary], {
			cwd: this.session.cwd,
			signal,
			session: this.session,
			artifactType: "readelf",
		});
		if (result.exitCode !== 0) return commandFailure(result, undefined, "readelf could not inspect this file.");
		return flag === "-hW"
			? { ok: true, headers: parseHeaders(result.stdout), artifacts: result.artifacts }
			: { ok: true, sections: parseSections(result.stdout, limit(params, 500)), artifacts: result.artifacts };
	}

	async #symbols(params: BinaryInspectParams, binary: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const executable = Bun.which("nm");
		if (!executable) return missingTool("nm", "Install GNU binutils and ensure nm is on PATH.");
		const result = await runCommand([executable, "-C", "--defined-only", binary], {
			cwd: this.session.cwd,
			signal,
			session: this.session,
			artifactType: "nm",
		});
		if (result.exitCode !== 0) return commandFailure(result, undefined, "nm could not read symbols from this file.");
		return { ok: true, symbols: parseSymbols(result.stdout, limit(params, 500)), artifacts: result.artifacts };
	}

	async #deps(params: BinaryInspectParams, binary: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const executable = Bun.which("ldd");
		if (!executable) return missingTool("ldd", "Install glibc/binutils tooling and ensure ldd is on PATH.");
		const result = await runCommand([executable, binary], {
			cwd: this.session.cwd,
			signal,
			session: this.session,
			artifactType: "ldd",
		});
		const output = `${result.stdout}\n${result.stderr}`;
		if (/not a dynamic executable|statically linked/i.test(output))
			return { ok: true, static: true, dependencies: [] };
		if (result.exitCode !== 0)
			return commandFailure(result, undefined, "ldd could not inspect dynamic dependencies.");
		return {
			ok: true,
			static: false,
			dependencies: parseDependencies(output, limit(params, 500)),
			artifacts: result.artifacts,
		};
	}

	async #disasm(params: BinaryInspectParams, binary: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
		if (!params.symbol) return { ok: false, reason: "symbol_missing", hint: "symbol is required for disasm." };
		const rizin = Bun.which("rizin");
		if (rizin && /^[A-Za-z0-9_.$:@~?+-]+$/.test(params.symbol)) {
			const result = await runCommand([rizin, "-q", "-c", `aaa; pdfj @ sym.${params.symbol}`, binary], {
				cwd: this.session.cwd,
				signal,
				session: this.session,
				artifactType: "rizin-disasm",
			});
			if (result.exitCode === 0) {
				let document: unknown;
				try {
					document = JSON.parse(result.stdout);
				} catch {
					document = undefined;
				}
				if (document !== undefined) {
					const ops = field(document, "ops");
					return {
						ok: true,
						backend: "rizin",
						function: {
							name: field(document, "name"),
							address: field(document, "addr"),
							size: field(document, "size"),
						},
						instructions: Array.isArray(ops) ? ops.slice(0, limit(params, 500)) : [],
						artifacts: result.artifacts,
					};
				}
			}
		}
		const objdump = Bun.which("objdump");
		if (!objdump) return missingTool("objdump", "Install GNU binutils or rizin for disassembly.");
		const result = await runCommand([objdump, "-d", `--disassemble=${params.symbol}`, binary], {
			cwd: this.session.cwd,
			signal,
			session: this.session,
			artifactType: "objdump-disasm",
		});
		if (result.exitCode !== 0)
			return commandFailure(result, undefined, "Neither rizin nor objdump could disassemble the symbol.");
		return {
			ok: true,
			backend: "objdump",
			lines: result.stdout.split(/\r?\n/).filter(Boolean).slice(0, limit(params, 500)),
			artifacts: result.artifacts,
		};
	}

	async #functions(
		params: BinaryInspectParams,
		binary: string,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const executable = Bun.which("rizin");
		if (!executable) return missingTool("rizin", "Install rizin and ensure rizin is on PATH for function analysis.");
		const result = await runCommand([executable, "-q", "-c", "aaa; aflj", binary], {
			cwd: this.session.cwd,
			signal,
			session: this.session,
			artifactType: "rizin-functions",
		});
		if (result.exitCode !== 0) return commandFailure(result, undefined, "rizin function analysis failed.");
		let document: unknown;
		try {
			document = JSON.parse(result.stdout);
		} catch {
			return { ok: false, reason: "parse_failed", hint: "rizin returned non-JSON function output." };
		}
		if (!Array.isArray(document))
			return { ok: false, reason: "parse_failed", hint: "rizin aflj output was not an array." };
		const functions = document
			.map(entry => ({
				name: String(field(entry, "name") ?? "<unknown>"),
				size: Number(field(entry, "size")) || 0,
				address: field(entry, "offset"),
			}))
			.sort((left, right) => right.size - left.size)
			.slice(0, limit(params));
		return { ok: true, functions, total_functions: document.length, artifacts: result.artifacts };
	}

	async #strings(params: BinaryInspectParams, binary: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const executable = Bun.which("strings");
		if (!executable) return missingTool("strings", "Install GNU binutils and ensure strings is on PATH.");
		const minLength = Math.max(1, Math.min(1024, Math.trunc(params.min_len ?? 4)));
		const result = await runCommand([executable, "-n", String(minLength), binary], {
			cwd: this.session.cwd,
			signal,
			session: this.session,
			artifactType: "strings",
		});
		if (result.exitCode !== 0) return commandFailure(result, undefined, "strings could not inspect this file.");
		const strings = result.stdout.split(/\r?\n/).filter(Boolean);
		return {
			ok: true,
			strings: strings.slice(0, limit(params, 200)),
			total_captured: strings.length,
			truncated: result.truncated || strings.length > limit(params, 200),
			artifacts: result.artifacts,
		};
	}

	async #size(params: BinaryInspectParams, binary: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const executable = Bun.which("bloaty");
		if (!executable) return missingTool("bloaty", "Install bloaty and ensure bloaty is on PATH.");
		const baseline = params.baseline ? path.resolve(this.session.cwd, params.baseline) : undefined;
		if (baseline && !(await exists(baseline)))
			return { ok: false, reason: "baseline_missing", hint: `Baseline does not exist: ${baseline}` };
		const result = await runCommand(
			[executable, "--csv", "-d", "sections,symbols", binary, ...(baseline ? ["--", baseline] : [])],
			{
				cwd: this.session.cwd,
				signal,
				session: this.session,
				artifactType: "bloaty",
			},
		);
		if (result.exitCode !== 0)
			return commandFailure(result, undefined, "bloaty failed to inspect or compare this binary.");
		return { ok: true, rows: parseCsv(result.stdout, limit(params, 500)), baseline, artifacts: result.artifacts };
	}
}
