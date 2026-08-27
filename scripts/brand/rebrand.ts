#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";

export interface RuleHit {
	readonly rule: string;
	readonly count: number;
}

export interface TransformResult {
	readonly text: string;
	readonly hits: readonly RuleHit[];
}

interface BrandRule {
	readonly name: string;
	readonly pattern: RegExp;
	readonly replacement: string;
	readonly scope: "all" | "docs" | "source";
}

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../..");
const TEXT_EXTENSIONS: Record<string, true> = {
	".cjs": true,
	".css": true,
	".html": true,
	".js": true,
	".json": true,
	".jsonc": true,
	".jsx": true,
	".md": true,
	".mjs": true,
	".ps1": true,
	".sh": true,
	".toml": true,
	".ts": true,
	".tsx": true,
	".txt": true,
	".yaml": true,
	".yml": true,
};
const SKIPPED_SEGMENTS: Record<string, true> = {
	".git": true,
	".turbo": true,
	build: true,
	evidence: true,
	coverage: true,
	dist: true,
	generated: true,
	"graphify-out": true,
	node_modules: true,
	target: true,
	vendor: true,
};

// Ordered, most-specific first. The intermediate Chudware Code identity is
// migrated before upstream names so rerunning the codemod on either baseline
// converges on the same Chudcode result. Explicitly labelled compatibility
// commands remain untouched, as do persisted paths, package names, upstream
// URLs, CAD vendoring imports, and glued homonyms.
const BRAND_RULES: readonly BrandRule[] = [
	{
		name: "legacy-display-name",
		pattern: /\bChudware Code\b/g,
		replacement: "Chudcode",
		scope: "all",
	},
	{
		name: "legacy-cli-command",
		pattern: /\bchudware-code\b(?![^\n]*\b(?:compatibility (?:alias(?:es)?|command(?:s)?)|legacy alias)\b)/g,
		replacement: "chudcode",
		scope: "all",
	},
	{
		name: "private-repository",
		pattern: /(?<!--from https:\/\/github\.com\/)Hunter-124\/(?:omp|oh-my-pi)\b/g,
		replacement: "Hunter-124/chudcode",
		scope: "docs",
	},
	{
		name: "cli-command-backtick",
		pattern: /`omp(?=\s|`)(?!`(?:-based|\s+legacy))/g,
		replacement: "`chudcode",
		scope: "all",
	},
	{
		name: "cli-command-subshell",
		pattern: /(\$\()omp(?=\s)/g,
		replacement: "$1chudcode",
		scope: "docs",
	},
	{
		name: "cli-command-shell",
		pattern: /^(\s*(?:\$ )?)omp(?!\s+legacy alias)(?=\s|$)/gm,
		replacement: "$1chudcode",
		scope: "docs",
	},
	{
		name: "display-name-title",
		pattern: /\bOh My Pi\b/g,
		replacement: "Chudcode",
		scope: "all",
	},
	{
		name: "display-name-slug",
		pattern: /(?<![\/.@])\boh-my-pi\b(?!\/)/g,
		replacement: "Chudcode",
		scope: "docs",
	},
	{
		name: "cli-command-source-token",
		pattern: /(?<!based on )(?<![\/.@-])\bomp\b(?=\s)/g,
		replacement: "chudcode",
		scope: "source",
	},
	{
		name: "display-name-uppercase",
		pattern: /\bOMP\b(?![._A-Za-z0-9])/g,
		replacement: "Chudcode",
		scope: "all",
	},
	{
		name: "display-name-lowercase-docs",
		pattern: /(?<!based on )(?<![\/.@#`-])\bomp\b(?![\/._-]|\s+legacy alias)/g,
		replacement: "Chudcode",
		scope: "docs",
	},
	{
		name: "display-article-lowercase",
		pattern: /\ban Chudcode\b/g,
		replacement: "a Chudcode",
		scope: "all",
	},
	{
		name: "display-article-title",
		pattern: /\bAn Chudcode\b/g,
		replacement: "A Chudcode",
		scope: "all",
	},
];

interface PreservePattern {
	readonly name: string;
	readonly pattern: RegExp;
	readonly exactMatches?: true;
}

const PRESERVE_PATTERNS: readonly PreservePattern[] = [
	{ name: "@oh-my-pi/", pattern: /@oh-my-pi\//g },
	{ name: "pi-coding-agent", pattern: /pi-coding-agent/g },
	{ name: "PI_", pattern: /\bPI_/g },
	{ name: "OMP_", pattern: /\bOMP_/g },
	{ name: ".omp", pattern: /\.omp\b/g },
	{ name: "can1357/oh-my-pi", pattern: /can1357\/oh-my-pi/g },
	{ name: "omp-stats", pattern: /omp-stats/g },
	{ name: "LICENSE", pattern: /LICENSE/g },
	{ name: "copyright lines", pattern: /^.*copyright.*$/gim, exactMatches: true },
];

function applies(rule: BrandRule, relativePath: string): boolean {
	if (rule.name === "legacy-cli-command" && relativePath === "packages/coding-agent/src/brand.ts") return false;
	if (rule.scope === "all") return true;
	const docsPath = relativePath === "README.md" || relativePath.startsWith("docs/");
	if (rule.scope === "docs") return docsPath;
	if (rule.name === "cli-command-source-token") {
		if (relativePath.endsWith("/cli/profile-alias.ts") || relativePath.endsWith("/commands/init-xdg.ts")) return false;
		const sourceRelativePath = relativePath.replace("packages/coding-agent/src/", "");
		return (
			sourceRelativePath.startsWith("cli/") ||
			sourceRelativePath.startsWith("commands/") ||
			sourceRelativePath.startsWith("config/") ||
			sourceRelativePath.startsWith("export/html/") ||
			sourceRelativePath.startsWith("modes/") ||
			sourceRelativePath.startsWith("prompts/") ||
			sourceRelativePath.startsWith("slash-commands/") ||
			sourceRelativePath === "cli.ts" ||
			sourceRelativePath === "cli-commands.ts" ||
			sourceRelativePath === "main.ts" ||
			sourceRelativePath === "sdk.ts" ||
			sourceRelativePath === "utils/resume-command.ts"
		);
	}
	return relativePath.startsWith("packages/coding-agent/src/");
}

function countMatches(text: string, pattern: RegExp): number {
	return Array.from(text.matchAll(new RegExp(pattern.source, pattern.flags))).length;
}

export function transformText(text: string, relativePath: string): TransformResult {
	let transformed = text;
	const hits: RuleHit[] = [];
	for (const rule of BRAND_RULES) {
		if (!applies(rule, relativePath)) continue;
		const count = countMatches(transformed, rule.pattern);
		if (count === 0) continue;
		transformed = transformed.replace(rule.pattern, rule.replacement);
		hits.push({ rule: rule.name, count });
	}
	return { text: transformed, hits };
}

function isTarget(relativePath: string): boolean {
	if (
		relativePath !== "README.md" &&
		!relativePath.startsWith("docs/") &&
		!relativePath.startsWith("packages/coding-agent/src/")
	) {
		return false;
	}
	const basename = path.basename(relativePath).toLowerCase();
	if (basename.includes("license") || basename.includes("notice")) return false;
	if (!TEXT_EXTENSIONS[path.extname(relativePath)]) return false;
	return !relativePath.split("/").some(segment => SKIPPED_SEGMENTS[segment]);
}

function trackedTargetFiles(): string[] {
	const result = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: REPOSITORY_ROOT, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		throw new Error(`git ls-files failed: ${result.stderr.toString().trim()}`);
	}
	return result.stdout
		.toString()
		.split("\0")
		.filter(Boolean)
		.filter(isTarget)
		.filter(relativePath => !fs.lstatSync(path.join(REPOSITORY_ROOT, relativePath)).isSymbolicLink())
		.sort();
}

function preserveMatches(contents: readonly string[]): Record<string, readonly string[]> {
	const matches: Record<string, readonly string[]> = {};
	const corpus = contents.join("\n");
	for (const preserved of PRESERVE_PATTERNS) {
		matches[preserved.name] = Array.from(
			corpus.matchAll(new RegExp(preserved.pattern.source, preserved.pattern.flags)),
			match => (preserved.exactMatches ? match[0] : ""),
		);
	}
	return matches;
}

function main(): void {
	const args = process.argv.slice(2);
	if (args.some(arg => arg !== "--dry-run" && arg !== "--apply")) {
		throw new Error("Usage: bun scripts/brand/rebrand.ts [--dry-run|--apply]");
	}
	if (args.includes("--dry-run") && args.includes("--apply")) {
		throw new Error("Choose exactly one mode: --dry-run or --apply");
	}
	const applyChanges = args.includes("--apply");
	const files = trackedTargetFiles();
	const beforeContents: string[] = [];
	const afterContents: string[] = [];
	const changed: Array<{ readonly path: string; readonly text: string; readonly hits: readonly RuleHit[] }> = [];
	const totals: Record<string, number> = {};

	for (const relativePath of files) {
		const absolutePath = path.join(REPOSITORY_ROOT, relativePath);
		const before = fs.readFileSync(absolutePath, "utf8");
		const result = transformText(before, relativePath);
		beforeContents.push(before);
		afterContents.push(result.text);
		if (result.text === before) continue;
		changed.push({ path: relativePath, text: result.text, hits: result.hits });
		for (const hit of result.hits) totals[hit.rule] = (totals[hit.rule] ?? 0) + hit.count;
	}

	const beforePreserved = preserveMatches(beforeContents);
	const afterPreserved = preserveMatches(afterContents);
	process.stdout.write(`Mode: ${applyChanges ? "apply" : "dry-run"}\n`);
	for (const file of changed) {
		process.stdout.write(`${file.path}\n`);
		for (const hit of file.hits) process.stdout.write(`  ${hit.rule}: ${hit.count}\n`);
	}
	const totalHits = Object.values(totals).reduce((sum, count) => sum + count, 0);
	process.stdout.write(`Summary: ${changed.length} files, ${totalHits} hits\n`);
	for (const rule of BRAND_RULES) process.stdout.write(`  ${rule.name}: ${totals[rule.name] ?? 0}\n`);
	process.stdout.write("Preserve audit:\n");
	let preserved = true;
	for (const item of PRESERVE_PATTERNS) {
		const before = beforePreserved[item.name] ?? [];
		const after = afterPreserved[item.name] ?? [];
		const exactMatchesPreserved =
			!item.exactMatches || (before.length === after.length && before.every((value, index) => value === after[index]));
		const ok = before.length === after.length && exactMatchesPreserved;
		preserved &&= ok;
		process.stdout.write(`  ${item.name}: ${before.length} -> ${after.length} ${ok ? "OK" : "CHANGED"}\n`);
	}
	if (!preserved) throw new Error("Preserve audit failed; no files were safe to apply");
	if (applyChanges) {
		for (const file of changed) fs.writeFileSync(path.join(REPOSITORY_ROOT, file.path), file.text);
	}
	process.stdout.write(`Preserve audit: PASS (${PRESERVE_PATTERNS.length} invariants unchanged)\n`);
}

if (import.meta.main) main();
