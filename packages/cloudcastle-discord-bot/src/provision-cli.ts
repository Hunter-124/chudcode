#!/usr/bin/env bun
/**
 * Dry-run or apply the CloudCastle guild layout declared in `channels.ts`.
 *
 * Usage:
 *   bun src/provision-cli.ts --token-file <owner-only-file> [--guild <id>]
 *     [--dry-run | --apply] [--flatten-threads]
 *
 * `--dry-run` is the default and needs no mutating permission, so the plan is
 * reviewable before the bot is re-invited. `--apply` must be passed explicitly
 * and feeds `applyProvision` the exact plan the dry run printed.
 *
 * `--flatten-threads` adds the one-time thread migration: every mapped thread's
 * messages are reposted into its parent channel with a header carrying the
 * original thread, author, and timestamp. Off unless asked for, idempotent, and
 * it never deletes the source thread. It refuses while the MESSAGE_CONTENT
 * privileged intent is off, because every message body reads as empty until then.
 *
 * Exit codes:
 *   0  the plan was computed, and under `--apply` every action succeeded.
 *   1  an error: bad arguments, an unreadable token file, an id in `channels.ts`
 *      that no longer matches the guild, unreadable source content for
 *      `--flatten-threads`, or a REST failure.
 *   2  blocked on a missing permission. Reported by `--dry-run` as well, so a
 *      plan that cannot be applied yet says so without anything being attempted.
 */

import path from "node:path";
import { DiscordRest, type DiscordRestClient } from "./discord-rest";
import {
	applyProvision,
	describeAction,
	PermissionPreflightError,
	planProvision,
	type ProvisionPlan,
} from "./provision";

interface CliArguments {
	guildId?: string;
	tokenFile: string;
	apply: boolean;
	flattenThreads: boolean;
}

const USAGE = `Usage: bun src/provision-cli.ts --token-file <owner-only-file> [--guild <id>] [--dry-run | --apply] [--flatten-threads]`;

/**
 * `dependencies.rest` overrides the token-file transport. Same seam as
 * `ExportGuildOptions.dependencies` in `archive.ts`: it is how the exit-code
 * contract above is tested without a live guild.
 */
export async function runProvisionCli(argv: string[], dependencies?: { rest?: DiscordRestClient }): Promise<number> {
	let args: CliArguments;
	try {
		args = parseArguments(argv);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : "bad arguments"}\n${USAGE}\n`);
		return 1;
	}

	try {
		const rest = dependencies?.rest ?? new DiscordRest({ tokenFile: args.tokenFile });
		const plan = await planProvision({
			rest,
			flattenThreads: args.flattenThreads,
			...(args.guildId ? { guildId: args.guildId } : {}),
		});
		process.stdout.write(renderPlan(plan, args.apply));

		if (!args.apply) return plan.permissions.missing.length > 0 ? 2 : 0;

		const report = await applyProvision(plan, { rest });
		process.stdout.write(
			`\napplied ${report.requests.length} call(s):\n${report.requests
				.map(request => `  ${request.operation.padEnd(14)} ${request.target}  (${request.kind} ${request.key})`)
				.join("\n")}\n`,
		);
		if (report.unpinned.length > 0) {
			process.stdout.write(
				`\nDiscord refused to pin ${report.unpinned.length} seed message(s) (MANAGE_MESSAGES is missing):\n${report.unpinned
					.map(entry => `  ${entry}`)
					.join("\n")}\nThey were posted and will be matched from channel history next run, not reposted.\n`,
			);
		}
		return 0;
	} catch (error) {
		if (error instanceof PermissionPreflightError) {
			process.stderr.write(`${error.message}\n`);
			return 2;
		}
		process.stderr.write(`${error instanceof Error ? error.message : "provision failed"}\n`);
		return 1;
	}
}

function renderPlan(plan: ProvisionPlan, apply: boolean): string {
	const lines = [
		`provision ${apply ? "apply" : "dry-run"} for guild ${plan.guildId}`,
		`bot ${plan.botUsername || "(unnamed)"} (${plan.botUserId})`,
		"",
	];

	if (plan.permissions.administrator) {
		lines.push("permissions: ADMINISTRATOR (all mutating permissions implied)");
	} else if (plan.permissions.missing.length === 0) {
		lines.push("permissions: every mutating permission present");
	} else {
		lines.push(
			`permissions: MISSING ${plan.permissions.missing
				.map(entry => `${entry.name} (bit ${entry.bit})`)
				.join(", ")}`,
		);
		for (const entry of plan.permissions.missing) lines.push(`  ${entry.name} is needed to ${entry.needed}`);
		lines.push(`  re-invite the application with permissions=${plan.permissions.reinvitePermissions}`);
		lines.push(apply ? "  APPLY IS BLOCKED" : "  this plan is reviewable now; applying it is blocked until then");
	}
	lines.push("");

	if (plan.actions.length === 0) {
		lines.push("0 actions: the guild already matches the target layout");
	} else {
		lines.push(`${plan.actions.length} action(s):`);
		for (const action of plan.actions) lines.push(`  ${describeAction(action)}`);
	}

	if (plan.notes.length > 0) {
		lines.push("", "notes:");
		for (const note of plan.notes) lines.push(`  - ${note}`);
	}

	lines.push("");
	return lines.join("\n");
}

function parseArguments(argv: string[]): CliArguments {
	const values: Record<string, string> = {};
	let dryRun = false;
	let apply = false;
	let flattenThreads = false;
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index] ?? "";
		if (argument === "--dry-run") {
			dryRun = true;
			continue;
		}
		if (argument === "--apply") {
			apply = true;
			continue;
		}
		if (argument === "--flatten-threads") {
			flattenThreads = true;
			continue;
		}
		if (!["--guild", "--token-file"].includes(argument)) throw new Error(`unknown argument: ${argument}`);
		const value = argv[++index];
		if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
		if (values[argument]) throw new Error(`${argument} may be specified only once`);
		values[argument] = value;
	}
	if (dryRun && apply) throw new Error("--dry-run and --apply are mutually exclusive");
	const tokenFile = values["--token-file"];
	if (!tokenFile) throw new Error("--token-file is required; environment tokens are not accepted");
	const guildId = values["--guild"];
	if (guildId !== undefined && !/^\d+$/.test(guildId)) throw new Error("--guild must be a decimal snowflake string");
	return { tokenFile: path.resolve(tokenFile), apply, flattenThreads, ...(guildId ? { guildId } : {}) };
}

if (import.meta.main) process.exitCode = await runProvisionCli(process.argv.slice(2));
