import { describe, expect, it } from "bun:test";
import { parseClangTidy } from "@oh-my-pi/pi-coding-agent/tools/analyzers/clang-tidy-parse";
import { parseDhatJson } from "@oh-my-pi/pi-coding-agent/tools/analyzers/dhat-json";
import { parseMiRecord } from "@oh-my-pi/pi-coding-agent/tools/analyzers/gdb-mi";
import { parseSanitizerOutput } from "@oh-my-pi/pi-coding-agent/tools/analyzers/sanitizer-parse";
import { parseSarif } from "@oh-my-pi/pi-coding-agent/tools/analyzers/sarif";
import { parseValgrindXml } from "@oh-my-pi/pi-coding-agent/tools/analyzers/valgrind-xml";

describe("native analyzer result parsers", () => {
	it("normalizes SARIF and clang-tidy findings", () => {
		const sarif = parseSarif({
			runs: [
				{
					tool: { driver: { name: "cppcheck" } },
					results: [
						{
							ruleId: "nullPointer",
							level: "error",
							message: { text: "Null pointer dereference" },
							locations: [
								{
									physicalLocation: {
										artifactLocation: { uri: "src/main.c" },
										region: { startLine: 12, startColumn: 4 },
									},
								},
							],
						},
					],
				},
			],
		});
		expect(sarif).toEqual([
			{
				tool: "cppcheck",
				rule: "nullPointer",
				severity: "error",
				file: "src/main.c",
				line: 12,
				col: 4,
				message: "Null pointer dereference",
			},
		]);
		expect(parseClangTidy("src/main.cc:9:3: warning: use nullptr [modernize-use-nullptr]")).toEqual([
			{
				tool: "clang-tidy",
				rule: "modernize-use-nullptr",
				severity: "warning",
				file: "src/main.cc",
				line: 9,
				col: 3,
				message: "use nullptr",
			},
		]);
	});

	it("extracts sanitizer and Valgrind source frames", () => {
		const sanitizer = parseSanitizerOutput(
			`==42==ERROR: AddressSanitizer: heap-use-after-free on address 0x1234\n    #0 0xabc in main /tmp/uaf.c:14:7\nSUMMARY: AddressSanitizer: heap-use-after-free /tmp/uaf.c:14 in main\n`,
		);
		expect(sanitizer[0]?.kind).toBe("AddressSanitizer");
		expect(sanitizer[0]?.summary).toContain("heap-use-after-free");
		expect(sanitizer[0]?.frames[0]).toMatchObject({ function: "main", file: "/tmp/uaf.c", line: 14, col: 7 });

		const valgrind = parseValgrindXml(`
			<valgrindoutput><error><kind>InvalidRead</kind><what>Invalid read of size 4</what>
			<stack><frame><ip>0x1</ip><fn>main</fn><dir>/tmp</dir><file>uaf.c</file><line>14</line></frame></stack>
			</error></valgrindoutput>`);
		expect(valgrind).toEqual([
			{
				kind: "InvalidRead",
				message: "Invalid read of size 4",
				frames: [{ ip: "0x1", function: "main", directory: "/tmp", file: "uaf.c", line: 14 }],
			},
		]);
	});

	it("parses nested GDB-MI values and ranks DHAT allocation points", () => {
		const record = parseMiRecord('7^done,bkpt={number="1",addr="0x401000"}');
		expect(record).toMatchObject({
			token: 7,
			type: "result",
			class: "done",
			results: { bkpt: { number: "1", addr: "0x401000" } },
		});

		const points = parseDhatJson(
			{
				ftbl: ["main (uaf.c:4)", "allocate (alloc.c:8)"],
				pps: [
					{ tb: 64, tbk: 1, mb: 64, mbk: 1, eb: 0, ebk: 0, fs: [0] },
					{ tb: 4096, tbk: 8, mb: 1024, mbk: 2, eb: 128, ebk: 1, fs: [1] },
				],
			},
			1,
		);
		expect(points).toEqual([
			{
				total_bytes: 4096,
				total_blocks: 8,
				max_bytes: 1024,
				max_blocks: 2,
				end_bytes: 128,
				end_blocks: 1,
				frames: ["allocate (alloc.c:8)"],
			},
		]);
	});
});
