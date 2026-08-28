#!/usr/bin/env bun
/**
 * CLI entry for chudcode session reports (`docs/19-development-tracking-bridge.md` §11).
 *
 * Mirrors `export-cli.ts`: argument parsing throws, the single catch turns any
 * throw into usage output, and the exit code carries the distinction that
 * matters to a workflow step.
 *
 * Exit codes:
 *   0 — the report was rendered and every requested output succeeded
 *   1 — usage or configuration error; nothing was attempted
 *   2 — the JSON record was written but the Discord delivery failed
 *
 * The 0/2 split is the same one `export-cli.ts` draws for unresolved scopes: a
 * run that produced its durable artifact is not a failed run, but it must not be
 * reported as clean either.
 */

import { webhookEnvVar } from "./channels";
import { type NotifyDependencies, redactUrl, webhookUrlFromEnv } from "./notify";
import {
	emitSessionReport,
	type EmitSessionResult,
	type SessionCommit,
	type SessionInput,
	type SessionToolUse,
} from "./session-report";

interface CliArguments {
	input: SessionInput;
	outPath?: string;
	webhookEnv: string;
	dryRun: boolean;
}

export interface ReportCliOverrides {
	env?: Record<string, string | undefined>;
	dependencies?: Partial<NotifyDependencies>;
	stdout?: (text: string) => void;
	stderr?: (text: string) => void;
}

const SINGLE_FLAGS = ["--repo", "--branch", "--model", "--started", "--ended", "--session", "--notes", "--out", "--webhook-env"];
const REPEATED_FLAGS = ["--file", "--commit", "--tool"];

const USAGE = `Usage: bun run report -- --repo <name> --branch <name> --model <id> \\
  --started <iso8601> --ended <iso8601> \\
  [--session <id>] [--notes <text>] [--file <path>]... [--commit <sha[:subject]>]... \\
  [--tool <name[:count]>]... [--out <json-file>] [--webhook-env <VAR>] [--dry-run]

--webhook-env defaults to ${webhookEnvVar("sessions")}; it must hold a discord.com webhook URL.
--dry-run renders the report and prints it, and posts nothing.`;

export async function runReportCli(argv: string[], overrides: ReportCliOverrides = {}): Promise<number> {
	const stdout = overrides.stdout ?? (text => process.stdout.write(text));
	const stderr = overrides.stderr ?? (text => process.stderr.write(text));
	let args: CliArguments;
	let webhookUrl: string | undefined;
	try {
		args = parseArguments(argv);
		// Resolved before anything is written so a bad credential is a clean
		// configuration failure rather than a half-completed run.
		if (!args.dryRun) webhookUrl = webhookUrlFromEnv(args.webhookEnv, overrides.env ?? process.env);
	} catch (error) {
		stderr(`${error instanceof Error ? error.message : "session report failed"}\n${USAGE}\n`);
		return 1;
	}

	let result: EmitSessionResult;
	try {
		result = await emitSessionReport({
			input: args.input,
			dryRun: args.dryRun,
			...(args.outPath ? { outPath: args.outPath } : {}),
			...(webhookUrl ? { webhookUrl } : {}),
			...(overrides.dependencies ? { dependencies: overrides.dependencies } : {}),
		});
	} catch (error) {
		stderr(`${error instanceof Error ? error.message : "session report failed"}\n${USAGE}\n`);
		return 1;
	}

	if (args.dryRun) {
		stdout(`${JSON.stringify({ record: result.record, payload: result.payload }, null, 2)}\n`);
		stdout("Dry run: nothing was posted.\n");
		return 0;
	}

	const summary =
		`Session report: ${result.record.files_touched.length} files, ${result.record.commits.length} commits, ` +
		`${result.record.digest}`;
	if (result.wrote) stdout(`${summary}; record written to ${result.outPath}\n`);
	else stdout(`${summary}\n`);
	if (result.redactedPaths.length > 0) {
		stdout(`Screened ${result.redactedPaths.length} field(s) before sending: ${result.redactedPaths.join(", ")}\n`);
	}

	if (result.deliveryError !== null) {
		stderr(`Discord delivery failed: ${result.deliveryError}\n`);
		return result.wrote ? 2 : 1;
	}
	stdout(`Posted to ${redactUrl(webhookUrl ?? "")} as message ${result.messageId ?? "(no id returned)"}\n`);
	return 0;
}

function parseArguments(argv: string[]): CliArguments {
	const values = new Map<string, string>();
	const repeated = new Map<string, string[]>();
	let dryRun = false;
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--dry-run") {
			dryRun = true;
			continue;
		}
		const isRepeated = REPEATED_FLAGS.includes(argument ?? "");
		if (!isRepeated && !SINGLE_FLAGS.includes(argument ?? "")) {
			throw new Error(`unknown argument: ${argument ?? ""}`);
		}
		const value = argv[++index];
		if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value`);
		if (isRepeated) {
			const bucket = repeated.get(argument) ?? [];
			bucket.push(value);
			repeated.set(argument, bucket);
			continue;
		}
		if (values.has(argument ?? "")) throw new Error(`${argument} may be specified only once`);
		values.set(argument ?? "", value);
	}

	const repo = values.get("--repo");
	const branch = values.get("--branch");
	const model = values.get("--model");
	const started = values.get("--started");
	const ended = values.get("--ended");
	if (!repo) throw new Error("--repo is required");
	if (!branch) throw new Error("--branch is required");
	if (!model) throw new Error("--model is required");
	if (!started) throw new Error("--started is required");
	if (!ended) throw new Error("--ended is required");

	const input: SessionInput = {
		repo,
		branch,
		model,
		startedAt: started,
		endedAt: ended,
		filesTouched: repeated.get("--file") ?? [],
		commits: (repeated.get("--commit") ?? []).map(parseCommit),
		tools: (repeated.get("--tool") ?? []).map(parseTool),
		...(values.get("--session") ? { sessionId: values.get("--session") as string } : {}),
		...(values.get("--notes") ? { notes: values.get("--notes") as string } : {}),
	};
	return {
		input,
		webhookEnv: values.get("--webhook-env") ?? (webhookEnvVar("sessions") as string),
		dryRun,
		...(values.get("--out") ? { outPath: values.get("--out") as string } : {}),
	};
}

/** `<sha>` or `<sha>:<subject>`; a subject may contain colons, so split only once. */
function parseCommit(value: string): SessionCommit {
	const separator = value.indexOf(":");
	if (separator === -1) return { sha: value, subject: "" };
	return { sha: value.slice(0, separator), subject: value.slice(separator + 1).trim() };
}

/** `<name>` counts once; `<name>:<n>` counts n times. */
function parseTool(value: string): SessionToolUse {
	const separator = value.lastIndexOf(":");
	if (separator === -1) return { name: value, count: 1 };
	const count = Number(value.slice(separator + 1));
	if (!Number.isInteger(count) || count < 0) throw new Error(`--tool count must be a non-negative integer: ${value}`);
	return { name: value.slice(0, separator), count };
}

if (import.meta.main) process.exitCode = await runReportCli(process.argv.slice(2));
