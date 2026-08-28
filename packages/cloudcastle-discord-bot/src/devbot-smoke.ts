#!/usr/bin/env bun
/**
 * Headless smoke for the agent half of the session bot: `bun run devbot-smoke`.
 *
 * It runs one real turn through {@link SessionPool} and prints exactly what the
 * Discord thread would have shown -- status block, answer, footer -- without a
 * bot token, a gateway connection, or any guild mutation. That split matters:
 * every failure mode worth debugging (agent spawn, RPC handshake, auth, model
 * resolution, turn settlement, todo polling) lives on this side of Discord, so
 * it should be provable before an operator is standing in front of a silent
 * channel wondering which half is broken.
 *
 * Usage:
 *   bun run devbot-smoke -- [--workspace <name>] [--prompt <text>]
 *
 * `CC_DEVBOT_WORKSPACES` is the only required environment; the operator
 * allowlist and token file are not read, because nothing here talks to Discord.
 */

import { flattenTodos, type ManagedSession, SessionPool } from "./agent-runtime";
import { type DevbotConfig, DevbotConfigError, loadDevbotConfig } from "./devbot-config";
import { renderFooter, renderStatus, splitForDiscord, type TodoLine, TurnAccumulator } from "./transcript";

/** A snowflake-shaped stand-in for the Discord thread id the pool keys on. */
const FAKE_THREAD_ID = "100000000000000001";

const DEFAULT_PROMPT = "Reply with exactly the word ok. Do not use any tools.";

export async function runDevbotSmoke(argv: string[]): Promise<number> {
	let config: DevbotConfig;
	try {
		// The allowlist only guards Discord ingress, and there is none here.
		config = loadDevbotConfig({ ...process.env, CC_DEVBOT_OPERATORS: "100000000000000002" });
	} catch (error) {
		if (error instanceof DevbotConfigError) {
			process.stderr.write(`${error.message}\n`);
			return 1;
		}
		throw error;
	}

	const options = parseArguments(argv);
	const workspace = options.workspace
		? config.workspaces.find(entry => entry.name === options.workspace)
		: config.defaultWorkspace;
	if (!workspace) {
		process.stderr.write(
			`unknown workspace ${options.workspace}; known: ${config.workspaces.map(entry => entry.name).join(", ")}\n`,
		);
		return 1;
	}

	const pool = new SessionPool(config);
	process.stdout.write(`spawning agent in ${workspace.path}\n`);
	const startedAt = Date.now();
	let session: ManagedSession;
	try {
		session = await pool.acquire(FAKE_THREAD_ID, workspace);
	} catch (error) {
		process.stderr.write(`agent failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
	process.stdout.write(`agent up in ${Date.now() - startedAt}ms, session ${session.sessionId ?? "unknown"}\n`);

	const state = await session.state();
	process.stdout.write(
		`model ${state.model ? `${state.model.provider}/${state.model.id}` : "unresolved"}, todos ${flattenTodos(state).length}\n\n`,
	);

	const accumulator = new TurnAccumulator();
	let todos: readonly TodoLine[] = [];
	const turnStartedAt = Date.now();
	const result = await session.runTurn(options.prompt, {
		onEvent: event => {
			accumulator.push(event);
			if (event.type === "tool_execution_start") process.stdout.write(`  tool ${event.toolName}\n`);
		},
		onHeartbeat: latest => {
			todos = latest;
			accumulator.setTodos(latest);
		},
	});
	const elapsed = Date.now() - turnStartedAt;

	const digest = accumulator.digest();
	process.stdout.write(
		[
			"--- status block ---",
			renderStatus(accumulator.status(), todos, elapsed),
			"",
			"--- answer ---",
			splitForDiscord(digest.text).join("\n<<<chunk break>>>\n") || "(no assistant text)",
			"",
			"--- footer ---",
			renderFooter(digest, elapsed),
			result.stats ? `session cost $${result.stats.cost.toFixed(4)}` : "session cost unavailable",
			"",
			`outcome ${result.outcome}${result.detail ? `: ${result.detail}` : ""}`,
			"",
		].join("\n"),
	);

	await pool.forget(FAKE_THREAD_ID);
	await pool.shutdown();
	return result.outcome === "completed" ? 0 : 2;
}

interface SmokeArguments {
	workspace: string | undefined;
	prompt: string;
}

function parseArguments(argv: string[]): SmokeArguments {
	let workspace: string | undefined;
	let prompt = DEFAULT_PROMPT;
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		const value = argv[++index];
		if (!value) throw new Error(`${flag ?? ""} requires a value`);
		if (flag === "--workspace") workspace = value.toLowerCase();
		else if (flag === "--prompt") prompt = value;
		else throw new Error(`unknown argument: ${flag ?? ""}`);
	}
	return { workspace, prompt };
}

if (import.meta.main) process.exitCode = await runDevbotSmoke(process.argv.slice(2));
