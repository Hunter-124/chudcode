export interface SanitizerFrame {
	index: number;
	address?: string;
	function?: string;
	file?: string;
	line?: number;
	col?: number;
}

export interface SanitizerReport {
	kind: string;
	summary: string;
	frames: SanitizerFrame[];
	raw_excerpt: string;
}

const REPORT_START = /^==\d+==(?:ERROR|WARNING):\s+([A-Za-z]+Sanitizer):\s*(.*)$/m;
const FRAME = /^\s*#(\d+)\s+(?:(0x[0-9a-fA-F]+)\s+)?(?:in\s+)?(.*?)\s*$/;
const FRAME_LOCATION = /^(.*?)\s+((?:[A-Za-z]:)?[^\n]+?):(\d+)(?::(\d+))?$/;
const UBSAN = /^((?:[A-Za-z]:)?[^\n:]+):(\d+):(\d+):\s+runtime error:\s+(.+)$/gm;

function parseFrames(block: string): SanitizerFrame[] {
	const frames: SanitizerFrame[] = [];
	for (const line of block.split(/\r?\n/)) {
		const match = FRAME.exec(line);
		if (!match) continue;
		const body = match[3]?.trim() ?? "";
		const location = FRAME_LOCATION.exec(body);
		frames.push({
			index: Number(match[1]),
			...(match[2] ? { address: match[2] } : {}),
			...(location?.[1]?.trim() ? { function: location[1].trim() } : body ? { function: body } : {}),
			...(location?.[2] ? { file: location[2] } : {}),
			...(location?.[3] ? { line: Number(location[3]) } : {}),
			...(location?.[4] ? { col: Number(location[4]) } : {}),
		});
		if (frames.length >= 100) break;
	}
	return frames;
}

export function parseSanitizerOutput(output: string): SanitizerReport[] {
	const lines = output.split(/\r?\n/);
	const reports: SanitizerReport[] = [];
	let start = -1;
	for (let index = 0; index <= lines.length; index++) {
		const line = lines[index] ?? "";
		const isStart = REPORT_START.test(line);
		REPORT_START.lastIndex = 0;
		if ((isStart || index === lines.length) && start >= 0) {
			const block = lines.slice(start, index).join("\n");
			const header = REPORT_START.exec(lines[start]!)!;
			REPORT_START.lastIndex = 0;
			reports.push({
				kind: header[1]!,
				summary: header[2]?.trim() || `${header[1]} report`,
				frames: parseFrames(block),
				raw_excerpt: block.slice(0, 16_000),
			});
		}
		if (isStart) start = index;
		if (reports.length >= 100) break;
	}
	for (const match of output.matchAll(UBSAN)) {
		reports.push({
			kind: "UndefinedBehaviorSanitizer",
			summary: match[4]!,
			frames: [{ index: 0, file: match[1]!, line: Number(match[2]), col: Number(match[3]) }],
			raw_excerpt: match[0].slice(0, 16_000),
		});
		if (reports.length >= 100) break;
	}
	return reports;
}
