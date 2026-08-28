#!/usr/bin/env bun

/**
 * Entry point for the live session bot: `bun run devbot`.
 *
 * The process is the bot. It holds an outbound websocket to Discord, so nothing
 * inbound needs to be exposed, but if this process stops, Discord control stops
 * with it -- see `RUNBOOK-DEVBOT.md` §4 for keeping it alive across a workday.
 *
 * Startup prints the effective configuration so a silent bot can be diagnosed
 * from its own first ten lines of output. The token never appears; only the path
 * it was read from.
 */

import { type DevbotHandle, startDevbot } from "./devbot";
import { type DevbotConfig, DevbotConfigError, loadDevbotConfig } from "./devbot-config";

export async function runDevbotCli(): Promise<number> {
	let config: DevbotConfig;
	try {
		config = loadDevbotConfig();
	} catch (error) {
		if (error instanceof DevbotConfigError) {
			process.stderr.write(`${error.message}\nSee packages/cloudcastle-discord-bot/RUNBOOK-DEVBOT.md §3\n`);
			return 1;
		}
		throw error;
	}

	process.stdout.write(
		[
			"devbot configuration",
			`  token file       ${config.tokenFile}`,
			`  operators        ${Array.from(config.operators).join(", ")}`,
			`  workspaces       ${config.workspaces.map(entry => `${entry.name}=${entry.path}`).join(", ")}`,
			`  default          ${config.defaultWorkspace.name}`,
			`  model            ${config.model ?? "(session default)"}`,
			`  approval mode    ${config.approvalMode}`,
			`  max sessions     ${config.maxSessions}`,
			`  idle timeout     ${config.idleTimeoutMs}ms`,
			`  turn timeout     ${config.turnTimeoutMs}ms`,
			`  state dir        ${config.stateDir}`,
			`  sessions channel ${config.sessionsChannelId}`,
			"",
		].join("\n"),
	);
	if (config.approvalMode === "yolo") {
		process.stdout.write(
			"approval mode is yolo: every operator on the allowlist can run arbitrary code on this workstation through Discord.\n\n",
		);
	}

	let handle: DevbotHandle;
	try {
		handle = await startDevbot(config);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		process.stderr.write(`devbot failed to start: ${detail}\n`);
		return 1;
	}

	const exit = Promise.withResolvers<void>();
	let stopping = false;
	const shutdown = (signal: string): void => {
		if (stopping) return;
		stopping = true;
		process.stdout.write(`\ndevbot stopping on ${signal}\n`);
		void handle
			.stop()
			.catch((error: unknown) => {
				const detail = error instanceof Error ? error.message : String(error);
				process.stderr.write(`devbot shutdown was not clean: ${detail}\n`);
			})
			.finally(() => exit.resolve());
	};
	process.once("SIGINT", () => shutdown("SIGINT"));
	process.once("SIGTERM", () => shutdown("SIGTERM"));

	await exit.promise;
	return 0;
}

if (import.meta.main) process.exitCode = await runDevbotCli();
