/**
 * Fold the committed Discord archive into proposed GitHub issues.
 *
 * This module does NOT call the GitHub API. It reads the export written by
 * `archive.ts` and emits a plan: titles, bodies, labels, and the provenance
 * needed to walk every issue back to the exact Discord message it came from.
 * Creating the issues is a separate, reviewed step -- run the `gh issue create`
 * commands printed in `condense-plan.md`, or feed `condense-plan.json` to
 * cc-track. Nothing here mutates Discord or GitHub.
 *
 * Two rules the plan is built around:
 *
 *  - Traceability. Every message folded into an issue contributes its author,
 *    its timestamp, and a `https://discord.com/channels/...` permalink to the
 *    issue body. An issue you cannot trace back to the conversation is worse
 *    than no issue.
 *  - No invention. The MESSAGE_CONTENT privileged intent was off when the
 *    current export ran, so Discord returned `""` for every message body. An
 *    export in that state is refused outright rather than turned into issues
 *    titled from empty strings. See `EmptyExportContentError`.
 *
 * Output is deterministic: same export plus same label catalogue produces
 * byte-identical files. Nothing is stamped with the current time.
 *
 * Runnable directly:
 *   bun src/condense.ts --export-dir <dir> --labels <cc_track_labels.json> [--out <dir>]
 *     [--guild <id>] [--repo <owner/name>] [--content-bots <id,id>]
 * Exit codes: 0 plan emitted; 1 error; 2 the export has no readable message
 * bodies (enable MESSAGE_CONTENT and re-export).
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { CHANNEL_IDS, type ChannelPlan, GUILD_ID, TARGET_LAYOUT } from "./channels";

export type ScopeKind = "channel" | "thread";

export interface CondenseOptions {
	/** The `discord-server-export` directory: `manifest.json` plus one jsonl per scope. */
	readonly exportDir: string;
	/** `scripts/cc_track_labels.json` in the CloudCastle repo. The only source of label names. */
	readonly labelCatalogPath: string;
	readonly guildId?: string;
	/** `owner/name` used in the emitted `gh issue create` commands. */
	readonly repo?: string;
	/**
	 * Bot accounts whose posts are discussion rather than machine output. Empty by
	 * default: a bot-authored message is skipped, because folding a tracker's own
	 * feed back into issues is a loop. A meeting transcriber is the exception --
	 * every archived thread message in this guild was posted by one -- so its id
	 * goes here once a human has decided that account carries people talking.
	 * Scopes skipped only for this reason say so, naming the account and this option.
	 */
	readonly contentBotAuthorIds?: readonly string[];
	/** When set, `condense-plan.json`, `condense-plan.md`, and `issues/<key>.md` are written here. */
	readonly outputDir?: string;
}

export interface IssueSource {
	readonly scopeId: string;
	readonly scopeName: string;
	readonly scopeKind: ScopeKind;
	readonly messageId: string;
	readonly author: string;
	readonly authorId: string;
	/** Normalised to `...Z` so the output does not depend on the exporter's offset format. */
	readonly timestamp: string;
	readonly permalink: string;
	readonly content: string;
}

export interface ProposedIssue {
	/** Stable, derived from ids: safe as a filename and as a dedupe key across runs. */
	readonly key: string;
	readonly title: string;
	readonly body: string;
	readonly labels: readonly string[];
	readonly sources: readonly IssueSource[];
}

export interface SkippedScope {
	readonly scopeId: string;
	readonly scopeName: string;
	readonly scopeKind: ScopeKind;
	readonly reason: string;
}

export interface SkippedMessage {
	readonly scopeId: string;
	readonly messageId: string;
	readonly reason: string;
}

export interface CondensePlan {
	readonly version: number;
	readonly guildId: string;
	readonly repo: string;
	/** Hash of the exact `manifest.json` this plan was built from. */
	readonly exportManifestSha256: string;
	readonly exportGeneratedAt: string;
	readonly issues: readonly ProposedIssue[];
	readonly skippedScopes: readonly SkippedScope[];
	readonly skippedMessages: readonly SkippedMessage[];
}

/**
 * Thrown when an export carries no readable message bodies at all. Separate
 * class because it is not a bug in the export or in this code: it is the
 * MESSAGE_CONTENT intent being off, and the fix is a Discord setting plus a
 * re-export, not a retry.
 */
export class EmptyExportContentError extends Error {
	readonly candidateMessages: number;
	constructor(exportDir: string, candidateMessages: number) {
		super(
			`every one of the ${candidateMessages} analysable message(s) in ${exportDir} has an empty body. ` +
				"That is the MESSAGE_CONTENT privileged intent being off when the export ran: the Discord API returns " +
				'content: "" for every message until it is enabled. Enable MESSAGE_CONTENT under the application\'s Bot ' +
				"settings, re-run the archive exporter, and condense the fresh export. Refusing to propose issues with " +
				"no content, because a title invented from an empty string is worse than no issue.",
		);
		this.candidateMessages = candidateMessages;
	}
}

const PLAN_VERSION = 1;
const DEFAULT_REPO = "Hunter-124/CloudCastle";
const TITLE_LIMIT = 72;

/** DEFAULT and REPLY. Every other type is a system event with no authored body. */
const CONVERSATIONAL_MESSAGE_TYPES: Readonly<Record<string, true>> = { "0": true, "19": true };

const LAYOUT_BY_CHANNEL_ID: Readonly<Record<string, ChannelPlan>> = Object.fromEntries(
	TARGET_LAYOUT.filter(plan => plan.id !== null).map(plan => [plan.id as string, plan] as const),
);

/**
 * Label inference. Every produced name is checked against the catalogue before
 * it lands on an issue, so a catalogue rename turns into a loud failure instead
 * of an issue carrying a label that does not exist.
 *
 * Patterns are deliberately narrow. "where the content clearly implies one,
 * otherwise omit" means a bare "C3" or "W1" is not enough; the words
 * "checkpoint" and "wave" have to be there.
 */
const PRIORITY_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
	{ label: "prio:p0", pattern: /\b(p0|drop everything|outage|data loss|launch[ -]blocking)\b/i },
	{ label: "prio:p1", pattern: /\b(p1|blocking (a )?(teammate|checkpoint)|blocks (a )?(teammate|checkpoint))\b/i },
	{ label: "prio:p2", pattern: /\bp2\b/i },
	{ label: "prio:p3", pattern: /\b(p3|nice to have)\b/i },
];

const AREA_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
	{ label: "area:rmm", pattern: /\b(rmm|technician console|control[ -]api|remote desktop|patch management)\b/i },
	{ label: "area:defender", pattern: /\b(defender|edr|agentd|detection engine|sensor)\b/i },
	{
		label: "area:webservice",
		pattern: /\b(marketing site|public site|customer portal|signup|sign[ -]up|billing|pricing page|admin console)\b/i,
	},
	{ label: "area:emailsec", pattern: /\b(email security|emailsec|quarantine|phishing|dmarc|spf)\b/i },
	{ label: "area:cloudsec", pattern: /\b(cloud posture|ztna|sdp|network security)\b/i },
	{ label: "area:eventstore", pattern: /\b(event store|eventstore|event ingestion|retention policy)\b/i },
	{ label: "area:shared", pattern: /\bshared crates?\b/i },
	{ label: "area:docs", pattern: /\b(runbook|docs tree|documentation)\b/i },
	{ label: "area:ci", pattern: /\b(github actions|ci pipeline|release pipeline|code signing|notariz)/i },
];

const WAVE_PATTERN = /\bwave[ :-]?W([0-4])\b/i;
const CHECKPOINT_PATTERN = /\bcheckpoint[ :-]?C(\d{1,2})\b/i;

/** Label name to its position in the catalogue, which is also the sort order on an issue. */
type LabelCatalogue = Map<string, number>;

interface ManifestScope {
	readonly id: string;
	readonly name: string;
	readonly kind: ScopeKind;
	readonly parentId: string | null;
	readonly jsonlPath: string;
	readonly messageCount: number;
}

interface ExportMessage {
	readonly id: string;
	readonly authorId: string;
	readonly author: string;
	readonly authorIsBot: boolean;
	readonly type: number;
	readonly timestamp: string;
	readonly content: string;
}

export async function condense(options: CondenseOptions): Promise<CondensePlan> {
	const exportDir = path.resolve(options.exportDir);
	const guildId = options.guildId ?? GUILD_ID;
	const repo = options.repo ?? DEFAULT_REPO;

	const manifestBytes = await fs.readFile(path.join(exportDir, "manifest.json"));
	const manifest = asObject(JSON.parse(manifestBytes.toString("utf8")) as unknown);
	const scopes = parseScopes(manifest.scopes);
	const catalogue = await readLabelCatalogue(options.labelCatalogPath);

	const skippedScopes: SkippedScope[] = [];
	const skippedMessages: SkippedMessage[] = [];
	const sourceScopes: ManifestScope[] = [];

	const scopeById = new Map(scopes.map(scope => [scope.id, scope]));

	for (const scope of scopes) {
		const verdict = classifyScope(scope, scopeById);
		if (verdict)
			skippedScopes.push({ scopeId: scope.id, scopeName: scope.name, scopeKind: scope.kind, reason: verdict });
		else sourceScopes.push(scope);
	}

	// Read every source scope up front: the all-empty refusal has to see the
	// whole export, not fail after half a plan has been built.
	const contentBots = new Set(options.contentBotAuthorIds ?? []);
	const loaded: { scope: ManifestScope; messages: ExportMessage[]; skippedBots: Map<string, string> }[] = [];
	let candidateMessages = 0;
	let messagesWithContent = 0;
	for (const scope of sourceScopes) {
		const eligible: ExportMessage[] = [];
		const skippedBots = new Map<string, string>();
		for (const message of await readScopeMessages(exportDir, scope)) {
			if (message.authorIsBot && !contentBots.has(message.authorId)) {
				if (CONVERSATIONAL_MESSAGE_TYPES[String(message.type)]) skippedBots.set(message.authorId, message.author);
				skippedMessages.push({ scopeId: scope.id, messageId: message.id, reason: "bot-authored" });
				continue;
			}
			if (!CONVERSATIONAL_MESSAGE_TYPES[String(message.type)]) {
				skippedMessages.push({
					scopeId: scope.id,
					messageId: message.id,
					reason: `system message (type ${message.type})`,
				});
				continue;
			}
			candidateMessages++;
			if (message.content.trim().length === 0) {
				skippedMessages.push({
					scopeId: scope.id,
					messageId: message.id,
					reason: "empty body (MESSAGE_CONTENT privileged intent was off at export time)",
				});
				continue;
			}
			messagesWithContent++;
			eligible.push(message);
		}
		loaded.push({ scope, messages: eligible, skippedBots });
	}

	if (candidateMessages > 0 && messagesWithContent === 0)
		throw new EmptyExportContentError(exportDir, candidateMessages);

	const exportManifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
	const issues: ProposedIssue[] = [];
	for (const entry of loaded) {
		if (entry.messages.length === 0) {
			const bots = [...entry.skippedBots]
				.sort(([left], [right]) => (left < right ? -1 : 1))
				.map(([id, name]) => `${name} (${id})`);
			skippedScopes.push({
				scopeId: entry.scope.id,
				scopeName: entry.scope.name,
				scopeKind: entry.scope.kind,
				reason:
					bots.length > 0
						? `every message is bot-authored: ${bots.join(", ")}. Pass contentBotAuthorIds / --content-bots ` +
							"with that id if the account transcribes people rather than reporting machine state"
						: "no message with a readable body",
			});
			continue;
		}
		const sources = entry.messages
			.map(message => toSource(entry.scope, message, guildId))
			.sort((left, right) => compareSnowflakes(left.messageId, right.messageId));

		// A thread is a discussion about one thing, so it becomes one issue.
		// An intake-channel message stands alone, so each becomes its own.
		const context = { guildId, catalogue, exportManifestSha256 };
		if (entry.scope.kind === "thread") {
			issues.push(buildIssue(`thread-${entry.scope.id}`, entry.scope, sources, context));
			continue;
		}
		for (const source of sources)
			issues.push(buildIssue(`message-${entry.scope.id}-${source.messageId}`, entry.scope, [source], context));
	}

	issues.sort(
		(left, right) =>
			compareSnowflakes(left.sources[0]?.messageId ?? "0", right.sources[0]?.messageId ?? "0") ||
			(left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
	);
	skippedScopes.sort((left, right) => compareSnowflakes(left.scopeId, right.scopeId));
	skippedMessages.sort(
		(left, right) =>
			compareSnowflakes(left.scopeId, right.scopeId) || compareSnowflakes(left.messageId, right.messageId),
	);

	const plan: CondensePlan = {
		version: PLAN_VERSION,
		guildId,
		repo,
		exportManifestSha256,
		exportGeneratedAt: stringField(manifest, "generated_at"),
		issues,
		skippedScopes,
		skippedMessages,
	};

	if (options.outputDir) await writePlan(plan, path.resolve(options.outputDir));
	return plan;
}

/** Stable JSON: keys sorted, so the bytes do not depend on construction order. */
export function renderCondenseJson(plan: CondensePlan): string {
	return `${JSON.stringify(sortJson(plan), null, 2)}\n`;
}

export function renderCondenseMarkdown(plan: CondensePlan): string {
	const lines = [
		"# Discord archive condense plan",
		"",
		`Guild \`${plan.guildId}\`, export manifest \`sha256:${plan.exportManifestSha256}\` generated ${plan.exportGeneratedAt}.`,
		`${plan.issues.length} proposed issue(s), ${plan.skippedScopes.length} scope(s) skipped, ${plan.skippedMessages.length} message(s) skipped.`,
		"",
		"Nothing here has been filed. Review each issue, then create it:",
		"",
		"```bash",
		...plan.issues.map(
			issue =>
				`gh issue create --repo ${plan.repo} --title ${shellQuote(issue.title)} ` +
				`${issue.labels.map(label => `--label ${shellQuote(label)}`).join(" ")} --body-file issues/${issue.key}.md`,
		),
		"```",
		"",
		"## Proposed issues",
		"",
	];

	plan.issues.forEach((issue, index) => {
		lines.push(
			`### ${index + 1}. ${issue.title}`,
			"",
			`- key: \`${issue.key}\``,
			`- labels: ${issue.labels.map(label => `\`${label}\``).join(", ") || "(none)"}`,
			`- folded from ${issue.sources.length} message(s) in ${issue.sources[0]?.scopeKind ?? "scope"} \`${
				issue.sources[0]?.scopeId ?? ""
			}\``,
			"",
			// <details> keeps a body's own headings and code fences from colliding
			// with this document's structure.
			"<details><summary>body</summary>",
			"",
			issue.body,
			"",
			"</details>",
			"",
		);
	});

	lines.push("## Skipped scopes", "");
	if (plan.skippedScopes.length === 0) lines.push("(none)", "");
	for (const scope of plan.skippedScopes)
		lines.push(`- \`${scope.scopeId}\` ${scope.scopeKind} **${scope.scopeName}**: ${scope.reason}`);

	lines.push("", "## Skipped messages", "");
	if (plan.skippedMessages.length === 0) lines.push("(none)", "");
	const byReason = new Map<string, number>();
	for (const message of plan.skippedMessages) byReason.set(message.reason, (byReason.get(message.reason) ?? 0) + 1);
	for (const reason of [...byReason.keys()].sort()) lines.push(`- ${byReason.get(reason)} x ${reason}`);
	lines.push("");
	return lines.join("\n");
}

export async function runCondenseCli(argv: string[]): Promise<number> {
	const values: Record<string, string> = {};
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index] ?? "";
		if (!["--export-dir", "--labels", "--out", "--guild", "--repo", "--content-bots"].includes(argument)) {
			process.stderr.write(`unknown argument: ${argument}\n`);
			return 1;
		}
		const value = argv[++index];
		if (!value || value.startsWith("--")) {
			process.stderr.write(`${argument} requires a value\n`);
			return 1;
		}
		if (values[argument]) {
			process.stderr.write(`${argument} may be specified only once\n`);
			return 1;
		}
		values[argument] = value;
	}
	const exportDir = values["--export-dir"];
	const labelCatalogPath = values["--labels"];
	if (!exportDir || !labelCatalogPath) {
		process.stderr.write(
			"Usage: bun src/condense.ts --export-dir <dir> --labels <cc_track_labels.json> [--out <dir>] [--guild <id>] [--repo <owner/name>] [--content-bots <id,id>]\n",
		);
		return 1;
	}

	try {
		const plan = await condense({
			exportDir,
			labelCatalogPath,
			...(values["--out"] ? { outputDir: values["--out"] } : {}),
			...(values["--guild"] ? { guildId: values["--guild"] } : {}),
			...(values["--content-bots"]
				? {
						contentBotAuthorIds: (values["--content-bots"] ?? "")
							.split(",")
							.map(id => id.trim())
							.filter(Boolean),
					}
				: {}),
		});
		process.stdout.write(
			`${plan.issues.length} proposed issue(s) from ${plan.skippedScopes.length + plan.issues.length} scope(s)` +
				`${values["--out"] ? `, written to ${values["--out"]}` : ""}\n`,
		);
		return 0;
	} catch (error) {
		if (error instanceof EmptyExportContentError) {
			process.stderr.write(`${error.message}\n`);
			return 2;
		}
		process.stderr.write(`${error instanceof Error ? error.message : "condense failed"}\n`);
		return 1;
	}
}

// ---------------------------------------------------------------------------
// Scope and message selection

/** Returns the reason a scope contributes nothing, or null when it is a source. */
function classifyScope(scope: ManifestScope, scopeById: ReadonlyMap<string, ManifestScope>): string | null {
	if (scope.messageCount === 0) return "no messages";

	const analysisRoot = scope.kind === "thread" ? (scope.parentId ?? scope.id) : scope.id;
	if (analysisRoot === CHANNEL_IDS.notForAnalysis) return "excluded from analysis: #not-for-analysis";

	if (scope.kind === "thread") {
		if (scope.parentId && !scopeById.has(scope.parentId))
			return `parent scope ${scope.parentId} is not in the export`;
		return null;
	}

	const plan = LAYOUT_BY_CHANNEL_ID[scope.id];
	if (!plan) return "channel is not in the target layout";
	if (plan.role !== "intake") return `channel role "${plan.role}" is not an intake channel; nothing to file from it`;
	return null;
}

async function readScopeMessages(exportDir: string, scope: ManifestScope): Promise<ExportMessage[]> {
	const raw = await fs.readFile(path.join(exportDir, scope.jsonlPath), "utf8");
	const messages: ExportMessage[] = [];
	for (const line of raw.split("\n")) {
		if (line.trim().length === 0) continue;
		const record = asObject(JSON.parse(line) as unknown);
		const author = asObject(record.author);
		const timestamp = stringField(record, "timestamp");
		const parsed = new Date(timestamp);
		messages.push({
			id: stringField(record, "id"),
			authorId: stringField(author, "id"),
			author: stringField(author, "global_name") || stringField(author, "username") || stringField(author, "id"),
			authorIsBot: author.bot === true,
			type: numberField(record, "type"),
			timestamp: Number.isNaN(parsed.getTime()) ? timestamp : parsed.toISOString(),
			content: stringField(record, "content"),
		});
	}
	return messages;
}

// ---------------------------------------------------------------------------
// Issue construction

interface IssueContext {
	readonly guildId: string;
	readonly catalogue: LabelCatalogue;
	readonly exportManifestSha256: string;
}

function buildIssue(
	key: string,
	scope: ManifestScope,
	sources: readonly IssueSource[],
	context: IssueContext,
): ProposedIssue {
	const first = sources[0];
	if (!first) throw new Error(`issue ${key} has no source messages`);
	const combined = sources.map(source => source.content).join("\n");

	const title =
		scope.kind === "thread" && scope.name.trim().length > 0 ? scope.name.trim() : summariseTitle(first.content);

	const origin =
		scope.kind === "thread"
			? `the Discord thread **${scope.name}**${scope.parentId ? ` under channel \`${scope.parentId}\`` : ""}`
			: `a Discord message in **#${scope.name}**`;
	const span =
		sources.length === 1
			? `posted ${first.timestamp}`
			: `${sources.length} messages, ${first.timestamp} to ${sources[sources.length - 1]?.timestamp}`;

	const body = [
		`Condensed from ${origin} (${span}).`,
		"",
		"Filed from the committed archive rather than from live Discord. The discussion is reproduced verbatim below;",
		"sharpen the ask before working it.",
		"",
		"## Discussion",
		"",
		...sources.flatMap((source, index) => [
			`### ${index + 1}. ${source.author} - ${source.timestamp}`,
			"",
			source.permalink,
			"",
			...source.content.split("\n").map(line => (line.length === 0 ? ">" : `> ${line}`)),
			"",
		]),
		"## Provenance",
		"",
		`- guild \`${context.guildId}\`, scope \`${scope.id}\` (${scope.kind} **${scope.name}**)`,
		`- export manifest \`sha256:${context.exportManifestSha256}\``,
		`- source message ids: ${sources.map(source => `\`${source.messageId}\``).join(", ")}`,
		"",
	].join("\n");

	return { key, title, body, labels: inferLabels(scope, combined, context.catalogue), sources };
}

function summariseTitle(content: string): string {
	const firstLine =
		content
			.split("\n")
			.map(line => line.replace(/^\s*(?:!task|!problem|[-*#>]+)\s*/i, "").trim())
			.find(line => line.length > 0) ?? "";
	const collapsed = firstLine.replace(/\s+/g, " ");
	if (collapsed.length === 0) throw new Error("cannot title an issue from empty content");
	if (collapsed.length <= TITLE_LIMIT) return collapsed;
	const cut = collapsed.slice(0, TITLE_LIMIT - 3);
	const lastSpace = cut.lastIndexOf(" ");
	return `${(lastSpace > TITLE_LIMIT / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
}

function inferLabels(scope: ManifestScope, content: string, catalogue: LabelCatalogue): string[] {
	const chosen = new Set<string>(["from:discord"]);

	if (scope.kind === "thread") chosen.add("proposal");
	else if (scope.id === CHANNEL_IDS.problems) chosen.add("bug");
	else if (scope.id === CHANNEL_IDS.que) chosen.add("enhancement");

	// First priority match only: two prio labels on one issue is meaningless.
	const priority = PRIORITY_PATTERNS.find(entry => entry.pattern.test(content));
	if (priority) chosen.add(priority.label);

	for (const area of AREA_PATTERNS) if (area.pattern.test(content)) chosen.add(area.label);

	const wave = content.match(WAVE_PATTERN);
	if (wave) chosen.add(`wave:W${wave[1]}`);
	const checkpoint = content.match(CHECKPOINT_PATTERN);
	if (checkpoint) chosen.add(`checkpoint:C${Number(checkpoint[1])}`);

	// The catalogue is authoritative. An inferred name that is not in it (a
	// checkpoint that does not exist, a renamed area) is dropped, never invented.
	return [...chosen]
		.filter(label => catalogue.has(label))
		.sort((left, right) => (catalogue.get(left) ?? 0) - (catalogue.get(right) ?? 0));
}

async function readLabelCatalogue(catalogPath: string): Promise<LabelCatalogue> {
	const parsed = asObject(JSON.parse(await fs.readFile(path.resolve(catalogPath), "utf8")) as unknown);
	const catalogue: LabelCatalogue = new Map();
	for (const entry of asArray(parsed.labels)) {
		const name = stringField(asObject(entry), "name");
		if (name) catalogue.set(name, catalogue.size);
	}
	if (catalogue.size === 0) throw new Error(`${catalogPath} contains no labels`);
	return catalogue;
}

// ---------------------------------------------------------------------------
// Emission

async function writePlan(plan: CondensePlan, outputDir: string): Promise<void> {
	await fs.mkdir(path.join(outputDir, "issues"), { recursive: true });
	await fs.writeFile(path.join(outputDir, "condense-plan.json"), renderCondenseJson(plan), "utf8");
	await fs.writeFile(path.join(outputDir, "condense-plan.md"), renderCondenseMarkdown(plan), "utf8");
	for (const issue of plan.issues)
		await fs.writeFile(path.join(outputDir, "issues", `${issue.key}.md`), issue.body, "utf8");
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Parsing helpers

function parseScopes(value: unknown): ManifestScope[] {
	const scopes = asArray(value)
		.map(asObject)
		.filter(scope => typeof scope.id === "string" && typeof scope.jsonl_path === "string")
		.map(scope => ({
			id: stringField(scope, "id"),
			name: stringField(scope, "name"),
			kind: stringField(scope, "kind") === "thread" ? ("thread" as const) : ("channel" as const),
			parentId: typeof scope.parent_id === "string" ? scope.parent_id : null,
			jsonlPath: stringField(scope, "jsonl_path"),
			messageCount: numberField(scope, "message_count"),
		}));
	if (scopes.length === 0) throw new Error("manifest.json lists no scopes with a jsonl_path");
	return scopes.sort((left, right) => compareSnowflakes(left.id, right.id));
}

function toSource(scope: ManifestScope, message: ExportMessage, guildId: string): IssueSource {
	return {
		scopeId: scope.id,
		scopeName: scope.name,
		scopeKind: scope.kind,
		messageId: message.id,
		author: message.author,
		authorId: message.authorId,
		timestamp: message.timestamp,
		// The channel segment is the thread id for a thread message, which is
		// what Discord itself links to.
		permalink: `https://discord.com/channels/${guildId}/${scope.id}/${message.id}`,
		content: message.content,
	};
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJson);
	if (value === null || typeof value !== "object") return value;
	const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
		left < right ? -1 : left > right ? 1 : 0,
	);
	return Object.fromEntries(entries.map(([key, item]) => [key, sortJson(item)]));
}

function compareSnowflakes(left: string, right: string): number {
	const a = /^\d+$/.test(left) ? BigInt(left) : 0n;
	const b = /^\d+$/.test(right) ? BigInt(right) : 0n;
	return a < b ? -1 : a > b ? 1 : 0;
}

function asObject(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function stringField(value: Record<string, unknown>, key: string): string {
	return typeof value[key] === "string" ? value[key] : "";
}

function numberField(value: Record<string, unknown>, key: string): number {
	return typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] : 0;
}

if (import.meta.main) process.exitCode = await runCondenseCli(process.argv.slice(2));
