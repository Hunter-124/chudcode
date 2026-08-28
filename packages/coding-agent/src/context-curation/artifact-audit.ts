import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const MANAGED_MARKER_RE = /<!--\s*chudcode-managed-artifact:v1\s+sha256:([a-f0-9]{64})\s+terminal:(true|false)\s*-->/i;
const EXPLICIT_HISTORICAL_RE =
	/(?:^|\n)(?:#{1,6}\s+.*\b(?:superseded|obsolete)\b|(?:status|state)\s*[:=-]\s*(?:superseded|archived|obsolete)\b|\*\*(?:superseded|obsolete)\*\*)/i;
const AUDITED_EXTENSIONS: Readonly<Record<string, true>> = {
	".json": true,
	".jsonl": true,
	".md": true,
	".txt": true,
	".yaml": true,
	".yml": true,
};
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MANAGED_ROOT = ".chudcode/context/generated/";

export type ArtifactCurationAction = "keep" | "review" | "archive" | "deduplicate" | "remove";

export interface ArtifactCurationDecision {
	path: string;
	action: ArtifactCurationAction;
	confidence: number;
	reason: string;
	managed: boolean;
	terminal: boolean;
	tracked: boolean;
	sha256: string;
	referencedBy: string[];
	duplicateOf?: string;
}

export interface ArtifactAuditReport {
	version: 1;
	root: string;
	generatedAt: string;
	filesScanned: number;
	decisions: ArtifactCurationDecision[];
	removed: string[];
	errors: Array<{ path: string; message: string }>;
}

interface ArtifactRecord {
	path: string;
	absolutePath: string;
	content: string;
	tracked: boolean;
	sha256: string;
	managed: boolean;
	terminal: boolean;
	expectedHash?: string;
	managedBodyHash?: string;
	explicitHistorical: boolean;
	referencedBy: string[];
	duplicateOf?: string;
}

export interface ArtifactAuditOptions {
	root: string;
	apply?: boolean;
	now?: () => Date;
}

export async function auditProjectArtifacts(options: ArtifactAuditOptions): Promise<ArtifactAuditReport> {
	const root = path.resolve(options.root);
	const tracked = new Set(await listGitFiles(root, ["--cached"]));
	const listed = await listGitFiles(root, ["--cached", "--others", "--exclude-standard"]);
	const errors: ArtifactAuditReport["errors"] = [];
	const records: ArtifactRecord[] = [];
	for (const relativePath of listed) {
		if (!isAuditedArtifact(relativePath)) continue;
		const absolutePath = path.resolve(root, relativePath);
		if (!isWithinRoot(root, absolutePath)) continue;
		try {
			const stat = await fs.stat(absolutePath);
			if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
			const content = await fs.readFile(absolutePath, "utf8");
			const marker = MANAGED_MARKER_RE.exec(content);
			const body = marker ? content.replace(marker[0], "") : content;
			records.push({
				path: toPosix(relativePath),
				absolutePath,
				content,
				tracked: tracked.has(toPosix(relativePath)),
				sha256: sha256(content),
				managed: marker !== null,
				terminal: marker?.[2]?.toLowerCase() === "true",
				...(marker?.[1] ? { expectedHash: marker[1].toLowerCase(), managedBodyHash: sha256(body) } : {}),
				explicitHistorical: EXPLICIT_HISTORICAL_RE.test(content.slice(0, 16_384)),
				referencedBy: [],
			});
		} catch (error) {
			errors.push({ path: toPosix(relativePath), message: error instanceof Error ? error.message : String(error) });
		}
	}

	const firstByHash = new Map<string, ArtifactRecord>();
	for (const record of records) {
		const first = firstByHash.get(record.sha256);
		if (first) record.duplicateOf = first.path;
		else firstByHash.set(record.sha256, record);
	}
	for (const target of records) {
		const references: string[] = [];
		const basename = path.posix.basename(target.path);
		for (const source of records) {
			if (source.path === target.path) continue;
			if (source.content.includes(target.path) || source.content.includes(`](${basename})`))
				references.push(source.path);
		}
		target.referencedBy = references.sort();
	}

	const decisions = records.map(assessArtifact).sort(compareDecisions);
	const removed: string[] = [];
	if (options.apply) {
		for (const decision of decisions) {
			if (decision.action !== "remove" || decision.confidence !== 1) continue;
			const record = records.find(candidate => candidate.path === decision.path);
			if (!record?.path.startsWith(MANAGED_ROOT)) continue;
			const current = await fs.readFile(record.absolutePath, "utf8");
			const marker = MANAGED_MARKER_RE.exec(current);
			if (marker?.[2]?.toLowerCase() !== "true") continue;
			const currentBodyHash = sha256(current.replace(marker[0], ""));
			if (currentBodyHash !== marker[1]?.toLowerCase() || currentBodyHash !== record.managedBodyHash) continue;
			await fs.unlink(record.absolutePath);
			removed.push(record.path);
		}
	}

	return {
		version: 1,
		root,
		generatedAt: (options.now ?? (() => new Date()))().toISOString(),
		filesScanned: records.length,
		decisions,
		removed,
		errors,
	};
}

export function assessArtifact(record: Omit<ArtifactRecord, "absolutePath" | "content">): ArtifactCurationDecision {
	const base = {
		path: record.path,
		managed: record.managed,
		terminal: record.terminal,
		tracked: record.tracked,
		sha256: record.sha256,
		referencedBy: record.referencedBy,
		...(record.duplicateOf ? { duplicateOf: record.duplicateOf } : {}),
	};
	if (
		record.managed &&
		record.terminal &&
		record.path.startsWith(MANAGED_ROOT) &&
		record.expectedHash !== undefined &&
		record.expectedHash === record.managedBodyHash &&
		record.referencedBy.length === 0
	) {
		return {
			...base,
			action: "remove",
			confidence: 1,
			reason: "terminal Chudcode-managed artifact; body hash and zero-reference proof match",
		};
	}
	if (record.explicitHistorical && record.referencedBy.length === 0) {
		return {
			...base,
			action: "archive",
			confidence: 0.95,
			reason: "explicit historical marker with no discovered references; human review required",
		};
	}
	if (record.duplicateOf && record.referencedBy.length === 0) {
		return {
			...base,
			action: "deduplicate",
			confidence: 0.9,
			reason: "exact duplicate bytes with no discovered references; human review required",
		};
	}
	if (record.managed && (record.expectedHash !== record.managedBodyHash || record.referencedBy.length > 0)) {
		return {
			...base,
			action: "review",
			confidence: 0,
			reason: "managed artifact changed or referenced; automatic cleanup refused",
		};
	}
	return { ...base, action: "keep", confidence: 1, reason: "no deletion-grade evidence" };
}

async function listGitFiles(root: string, args: string[]): Promise<string[]> {
	const process = Bun.spawn(["git", "ls-files", "-z", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).arrayBuffer(),
		new Response(process.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(`git ls-files failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
	return new TextDecoder().decode(stdout).split("\0").filter(Boolean).map(toPosix);
}

function isAuditedArtifact(relativePath: string): boolean {
	const normalized = toPosix(relativePath);
	if (!AUDITED_EXTENSIONS[path.posix.extname(normalized).toLowerCase()]) return false;
	if (normalized.startsWith("docs/") || normalized.startsWith(MANAGED_ROOT)) return true;
	return !normalized.includes("/") && /(?:plan|decision|todo|roadmap|meeting|notes?)/i.test(normalized);
}

function isWithinRoot(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function compareDecisions(left: ArtifactCurationDecision, right: ArtifactCurationDecision): number {
	const rank: Readonly<Record<ArtifactCurationAction, number>> = {
		remove: 0,
		archive: 1,
		deduplicate: 2,
		review: 3,
		keep: 4,
	};
	return rank[left.action] - rank[right.action] || left.path.localeCompare(right.path);
}

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function toPosix(value: string): string {
	return value.split(path.sep).join(path.posix.sep);
}
