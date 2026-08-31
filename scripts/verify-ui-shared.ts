#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import * as path from "node:path";

interface FontFile {
	file: string;
	path: string;
	family: string;
	weight: number;
	sha256: string;
}

interface SharedManifest {
	schema: string;
	contractVersion: number;
	semanticRoles: string[];
	surfaceRoleSemantics: Record<string, string>;
	tones: string[];
	densities: string[];
	animationSeconds: Record<string, number>;
	usageThresholds: { warning: number; critical: number };
	iconPipeline: {
		version: string;
		manifest: string;
		generator: string;
		cellSizes: number[];
		license: string;
	};
	fonts: {
		license: { spdx: string; text: string };
		provenance: Record<string, string>;
		files: FontFile[];
	};
	chudcodeImplementation: {
		themeHeader: string;
		animationHeader: string;
		kitHeader: string;
	};
}

interface VerificationPaths {
	themeHeader: string;
	animationHeader: string;
	kitHeader: string;
	iconManifest: string;
	fontsDir?: string;
	fontLicense: string;
}

interface Arguments {
	root: string;
	manifestPath: string;
	overrides: Partial<VerificationPaths>;
}

function parseArgs(): Arguments {
	let root = path.resolve(import.meta.dir, "..");
	let manifestPath: string | undefined;
	const overrides: Partial<VerificationPaths> = {};
	const overrideByFlag: Record<string, keyof VerificationPaths> = {
		"--theme-header": "themeHeader",
		"--animation-header": "animationHeader",
		"--kit-header": "kitHeader",
		"--icon-manifest": "iconManifest",
		"--fonts-dir": "fontsDir",
		"--font-license": "fontLicense",
	};
	for (let index = 2; index < process.argv.length; ++index) {
		const argument = process.argv[index];
		const separator = argument.indexOf("=");
		const flag = separator >= 0 ? argument.slice(0, separator) : argument;
		const inlineValue = separator >= 0 ? argument.slice(separator + 1) : undefined;
		if (flag === "--root") {
			const value = inlineValue ?? process.argv[++index];
			if (!value) throw new Error("--root requires a path");
			root = path.resolve(value);
		} else if (flag === "--manifest") {
			const value = inlineValue ?? process.argv[++index];
			if (!value) throw new Error("--manifest requires a path");
			manifestPath = path.resolve(value);
		} else if (overrideByFlag[flag]) {
			const value = inlineValue ?? process.argv[++index];
			if (!value) throw new Error(`${flag} requires a repository-relative path`);
			overrides[overrideByFlag[flag]] = value;
		} else {
			throw new Error(`unknown argument: ${argument}`);
		}
	}
	return {
		root,
		manifestPath: manifestPath ?? path.join(root, "assets", "ui-shared-manifest.json"),
		overrides,
	};
}

const failures: string[] = [];

function drift(location: string, expected: unknown, actual: unknown): void {
	failures.push(`${location}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function expectEqual(location: string, expected: unknown, actual: unknown): void {
	if (JSON.stringify(expected) !== JSON.stringify(actual)) drift(location, expected, actual);
}

function expectUnique(location: string, values: string[]): void {
	const duplicates = [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
	if (duplicates.length > 0) drift(location, "unique values", duplicates);
}

function readRequired(filePath: string, label: string): string {
	if (!existsSync(filePath)) {
		drift(label, "existing file", "missing");
		return "";
	}
	return readFileSync(filePath, "utf8");
}

function cppQuotedArray(source: string, name: string): string[] {
	const start = source.indexOf(name);
	if (start < 0) return [];
	const end = source.indexOf("});", start);
	if (end < 0) return [];
	return [...source.slice(start, end).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function cppEnum(source: string, name: string): string[] {
	const match = source.match(new RegExp(`enum\\s+class\\s+${name}\\s*\\{([^}]+)\\}`));
	return match ? match[1].split(",").map((value) => value.trim()).filter(Boolean) : [];
}

function cppNumber(source: string, name: string): number | undefined {
	const match = source.match(new RegExp(`\\b${name}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)f?\\b`));
	return match ? Number(match[1]) : undefined;
}

function sha256(filePath: string): string {
	return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function loadManifest(manifestPath: string): SharedManifest {
	const text = readRequired(manifestPath, "manifest");
	try {
		return JSON.parse(text) as SharedManifest;
	} catch (error) {
		throw new Error(`invalid JSON in ${manifestPath}: ${String(error)}`);
	}
}

function verifyManifestShape(manifest: SharedManifest): void {
	expectEqual("schema", "chud-ui-shared-v1", manifest.schema);
	expectEqual("contractVersion", 1, manifest.contractVersion);
	expectUnique("semanticRoles", manifest.semanticRoles);
	expectUnique("tones", manifest.tones);
	expectUnique("densities", manifest.densities);
	const cadDomainPrefixes = [
		"viewport", "plane", "sketch", "sim", "flow", "cam", "fit", "plan",
		"parts", "ribbon",
	];
	for (const role of manifest.semanticRoles) {
		const matched = cadDomainPrefixes.find((prefix) => role.toLowerCase().startsWith(prefix));
		if (matched) drift(`semanticRoles.${role}`, "general cross-product role", `CAD-domain prefix ${matched}`);
	}
	for (const font of manifest.fonts.files) {
		if (path.isAbsolute(font.path) || font.path.split(/[\\/]/).includes("..")) {
			drift(`fonts.${font.file}.path`, "repository-relative path", font.path);
		}
	}
	if (!(manifest.usageThresholds.warning >= 0 &&
		manifest.usageThresholds.warning < manifest.usageThresholds.critical &&
		manifest.usageThresholds.critical <= 1)) {
		drift("usageThresholds", "0 <= warning < critical <= 1", manifest.usageThresholds);
	}
	for (const role of Object.keys(manifest.surfaceRoleSemantics)) {
		if (!manifest.semanticRoles.includes(role)) drift(`surfaceRoleSemantics.${role}`, "declared semantic role", "missing");
	}
	for (const role of [
		"usageTrack", "usageOk", "usageWarn", "usageErr", "usageUnknown",
		"attachmentBg", "attachmentBorder", "attachmentHovered", "attachmentSelected",
		"dagEdge", "dagEdgeActive", "dagNodeBg", "dagNodeHovered",
	]) {
		if (!manifest.surfaceRoleSemantics[role]) drift(`surfaceRoleSemantics.${role}`, "non-empty semantics", manifest.surfaceRoleSemantics[role]);
	}
}

function verifyTheme(root: string, manifest: SharedManifest, paths: VerificationPaths): void {
	const theme = readRequired(path.join(root, paths.themeHeader), paths.themeHeader);
	const animation = readRequired(path.join(root, paths.animationHeader), paths.animationHeader);
	const kit = readRequired(path.join(root, paths.kitHeader), paths.kitHeader);

	expectEqual("theme.kManifestSchema", manifest.schema, cppQuotedArray(theme, "kManifestSchema")[0]);
	expectEqual("theme.kSharedSemanticRoleNames", manifest.semanticRoles,
		cppQuotedArray(theme, "kSemanticRoleNames"));
	expectEqual("theme.kToneNames", manifest.tones, cppQuotedArray(theme, "kToneNames"));
	expectEqual("theme.kDensityNames", manifest.densities, cppQuotedArray(theme, "kDensityNames"));
	expectEqual("kit.Tone", manifest.tones, cppEnum(kit, "Tone"));
	expectEqual("kit.Density", manifest.densities, cppEnum(kit, "Density"));

	for (const role of manifest.semanticRoles) {
		if (!new RegExp(`\\bImVec4\\s+${role}\\s*;`).test(theme)) {
			drift(`theme.Palette.${role}`, "ImVec4 field", "missing");
		}
	}

	const animationNames: Record<string, string> = {
		instant: "kInstant",
		fast: "kFast",
		base: "kBase",
		slow: "kSlow",
		stagger: "kStagger",
		breathe: "kBreathe",
		march: "kMarch",
		maxDeltaTime: "kMaxDeltaTime",
	};
	for (const [manifestName, cppName] of Object.entries(animationNames)) {
		expectEqual(`animation.${cppName}`, manifest.animationSeconds[manifestName], cppNumber(animation, cppName));
	}

	const thresholdBlock = theme.match(/kUsageThresholds\s*\{([^}]+)\}/)?.[1] ?? "";
	const thresholdValues = [...thresholdBlock.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
	expectEqual("theme.kUsageThresholds", [manifest.usageThresholds.warning, manifest.usageThresholds.critical], thresholdValues);
	expectEqual("theme.kIconPipelineVersion", manifest.iconPipeline.version,
		cppQuotedArray(theme, "kIconPipelineVersion")[0]);

	const fontBlock = theme.slice(theme.indexOf("kFontAssets"), theme.indexOf("});", theme.indexOf("kFontAssets")));
	const fontPairs = [...fontBlock.matchAll(/\{"([^"]+)",\s*"([a-f0-9]{64})"\}/g)]
		.map((match) => ({ file: match[1], sha256: match[2] }));
	expectEqual("theme.kFontAssets", manifest.fonts.files.map(({ file, sha256 }) => ({ file, sha256 })), fontPairs);
}

function verifyAssets(root: string, manifest: SharedManifest, paths: VerificationPaths): void {
	const licensePath = path.join(root, paths.fontLicense);
	const license = readRequired(licensePath, paths.fontLicense);
	expectEqual("fonts.license.spdx", "OFL-1.1", manifest.fonts.license.spdx);
	for (const marker of ["SIL OPEN FONT LICENSE Version 1.1", "The Rubik Project Authors", "The JetBrains Mono Project Authors"]) {
		if (!license.includes(marker)) drift(`fonts.license.text:${marker}`, "present", "missing");
	}

	for (const font of manifest.fonts.files) {
		const fontPath = path.join(root, paths.fontsDir ?? path.dirname(font.path), font.file);
		if (!existsSync(fontPath)) {
			drift(`fonts.${font.file}`, font.sha256, "missing");
			continue;
		}
		if (lstatSync(fontPath).isSymbolicLink()) {
			drift(`fonts.${font.file}.storage`, "regular vendored file", "symbolic link");
			continue;
		}
		expectEqual(`fonts.${font.file}.sha256`, font.sha256, sha256(fontPath));
	}

	const atlasText = readRequired(path.join(root, paths.iconManifest), paths.iconManifest);
	if (atlasText) {
		try {
			const atlas = JSON.parse(atlasText) as { schema?: string; generator?: string; cell_sizes?: number[] };
			expectEqual("iconPipeline.version", manifest.iconPipeline.version, atlas.schema);
			expectEqual("iconPipeline.generator", manifest.iconPipeline.generator, atlas.generator);
			expectEqual("iconPipeline.cellSizes", manifest.iconPipeline.cellSizes, atlas.cell_sizes);
		} catch (error) {
			drift("iconPipeline.manifest", "valid JSON", String(error));
		}
	}
}

function main(): void {
	const { root, manifestPath, overrides } = parseArgs();
	const manifest = loadManifest(manifestPath);
	const paths: VerificationPaths = {
		themeHeader: manifest.chudcodeImplementation.themeHeader,
		animationHeader: manifest.chudcodeImplementation.animationHeader,
		kitHeader: manifest.chudcodeImplementation.kitHeader,
		iconManifest: manifest.iconPipeline.manifest,
		fontLicense: manifest.fonts.license.text,
		...overrides,
	};
	verifyManifestShape(manifest);
	verifyTheme(root, manifest, paths);
	verifyAssets(root, manifest, paths);
	if (failures.length > 0) {
		for (const failure of failures) console.error(`UI shared drift: ${failure}`);
		process.exitCode = 1;
		return;
	}
	console.log(`UI shared contract verified: ${manifest.schema} (${manifest.semanticRoles.length} roles, ${manifest.fonts.files.length} fonts)`);
}

try {
	main();
} catch (error) {
	console.error(`UI shared verifier error: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
