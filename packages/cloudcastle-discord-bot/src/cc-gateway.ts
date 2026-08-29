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

import { Client, GatewayIntentBits, REST, Routes } from "discord.js";
import type { AutocompleteInteraction, ChatInputCommandInteraction } from "discord.js";
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
}

export function renderSessionList(views: readonly HostView[]): string {
	if (views.length === 0) {
		return "No agent has reported in. Start `cc-agent` on a machine and it will appear here within a minute.";
	}
	const lines: string[] = [];
	for (const view of views) {
		const age = Math.round(view.ageMs / 1000);
		lines.push(
			view.stale
				? `**${view.host}** — offline, last heard ${age}s ago (sessions below may be out of date)`
				: `**${view.host}** — online, chudcode ${view.chudcodeVersion}`,
		);
		if (view.sessions.length === 0) {
			lines.push("· no sessions");
			continue;
		}
		for (const session of view.sessions) {
			const where = session.channelId ? `<#${session.channelId}>` : session.project;
			lines.push(`· ${where} — ${session.status} — ${session.title ?? session.sessionId} \`${session.sessionId}\``);
		}
	}
	return lines.join("\n").slice(0, 1_900);
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
			choices.push({ name: project.slice(-100), value: project.slice(0, 100) });
			if (choices.length === MAX_AUTOCOMPLETE_CHOICES) return choices;
		}
	}
	return choices;
}

export function sessionChoices(views: readonly HostView[], query: string): Choice[] {
	const needle = query.trim().toLowerCase();
	const choices: Choice[] = [];
	for (const view of views) {
		for (const session of view.sessions) {
			const label = `${session.title ?? session.project} · ${view.host} · ${session.status}`;
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

/** What the user reads back. Kept out of the discord.js wiring so it can be checked directly. */
export function renderOutcome(result: CommandResult | null, host: string, action: string): string {
	if (!result) {
		return `No answer from **${host}** within ${Math.round(COMMAND_RESULT_TIMEOUT_MS / 1000)}s. The agent there may be stopped or offline; \`/session list\` shows what has reported in.`;
	}
	const where = result.channelId ? ` → <#${result.channelId}>` : "";
	switch (result.outcome) {
		case "accepted":
			return `${action} on **${host}**${where} — ${result.detail}`;
		case "done":
			return `${action} on **${host}**${where} — done: ${result.detail}`;
		case "rejected":
			return `**${host}** refused: ${result.detail}`;
		default:
			return `**${host}** failed: ${result.detail}`;
	}
}

// ---------------------------------------------------------------------------
// Slash command definitions
// ---------------------------------------------------------------------------

const STRING_OPTION = 3;
const INTEGER_OPTION = 4;
const SUBCOMMAND_OPTION = 1;

/**
 * Hand-built rather than SlashCommandBuilder: these are plain JSON in the
 * registration payload, and writing them out makes the whole command surface
 * readable in one screen.
 */
export const COMMAND_DEFINITIONS: readonly Record<string, unknown>[] = [
	{
		name: "new",
		description: "Start a chudcode session in its own channel",
		options: [
			{ type: STRING_OPTION, name: "prompt", description: "What the agent should do", required: true },
			{ type: STRING_OPTION, name: "project", description: "Absolute repo path on the host", autocomplete: true },
			{ type: STRING_OPTION, name: "host", description: "Machine to run on", autocomplete: true },
			{ type: STRING_OPTION, name: "model", description: "Model override" },
		],
	},
	{
		name: "session",
		description: "Inspect and steer chudcode sessions",
		options: [
			{ type: SUBCOMMAND_OPTION, name: "list", description: "Hosts and their sessions" },
			{
				type: SUBCOMMAND_OPTION,
				name: "say",
				description: "Send another turn into a running session",
				options: [
					{ type: STRING_OPTION, name: "session", description: "Session", required: true, autocomplete: true },
					{ type: STRING_OPTION, name: "message", description: "What to say", required: true },
				],
			},
			{
				type: SUBCOMMAND_OPTION,
				name: "interrupt",
				description: "Stop the in-flight turn without ending the session",
				options: [{ type: STRING_OPTION, name: "session", description: "Session", required: true, autocomplete: true }],
			},
			{
				type: SUBCOMMAND_OPTION,
				name: "stop",
				description: "End the session process",
				options: [{ type: STRING_OPTION, name: "session", description: "Session", required: true, autocomplete: true }],
			},
			{
				type: SUBCOMMAND_OPTION,
				name: "tail",
				description: "Repost the last turns into the session channel",
				options: [
					{ type: STRING_OPTION, name: "session", description: "Session", required: true, autocomplete: true },
					{ type: INTEGER_OPTION, name: "lines", description: "How many entries (1-25)" },
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

		// `Guilds` only: slash commands and interactions carry everything the
		// gateway reads, and this app has no privileged intent.
		const client = new Client({ intents: [GatewayIntentBits.Guilds] });
		this.#client = client;
		client.on("interactionCreate", interaction => {
			if (interaction.isAutocomplete()) {
				void this.#autocomplete(interaction);
				return;
			}
			if (interaction.isChatInputCommand()) void this.#command(interaction);
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
					: sessionChoices(views, focused.value);
		await interaction.respond(choices);
	}

	async #command(interaction: ChatInputCommandInteraction): Promise<void> {
		const broker = this.#broker;
		if (!broker) return;
		const now = new Date();
		// `/session list` answers from memory, so it can defer and reply at once.
		if (interaction.commandName === "session" && interaction.options.getSubcommand() === "list") {
			await interaction.deferReply();
			await interaction.editReply(renderSessionList(broker.registry.hosts(now)));
			return;
		}
		// Deferred before anything that can block: the interaction budget is three
		// seconds and a bus round trip is not.
		await interaction.deferReply();

		const plan = this.#plan(interaction, broker, now);
		if (typeof plan === "string") {
			await interaction.editReply(plan);
			return;
		}
		try {
			const result = await broker.dispatch(plan.input);
			await interaction.editReply(renderOutcome(result, plan.input.host, plan.action));
		} catch (error) {
			await interaction.editReply(`Could not reach the bus: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** Returns the dispatch to make, or the message explaining why there is none. */
	#plan(
		interaction: ChatInputCommandInteraction,
		broker: CommandBroker,
		now: Date,
	): { input: DispatchInput; action: string } | string {
		const requestedBy = interaction.user.id;
		const replyChannelId = interaction.channelId ?? CHANNEL_IDS.sessions;
		const live = broker.registry.liveHosts(now);

		if (interaction.commandName === "new") {
			const requested = interaction.options.getString("host");
			const host = requested ?? (live.length === 1 ? live[0]?.host : undefined);
			if (!host) {
				return live.length === 0
					? "No agent is online. Start `cc-agent` on the machine you want to run on."
					: `Several machines are online (${live.map(view => view.host).join(", ")}). Pass \`host:\`.`;
			}
			if (!live.some(view => view.host === host)) {
				return `**${host}** has not reported in within the staleness window, so it is presumed offline. \`/session list\` shows what has.`;
			}
			const project = interaction.options.getString("project") ?? live.find(view => view.host === host)?.projects[0];
			if (!project) return `**${host}** reported no project roots, so there is nowhere to start a session.`;
			return {
				action: "Starting a session",
				input: {
					name: "new",
					host,
					cwd: project,
					prompt: interaction.options.getString("prompt", true),
					model: interaction.options.getString("model"),
					requestedBy,
					replyChannelId,
				},
			};
		}

		const subcommand = interaction.options.getSubcommand();
		const sessionId = interaction.options.getString("session", true);
		const located = broker.registry.findSession(sessionId, now);
		if (!located) return `No host is reporting session \`${sessionId}\`. \`/session list\` shows what is live.`;
		if (!live.some(view => view.host === located.host)) {
			return `**${located.host}** owns \`${sessionId}\` but is presumed offline, so the command would not be picked up.`;
		}
		const base = {
			host: located.host,
			sessionId,
			channelId: located.snapshot.channelId,
			requestedBy,
			replyChannelId,
		};
		switch (subcommand) {
			case "say":
				return { action: "Message sent", input: { ...base, name: "say", prompt: interaction.options.getString("message", true) } };
			case "interrupt":
				return { action: "Interrupt", input: { ...base, name: "interrupt" } };
			case "stop":
				return { action: "Stop", input: { ...base, name: "stop" } };
			case "tail":
				return { action: "Tail", input: { ...base, name: "tail", lines: interaction.options.getInteger("lines") } };
			default:
				return `\`/session ${subcommand}\` is not a command this gateway knows.`;
		}
	}
}

if (import.meta.main) await new SessionBridgeGateway().start();
