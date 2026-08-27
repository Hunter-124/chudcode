export type DiffLineKind = "context" | "addition" | "deletion" | "no-newline";

export interface DiffLine {
	id: string;
	kind: DiffLineKind;
	content: string;
	oldLine: number | null;
	newLine: number | null;
}

export interface DiffHunk {
	id: string;
	header: string;
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: DiffLine[];
	raw: string;
}

export type DiffFileStatus = "added" | "deleted" | "modified" | "renamed" | "copied" | "binary";

export interface DiffFile {
	id: string;
	oldPath: string | null;
	newPath: string | null;
	status: DiffFileStatus;
	headers: string[];
	hunks: DiffHunk[];
	binary: boolean;
}

export interface UnifiedDiff {
	files: DiffFile[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/;

function stableId(prefix: string, value: string): string {
	// FNV-1a 64-bit. IDs are display identities, not security boundaries.
	let hash = 0xcbf29ce484222325n;
	for (const byte of new TextEncoder().encode(value)) {
		hash ^= BigInt(byte);
		hash = BigInt.asUintN(64, hash * 0x100000001b3n);
	}
	return `${prefix}:${hash.toString(16).padStart(16, "0")}`;
}

function decodeGitQuotedPath(value: string): string {
	if (!value.startsWith('"')) return value;
	if (!value.endsWith('"')) throw new Error(`Malformed quoted Git path: ${value}`);
	const input = value.slice(1, -1);
	const bytes: number[] = [];
	for (let index = 0; index < input.length; index += 1) {
		const character = input[index]!;
		if (character !== "\\") {
			for (const byte of new TextEncoder().encode(character)) bytes.push(byte);
			continue;
		}
		const escaped = input[++index];
		if (escaped === undefined) throw new Error(`Malformed quoted Git path: ${value}`);
		const simple: Record<string, number> = {
			a: 7,
			b: 8,
			t: 9,
			n: 10,
			v: 11,
			f: 12,
			r: 13,
			'"': 34,
			"\\": 92,
		};
		if (escaped in simple) {
			bytes.push(simple[escaped]!);
			continue;
		}
		if (/[0-7]/.test(escaped)) {
			let octal = escaped;
			while (octal.length < 3 && index + 1 < input.length && /[0-7]/.test(input[index + 1]!)) {
				octal += input[++index];
			}
			bytes.push(Number.parseInt(octal, 8));
			continue;
		}
		bytes.push(...new TextEncoder().encode(escaped));
	}
	return new TextDecoder().decode(Uint8Array.from(bytes));
}

function parseDiffGitPaths(line: string): [string, string] {
	const input = line.slice("diff --git ".length);
	const tokens: string[] = [];
	let index = 0;
	while (tokens.length < 2 && index < input.length) {
		while (input[index] === " ") index += 1;
		const start = index;
		if (input[index] === '"') {
			index += 1;
			let escaped = false;
			while (index < input.length) {
				const current = input[index++]!;
				if (current === '"' && !escaped) break;
				escaped = current === "\\" && !escaped;
				if (current !== "\\") escaped = false;
			}
			tokens.push(input.slice(start, index));
		} else {
			while (index < input.length && input[index] !== " ") index += 1;
			tokens.push(input.slice(start, index));
		}
	}
	if (tokens.length !== 2) throw new Error(`Malformed diff header: ${line}`);
	return tokens.map(token => decodeGitQuotedPath(token).replace(/^[ab]\//, "")) as [string, string];
}

function pathFromMarker(line: string): string | null {
	const raw = line.slice(4).split("\t", 1)[0]!;
	if (raw === "/dev/null") return null;
	return decodeGitQuotedPath(raw).replace(/^[ab]\//, "");
}

function statusFor(
	headers: readonly string[],
	oldPath: string | null,
	newPath: string | null,
	binary: boolean,
): DiffFileStatus {
	if (binary) return "binary";
	if (headers.some(line => line.startsWith("rename from "))) return "renamed";
	if (headers.some(line => line.startsWith("copy from "))) return "copied";
	if (oldPath === null) return "added";
	if (newPath === null) return "deleted";
	return "modified";
}

/** Parse ordinary `git diff` unified output without reordering files, hunks, or lines. */
export function parseUnifiedDiff(unified: string): UnifiedDiff {
	const normalized = unified.replace(/\r\n/g, "\n");
	const lines = normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
	if (lines.length === 1 && lines[0] === "") return { files: [] };

	const files: DiffFile[] = [];
	let index = 0;
	while (index < lines.length) {
		if (!lines[index]!.startsWith("diff --git ")) {
			index += 1;
			continue;
		}

		const firstHeader = lines[index]!;
		const fallbackPaths = parseDiffGitPaths(firstHeader);
		const headers: string[] = [lines[index++]!];
		while (index < lines.length && !lines[index]!.startsWith("@@ ") && !lines[index]!.startsWith("diff --git ")) {
			headers.push(lines[index++]!);
		}

		let oldPath: string | null = fallbackPaths[0];
		let newPath: string | null = fallbackPaths[1];
		const oldMarker = headers.find(line => line.startsWith("--- "));
		const newMarker = headers.find(line => line.startsWith("+++ "));
		if (oldMarker !== undefined) oldPath = pathFromMarker(oldMarker);
		if (newMarker !== undefined) newPath = pathFromMarker(newMarker);
		const renameFrom = headers.find(line => line.startsWith("rename from "));
		const renameTo = headers.find(line => line.startsWith("rename to "));
		if (renameFrom !== undefined) oldPath = decodeGitQuotedPath(renameFrom.slice("rename from ".length));
		if (renameTo !== undefined) newPath = decodeGitQuotedPath(renameTo.slice("rename to ".length));
		const binary = headers.some(line => line.startsWith("Binary files ") || line === "GIT binary patch");
		const fileIdentity = `${oldPath ?? "/dev/null"}\0${newPath ?? "/dev/null"}`;
		const fileId = stableId("file", fileIdentity);
		const hunks: DiffHunk[] = [];

		while (index < lines.length && lines[index]!.startsWith("@@ ")) {
			const header = lines[index++]!;
			const match = HUNK_HEADER.exec(header);
			if (match === null) throw new Error(`Malformed hunk header: ${header}`);
			const oldStart = Number(match[1]);
			const oldLines = match[2] === undefined ? 1 : Number(match[2]);
			const newStart = Number(match[3]);
			const newLines = match[4] === undefined ? 1 : Number(match[4]);
			const rawLines = [header];
			const parsedLines: DiffLine[] = [];
			let oldLine = oldStart;
			let newLine = newStart;
			let lineOrdinal = 0;

			while (index < lines.length && !lines[index]!.startsWith("@@ ") && !lines[index]!.startsWith("diff --git ")) {
				const raw = lines[index++]!;
				rawLines.push(raw);
				let kind: DiffLineKind;
				let currentOld: number | null = null;
				let currentNew: number | null = null;
				if (raw.startsWith("+")) {
					kind = "addition";
					currentNew = newLine++;
				} else if (raw.startsWith("-")) {
					kind = "deletion";
					currentOld = oldLine++;
				} else if (raw.startsWith(" ")) {
					kind = "context";
					currentOld = oldLine++;
					currentNew = newLine++;
				} else if (raw === "\\ No newline at end of file") {
					kind = "no-newline";
				} else {
					throw new Error(`Malformed hunk line: ${raw}`);
				}
				const hunkSeed = `${fileIdentity}\0${header}\0${hunks.length}`;
				parsedLines.push({
					id: stableId("line", `${hunkSeed}\0${lineOrdinal++}`),
					kind,
					content: kind === "no-newline" ? raw : raw.slice(1),
					oldLine: currentOld,
					newLine: currentNew,
				});
			}

			const hunkId = stableId("hunk", `${fileIdentity}\0${header}\0${hunks.length}\0${rawLines.join("\n")}`);
			hunks.push({
				id: hunkId,
				header,
				oldStart,
				oldLines,
				newStart,
				newLines,
				lines: parsedLines,
				raw: `${rawLines.join("\n")}\n`,
			});
		}

		files.push({
			id: fileId,
			oldPath,
			newPath,
			status: statusFor(headers, oldPath, newPath, binary),
			headers,
			hunks,
			binary,
		});
	}
	return { files };
}

export function patchForHunk(file: DiffFile, hunkId: string): string {
	if (file.binary) throw new Error("Binary diffs cannot be applied by hunk");
	if (file.status === "renamed" || file.status === "copied") {
		throw new Error("Rename and copy diffs cannot be partially applied safely");
	}
	if (
		file.headers.some(
			line =>
				line.startsWith("old mode ") ||
				line.startsWith("new mode ") ||
				(line.startsWith("deleted file mode ") && file.hunks.length > 1) ||
				(line.startsWith("new file mode ") && file.hunks.length > 1),
		)
	) {
		throw new Error("Mode-changing and multi-hunk add/delete diffs cannot be partially applied safely");
	}
	const hunk = file.hunks.find(candidate => candidate.id === hunkId);
	if (hunk === undefined) throw new Error("Selected hunk is stale or does not belong to the file");
	if (!file.headers.some(line => line.startsWith("--- ")) || !file.headers.some(line => line.startsWith("+++ "))) {
		throw new Error("Diff is missing file markers required for a safe patch");
	}
	return `${file.headers.join("\n")}\n${hunk.raw}`;
}
