import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { buildSecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { REST } from "discord.js";

export type ArchiveMode = "before-mutate" | "final-delta";
export type ScopeKind = "channel" | "thread";

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue | undefined };
export type JsonObject = { [key: string]: JsonValue | undefined };

export interface ArchiveError {
	operation: string;
	status?: number;
	code?: string;
	message: string;
}

export interface ArchiveReaction {
	message_id: string;
	emoji: string;
	count: number;
	user_ids: string[];
}

export interface ArchiveAttachment {
	channel_id: string;
	message_id: string;
	filename: string;
	relative_path: string;
	size: number;
	sha256: string;
	source_url: string;
}

export interface ArchiveScope {
	id: string;
	kind: ScopeKind;
	parent_id: string | null;
	type: number;
	name: string;
	jsonl_path: string;
	markdown_path: string;
	message_count: number;
	first_message_id: string | null;
	last_message_id: string | null;
	message_ids: string[];
	permission_overwrites: JsonObject[];
	pins: string[];
	reactions: ArchiveReaction[];
	attachments: ArchiveAttachment[];
	errors: ArchiveError[];
}

export interface ArchiveFile {
	path: string;
	size: number;
	sha256: string;
}

export interface ArchiveRedaction {
	scope_id: string;
	message_id: string;
	sha256: string;
	paths: string[];
}

export interface ArchiveUnresolved extends ArchiveError {
	scope_id: string;
}

export interface ArchiveManifest {
	version: 1;
	guild_id: string;
	generated_at: string;
	mode: ArchiveMode;
	cutoff_by_channel: Record<string, string>;
	scopes: ArchiveScope[];
	files: ArchiveFile[];
	preexisting_artifacts: ArchiveFile[];
	redactions: ArchiveRedaction[];
	unresolved: ArchiveUnresolved[];
}

export interface ReadOnlyRest {
	get(route: string, options?: { query?: URLSearchParams }): Promise<unknown>;
}

export interface SecretScreener {
	obfuscate(text: string): string;
}

export interface ArchiveDependencies {
	rest: ReadOnlyRest;
	fetch: typeof globalThis.fetch;
	now: () => Date;
	secretObfuscator: SecretScreener | undefined;
	encryptTar: (tar: Uint8Array, recipientFile: string) => Promise<Uint8Array>;
}

export interface ExportGuildOptions {
	guildId: string;
	outputDir: string;
	cutoffByChannel?: Readonly<Record<string, string>>;
	mode?: ArchiveMode;
	tokenFile?: string;
	ageRecipientFile?: string;
	dependencies?: Partial<ArchiveDependencies>;
}

interface DiscordChannel extends JsonObject {
	id: string;
	name?: string;
	type: number;
	parent_id?: string | null;
	permission_overwrites?: JsonObject[];
	thread_metadata?: JsonObject;
}

interface ScopeWork {
	channel: DiscordChannel;
	kind: ScopeKind;
	messages: JsonObject[];
	rawMessages: JsonObject[];
	scope: ArchiveScope;
}

interface QuarantinedRecord {
	scope_id: string;
	message_id: string;
	sha256: string;
	record: JsonObject;
}

const MESSAGE_CHANNEL_TYPES = new Set([0, 2, 5, 13]);
const THREAD_PARENT_TYPES = new Set([0, 5, 15, 16]);
const PRIVATE_THREAD_PARENT_TYPES = new Set([0]);
const THREAD_TYPES = new Set([10, 11, 12]);
const PREEXISTING_FILES = ["#1.txt", "#1-A.md", "#2.txt", "#2-A.md"] as const;
let atomicSequence = 0;

/**
 * Export every readable message-bearing scope in a guild. The production REST
 * implementation exposes only GET, so this module cannot send, edit, or delete
 * Discord data. discord.js REST owns rate-limit buckets and retries.
 */
export async function exportGuild(options: ExportGuildOptions): Promise<ArchiveManifest> {
	const guildId = requireSnowflake(options.guildId, "guildId");
	const outputDir = path.resolve(options.outputDir);
	const cutoffByChannel = normalizeCutoffs(options.cutoffByChannel ?? {});
	const repoRoot = path.resolve(import.meta.dir, "../../..");
	const rest = options.dependencies?.rest ?? (await createDiscordRest(options.tokenFile));
	const fetchImpl = options.dependencies?.fetch ?? globalThis.fetch;
	const now = options.dependencies?.now ?? (() => new Date());
	const encryptTar = options.dependencies?.encryptTar ?? encryptTarWithAge;
	const secretObfuscator = Object.hasOwn(options.dependencies ?? {}, "secretObfuscator")
		? options.dependencies?.secretObfuscator
		: await buildSecretObfuscator(
				repoRoot,
				process.env.CHUDCODE_AGENT_DIR ?? path.join(homedir(), ".chudcode", "agent"),
			);
	const deps: ArchiveDependencies = { rest, fetch: fetchImpl, now, secretObfuscator, encryptTar };

	await fs.mkdir(outputDir, { recursive: true });
	const unresolved: ArchiveUnresolved[] = [];
	const channelById = new Map<string, DiscordChannel>();
	const discoveredThreads = new Map<string, DiscordChannel>();
	let guildChannels: DiscordChannel[] = [];

	try {
		guildChannels = parseChannels(await get(rest, `/guilds/${guildId}/channels`));
		for (const channel of guildChannels) channelById.set(channel.id, channel);
	} catch (error) {
		unresolved.push(toUnresolved(guildId, "enumerate_guild_channels", error));
	}

	try {
		const active = asObject(await get(rest, `/guilds/${guildId}/threads/active`));
		for (const thread of parseChannels(active.threads)) discoveredThreads.set(thread.id, thread);
	} catch (error) {
		unresolved.push(toUnresolved(guildId, "enumerate_active_threads", error));
	}

	for (const parent of guildChannels.filter(channel => THREAD_PARENT_TYPES.has(channel.type))) {
		await discoverArchivedThreads(rest, parent, "public", discoveredThreads, unresolved);
		if (PRIVATE_THREAD_PARENT_TYPES.has(parent.type)) {
			await discoverArchivedThreads(rest, parent, "private", discoveredThreads, unresolved);
			await discoverArchivedThreads(rest, parent, "joined-private", discoveredThreads, unresolved);
		}
	}

	for (const thread of discoveredThreads.values()) channelById.set(thread.id, thread);
	const sources: Array<{ channel: DiscordChannel; kind: ScopeKind }> = [
		...guildChannels
			.filter(channel => MESSAGE_CHANNEL_TYPES.has(channel.type))
			.map(channel => ({ channel, kind: "channel" as const })),
		...[...discoveredThreads.values()]
			.filter(channel => THREAD_TYPES.has(channel.type))
			.map(channel => ({ channel, kind: "thread" as const })),
	].sort((left, right) => compareSnowflakes(left.channel.id, right.channel.id));

	const works: ScopeWork[] = [];
	const redactions: ArchiveRedaction[] = [];
	const quarantine: QuarantinedRecord[] = [];
	for (const source of sources) {
		const parent = source.channel.parent_id ? channelById.get(source.channel.parent_id) : undefined;
		const work = await exportScope(source.channel, source.kind, parent, cutoffByChannel, deps, outputDir, unresolved);
		for (let index = 0; index < work.messages.length; index++) {
			const normalized = work.messages[index];
			if (!normalized) continue;
			const screened = screenJson(normalized, secretObfuscator);
			if (screened.paths.length > 0) {
				const exactRaw = work.rawMessages[index] ?? normalized;
				const digest = sha256(stableJson(exactRaw));
				const messageId = stringField(normalized, "id");
				redactions.push({
					scope_id: source.channel.id,
					message_id: messageId,
					sha256: digest,
					paths: screened.paths,
				});
				quarantine.push({ scope_id: source.channel.id, message_id: messageId, sha256: digest, record: exactRaw });
			}
			work.messages[index] = screened.value as JsonObject;
		}
		work.scope.attachments = work.messages.flatMap(message => parseArchiveAttachments(message.attachments));
		work.scope.reactions = work.messages.flatMap(message => parseArchiveReactions(message));
		works.push(work);
	}

	redactions.sort(
		(a, b) => compareSnowflakes(a.scope_id, b.scope_id) || compareSnowflakes(a.message_id, b.message_id),
	);
	if (quarantine.length > 0 && !options.ageRecipientFile) {
		throw new Error("redactions were found; --age-recipient-file is required to preserve exact raw records");
	}

	const generatedPaths: string[] = [];
	for (const work of works) {
		const jsonl =
			work.messages.map(message => stableJson(message)).join("\n") + (work.messages.length > 0 ? "\n" : "");
		const markdown = renderScopeMarkdown(work.scope, work.messages);
		await atomicWrite(path.join(outputDir, work.scope.jsonl_path), jsonl);
		await atomicWrite(path.join(outputDir, work.scope.markdown_path), markdown);
		generatedPaths.push(work.scope.jsonl_path, work.scope.markdown_path);
	}

	const redactionReportPath = "redaction-report.json";
	await atomicWrite(
		path.join(outputDir, redactionReportPath),
		`${stableJson({ version: 1, redactions, quarantine: quarantine.length > 0 ? "raw-secret-quarantine.tar.age" : null })}\n`,
	);
	generatedPaths.push(redactionReportPath);

	if (quarantine.length > 0 && options.ageRecipientFile) {
		const rawJsonl = `${quarantine.map(item => stableJson(item)).join("\n")}\n`;
		const tar = createTar([{ name: "raw-records.jsonl", bytes: new TextEncoder().encode(rawJsonl) }]);
		const encrypted = await encryptTar(tar, path.resolve(options.ageRecipientFile));
		const quarantinePath = "raw-secret-quarantine.tar.age";
		await atomicWrite(path.join(outputDir, quarantinePath), encrypted);
		generatedPaths.push(quarantinePath);
	}

	const preexistingArtifacts = await collectPreexistingArtifacts(outputDir);
	const indexPath = "INDEX.md";
	await atomicWrite(
		path.join(outputDir, indexPath),
		renderIndex(
			guildId,
			works.map(work => work.scope),
			preexistingArtifacts,
		),
	);
	generatedPaths.push(indexPath);

	for (const work of works) {
		for (const attachment of work.scope.attachments) {
			if (attachment.sha256) generatedPaths.push(attachment.relative_path);
		}
	}
	const files = await hashFiles(outputDir, generatedPaths);
	const manifest: ArchiveManifest = {
		version: 1,
		guild_id: guildId,
		generated_at: now().toISOString(),
		mode: options.mode ?? "before-mutate",
		cutoff_by_channel: cutoffByChannel,
		scopes: works.map(work => work.scope),
		files,
		preexisting_artifacts: preexistingArtifacts,
		redactions,
		unresolved,
	};
	await atomicWrite(path.join(outputDir, "manifest.json"), `${stableJson(manifest, 2)}\n`);
	return manifest;
}

async function createDiscordRest(tokenFile: string | undefined): Promise<ReadOnlyRest> {
	if (!tokenFile) throw new Error("a --token-file path or injected read-only REST client is required");
	const token = await readOwnerOnlyFile(path.resolve(tokenFile), "Discord token");
	const client = new REST({ version: "10" }).setToken(token);
	return { get: (route, options) => client.get(route as `/${string}`, options) };
}

async function readOwnerOnlyFile(filePath: string, label: string): Promise<string> {
	const stat = await fs.stat(filePath);
	if (!stat.isFile()) throw new Error(`${label} file must be a regular file`);
	if ((stat.mode & 0o077) !== 0) throw new Error(`${label} file must not be accessible by group or other users`);
	const value = (await fs.readFile(filePath, "utf8")).trim();
	if (!value) throw new Error(`${label} file is empty`);
	return value;
}

async function get(rest: ReadOnlyRest, route: string, query?: Record<string, string>): Promise<unknown> {
	return rest.get(route, query ? { query: new URLSearchParams(query) } : undefined);
}

async function discoverArchivedThreads(
	rest: ReadOnlyRest,
	parent: DiscordChannel,
	kind: "public" | "private" | "joined-private",
	threads: Map<string, DiscordChannel>,
	unresolved: ArchiveUnresolved[],
): Promise<void> {
	const suffix = kind === "joined-private" ? "/users/@me/threads/archived/private" : `/threads/archived/${kind}`;
	let before: string | undefined;
	const seenCursors = new Set<string>();
	try {
		for (;;) {
			const response = asObject(
				await get(rest, `/channels/${parent.id}${suffix}`, before ? { before, limit: "100" } : { limit: "100" }),
			);
			const page = parseChannels(response.threads);
			for (const thread of page) threads.set(thread.id, thread);
			if (response.has_more !== true || page.length === 0) break;
			const last = page.at(-1);
			const metadata = last ? asObject(last.thread_metadata) : {};
			const cursor =
				kind === "joined-private"
					? last
						? stringField(last, "id")
						: undefined
					: typeof metadata.archive_timestamp === "string"
						? metadata.archive_timestamp
						: undefined;
			if (!cursor || seenCursors.has(cursor)) throw new Error("archived thread pagination did not advance");
			seenCursors.add(cursor);
			before = cursor;
		}
	} catch (error) {
		unresolved.push(toUnresolved(parent.id, `enumerate_archived_${kind}_threads`, error));
	}
}

async function exportScope(
	channel: DiscordChannel,
	kind: ScopeKind,
	parent: DiscordChannel | undefined,
	cutoffs: Record<string, string>,
	deps: ArchiveDependencies,
	outputDir: string,
	unresolved: ArchiveUnresolved[],
): Promise<ScopeWork> {
	const errors: ArchiveError[] = [];
	const stem = `${slug(typeof channel.name === "string" ? channel.name : kind)}-${channel.id}`;
	const scope: ArchiveScope = {
		id: channel.id,
		kind,
		type: channel.type,
		parent_id: typeof channel.parent_id === "string" ? channel.parent_id : null,
		name: typeof channel.name === "string" ? channel.name : channel.id,
		jsonl_path: `${stem}.jsonl`,
		markdown_path: `${stem}.md`,
		message_count: 0,
		first_message_id: null,
		last_message_id: null,
		message_ids: [],
		permission_overwrites: parsePermissionOverwrites(channel.permission_overwrites ?? parent?.permission_overwrites),
		pins: [],
		reactions: [],
		attachments: [],
		errors,
	};

	let rawMessages: JsonObject[] = [];
	try {
		rawMessages = await fetchAllMessages(deps.rest, channel.id, cutoffs[channel.id]);
	} catch (error) {
		recordScopeError(scope, unresolved, "messages", error);
	}

	try {
		const rawPins = await get(deps.rest, `/channels/${channel.id}/pins`);
		const pins = Array.isArray(rawPins) ? rawPins : asArray(asObject(rawPins).items);
		scope.pins = pins
			.map(pin => {
				const item = asObject(pin);
				return stringField(asObject(item.message), "id") || stringField(item, "id");
			})
			.filter(Boolean)
			.sort(compareSnowflakes);
	} catch (error) {
		recordScopeError(scope, unresolved, "pins", error);
	}

	const messages: JsonObject[] = [];
	for (const raw of rawMessages) {
		const message = await normalizeMessage(raw, channel, deps, outputDir, scope, unresolved);
		messages.push(message);
	}
	messages.sort((a, b) => compareSnowflakes(stringField(a, "id"), stringField(b, "id")));
	scope.message_ids = messages.map(message => stringField(message, "id"));
	scope.message_count = messages.length;
	scope.first_message_id = scope.message_ids[0] ?? null;
	scope.last_message_id = scope.message_ids.at(-1) ?? null;
	return { channel, kind, messages, rawMessages, scope };
}

async function fetchAllMessages(
	rest: ReadOnlyRest,
	channelId: string,
	cutoff: string | undefined,
): Promise<JsonObject[]> {
	const newestFirst: JsonObject[] = [];
	let before = cutoff;
	const seen = new Set<string>();
	for (;;) {
		const query: Record<string, string> = { limit: "100" };
		if (before) query.before = before;
		const page = asArray(await get(rest, `/channels/${channelId}/messages`, query)).map(asObject);
		if (page.length === 0) break;
		newestFirst.push(...page);
		const cursor = stringField(page.at(-1) ?? {}, "id");
		if (!cursor || seen.has(cursor)) throw new Error("message pagination did not advance");
		seen.add(cursor);
		before = cursor;
		if (page.length < 100) break;
	}
	return newestFirst.sort((a, b) => compareSnowflakes(stringField(a, "id"), stringField(b, "id")));
}

async function normalizeMessage(
	raw: JsonObject,
	channel: DiscordChannel,
	deps: ArchiveDependencies,
	outputDir: string,
	scope: ArchiveScope,
	unresolved: ArchiveUnresolved[],
): Promise<JsonObject> {
	const messageId = requireSnowflake(stringField(raw, "id"), "message.id");
	const channelId = requireSnowflake(stringField(raw, "channel_id") || channel.id, "message.channel_id");
	const author = asObject(raw.author);
	const reactions: JsonObject[] = [];
	for (const rawReaction of asArray(raw.reactions).map(asObject)) {
		const emojiObject = asObject(rawReaction.emoji);
		const emoji = reactionEmoji(emojiObject);
		const includeBurst = numberField(asObject(rawReaction.count_details), "burst") > 0;
		let userIds: string[] = [];
		try {
			userIds = await fetchReactionUsers(deps.rest, channelId, messageId, emoji, includeBurst);
		} catch (error) {
			recordScopeError(scope, unresolved, `reaction_users:${messageId}:${emoji}`, error);
		}
		reactions.push({ emoji, count: numberField(rawReaction, "count"), user_ids: userIds });
	}

	const attachments: JsonObject[] = [];
	const usedAttachmentPaths = new Set<string>();
	for (const rawAttachment of asArray(raw.attachments).map(asObject)) {
		const filename = typeof rawAttachment.filename === "string" ? rawAttachment.filename : "attachment";
		const sourceUrl = typeof rawAttachment.url === "string" ? rawAttachment.url : "";
		const pathFilename = screenText(filename, deps.secretObfuscator);
		const relativePath = uniqueAttachmentPath(
			channelId,
			messageId,
			pathFilename,
			stringField(rawAttachment, "id"),
			usedAttachmentPaths,
		);
		let bytes = new Uint8Array();
		let digest = "";
		if (!sourceUrl) {
			recordScopeError(
				scope,
				unresolved,
				`attachment:${messageId}:${filename}`,
				new Error("attachment URL missing"),
			);
		} else {
			try {
				assertDiscordAttachmentUrl(sourceUrl);
				const response = await deps.fetch(sourceUrl, { redirect: "error" });
				if (!response.ok) throw new HttpStatusError(response.status, "attachment download failed");
				const finalUrl = response.url || sourceUrl;
				assertDiscordAttachmentUrl(finalUrl);
				bytes = new Uint8Array(await response.arrayBuffer());
				digest = sha256(bytes);
				await atomicWrite(path.join(outputDir, relativePath), bytes);
			} catch (error) {
				recordScopeError(scope, unresolved, `attachment:${messageId}:${filename}`, error);
			}
		}
		attachments.push({
			channel_id: channelId,
			message_id: messageId,
			filename,
			relative_path: relativePath,
			size: bytes.length,
			sha256: digest,
			source_url: sourceUrl,
		});
	}

	const thread = asObject(raw.thread);
	return {
		id: messageId,
		channel_id: channelId,
		author: {
			id: stringField(author, "id"),
			username: stringField(author, "username"),
			global_name: nullableString(author.global_name),
			bot: author.bot === true,
		},
		timestamp: stringField(raw, "timestamp"),
		edited_timestamp: nullableString(raw.edited_timestamp),
		content: stringField(raw, "content"),
		tts: raw.tts === true,
		pinned: raw.pinned === true,
		type: numberField(raw, "type"),
		embeds: jsonArray(raw.embeds),
		reactions,
		attachments,
		message_reference: jsonObjectOrNull(raw.message_reference),
		referenced_message_id: stringField(asObject(raw.referenced_message), "id") || null,
		thread_metadata:
			Object.keys(thread).length > 0
				? {
						id: stringField(thread, "id"),
						name: stringField(thread, "name"),
						parent_id: nullableString(thread.parent_id),
						metadata: jsonObjectOrNull(thread.thread_metadata),
					}
				: null,
	};
}

async function fetchReactionUsers(
	rest: ReadOnlyRest,
	channelId: string,
	messageId: string,
	emoji: string,
	includeBurst: boolean,
): Promise<string[]> {
	const users = new Set<string>();
	for (const type of includeBurst ? ["0", "1"] : ["0"]) {
		let after: string | undefined;
		for (;;) {
			const query: Record<string, string> = { limit: "100", type };
			if (after) query.after = after;
			const page = asArray(
				await get(
					rest,
					`/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
					query,
				),
			).map(asObject);
			for (const user of page) {
				const id = stringField(user, "id");
				if (id) users.add(id);
			}
			if (page.length < 100) break;
			const cursor = stringField(page.at(-1) ?? {}, "id");
			if (!cursor || cursor === after) throw new Error("reaction-user pagination did not advance");
			after = cursor;
		}
	}
	return [...users].sort(compareSnowflakes);
}

function reactionEmoji(emoji: JsonObject): string {
	const name = stringField(emoji, "name");
	const id = stringField(emoji, "id");
	return id ? `${name}:${id}` : name;
}

function parseArchiveAttachments(value: JsonValue | undefined): ArchiveAttachment[] {
	return asArray(value).map(item => {
		const attachment = asObject(item);
		return {
			channel_id: stringField(attachment, "channel_id"),
			message_id: stringField(attachment, "message_id"),
			filename: stringField(attachment, "filename"),
			relative_path: stringField(attachment, "relative_path"),
			size: numberField(attachment, "size"),
			sha256: stringField(attachment, "sha256"),
			source_url: stringField(attachment, "source_url"),
		};
	});
}

function parseArchiveReactions(message: JsonObject): ArchiveReaction[] {
	const messageId = stringField(message, "id");
	return asArray(message.reactions).map(item => {
		const reaction = asObject(item);
		return {
			message_id: messageId,
			emoji: stringField(reaction, "emoji"),
			count: numberField(reaction, "count"),
			user_ids: asArray(reaction.user_ids).filter((value): value is string => typeof value === "string"),
		};
	});
}

function screenJson(value: JsonValue, obfuscator: SecretScreener | undefined): { value: JsonValue; paths: string[] } {
	if (!obfuscator) return { value, paths: [] };
	const paths: string[] = [];
	const visit = (current: JsonValue, currentPath: string): JsonValue => {
		if (typeof current === "string") {
			const screened = screenText(current, obfuscator);
			if (screened === current) return current;
			paths.push(currentPath || "$");
			return screened;
		}
		if (Array.isArray(current)) return current.map((item, index) => visit(item, `${currentPath}[${index}]`));
		if (current !== null && typeof current === "object") {
			const result: JsonObject = {};
			for (const key of Object.keys(current).sort())
				result[key] = visit(current[key] ?? null, `${currentPath}.${key}`);
			return result;
		}
		return current;
	};
	return { value: visit(value, "$"), paths };
}

function screenText(value: string, obfuscator: SecretScreener | undefined): string {
	if (!obfuscator) return value;
	const obfuscated = obfuscator.obfuscate(value);
	return obfuscated === value ? value : `[REDACTED sha256:${sha256(value)}]`;
}

function renderScopeMarkdown(scope: ArchiveScope, messages: JsonObject[]): string {
	const lines = [
		`# ${scope.name}`,
		"",
		`- Scope ID: \`${scope.id}\``,
		`- Kind: ${scope.kind}`,
		`- Messages: ${messages.length}`,
		"",
	];
	for (const message of messages) {
		const author = asObject(message.author);
		lines.push(
			`## ${stringField(message, "timestamp") || "Unknown time"} — ${stringField(author, "username") || "Unknown author"}`,
			"",
			`Message ID: \`${stringField(message, "id")}\``,
			"",
			stringField(message, "content") || "_(no text content)_",
			"",
		);
		const embeds = asArray(message.embeds);
		if (embeds.length > 0) lines.push("**Embeds**", "", "```json", stableJson(embeds, 2), "```", "");
		const attachments = parseArchiveAttachments(message.attachments);
		if (attachments.length > 0) {
			lines.push("**Attachments**", "");
			for (const attachment of attachments)
				lines.push(
					`- [${attachment.filename}](${attachment.relative_path}) — ${attachment.size} bytes, \`${attachment.sha256}\``,
				);
			lines.push("");
		}
		const reactions = asArray(message.reactions);
		if (reactions.length > 0) {
			lines.push("**Reactions**", "");
			for (const item of reactions) {
				const reaction = asObject(item);
				lines.push(
					`- ${stringField(reaction, "emoji")}: ${numberField(reaction, "count")} (${asArray(reaction.user_ids).length} users)`,
				);
			}
			lines.push("");
		}
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

function renderIndex(guildId: string, scopes: ArchiveScope[], preexisting: ArchiveFile[]): string {
	const lines = ["# Discord Server Export", "", `Guild: \`${guildId}\``, "", "## Exported scopes", ""];
	for (const scope of scopes)
		lines.push(
			`- **${scope.name}** (\`${scope.id}\`, ${scope.kind}, ${scope.message_count} messages): [JSONL](${scope.jsonl_path}) · [Markdown](${scope.markdown_path})`,
		);
	if (preexisting.length > 0) {
		lines.push("", "## Pre-existing meeting artifacts (preserved)", "");
		for (const file of preexisting)
			lines.push(`- [${path.posix.basename(file.path)}](${file.path}) — ${file.size} bytes, \`${file.sha256}\``);
	}
	lines.push(
		"",
		"See [manifest.json](manifest.json) for the machine-readable inventory and [redaction-report.json](redaction-report.json) for screening details.",
		"",
	);
	return lines.join("\n");
}

async function collectPreexistingArtifacts(outputDir: string): Promise<ArchiveFile[]> {
	const parent = path.dirname(outputDir);
	const artifacts: ArchiveFile[] = [];
	for (const filename of PREEXISTING_FILES) {
		const absolute = path.join(parent, filename);
		try {
			const bytes = new Uint8Array(await fs.readFile(absolute));
			artifacts.push({ path: `../${filename}`, size: bytes.length, sha256: sha256(bytes) });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return artifacts;
}

async function hashFiles(outputDir: string, relativePaths: string[]): Promise<ArchiveFile[]> {
	const files: ArchiveFile[] = [];
	for (const relativePath of [...new Set(relativePaths)].sort()) {
		try {
			const bytes = new Uint8Array(await fs.readFile(path.join(outputDir, relativePath)));
			files.push({ path: toPosix(relativePath), size: bytes.length, sha256: sha256(bytes) });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return files;
}

async function atomicWrite(destination: string, content: string | Uint8Array): Promise<void> {
	await fs.mkdir(path.dirname(destination), { recursive: true });
	const temporary = path.join(
		path.dirname(destination),
		`.${path.basename(destination)}.tmp-${process.pid}-${atomicSequence++}`,
	);
	try {
		await fs.writeFile(temporary, content, { flag: "wx", mode: 0o600 });
		await fs.rename(temporary, destination);
	} catch (error) {
		await fs.rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}

async function encryptTarWithAge(tar: Uint8Array, recipientFile: string): Promise<Uint8Array> {
	const stat = await fs.stat(recipientFile);
	if (!stat.isFile()) throw new Error("age recipient file must be a regular file");
	const child = Bun.spawn(["age", "--encrypt", "--recipients-file", recipientFile], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	child.stdin.write(tar);
	child.stdin.end();
	const [status, output, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).arrayBuffer(),
		new Response(child.stderr).text(),
	]);
	if (status !== 0) throw new Error(`age encryption failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
	return new Uint8Array(output);
}

function createTar(files: Array<{ name: string; bytes: Uint8Array }>): Uint8Array {
	const blocks: Uint8Array[] = [];
	for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
		const nameBytes = new TextEncoder().encode(file.name);
		if (nameBytes.length > 100) throw new Error(`tar entry name too long: ${file.name}`);
		const header = new Uint8Array(512);
		header.set(nameBytes, 0);
		writeTarOctal(header, 100, 8, 0o600);
		writeTarOctal(header, 108, 8, 0);
		writeTarOctal(header, 116, 8, 0);
		writeTarOctal(header, 124, 12, file.bytes.length);
		writeTarOctal(header, 136, 12, 0);
		header.fill(0x20, 148, 156);
		header[156] = "0".charCodeAt(0);
		header.set(new TextEncoder().encode("ustar\0"), 257);
		header.set(new TextEncoder().encode("00"), 263);
		writeTarOctal(
			header,
			148,
			8,
			header.reduce((sum, byte) => sum + byte, 0),
		);
		blocks.push(header, file.bytes);
		const padding = (512 - (file.bytes.length % 512)) % 512;
		if (padding > 0) blocks.push(new Uint8Array(padding));
	}
	blocks.push(new Uint8Array(1024));
	const result = new Uint8Array(blocks.reduce((sum, block) => sum + block.length, 0));
	let offset = 0;
	for (const block of blocks) {
		result.set(block, offset);
		offset += block.length;
	}
	return result;
}

function writeTarOctal(target: Uint8Array, offset: number, length: number, value: number): void {
	target.set(new TextEncoder().encode(`${value.toString(8).padStart(length - 1, "0")}\0`), offset);
}

function recordScopeError(
	scope: ArchiveScope,
	unresolved: ArchiveUnresolved[],
	operation: string,
	error: unknown,
): void {
	const safe = toArchiveError(operation, error);
	scope.errors.push(safe);
	unresolved.push({ scope_id: scope.id, ...safe });
}

function toUnresolved(scopeId: string, operation: string, error: unknown): ArchiveUnresolved {
	return { scope_id: scopeId, ...toArchiveError(operation, error) };
}

function toArchiveError(operation: string, error: unknown): ArchiveError {
	const candidate = error as { status?: unknown; code?: unknown };
	return {
		operation,
		...(typeof candidate?.status === "number" ? { status: candidate.status } : {}),
		...(typeof candidate?.code === "string" || typeof candidate?.code === "number"
			? { code: String(candidate.code) }
			: {}),
		message: error instanceof HttpStatusError ? error.message : "Discord archive operation failed",
	};
}

class HttpStatusError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function assertDiscordAttachmentUrl(value: string): void {
	const url = new URL(value);
	if (url.protocol !== "https:" || !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)) {
		throw new Error("attachment URL is not on an allowed Discord CDN host");
	}
}

function normalizeCutoffs(input: Readonly<Record<string, string>>): Record<string, string> {
	const output: Record<string, string> = {};
	for (const key of Object.keys(input).sort(compareSnowflakes))
		output[requireSnowflake(key, "cutoff channel ID")] = requireSnowflake(input[key] ?? "", "cutoff message ID");
	return output;
}

function parseChannels(value: unknown): DiscordChannel[] {
	return asArray(value)
		.map(asObject)
		.filter(
			channel =>
				/^\d+$/.test(stringField(channel, "id")) &&
				typeof channel.type === "number" &&
				Number.isInteger(channel.type),
		)
		.map(channel => ({
			...channel,
			id: stringField(channel, "id"),
			type: numberField(channel, "type"),
			name: typeof channel.name === "string" ? channel.name : undefined,
			parent_id: typeof channel.parent_id === "string" ? channel.parent_id : null,
			permission_overwrites: parsePermissionOverwrites(channel.permission_overwrites),
			thread_metadata: jsonObjectOrUndefined(channel.thread_metadata),
		}));
}

function parsePermissionOverwrites(value: JsonValue | undefined): JsonObject[] {
	return asArray(value)
		.map(asObject)
		.map(overwrite => ({
			id: stringField(overwrite, "id"),
			type: numberField(overwrite, "type"),
			allow: stringField(overwrite, "allow"),
			deny: stringField(overwrite, "deny"),
		}));
}

function uniqueAttachmentPath(
	channelId: string,
	messageId: string,
	filename: string,
	attachmentId: string,
	used: Set<string>,
): string {
	const safeFilename = sanitizeFilename(filename);
	let relative = `attachments/${channelId}/${messageId}-${safeFilename}`;
	if (used.has(relative)) {
		const extension = path.posix.extname(safeFilename);
		const base = safeFilename.slice(0, safeFilename.length - extension.length);
		relative = `attachments/${channelId}/${messageId}-${base}-${attachmentId || used.size}${extension}`;
	}
	used.add(relative);
	return relative;
}

function sanitizeFilename(filename: string): string {
	const cleaned = filename
		.normalize("NFKC")
		.replace(/[\\/\0-\x1f\x7f]+/g, "_")
		.replace(/^\.+/, "")
		.trim();
	return cleaned.slice(0, 180) || "attachment";
}

function slug(name: string): string {
	return (
		name
			.normalize("NFKD")
			.replace(/[\u0300-\u036f]/g, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 80) || "scope"
	);
}

function stableJson(value: unknown, space?: number): string {
	return JSON.stringify(sortJson(value), null, space) ?? "null";
}
function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJson);
	if (value !== null && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) result[key] = sortJson((value as Record<string, unknown>)[key]);
		return result;
	}
	return value;
}
function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}
function compareSnowflakes(left: string, right: string): number {
	if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
		const a = BigInt(left);
		const b = BigInt(right);
		return a < b ? -1 : a > b ? 1 : 0;
	}
	return left.localeCompare(right);
}
function requireSnowflake(value: string, label: string): string {
	if (!/^\d+$/.test(value)) throw new Error(`${label} must be a decimal snowflake string`);
	return value;
}
function asObject(value: unknown): JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}
function asArray(value: unknown): JsonValue[] {
	return Array.isArray(value) ? (value as JsonValue[]) : [];
}
function stringField(value: JsonObject, key: string): string {
	return typeof value[key] === "string" ? value[key] : "";
}
function numberField(value: JsonObject, key: string): number {
	return typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] : 0;
}
function nullableString(value: JsonValue | undefined): string | null {
	return typeof value === "string" ? value : null;
}
function jsonArray(value: JsonValue | undefined): JsonValue[] {
	return asArray(value).map(item => sortJson(item) as JsonValue);
}
function jsonObjectOrNull(value: JsonValue | undefined): JsonObject | null {
	const object = asObject(value);
	return Object.keys(object).length > 0 ? (sortJson(object) as JsonObject) : null;
}
function jsonObjectOrUndefined(value: JsonValue | undefined): JsonObject | undefined {
	const object = asObject(value);
	return Object.keys(object).length > 0 ? object : undefined;
}
function toPosix(value: string): string {
	return value.split(path.sep).join(path.posix.sep);
}
