#!/usr/bin/env bun
import { promises as fs } from "node:fs";
import path from "node:path";
import { type ArchiveMode, exportGuild } from "./archive";

interface CliArguments {
	guildId: string;
	outputDir: string;
	mode: ArchiveMode;
	cutoffsPath?: string;
	tokenFile: string;
	ageRecipientFile?: string;
}

const USAGE = `Usage: bun run export -- --guild <id> --out <directory> (--before-mutate | --final-delta) \\
  [--cutoffs <json-file>] --token-file <owner-only-file> [--age-recipient-file <file>]`;

export async function runExportCli(argv: string[]): Promise<number> {
	try {
		const args = parseArguments(argv);
		const cutoffByChannel = args.cutoffsPath ? await readCutoffs(args.cutoffsPath) : undefined;
		const manifest = await exportGuild({
			guildId: args.guildId,
			outputDir: args.outputDir,
			mode: args.mode,
			cutoffByChannel,
			tokenFile: args.tokenFile,
			ageRecipientFile: args.ageRecipientFile,
		});
		process.stdout.write(
			`Discord archive written: ${manifest.scopes.length} scopes, ${manifest.scopes.reduce((sum, scope) => sum + scope.message_count, 0)} messages, ${manifest.unresolved.length} unresolved\n`,
		);
		return manifest.unresolved.length === 0 ? 0 : 2;
	} catch (error) {
		const safeMessage = error instanceof Error ? error.message : "Discord archive export failed";
		process.stderr.write(`${safeMessage}\n${USAGE}\n`);
		return 1;
	}
}

function parseArguments(argv: string[]): CliArguments {
	const values = new Map<string, string>();
	let beforeMutate = false;
	let finalDelta = false;
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--before-mutate") {
			beforeMutate = true;
			continue;
		}
		if (argument === "--final-delta") {
			finalDelta = true;
			continue;
		}
		if (!["--guild", "--out", "--cutoffs", "--token-file", "--age-recipient-file"].includes(argument ?? "")) {
			throw new Error(`unknown argument: ${argument ?? ""}`);
		}
		const value = argv[++index];
		if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
		if (values.has(argument ?? "")) throw new Error(`${argument} may be specified only once`);
		values.set(argument ?? "", value);
	}
	if (beforeMutate === finalDelta) throw new Error("choose exactly one of --before-mutate or --final-delta");
	const guildId = values.get("--guild");
	const outputDir = values.get("--out");
	const tokenFile = values.get("--token-file");
	if (!guildId || !/^\d+$/.test(guildId)) throw new Error("--guild must be a decimal snowflake string");
	if (!outputDir) throw new Error("--out is required");
	if (!tokenFile) throw new Error("--token-file is required; environment tokens are not accepted");
	return {
		guildId,
		outputDir: path.resolve(outputDir),
		tokenFile: path.resolve(tokenFile),
		mode: beforeMutate ? "before-mutate" : "final-delta",
		...(values.get("--cutoffs") ? { cutoffsPath: path.resolve(values.get("--cutoffs") as string) } : {}),
		...(values.get("--age-recipient-file")
			? { ageRecipientFile: path.resolve(values.get("--age-recipient-file") as string) }
			: {}),
	};
}

async function readCutoffs(filePath: string): Promise<Record<string, string>> {
	const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("--cutoffs must contain a JSON object");
	const cutoffs: Record<string, string> = {};
	for (const [channelId, messageId] of Object.entries(parsed)) {
		if (!/^\d+$/.test(channelId) || typeof messageId !== "string" || !/^\d+$/.test(messageId)) {
			throw new Error("--cutoffs keys and values must be decimal snowflake strings");
		}
		cutoffs[channelId] = messageId;
	}
	return cutoffs;
}

if (import.meta.main) process.exitCode = await runExportCli(process.argv.slice(2));
