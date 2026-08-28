/**
 * The Discord gateway half of the session bot.
 *
 * Shape of the thing: a message in `#sessions` opens a thread and starts a real
 * chudcode agent in one of the allowlisted checkouts; every later message in
 * that thread is the next prompt for that agent. Progress is one status message
 * edited in place, because a phone on a work network cannot usefully consume a
 * token stream and Discord's per-channel edit budget cannot usefully produce
 * one. The final answer is posted as ordinary messages, with anything long
 * attached as a file rather than sliced into a wall of chat.
 *
 * Four rules this file enforces, in this order, before anything runs:
 *
 * 1. The guild must be CloudCastle, and the channel must be `#sessions` or one
 *    of its threads. Nothing else is even parsed.
 * 2. The author must be on the operator allowlist. A non-operator is ignored
 *    silently -- an error reply would confirm to a stranger that the bot listens
 *    and would make the channel noisy for the people who do use it.
 * 3. Bot and webhook messages are ignored, so the bot's own session reports
 *    cannot become prompts.
 * 4. Every outbound string is passed through the same secret screener the
 *    archive exporter and the webhook egress use. It is best-effort, not a
 *    guarantee: agent output is arbitrary process output.
 */

import {
	AttachmentBuilder,
	ChannelType,
	Client,
	Events,
	GatewayIntentBits,
	type Message,
	type OmitPartialGroupDMChannel,
	PermissionFlagsBits,
	type TextChannel,
	ThreadAutoArchiveDuration,
	type ThreadChannel,
} from "discord.js";
import {
	type ManagedSession,
	SessionBusyError,
	SessionLimitError,
	SessionPool,
	type TurnResult,
} from "./agent-runtime";
import { GUILD_ID } from "./channels";
import { type DevbotConfig, readDevbotToken, resolveWorkspace } from "./devbot-config";
import { resolveSecretObfuscator } from "./notify";
import {
	DISCORD_MESSAGE_LIMIT,
	renderFooter,
	renderStatus,
	splitForDiscord,
	type TodoLine,
	TurnAccumulator,
} from "./transcript";

/** Never edit the status message faster than this; Discord's budget is small. */
const STATUS_EDIT_INTERVAL_MS = 2_500;

/** Beyond this much assistant text, the answer becomes a file attachment. */
const INLINE_ANSWER_BUDGET = 3 * DISCORD_MESSAGE_LIMIT;

const THREAD_NAME_LIMIT = 90;

const HELP = [
	"**Session bot**",
	"Post in `#sessions` to start a session. Prefix with `name:` to pick a workspace.",
	"Every message in a session thread is the next prompt. Sent mid-turn, it steers the running turn.",
	"",
	"`!status` — model, cost, context, todos",
	"`!abort` — stop the running turn",
	"`!model <name>` — switch model for this session",
	"`!compact` — compact the transcript",
	"`!new` — forget this thread's transcript and start clean",
	"`!end` — stop the agent process (the transcript stays resumable)",
	"`!help` — this",
].join("\n");

type GuildMessage = OmitPartialGroupDMChannel<Message<true>>;

export interface DevbotHandle {
	readonly client: Client;
	readonly pool: SessionPool;
	stop(): Promise<void>;
}

export async function startDevbot(config: DevbotConfig): Promise<DevbotHandle> {
	const token = await readDevbotToken(config);
	const screener = await resolveSecretObfuscator();
	const pool = new SessionPool(config);
	const client = new Client({
		intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
	});

	client.once(Events.ClientReady, ready => {
		process.stdout.write(`devbot online as ${ready.user.tag}\n`);
		void reportPermissions(ready, config);
		pool.startReaper();
	});

	client.on(Events.MessageCreate, message => {
		void handleMessage(message, { config, pool, screener }).catch((error: unknown) => {
			process.stderr.write(`devbot message handler failed: ${describe(error)}\n`);
		});
	});

	await client.login(token);

	return {
		client,
		pool,
		async stop(): Promise<void> {
			await pool.shutdown();
			await client.destroy();
		},
	};
}

interface Deps {
	readonly config: DevbotConfig;
	readonly pool: SessionPool;
	readonly screener: { obfuscate(text: string): string } | undefined;
}

/**
 * Everything the routing decision depends on, lifted out of `discord.js` so the
 * allowlist and channel gates can be tested without fabricating a `Message`.
 */
export interface RouteInput {
	readonly authorId: string;
	readonly isBot: boolean;
	readonly isWebhook: boolean;
	readonly guildId: string | null;
	readonly channelId: string;
	readonly isThread: boolean;
	readonly parentId: string | null;
	readonly content: string;
}

export type Route =
	/** Say nothing. A stranger learns nothing about what this channel does. */
	| { readonly kind: "ignore" }
	/** Answer with a fixed sentence and run nothing. */
	| { readonly kind: "refuse"; readonly message: string }
	| { readonly kind: "root-prompt"; readonly text: string }
	| { readonly kind: "root-control"; readonly text: string }
	| { readonly kind: "thread-prompt"; readonly text: string }
	| { readonly kind: "thread-control"; readonly text: string };

/** The whole ingress policy, in evaluation order. */
export function routeMessage(input: RouteInput, config: DevbotConfig): Route {
	if (input.isBot || input.isWebhook) return { kind: "ignore" };
	if (input.guildId !== GUILD_ID) return { kind: "ignore" };
	if (!config.operators.has(input.authorId)) return { kind: "ignore" };

	const inRoot = !input.isThread && input.channelId === config.sessionsChannelId;
	const inThread = input.isThread && input.parentId === config.sessionsChannelId;
	if (!inRoot && !inThread) return { kind: "ignore" };

	const text = input.content.trim();
	if (!text) return { kind: "ignore" };

	// omp's own slash commands resolve locally and never produce an agent turn,
	// so a `/`-prefixed prompt would leave the thread waiting on a turn that is
	// never going to start. Refuse it where the operator can see why.
	if (text.startsWith("/")) {
		return {
			kind: "refuse",
			message: "omp slash commands are not wired through Discord. Use the `!` commands — `!help`.",
		};
	}

	if (inThread) return { kind: text.startsWith("!") ? "thread-control" : "thread-prompt", text };
	return { kind: text.startsWith("!") ? "root-control" : "root-prompt", text };
}

async function handleMessage(message: Message, deps: Deps): Promise<void> {
	if (!message.inGuild()) return;
	const channel = message.channel;
	const route = routeMessage(
		{
			authorId: message.author.id,
			isBot: message.author.bot,
			isWebhook: message.webhookId !== null,
			guildId: message.guildId,
			channelId: channel.id,
			isThread: channel.isThread(),
			parentId: channel.isThread() ? channel.parentId : null,
			content: message.content,
		},
		deps.config,
	);
	if (route.kind === "ignore") return;

	const guildMessage: GuildMessage = message;
	if (route.kind === "refuse") {
		await reply(guildMessage, route.message);
		return;
	}
	if (route.kind === "root-control") {
		await reply(
			guildMessage,
			route.text === "!help" ? HELP : "Control commands only work inside a session thread. `!help`",
		);
		return;
	}
	if (route.kind === "root-prompt") {
		await handleNewSession(guildMessage, route.text, deps);
		return;
	}
	if (!channel.isThread()) return;
	if (route.kind === "thread-control") {
		await handleControl(guildMessage, channel, route.text, deps);
		return;
	}
	await handleThreadPrompt(guildMessage, channel, route.text, deps);
}

async function handleNewSession(message: GuildMessage, text: string, deps: Deps): Promise<void> {
	const { workspaceName, prompt } = splitWorkspacePrefix(text);
	const workspace = resolveWorkspace(deps.config, workspaceName);
	if (!workspace) {
		const known = deps.config.workspaces.map(entry => entry.name).join(", ");
		await reply(message, `Unknown workspace \`${workspaceName ?? ""}\`. Known: ${known}`);
		return;
	}
	if (!prompt) {
		await reply(message, "That message is only a workspace prefix — add the actual prompt.");
		return;
	}

	const thread = await message.startThread({
		name: threadName(prompt),
		autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
		reason: "chudcode session",
	});
	await acknowledge(message);
	await runTurnInThread(thread, workspace.name, prompt, deps);
}

async function handleThreadPrompt(
	message: GuildMessage,
	thread: ThreadChannel,
	text: string,
	deps: Deps,
): Promise<void> {
	const live = deps.pool.get(thread.id);
	if (live?.busy) {
		await live.steer(text);
		await acknowledge(message, "🫸");
		return;
	}

	const known = (await deps.pool.knownWorkspace(thread.id)) ?? deps.config.defaultWorkspace.name;
	await acknowledge(message);
	await runTurnInThread(thread, known, text, deps);
}

async function handleControl(message: GuildMessage, thread: ThreadChannel, text: string, deps: Deps): Promise<void> {
	const [command = "", ...rest] = text.slice(1).split(/\s+/);
	const argument = rest.join(" ").trim();
	const live = deps.pool.get(thread.id);

	switch (command.toLowerCase()) {
		case "help":
			await reply(message, HELP);
			return;
		case "abort":
			if (!live) {
				await reply(message, "No agent is running in this thread.");
				return;
			}
			await live.abort();
			await acknowledge(message, "🛑");
			return;
		case "end":
			await deps.pool.release(thread.id);
			await reply(message, "Agent stopped. The transcript stays resumable — post again to reopen it.");
			return;
		case "new":
			await deps.pool.forget(thread.id);
			await reply(message, "Transcript forgotten. The next message starts a clean session in this thread.");
			return;
		case "status":
			await reply(message, await describeStatus(live, thread, deps));
			return;
		case "compact":
			if (!live) {
				await reply(message, "No agent is running in this thread.");
				return;
			}
			await live.compact();
			await reply(message, "Compacted.");
			return;
		case "model": {
			if (!live) {
				await reply(message, "No agent is running in this thread. Send a prompt first.");
				return;
			}
			if (!argument) {
				await reply(message, "Usage: `!model <name>`, e.g. `!model opus`.");
				return;
			}
			try {
				const chosen = await live.setModel(argument);
				await reply(message, `Model is now \`${chosen.provider}/${chosen.id}\`.`);
			} catch (error) {
				await reply(message, `Could not switch model: ${describe(error)}`);
			}
			return;
		}
		default:
			await reply(message, `Unknown command \`!${command}\`. \`!help\``);
	}
}

/**
 * Run one turn, reporting into `thread`. Owns the whole visible lifecycle of a
 * turn: status message, periodic edits, final answer, footer.
 */
async function runTurnInThread(
	thread: ThreadChannel,
	workspaceName: string,
	prompt: string,
	deps: Deps,
): Promise<void> {
	const workspace = resolveWorkspace(deps.config, workspaceName);
	if (!workspace) {
		await post(thread, deps, `Workspace \`${workspaceName}\` is no longer configured.`);
		return;
	}

	let session: ManagedSession;
	try {
		session = await deps.pool.acquire(thread.id, workspace);
	} catch (error) {
		if (error instanceof SessionLimitError || error instanceof SessionBusyError) {
			await post(thread, deps, error.message);
			return;
		}
		await post(thread, deps, `Could not start an agent in \`${workspace.name}\`: ${describe(error)}`);
		return;
	}
	await deps.pool.touch(thread.id);

	const accumulator = new TurnAccumulator();
	const startedAt = Date.now();
	let todos: readonly TodoLine[] = [];
	const header = `\`${workspace.name}\` · session \`${(session.sessionId ?? "new").slice(0, 8)}\``;
	const statusMessage = await thread.send(`${header}\n${renderStatus(accumulator.status(), todos, 0)}`);

	let lastEditAt = 0;
	let lastRevision = -1;
	const flush = async (): Promise<void> => {
		const now = Date.now();
		if (now - lastEditAt < STATUS_EDIT_INTERVAL_MS) return;
		if (accumulator.revision === lastRevision) return;
		lastEditAt = now;
		lastRevision = accumulator.revision;
		const body = `${header}\n${renderStatus(accumulator.status(), todos, now - startedAt)}`;
		await statusMessage.edit(clamp(screen(body, deps), DISCORD_MESSAGE_LIMIT)).catch(() => undefined);
	};
	const ticker = setInterval(() => {
		void flush();
	}, STATUS_EDIT_INTERVAL_MS);

	let result: TurnResult;
	try {
		result = await session.runTurn(prompt, {
			onEvent: event => accumulator.push(event),
			onHeartbeat: latest => {
				todos = latest;
				accumulator.setTodos(latest);
			},
		});
	} catch (error) {
		clearInterval(ticker);
		if (error instanceof SessionBusyError) {
			await post(thread, deps, "That session is mid-turn — send the message again to steer it.");
			return;
		}
		await post(thread, deps, `Turn failed to start: ${describe(error)}`);
		return;
	}
	clearInterval(ticker);

	const elapsed = Date.now() - startedAt;
	const digest = accumulator.digest();
	await statusMessage
		.edit(
			clamp(screen(`${header}\n${renderStatus(accumulator.status(), todos, elapsed)}`, deps), DISCORD_MESSAGE_LIMIT),
		)
		.catch(() => undefined);

	const answer = screen(digest.text, deps).trim();
	if (answer.length > INLINE_ANSWER_BUDGET) {
		const attachment = new AttachmentBuilder(Buffer.from(`${answer}\n`, "utf8"), {
			name: `turn-${statusMessage.id}.md`,
		});
		const head = splitForDiscord(answer.slice(0, DISCORD_MESSAGE_LIMIT - 200))[0] ?? "";
		await thread.send({ content: `${head}\n\n_full answer attached_`, files: [attachment] });
	} else if (answer) {
		for (const chunk of splitForDiscord(answer)) await thread.send(chunk);
	}

	const outcomeNote = result.outcome === "completed" ? "" : `\n${outcomeLine(result)}`;
	const cost = result.stats ? ` · session $${result.stats.cost.toFixed(4)}` : "";
	await post(thread, deps, `${renderFooter(digest, elapsed)}${cost}${outcomeNote}`);
}

async function describeStatus(session: ManagedSession | undefined, thread: ThreadChannel, deps: Deps): Promise<string> {
	if (!session) {
		const known = await deps.pool.knownWorkspace(thread.id);
		return known
			? `No agent running. This thread's transcript lives in \`${known}\` and reopens on the next message.`
			: "No agent running and no transcript recorded for this thread.";
	}
	try {
		const [state, stats] = await Promise.all([session.state(), session.stats()]);
		// `percent` is already scaled 0-100 by the agent, not a fraction.
		const context = state.contextUsage
			? `${state.contextUsage.percent.toFixed(1)}% of ${state.contextUsage.contextWindow}`
			: "unknown";
		const model = state.model ? `${state.model.provider}/${state.model.id}` : "unresolved";
		return [
			`workspace: \`${session.workspace.name}\``,
			`model: \`${model}\` · thinking \`${state.thinkingLevel ?? "default"}\``,
			`session: \`${state.sessionId.slice(0, 8)}\` · ${stats.totalMessages} messages · ${stats.toolCalls} tool calls`,
			`context: ${context} · tokens ${stats.tokens.total} · $${stats.cost.toFixed(4)}`,
			`state: ${session.busy ? "mid-turn" : "idle"}`,
		].join("\n");
	} catch (error) {
		return `Agent is not answering: ${describe(error)}`;
	}
}

function outcomeLine(result: TurnResult): string {
	const detail = result.detail ? ` — ${result.detail}` : "";
	if (result.outcome === "aborted") return `🛑 aborted${detail}`;
	if (result.outcome === "timeout") return `⏱️ turn ceiling reached${detail}`;
	return `⚠️ agent process failed${detail}`;
}

/**
 * `name:` selects a workspace. The colon must be in the first token, so a prompt
 * that merely contains a colon ("fix this: the build breaks") is not mistaken
 * for a workspace selector.
 */
export function splitWorkspacePrefix(text: string): { workspaceName: string | undefined; prompt: string } {
	const match = /^([A-Za-z0-9][A-Za-z0-9._-]*):\s*/.exec(text);
	if (!match) return { workspaceName: undefined, prompt: text };
	return { workspaceName: match[1]?.toLowerCase(), prompt: text.slice(match[0].length).trim() };
}

/** A thread title Discord will accept: one line, no fences, bounded. */
export function threadName(prompt: string): string {
	const flat = prompt
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const base = flat || "session";
	return base.length <= THREAD_NAME_LIMIT ? base : `${base.slice(0, THREAD_NAME_LIMIT - 1)}…`;
}

/**
 * Warn loudly at startup when the install is still the read-only archive slice.
 * Discovering "no Send Messages" from a silent bot at work is the worst possible
 * time to discover it.
 */
async function reportPermissions(client: Client<true>, config: DevbotConfig): Promise<void> {
	try {
		const channel = await client.channels.fetch(config.sessionsChannelId);
		if (!channel || channel.type !== ChannelType.GuildText) {
			process.stderr.write(`devbot cannot see #sessions (${config.sessionsChannelId})\n`);
			return;
		}
		const textChannel: TextChannel = channel;
		const me = await textChannel.guild.members.fetchMe();
		const permissions = textChannel.permissionsFor(me);
		const required = {
			ViewChannel: PermissionFlagsBits.ViewChannel,
			SendMessages: PermissionFlagsBits.SendMessages,
			ReadMessageHistory: PermissionFlagsBits.ReadMessageHistory,
			CreatePublicThreads: PermissionFlagsBits.CreatePublicThreads,
			SendMessagesInThreads: PermissionFlagsBits.SendMessagesInThreads,
			AttachFiles: PermissionFlagsBits.AttachFiles,
			AddReactions: PermissionFlagsBits.AddReactions,
		};
		const missing = Object.entries(required)
			.filter(([, bit]) => !permissions?.has(bit))
			.map(([name]) => name);
		if (missing.length > 0) {
			process.stderr.write(
				`devbot is missing ${missing.join(", ")} in #sessions — re-invite the app with permissions=326417632320 (RUNBOOK-DEVBOT.md §1)\n`,
			);
		}
	} catch (error) {
		process.stderr.write(`devbot could not check its own permissions: ${describe(error)}\n`);
	}
}

function screen(text: string, deps: Deps): string {
	return deps.screener ? deps.screener.obfuscate(text) : text;
}

function clamp(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

async function post(channel: ThreadChannel, deps: Deps, text: string): Promise<void> {
	for (const chunk of splitForDiscord(screen(text, deps))) {
		await channel.send(chunk).catch((error: unknown) => {
			process.stderr.write(`devbot could not post to ${channel.id}: ${describe(error)}\n`);
		});
	}
}

async function reply(message: GuildMessage, text: string): Promise<void> {
	await message.reply(clamp(text, DISCORD_MESSAGE_LIMIT)).catch(() => undefined);
}

/** A reaction is the cheapest possible "received" signal on a phone. */
async function acknowledge(message: GuildMessage, emoji = "👀"): Promise<void> {
	await message.react(emoji).catch(() => undefined);
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
