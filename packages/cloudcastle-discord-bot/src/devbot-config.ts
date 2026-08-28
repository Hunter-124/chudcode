/**
 * Configuration for the live session bot -- the half of `cc-track` that lets a
 * founder drive a real chudcode agent session from Discord while away from the
 * workstation.
 *
 * This module exists so that every dangerous decision the bot makes is made
 * once, here, from explicit environment input, and is then immutable for the
 * process lifetime. Three of those decisions deserve naming:
 *
 * 1. `operators` is the entire security boundary. The bot runs agent turns with
 *    tool approval disabled by default, so a Discord message from an allowlisted
 *    account is arbitrary code execution on this workstation. There is no second
 *    gate behind it. An empty or unset allowlist is a hard startup failure, not
 *    a permissive default.
 * 2. `workspaces` is a closed set of checkout roots. A session may be started in
 *    one of these directories and nowhere else, so a mistyped or hostile
 *    workspace name is refused rather than resolved relative to whatever the bot
 *    process happens to be sitting in.
 * 3. The bot token is read from an owner-only file, never from the environment,
 *    matching the archive slice's posture in `archive.ts`. Environment variables
 *    leak into child processes, and this process deliberately spawns children.
 *
 * The agent child is launched from this checkout's own `coding-agent` source
 * rather than a globally installed `omp`, so a session always runs the code that
 * ships beside this bot.
 */

import { homedir } from "node:os";
import path from "node:path";
import { readOwnerOnlyFile } from "./archive";
import { CHANNELS } from "./channels";

/**
 * OAuth permission integer a session-capable install needs, as a decimal string
 * for the authorize URL. Decomposition, verified bit by bit:
 * Add Reactions (1<<6) 64, View Channels (1<<10) 1024, Send Messages (1<<11)
 * 2048, Embed Links (1<<14) 16384, Attach Files (1<<15) 32768, Read Message
 * History (1<<16) 65536, Manage Threads (1<<34) 17179869184, Create Public
 * Threads (1<<35) 34359738368, Send Messages in Threads (1<<38) 274877906944.
 *
 * Deliberately absent: Administrator, Manage Channels, Manage Guild, Manage
 * Roles, Manage Messages, Mention Everyone, Kick Members, Ban Members. The bot
 * cannot delete a channel, delete someone else's message, or touch a role.
 */
export const DEVBOT_PERMISSIONS = "326417632320";

export type ApprovalMode = "always-ask" | "write" | "yolo";

const APPROVAL_MODES: readonly ApprovalMode[] = ["always-ask", "write", "yolo"];

/** A checkout a session is allowed to run in. `name` is what Discord types. */
export interface WorkspaceRoot {
	readonly name: string;
	readonly path: string;
}

export interface DevbotConfig {
	/** Owner-only file holding the bot token. Never an environment variable. */
	readonly tokenFile: string;
	/** Discord user ids permitted to drive sessions. Never empty. */
	readonly operators: ReadonlySet<string>;
	readonly workspaces: readonly WorkspaceRoot[];
	readonly defaultWorkspace: WorkspaceRoot;
	/** Passed straight to `--model`, so fuzzy names like `opus` work. */
	readonly model: string | undefined;
	readonly approvalMode: ApprovalMode;
	/** Ceiling on concurrent agent child processes. */
	readonly maxSessions: number;
	/** Reap an agent child after this long with no prompt. */
	readonly idleTimeoutMs: number;
	/** Abort a turn that has not settled within this window. */
	readonly turnTimeoutMs: number;
	/** Where the thread -> agent-session map is persisted across restarts. */
	readonly stateDir: string;
	/** The one channel whose messages and threads the bot answers. */
	readonly sessionsChannelId: string;
	/** argv prefix for the agent child; `--mode rpc` and friends are appended. */
	readonly agentCommand: readonly string[];
}

/** Thrown for every configuration problem so the CLI can exit 1 without a stack. */
export class DevbotConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DevbotConfigError";
	}
}

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_MAX_SESSIONS = 3;

/** This checkout's root, resolved the same way `archive.ts` and `notify.ts` do. */
export const CHUDCODE_ROOT = path.resolve(import.meta.dir, "../../..");

/** Where the operator keeps the bot token and the bot keeps its thread map. */
const DEVBOT_DIR = path.join(homedir(), ".config", "cloudcastle", "devbot");

export function loadDevbotConfig(env: Record<string, string | undefined> = process.env): DevbotConfig {
	const operators = parseIdList(env.CC_DEVBOT_OPERATORS);
	if (operators.size === 0) {
		throw new DevbotConfigError(
			"CC_DEVBOT_OPERATORS must list at least one Discord user id; an empty allowlist would let the whole guild run code on this workstation",
		);
	}

	const workspaces = parseWorkspaces(env.CC_DEVBOT_WORKSPACES);
	const defaultName = env.CC_DEVBOT_DEFAULT_WORKSPACE?.trim();
	const defaultWorkspace = defaultName ? workspaces.find(workspace => workspace.name === defaultName) : workspaces[0];
	if (!defaultWorkspace) {
		throw new DevbotConfigError(
			`CC_DEVBOT_DEFAULT_WORKSPACE=${defaultName ?? ""} names no workspace; known workspaces: ${workspaces
				.map(workspace => workspace.name)
				.join(", ")}`,
		);
	}

	const approvalMode = (env.CC_DEVBOT_APPROVAL_MODE?.trim() || "yolo") as ApprovalMode;
	if (!APPROVAL_MODES.includes(approvalMode)) {
		throw new DevbotConfigError(`CC_DEVBOT_APPROVAL_MODE must be one of ${APPROVAL_MODES.join(", ")}`);
	}

	const model = env.CC_DEVBOT_MODEL?.trim();

	return {
		tokenFile: path.resolve(env.CC_DEVBOT_TOKEN_FILE?.trim() || path.join(DEVBOT_DIR, "discord-token")),
		operators,
		workspaces,
		defaultWorkspace,
		model: model || undefined,
		approvalMode,
		maxSessions: parsePositiveInteger(env.CC_DEVBOT_MAX_SESSIONS, DEFAULT_MAX_SESSIONS, "CC_DEVBOT_MAX_SESSIONS"),
		idleTimeoutMs: parsePositiveInteger(
			env.CC_DEVBOT_IDLE_TIMEOUT_MS,
			DEFAULT_IDLE_TIMEOUT_MS,
			"CC_DEVBOT_IDLE_TIMEOUT_MS",
		),
		turnTimeoutMs: parsePositiveInteger(
			env.CC_DEVBOT_TURN_TIMEOUT_MS,
			DEFAULT_TURN_TIMEOUT_MS,
			"CC_DEVBOT_TURN_TIMEOUT_MS",
		),
		stateDir: path.resolve(env.CC_DEVBOT_STATE_DIR?.trim() || path.join(DEVBOT_DIR, "state")),
		sessionsChannelId: CHANNELS.sessions.id,
		agentCommand: ["bun", path.join(CHUDCODE_ROOT, "packages", "coding-agent", "src", "cli.ts")],
	};
}

/** The workspace a prompt names, or `undefined` when the name is not allowlisted. */
export function resolveWorkspace(config: DevbotConfig, name: string | undefined): WorkspaceRoot | undefined {
	if (!name) return config.defaultWorkspace;
	return config.workspaces.find(workspace => workspace.name === name.toLowerCase());
}

/**
 * Read the bot token through the same owner-only guard the archive exporter
 * applies, so a token file readable by `BUILTIN\Users` refuses to start the bot
 * instead of quietly running with a world-readable credential.
 */
export async function readDevbotToken(config: DevbotConfig): Promise<string> {
	try {
		return await readOwnerOnlyFile(config.tokenFile, "Discord bot token");
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new DevbotConfigError(`cannot read the bot token from ${config.tokenFile}: ${detail}`);
	}
}

function parseIdList(raw: string | undefined): ReadonlySet<string> {
	const ids = new Set<string>();
	for (const entry of (raw ?? "").split(",")) {
		const id = entry.trim();
		if (!id) continue;
		if (!/^\d{15,25}$/.test(id)) {
			throw new DevbotConfigError(`CC_DEVBOT_OPERATORS entry ${id} is not a Discord user id (decimal snowflake)`);
		}
		ids.add(id);
	}
	return ids;
}

/**
 * Parse `name=path` pairs. Names are lowercased because they are typed on a
 * phone keyboard, where capitalisation is not something to be precise about.
 */
function parseWorkspaces(raw: string | undefined): readonly WorkspaceRoot[] {
	const workspaces: WorkspaceRoot[] = [];
	const seen = new Set<string>();
	for (const entry of (raw ?? "").split(",")) {
		const pair = entry.trim();
		if (!pair) continue;
		const separator = pair.indexOf("=");
		if (separator <= 0) {
			throw new DevbotConfigError(`CC_DEVBOT_WORKSPACES entry ${pair} must be name=absolute-path`);
		}
		const name = pair.slice(0, separator).trim().toLowerCase();
		const target = pair.slice(separator + 1).trim();
		if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
			throw new DevbotConfigError(`CC_DEVBOT_WORKSPACES name ${name} must be alphanumeric with . _ -`);
		}
		if (!path.isAbsolute(target)) {
			throw new DevbotConfigError(`CC_DEVBOT_WORKSPACES path for ${name} must be absolute, got ${target}`);
		}
		if (seen.has(name)) throw new DevbotConfigError(`CC_DEVBOT_WORKSPACES declares ${name} twice`);
		seen.add(name);
		workspaces.push({ name, path: path.resolve(target) });
	}
	if (workspaces.length === 0) {
		throw new DevbotConfigError(
			"CC_DEVBOT_WORKSPACES must list at least one name=absolute-path checkout the bot may run agents in",
		);
	}
	return workspaces;
}

function parsePositiveInteger(raw: string | undefined, fallback: number, label: string): number {
	const text = raw?.trim();
	if (!text) return fallback;
	const value = Number(text);
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new DevbotConfigError(`${label} must be a positive integer, got ${text}`);
	}
	return value;
}
