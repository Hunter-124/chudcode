#!/usr/bin/env bun
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import * as fsx from "@oh-my-pi/pi-utils/fsx";
import { compareSecurityProducers, importCodexSecurityBundle, parseSecurityScanBundle } from "../src/security";

async function readBundle(directory: string) {
	const root = path.resolve(directory);
	let scan: unknown;
	try {
		scan = JSON.parse(await fsx.readText(path.join(root, "scan.json"))) as unknown;
	} catch (error) {
		if (!isEnoent(error)) throw error;
		return importCodexSecurityBundle(root, { repositoryRoot: root });
	}
	const findings = JSON.parse(await fsx.readText(path.join(root, "findings.json"))) as unknown;
	const report = await fsx.readText(path.join(root, "report.md")).catch(() => undefined);
	const sarifText = await fsx.readText(path.join(root, "results.sarif")).catch(() => undefined);
	return parseSecurityScanBundle({
		scan,
		findings,
		report,
		sarif: sarifText ? (JSON.parse(sarifText) as Record<string, unknown>) : undefined,
	});
}

const [referenceDirectory, candidateDirectory, outputPath] = process.argv.slice(2);
if (!referenceDirectory || !candidateDirectory) {
	process.stderr.write(
		"Usage: bun scripts/security-compare.ts <reference-scan-dir> <candidate-scan-dir> [output.json]\n",
	);
	process.exit(2);
}
const report = compareSecurityProducers(await readBundle(referenceDirectory), await readBundle(candidateDirectory));
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) await Bun.write(path.resolve(outputPath), serialized);
else process.stdout.write(serialized);
