#!/usr/bin/env bun
/**
 * cc-gateway: exactly one instance, guild-wide.
 *
 * It owns the only gateway socket in the system, registers the slash commands,
 * acknowledges interactions, and publishes `CommandRecord`s onto the bus. It
 * never touches a session, never spawns a process, and never reads a session
 * file -- that is cc-agent's job, on the machine that owns the session. All the
 * gateway knows about the fleet is what the agents heartbeat.
 *
 * Intents: `Guilds` only. Slash commands and interactions need no privileged
 * intent, and this app does not have MESSAGE_CONTENT.
 *
 * Every command defers its reply first. Discord gives an interaction three
 * seconds before it goes stale, and the round trip through the bus is bounded
 * by the agent's poll interval, which is longer than that on a bad day.
 */

import * as path from "node:path";
import { Client, GatewayIntentBits, REST, Routes } from "discord.js";
import type { AutocompleteInteraction, ChatInputCommandInteraction, Message } from "discord.js";
import {
	AGENT_STALE_AFTER_MS,
	BUS_PROTOCOL_VERSION,
	COMMAND_POLL_INTERVAL_MS,
	type BusRecord,
	type CommandName,
	type CommandRecord,
	type CommandResult,
	type SessionSnapshot,
} from "./bridge-protocol";
import { Bus } from "./bus";
import { CHANNEL_IDS, GUILD_ID } from "./channels";
import { DiscordRest, readOwnerOnlyFile, DEFAULT_TOKEN_FILE } from "./discord-rest";
import { taskStatusLabel } from "./session-render";

/** Bun's `Timer`, Node's `Timeout`, the DOM's number. */
type TimerHandle = ReturnType<typeof setInterval>;

/** How long an interaction waits for the agent's first answer before saying so. */
export const COMMAND_RESULT_TIMEOUT_MS = 25_000;
/** Discord's ceiling on autocomplete choices. */
export const MAX_AUTOCOMPLETE_CHOICES = 25;

// ---------------------------------------------------------------------------
// Fleet view, assembled purely from heartbeats
// ---------------------------------------------------------------------------

export interface HostView {
	readonly host: string;
	/** Nothing heard within the staleness window. The host is presumed offline. */
	readonly stale: boolean;
	readonly ageMs: number;
	readonly projects: readonly string[];
	readonly chudcodeVersion: string;
	readonly sessions: readonly SessionSnapshot[];
}

export interface LocatedSession {
	readonly host: string;
	readonly snapshot: SessionSnapshot;
}

/**
 * Last heartbeat per host. Heartbeats are absolute, not incremental, so a later
 * one wholly replaces its predecessor and there is nothing to reconcile.
 */
export class HeartbeatRegistry {
	readonly #byHost = new Map<string, { sentAt: number; heartbeat: BusRecord & { kind: "agent.heartbeat" } }>();

	ingest(record: BusRecord): void {
		if (record.kind !== "agent.heartbeat") return;
		const sentAt = Date.parse(record.sentAt);
		if (!Number.isFinite(sentAt)) return;
		const known = this.#byHost.get(record.host);
		if (known && known.sentAt > sentAt) return;
		this.#byHost.set(record.host, { sentAt, heartbeat: record });
	}

	hosts(now: Date): HostView[] {
		const views: HostView[] = [];
		for (const { sentAt, heartbeat } of this.#byHost.values()) {
			const ageMs = now.getTime() - sentAt;
			views.push({
				host: heartbeat.host,
				stale: ageMs > AGENT_STALE_AFTER_MS,
				ageMs,
				projects: heartbeat.projects,
				chudcodeVersion: heartbeat.chudcodeVersion,
				sessions: heartbeat.sessions,
			});
		}
		return views.sort((left, right) => left.host.localeCompare(right.host));
	}

	liveHosts(now: Date): HostView[] {
		return this.hosts(now).filter(view => !view.stale);
	}

	findSession(sessionId: string, now: Date): LocatedSession | null {
		for (const view of this.hosts(now)) {
			const snapshot = view.sessions.find(candidate => candidate.sessionId === sessionId);
			if (snapshot) return { host: view.host, snapshot };
		}
		return null;
	}

	findSessionByChannel(channelId: string, now: Date): LocatedSession | null {
		for (const view of this.hosts(now)) {
			const snapshot = view.sessions.find(candidate => candidate.channelId === channelId);
			if (snapshot) return { host: view.host, snapshot };
		}
		return null;
	}
}

export function renderTaskList(views: readonly HostView[]): string {
	const tasks = views.flatMap(view =>
		view.sessions
			.filter(session => session.channelId)
			.map(session => ({ view, session })),
	);
	if (tasks.length === 0) {
		return "No Discord tasks are active or recently completed. Use `/task start` to begin one.";
	}
	const active = tasks.filter(({ session }) => !["complete", "aborted", "error"].includes(session.status));
	const completed = tasks.filter(({ session }) => ["complete", "aborted", "error"].includes(session.status));
	const lines: string[] = ["**Active tasks**"];
	if (active.length === 0) lines.push("None.");
	for (const { view, session } of active) {
		const offline = view.stale ? " · runner offline" : "";
		lines.push(`- <#${session.channelId}> · ${taskStatusLabel(session.status)}${offline} · ${session.title ?? "Untitled task"}`);
	}
	if (completed.length > 0) {
		lines.push("", "**Recently completed**");
		for (const { session } of completed.slice(0, 8)) {
			lines.push(`- <#${session.channelId}> · ${taskStatusLabel(session.status)} · ${session.title ?? "Untitled task"}`);
		}
	}
	return lines.join("\n").slice(0, 1_900);
}

export function renderTaskStatus(located: LocatedSession): string {
	const { snapshot } = located;
	const channel = snapshot.channelId ? `<#${snapshot.channelId}>` : "Task channel unavailable";
	const summary = snapshot.lastText?.trim() || "No progress summary is available yet.";
	return `**${snapshot.title ?? "Untitled task"}**
${taskStatusLabel(snapshot.status)} · ${channel}

**Latest update**
${summary}`.slice(0, 1_900);
}

export interface Choice {
	readonly name: string;
	readonly value: string;
}

export function hostChoices(views: readonly HostView[], query: string): Choice[] {
	const needle = query.trim().toLowerCase();
	return views
		.filter(view => view.host.toLowerCase().includes(needle))
		.slice(0, MAX_AUTOCOMPLETE_CHOICES)
		.map(view => ({ name: `${view.host}${view.stale ? " (offline)" : ""}`.slice(0, 100), value: view.host }));
}

export function projectChoices(views: readonly HostView[], query: string, host: string | null): Choice[] {
	const needle = query.trim().toLowerCase();
	const seen = new Set<string>();
	const choices: Choice[] = [];
	for (const view of views) {
		if (host && view.host !== host) continue;
		for (const project of view.projects) {
			if (seen.has(project) || !project.toLowerCase().includes(needle)) continue;
			seen.add(project);
			const label = `${path.basename(project)} · ${view.host}`;
			choices.push({ name: label.slice(0, 100), value: project.slice(0, 100) });
			if (choices.length === MAX_AUTOCOMPLETE_CHOICES) return choices;
		}
	}
	return choices;
}

export function taskChoices(views: readonly HostView[], query: string): Choice[] {
	const needle = query.trim().toLowerCase();
	const choices: Choice[] = [];
	for (const view of views) {
		for (const session of view.sessions) {
			if (!session.channelId) continue;
			const label = `${session.title ?? "Untitled task"} · ${taskStatusLabel(session.status)}`;
			if (!label.toLowerCase().includes(needle) && !session.sessionId.includes(needle)) continue;
			choices.push({ name: label.slice(0, 100), value: session.sessionId.slice(0, 100) });
			if (choices.length === MAX_AUTOCOMPLETE_CHOICES) return choices;
		}
	}
	return choices;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface DispatchInput {
	readonly name: CommandName;
	readonly host: string;
	readonly sessionId?: string | null;
	readonly cwd?: string | null;
	readonly prompt?: string | null;
	readonly model?: string | null;
	readonly lines?: number | null;
	readonly channelId?: string | null;
	readonly requestedBy: string;
	readonly replyChannelId: string;
}

export interface BrokerOptions {
	bus: Bus;
	registry?: HeartbeatRegistry;
	now?: () => Date;
	timeoutMs?: number;
	pollIntervalMs?: number;
	logger?: (message: string) => void;
}

interface Waiter {
	readonly resolve: (result: CommandResult | null) => void;
	readonly deadline: number;
}

/**
 * Owns the single bus read loop: it feeds the heartbeat registry and hands each
 * `CommandResult` to whichever interaction is waiting on it. One loop rather
 * than one per interaction, because the bus is a channel and every reader costs
 * the same rate limit.
 */
export class CommandBroker {
	readonly registry: HeartbeatRegistry;

	readonly #bus: Bus;
	readonly #now: () => Date;
	readonly #timeoutMs: number;
	readonly #pollIntervalMs: number;
	readonly #log: (message: string) => void;
	readonly #waiters = new Map<string, Waiter>();
	#cursor: string | null = null;
	#sequence = 0;
	#timer: TimerHandle | undefined;

	constructor(options: BrokerOptions) {
		this.#bus = options.bus;
		this.registry = options.registry ?? new HeartbeatRegistry();
		this.#now = options.now ?? (() => new Date());
		this.#timeoutMs = options.timeoutMs ?? COMMAND_RESULT_TIMEOUT_MS;
		this.#pollIntervalMs = options.pollIntervalMs ?? COMMAND_POLL_INTERVAL_MS;
		this.#log = options.logger ?? (message => process.stderr.write(`[cc-gateway] ${message}\n`));
	}

	/** Seeds the registry from history so `/session list` works on the first call after a restart. */
	async prime(): Promise<void> {
		await this.#bus.ready();
		await this.pump();
	}

	async pump(): Promise<void> {
		const page = await this.#bus.poll({ after: this.#cursor ?? undefined });
		if (page.blindBotMessages > 0) {
			this.#log(
				`${page.blindBotMessages} bot-authored bus message(s) came back empty: the app cannot read its own records. Check the MESSAGE_CONTENT intent.`,
			);
		}
		if (page.after) this.#cursor = page.after;
		for (const entry of page.records) {
			this.registry.ingest(entry.record);
			if (entry.record.kind !== "command.result") continue;
			const waiter = this.#waiters.get(entry.record.commandId);
			if (!waiter) continue;
			this.#waiters.delete(entry.record.commandId);
			waiter.resolve(entry.record);
		}
		this.#expire();
	}

	start(): void {
		this.#timer ??= setInterval(() => {
			void this.pump().catch(error => this.#log(`bus poll failed: ${error instanceof Error ? error.message : error}`));
		}, this.#pollIntervalMs);
		this.#timer.unref?.();
	}

	stop(): void {
		clearInterval(this.#timer);
		this.#timer = undefined;
	}

	/**
	 * Publishes the command and resolves with the agent's first answer, or null
	 * when nothing came back in time. Callers turn null into a message naming the
	 * host that stayed silent -- "timed out" alone tells a user nothing.
	 */
	async dispatch(input: DispatchInput): Promise<CommandResult | null> {
		const record = this.buildRecord(input);
		const { promise, resolve } = Promise.withResolvers<CommandResult | null>();
		this.#waiters.set(record.id, { resolve, deadline: this.#now().getTime() + this.#timeoutMs });
		try {
			await this.#bus.publish(record);
		} catch (error) {
			this.#waiters.delete(record.id);
			throw error;
		}
		const timer = setTimeout(() => {
			if (!this.#waiters.delete(record.id)) return;
			resolve(null);
		}, this.#timeoutMs);
		timer.unref?.();
		const result = await promise;
		clearTimeout(timer);
		return result;
	}

	buildRecord(input: DispatchInput): CommandRecord {
		return {
			kind: "command",
			v: BUS_PROTOCOL_VERSION,
			id: `cmd-${this.#now().getTime().toString(36)}-${(this.#sequence += 1).toString(36)}`,
			name: input.name,
			host: input.host,
			sessionId: input.sessionId ?? null,
			cwd: input.cwd ?? null,
			prompt: input.prompt ?? null,
			model: input.model ?? null,
			lines: input.lines ?? null,
			channelId: input.channelId ?? null,
			requestedBy: input.requestedBy,
			replyChannelId: input.replyChannelId,
			issuedAt: this.#now().toISOString(),
		};
	}

	#expire(): void {
		const now = this.#now().getTime();
		for (const [id, waiter] of [...this.#waiters]) {
			if (waiter.deadline > now) continue;
			this.#waiters.delete(id);
			waiter.resolve(null);
		}
	}
}

export type TaskAction = "start" | "steer" | "pause" | "stop" | "transcript";

/** What a teammate reads after a task command. No host/session jargon on success. */
export function renderOutcome(result: CommandResult | null, host: string, action: TaskAction): string {
	if (!result) {
		return `The task runner on **${host}** did not answer within ${Math.round(COMMAND_RESULT_TIMEOUT_MS / 1000)} seconds. Use \`/task list\` to check whether it is online.`;
	}
	const channel = result.channelId ? `<#${result.channelId}>` : "the task";
	if (result.outcome === "rejected") return result.detail;
	if (result.outcome === "failed") return `The task runner could not complete that request: ${result.detail}`;
	switch (action) {
		case "start":
			return `Task started in ${channel}. Open it to watch progress, and reply in that channel to steer the work.`;
		case "steer":
			return `Direction sent to ${channel}. If the agent is busy, it will apply the message next.`;
		case "pause":
			return `Current work paused in ${channel}. The task stays available for more direction.`;
		case "stop":
			return `Task stopped in ${channel}.`;
		case "transcript":
			return `${result.detail} Open ${channel} to read it.`;
	}
	return result.detail;
}

const STRING_OPTION = 3;
const INTEGER_OPTION = 4;
const SUBCOMMAND_OPTION = 1;

/** One task-oriented command surface, written as registration JSON for auditability. */
export const COMMAND_DEFINITIONS: readonly Record<string, unknown>[] = [
	{
		name: "task",
		description: "Start, follow, and steer coding tasks",
		options: [
			{
				type: SUBCOMMAND_OPTION,
				name: "start",
				description: "Start a task and create its progress channel",
				options: [
					{ type: STRING_OPTION, name: "goal", description: "The result you want", required: true },
					{ type: STRING_OPTION, name: "project", description: "Project to work in", autocomplete: true },
					{ type: STRING_OPTION, name: "host", description: "Task runner (optional)", autocomplete: true },
					{ type: STRING_OPTION, name: "model", description: "Model override (optional)" },
				],
			},
			{ type: SUBCOMMAND_OPTION, name: "list", description: "Show active and recently completed tasks" },
			{
				type: SUBCOMMAND_OPTION,
				name: "status",
				description: "Show the latest progress summary for a task",
				options: [{ type: STRING_OPTION, name: "task", description: "Task", required: true, autocomplete: true }],
			},
			{
				type: SUBCOMMAND_OPTION,
				name: "steer",
				description: "Change direction while a task is working",
				options: [
					{ type: STRING_OPTION, name: "task", description: "Task", required: true, autocomplete: true },
					{ type: STRING_OPTION, name: "instruction", description: "What should change", required: true },
				],
			},
			{
				type: SUBCOMMAND_OPTION,
				name: "pause",
				description: "Pause the task's current work without closing it",
				options: [{ type: STRING_OPTION, name: "task", description: "Task", required: true, autocomplete: true }],
			},
			{
				type: SUBCOMMAND_OPTION,
				name: "stop",
				description: "Stop a task",
				options: [{ type: STRING_OPTION, name: "task", description: "Task", required: true, autocomplete: true }],
			},
			{
				type: SUBCOMMAND_OPTION,
				name: "transcript",
				description: "Post the latest conversation into the task channel",
				options: [
					{ type: STRING_OPTION, name: "task", description: "Task", required: true, autocomplete: true },
					{ type: INTEGER_OPTION, name: "turns", description: "Conversation turns (1-25)" },
				],
			},
		],
	},
];

// ---------------------------------------------------------------------------
// discord.js wiring
// ---------------------------------------------------------------------------

export interface GatewayOptions {
	token?: string;
	tokenFile?: string;
	guildId?: string;
	bus?: Bus;
	rest?: DiscordRest;
	broker?: CommandBroker;
}

export class SessionBridgeGateway {
	readonly #guildId: string;
	readonly #options: GatewayOptions;
	#broker: CommandBroker | undefined;
	#client: Client | undefined;
	readonly #taskRoutes = new Map<string, { host: string; sessionId: string }>();

	constructor(options: GatewayOptions = {}) {
		this.#options = options;
		this.#guildId = options.guildId ?? GUILD_ID;
	}

	async start(): Promise<void> {
		const token =
			this.#options.token ?? (await readOwnerOnlyFile(this.#options.tokenFile ?? DEFAULT_TOKEN_FILE, "Discord bot token"));
		const rest = this.#options.rest ?? new DiscordRest({ token });
		const application = await rest.getApplication();
		const bus = this.#options.bus ?? new Bus({ rest, botUserId: application.bot?.id ?? application.id });
		const broker = this.#options.broker ?? new CommandBroker({ bus });
		this.#broker = broker;

		await new REST({ version: "10" })
			.setToken(token)
			.put(Routes.applicationGuildCommands(application.id, this.#guildId), { body: COMMAND_DEFINITIONS });

		await broker.prime();
		broker.start();

		// Task channels accept ordinary replies as steering input. The limited
		// message-content intent is enabled for this private, single-guild app.
		const client = new Client({
			intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
		});
		this.#client = client;
		client.on("interactionCreate", interaction => {
			if (interaction.isAutocomplete()) {
				void this.#autocomplete(interaction);
				return;
			}
			if (interaction.isChatInputCommand()) void this.#command(interaction);
		});
		client.on("messageCreate", message => {
			void this.#message(message);
		});
		await client.login(token);
	}

	async stop(): Promise<void> {
		this.#broker?.stop();
		await this.#client?.destroy();
		this.#client = undefined;
	}

	async #autocomplete(interaction: AutocompleteInteraction): Promise<void> {
		const broker = this.#broker;
		if (!broker) return;
		const views = broker.registry.hosts(new Date());
		const focused = interaction.options.getFocused(true);
		const choices =
			focused.name === "host"
				? hostChoices(views, focused.value)
				: focused.name === "project"
					? projectChoices(views, focused.value, interaction.options.getString("host"))
					: taskChoices(views, focused.value);
		await interaction.respond(choices);
	}

	async #command(interaction: ChatInputCommandInteraction): Promise<void> {
		const broker = this.#broker;
		if (!broker || interaction.commandName !== "task") return;
		const now = new Date();
		const subcommand = interaction.options.getSubcommand();
		await interaction.deferReply();

		if (subcommand === "list") {
			await interaction.editReply(renderTaskList(broker.registry.hosts(now)));
			return;
		}
		if (subcommand === "status") {
			const taskId = interaction.options.getString("task", true);
			const located = broker.registry.findSession(taskId, now);
			await interaction.editReply(
				located ? renderTaskStatus(located) : "I cannot find that task. Use `/task list` to see what is available.",
			);
			return;
		}

		const plan = this.#plan(interaction, broker, now);
		if (typeof plan === "string") {
			await interaction.editReply(plan);
			return;
		}
		try {
			const result = await broker.dispatch(plan.input);
			if (plan.action === "start" && result?.channelId && result.sessionId) {
				this.#taskRoutes.set(result.channelId, { host: result.host, sessionId: result.sessionId });
			}
			await interaction.editReply(renderOutcome(result, plan.input.host, plan.action));
		} catch (error) {
			await interaction.editReply(
				`The task service could not send that request: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async #message(message: Message): Promise<void> {
		const broker = this.#broker;
		const instruction = message.content.trim();
		if (!broker || message.author.bot || !message.inGuild() || message.guildId !== this.#guildId || !instruction) return;
		const now = new Date();
		const located = broker.registry.findSessionByChannel(message.channelId, now);
		const remembered = this.#taskRoutes.get(message.channelId);
		if (!located && !remembered) return;
		if (located && ["complete", "aborted", "error"].includes(located.snapshot.status)) {
			await message.reply({
				content: "This task has finished. Use `/task start` to continue as a new task.",
				allowedMentions: { repliedUser: false },
			});
			return;
		}
		const host = located?.host ?? remembered?.host;
		const sessionId = located?.snapshot.sessionId ?? remembered?.sessionId;
		if (!host || !sessionId || !broker.registry.liveHosts(now).some(view => view.host === host)) {
			await message.reply({
				content: "The task runner is offline, so I could not send that direction. Try again when `/task list` shows it online.",
				allowedMentions: { repliedUser: false },
			});
			return;
		}
		const acknowledgement = await message.reply({
			content: "Sending this direction to the task…",
			allowedMentions: { repliedUser: false },
		});
		try {
			const result = await broker.dispatch({
				name: "say",
				host,
				sessionId,
				channelId: message.channelId,
				prompt: instruction,
				requestedBy: message.author.id,
				replyChannelId: message.channelId,
			});
			await acknowledgement.edit(renderOutcome(result, host, "steer"));
		} catch (error) {
			await acknowledgement.edit(
				`The task service could not send that direction: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/** Returns the dispatch to make, or the message explaining why there is none. */
	#plan(
		interaction: ChatInputCommandInteraction,
		broker: CommandBroker,
		now: Date,
	): { input: DispatchInput; action: TaskAction } | string {
		const requestedBy = interaction.user.id;
		const replyChannelId = interaction.channelId ?? CHANNEL_IDS.sessions;
		const live = broker.registry.liveHosts(now);
		const subcommand = interaction.options.getSubcommand();

		if (subcommand === "start") {
			const requested = interaction.options.getString("host");
			const host = requested ?? (live.length === 1 ? live[0]?.host : undefined);
			if (!host) {
				return live.length === 0
					? "No task runner is online yet. Start `cc-agent` on a development machine and try again."
					: "More than one task runner is online. Choose one in the `host` field.";
			}
			const runner = live.find(view => view.host === host);
			if (!runner) return "That task runner is offline. Use `/task list` to check the current state.";
			const project = interaction.options.getString("project") ?? runner.projects[0];
			if (!project) return "That task runner has no available project. Check its `CC_AGENT_PROJECT_ROOTS` setting.";
			return {
				action: "start",
				input: {
					name: "new",
					host,
					cwd: project,
					prompt: interaction.options.getString("goal", true),
					model: interaction.options.getString("model"),
					requestedBy,
					replyChannelId,
				},
			};
		}

		const taskId = interaction.options.getString("task", true);
		const located = broker.registry.findSession(taskId, now);
		if (!located) return "I cannot find that task. Use `/task list` to see what is available.";
		if (!live.some(view => view.host === located.host)) {
			return "The task runner is offline, so the command cannot be delivered yet.";
		}
		const base = {
			host: located.host,
			sessionId: taskId,
			channelId: located.snapshot.channelId,
			requestedBy,
			replyChannelId,
		};
		switch (subcommand) {
			case "steer":
				return {
					action: "steer",
					input: { ...base, name: "say", prompt: interaction.options.getString("instruction", true) },
				};
			case "pause":
				return { action: "pause", input: { ...base, name: "interrupt" } };
			case "stop":
				return { action: "stop", input: { ...base, name: "stop" } };
			case "transcript":
				return { action: "transcript", input: { ...base, name: "tail", lines: interaction.options.getInteger("turns") } };
			default:
				return `\`/task ${subcommand}\` is not available.`;
		}
	}
}

if (import.meta.main) await new SessionBridgeGateway().start();
