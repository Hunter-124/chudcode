import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CHANNEL_IDS, GUILD_ID } from "../src/channels";
import {
	type CondensePlan,
	condense,
	EmptyExportContentError,
	renderCondenseJson,
	renderCondenseMarkdown,
	runCondenseCli,
} from "../src/condense";

/**
 * The catalogue cc-track actually uses. Deliberately not a fixture copy: the
 * contract is that no label outside this file is ever emitted, and a stale copy
 * would make that contract untestable.
 */
const LABEL_CATALOGUE = "/home/hunter/Desktop/CloudCastle/scripts/cc_track_labels.json";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

async function temporaryDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(tmpdir(), "discord-condense-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

/** The error a call rejected with; fails the test if it resolved instead. */
async function rejection(call: Promise<unknown>): Promise<Error> {
	try {
		await call;
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
	throw new Error("expected the call to reject, but it resolved");
}

interface FixtureMessage {
	id: string;
	content: string;
	author?: string;
	authorId?: string;
	bot?: boolean;
	type?: number;
	timestamp?: string;
}

interface FixtureScope {
	id: string;
	name: string;
	kind: "channel" | "thread";
	parentId?: string | null;
	messages: FixtureMessage[];
}

/** Writes an export directory in the exact shape `archive.ts` produces. */
async function writeExport(scopes: FixtureScope[]): Promise<string> {
	const directory = await temporaryDirectory();
	const manifestScopes = [];
	for (const scope of scopes) {
		const jsonlPath = `${scope.name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}-${scope.id}.jsonl`;
		const lines = scope.messages.map(message =>
			JSON.stringify({
				attachments: [],
				author: {
					bot: message.bot ?? false,
					global_name: message.author ?? "Hunter",
					id: message.authorId ?? "1412981446033014848",
					username: (message.author ?? "Hunter").toLowerCase(),
				},
				channel_id: scope.id,
				content: message.content,
				edited_timestamp: null,
				embeds: [],
				id: message.id,
				message_reference: null,
				pinned: false,
				reactions: [],
				referenced_message_id: null,
				thread_metadata: null,
				timestamp: message.timestamp ?? "2026-08-27T20:14:03.622000+00:00",
				tts: false,
				type: message.type ?? 0,
			}),
		);
		await fs.writeFile(path.join(directory, jsonlPath), lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
		manifestScopes.push({
			attachments: [],
			errors: [],
			id: scope.id,
			jsonl_path: jsonlPath,
			kind: scope.kind,
			markdown_path: jsonlPath.replace(/\.jsonl$/, ".md"),
			message_count: scope.messages.length,
			message_ids: scope.messages.map(message => message.id),
			name: scope.name,
			parent_id: scope.parentId ?? null,
			permission_overwrites: [],
			pins: [],
			reactions: [],
			type: scope.kind === "thread" ? 11 : 0,
		});
	}
	await fs.writeFile(
		path.join(directory, "manifest.json"),
		JSON.stringify(
			{
				version: 1,
				guild_id: GUILD_ID,
				mode: "before-mutate",
				generated_at: "2026-08-28T23:20:17.216Z",
				scopes: manifestScopes,
				files: [],
				preexisting_artifacts: [],
				redactions: [],
				unresolved: [],
				cutoff_by_channel: {},
			},
			null,
			2,
		),
		"utf8",
	);
	return directory;
}

const THREAD_ID = "1542493184423239750";
const NOT_FOR_ANALYSIS_THREAD_ID = "1543035999999999999";
const BOT_ID = "1099999999999999999";

/** Every scope kind condense has to make a decision about, with real bodies. */
function populatedScopes(): FixtureScope[] {
	return [
		{
			id: CHANNEL_IDS.meetingTranscripts,
			name: "meeting-transcripts",
			kind: "channel",
			messages: [{ id: "1542474601362104340", content: "Transcript for the 8-27 call.", type: 18 }],
		},
		{
			id: THREAD_ID,
			name: "Equity Structure & Funding Strategy",
			kind: "thread",
			parentId: CHANNEL_IDS.meetingTranscripts,
			messages: [
				{ id: "1542493186881093774", content: "thread created", type: 4 },
				{
					id: "1542493200000000001",
					content: "Equity split has to land before we file the LLC.\nThat is checkpoint C1.",
					author: "Hunter",
					timestamp: "2026-08-27T20:14:03.622000+00:00",
				},
				{
					id: "1542493200000000002",
					content: "Agreed: 60/40 with a four-year vest, documented in the operating agreement.",
					author: "Affenmensch",
					authorId: "940136031041253387",
					timestamp: "2026-08-27T20:19:44.100000+00:00",
				},
				{
					id: "1542493200000000003",
					content: "Meeting summary generated automatically.",
					author: "DiscMeet",
					authorId: BOT_ID,
					bot: true,
				},
			],
		},
		{
			id: CHANNEL_IDS.problems,
			name: "problems",
			kind: "channel",
			messages: [
				{
					id: "1542699788569682021",
					content: "The customer portal billing page 500s on save. p0 outage for the law firm.",
					author: "Hunter",
					timestamp: "2026-08-28T00:58:11.571000+00:00",
				},
				{ id: "1542699788569682022", content: "Filed as #14.", author: "cc-track", authorId: BOT_ID, bot: true },
			],
		},
		{
			id: CHANNEL_IDS.que,
			name: "que",
			kind: "channel",
			messages: [
				{
					id: "1542699999999999999",
					content: "Add patch management scheduling to the RMM technician console before wave W2.",
					author: "Affenmensch",
					authorId: "940136031041253387",
					timestamp: "2026-08-28T01:10:00.000000+00:00",
				},
			],
		},
		{
			id: CHANNEL_IDS.notForAnalysis,
			name: "not-for-analysis",
			kind: "channel",
			messages: [{ id: "1543035594219716698", content: "Do not read this one.", author: "Hunter" }],
		},
		{
			id: NOT_FOR_ANALYSIS_THREAD_ID,
			name: "side conversation",
			kind: "thread",
			parentId: CHANNEL_IDS.notForAnalysis,
			messages: [{ id: "1543036000000000001", content: "Also private.", author: "Hunter" }],
		},
		{
			id: CHANNEL_IDS.chat,
			name: "chat",
			kind: "channel",
			messages: [{ id: "1542669556240355449", content: "morning", author: "Hunter" }],
		},
		{ id: CHANNEL_IDS.git, name: "git", kind: "channel", messages: [] },
	];
}

async function populatedPlan(outputDir?: string): Promise<{ plan: CondensePlan; exportDir: string }> {
	const exportDir = await writeExport(populatedScopes());
	const plan = await condense({
		exportDir,
		labelCatalogPath: LABEL_CATALOGUE,
		...(outputDir ? { outputDir } : {}),
	});
	return { plan, exportDir };
}

describe("condense refuses an export with no readable bodies", () => {
	test("names the MESSAGE_CONTENT intent and the re-export as the fix", async () => {
		const exportDir = await writeExport(
			populatedScopes().map(scope => ({
				...scope,
				messages: scope.messages.map(message => ({ ...message, content: "" })),
			})),
		);
		const failure = await rejection(condense({ exportDir, labelCatalogPath: LABEL_CATALOGUE }));

		expect(failure).toBeInstanceOf(EmptyExportContentError);
		expect(failure.message).toContain("MESSAGE_CONTENT");
		expect(failure.message).toContain("re-run the archive exporter");
		expect(failure.message).toContain("analysable message(s)");
		// Only the messages condense would actually have used are counted: two in
		// the thread, one in #problems, one in #que. Bot and system messages and
		// every excluded scope are not candidates.
		expect((failure as EmptyExportContentError).candidateMessages).toBe(4);
	});

	test("the CLI reports the refusal with its own exit code", async () => {
		const exportDir = await writeExport([
			{
				id: CHANNEL_IDS.problems,
				name: "problems",
				kind: "channel",
				messages: [{ id: "1542699788569682021", content: "" }],
			},
		]);
		expect(await runCondenseCli(["--export-dir", exportDir, "--labels", LABEL_CATALOGUE])).toBe(2);
	});
});

describe("condense groups and skips", () => {
	test("a thread folds into one issue carrying every message's provenance", async () => {
		const { plan } = await populatedPlan();
		const issue = plan.issues.find(entry => entry.key === `thread-${THREAD_ID}`);
		if (!issue) throw new Error("expected an issue for the thread");

		expect(plan.issues.filter(entry => entry.sources[0]?.scopeId === THREAD_ID)).toHaveLength(1);
		expect(issue.title).toBe("Equity Structure & Funding Strategy");
		expect(issue.sources.map(source => source.messageId)).toEqual(["1542493200000000001", "1542493200000000002"]);
		expect(issue.sources.map(source => source.author)).toEqual(["Hunter", "Affenmensch"]);
		expect(issue.sources.map(source => source.timestamp)).toEqual([
			"2026-08-27T20:14:03.622Z",
			"2026-08-27T20:19:44.100Z",
		]);
		for (const source of issue.sources) {
			expect(source.permalink).toBe(`https://discord.com/channels/${GUILD_ID}/${THREAD_ID}/${source.messageId}`);
			expect(issue.body).toContain(source.permalink);
			expect(issue.body).toContain(source.author);
			expect(issue.body).toContain(source.timestamp);
		}
		expect(issue.body).toContain("> Equity split has to land before we file the LLC.");
		expect(issue.body).toContain("Condensed from the Discord thread **Equity Structure & Funding Strategy**");
	});

	test("intake-channel messages become one issue each", async () => {
		const { plan } = await populatedPlan();
		const problems = plan.issues.filter(issue => issue.sources[0]?.scopeId === CHANNEL_IDS.problems);
		const que = plan.issues.filter(issue => issue.sources[0]?.scopeId === CHANNEL_IDS.que);

		expect(problems).toHaveLength(1);
		expect(problems[0]?.sources).toHaveLength(1);
		expect(problems[0]?.title).toBe("The customer portal billing page 500s on save. p0 outage for the law...");
		expect(que).toHaveLength(1);
		expect(que[0]?.title).toBe("Add patch management scheduling to the RMM technician console before...");
		expect(plan.issues).toHaveLength(3);
	});

	test("not-for-analysis, its threads, bot messages, and non-intake channels are all skipped", async () => {
		const { plan } = await populatedPlan();
		const reasonFor = (scopeId: string) => plan.skippedScopes.find(scope => scope.scopeId === scopeId)?.reason;

		expect(reasonFor(CHANNEL_IDS.notForAnalysis)).toBe("excluded from analysis: #not-for-analysis");
		expect(reasonFor(NOT_FOR_ANALYSIS_THREAD_ID)).toBe("excluded from analysis: #not-for-analysis");
		expect(reasonFor(CHANNEL_IDS.chat)).toContain('channel role "human" is not an intake channel');
		expect(reasonFor(CHANNEL_IDS.meetingTranscripts)).toContain('channel role "human" is not an intake channel');
		expect(reasonFor(CHANNEL_IDS.git)).toBe("no messages");

		expect(plan.skippedMessages).toContainEqual({
			scopeId: THREAD_ID,
			messageId: "1542493200000000003",
			reason: "bot-authored",
		});
		expect(plan.skippedMessages).toContainEqual({
			scopeId: CHANNEL_IDS.problems,
			messageId: "1542699788569682022",
			reason: "bot-authored",
		});
		expect(plan.skippedMessages).toContainEqual({
			scopeId: THREAD_ID,
			messageId: "1542493186881093774",
			reason: "system message (type 4)",
		});

		// Nothing excluded leaks into an issue body.
		for (const issue of plan.issues) {
			expect(issue.body).not.toContain("Do not read this one");
			expect(issue.body).not.toContain("Also private");
			expect(issue.body).not.toContain("Meeting summary generated automatically");
			expect(issue.body).not.toContain("Filed as #14");
		}
	});

	test("an issue is never titled from an empty body", async () => {
		const exportDir = await writeExport([
			{
				id: CHANNEL_IDS.problems,
				name: "problems",
				kind: "channel",
				messages: [
					{ id: "1542699788569682021", content: "" },
					{ id: "1542699788569682022", content: "Sessions channel shows a stale status." },
				],
			},
		]);
		const plan = await condense({ exportDir, labelCatalogPath: LABEL_CATALOGUE });
		expect(plan.issues).toHaveLength(1);
		expect(plan.issues[0]?.title).toBe("Sessions channel shows a stale status.");
		expect(plan.skippedMessages).toContainEqual({
			scopeId: CHANNEL_IDS.problems,
			messageId: "1542699788569682021",
			reason: "empty body (MESSAGE_CONTENT privileged intent was off at export time)",
		});
	});
});

describe("condense and bot-authored discussion", () => {
	/** Every real thread in this guild was transcribed by a note-taker bot. */
	const transcribedThread = (): FixtureScope[] => [
		{
			id: CHANNEL_IDS.meetingTranscripts,
			name: "meeting-transcripts",
			kind: "channel",
			messages: [{ id: "1542474601362104340", content: "transcript", type: 18 }],
		},
		{
			id: THREAD_ID,
			name: "Equity Structure & Funding Strategy",
			kind: "thread",
			parentId: CHANNEL_IDS.meetingTranscripts,
			messages: [
				{
					id: "1542493200000000001",
					content: "Hunter: equity split has to land before we file the LLC.",
					author: "DiscMeet - Note Taker",
					authorId: BOT_ID,
					bot: true,
				},
				{
					id: "1542493200000000002",
					content: "Affenmensch: agreed, 60/40 with a four-year vest.",
					author: "DiscMeet - Note Taker",
					authorId: BOT_ID,
					bot: true,
				},
			],
		},
		{
			id: CHANNEL_IDS.problems,
			name: "problems",
			kind: "channel",
			messages: [{ id: "1542699788569682021", content: "The billing page 500s on save." }],
		},
	];

	test("by default the thread is skipped, and the reason names the bot and the lever", async () => {
		const exportDir = await writeExport(transcribedThread());
		const plan = await condense({ exportDir, labelCatalogPath: LABEL_CATALOGUE });

		expect(plan.issues.map(issue => issue.key)).toEqual([`message-${CHANNEL_IDS.problems}-1542699788569682021`]);
		const skipped = plan.skippedScopes.find(scope => scope.scopeId === THREAD_ID);
		expect(skipped?.reason).toContain("every message is bot-authored: DiscMeet - Note Taker");
		expect(skipped?.reason).toContain(BOT_ID);
		expect(skipped?.reason).toContain("--content-bots");
	});

	test("naming the transcriber as a content bot folds the thread into one issue", async () => {
		const exportDir = await writeExport(transcribedThread());
		const plan = await condense({
			exportDir,
			labelCatalogPath: LABEL_CATALOGUE,
			contentBotAuthorIds: [BOT_ID],
		});

		const issue = plan.issues.find(entry => entry.key === `thread-${THREAD_ID}`);
		expect(issue?.sources).toHaveLength(2);
		expect(issue?.title).toBe("Equity Structure & Funding Strategy");
		expect(issue?.body).toContain("> Hunter: equity split has to land before we file the LLC.");
		expect(plan.skippedScopes.some(scope => scope.scopeId === THREAD_ID)).toBe(false);
	});

	test("the tracker's own feed posts are still never folded back in", async () => {
		const exportDir = await writeExport(transcribedThread());
		const plan = await condense({
			exportDir,
			labelCatalogPath: LABEL_CATALOGUE,
			contentBotAuthorIds: ["1000000000000000000"],
		});
		expect(plan.issues.map(issue => issue.key)).toEqual([`message-${CHANNEL_IDS.problems}-1542699788569682021`]);
	});
});

describe("condense labels", () => {
	test("every label comes from the real catalogue", async () => {
		const catalogue = JSON.parse(await fs.readFile(LABEL_CATALOGUE, "utf8")) as {
			labels: { name: string }[];
		};
		const known = new Set(catalogue.labels.map(label => label.name));
		const { plan } = await populatedPlan();

		expect(plan.issues.length).toBeGreaterThan(0);
		for (const issue of plan.issues) {
			expect(issue.labels.length).toBeGreaterThan(0);
			for (const label of issue.labels) expect(known.has(label), `${label} is not in the catalogue`).toBe(true);
		}
	});

	test("labels are inferred only where the content says so", async () => {
		const { plan } = await populatedPlan();
		const labelsFor = (scopeId: string) =>
			plan.issues.find(issue => issue.sources[0]?.scopeId === scopeId)?.labels ?? [];

		// problems -> bug; "p0 outage" -> prio:p0; "customer portal billing" -> area:webservice.
		expect(labelsFor(CHANNEL_IDS.problems)).toEqual(["prio:p0", "bug", "area:webservice", "from:discord"]);
		// que -> enhancement; "RMM technician console" -> area:rmm; "wave W2" -> wave:W2.
		expect(labelsFor(CHANNEL_IDS.que)).toEqual(["enhancement", "area:rmm", "wave:W2", "from:discord"]);
		// thread -> proposal; "checkpoint C1" is explicit; no area is clearly implied.
		expect(labelsFor(THREAD_ID)).toEqual(["proposal", "checkpoint:C1", "from:discord"]);
	});

	test("an inferred name that is not in the catalogue is dropped, not invented", async () => {
		const exportDir = await writeExport([
			{
				id: CHANNEL_IDS.que,
				name: "que",
				kind: "channel",
				messages: [{ id: "1542699999999999999", content: "Blocked on checkpoint C99 and wave W2." }],
			},
		]);
		const plan = await condense({ exportDir, labelCatalogPath: LABEL_CATALOGUE });
		expect(plan.issues[0]?.labels).toEqual(["enhancement", "wave:W2", "from:discord"]);
	});
});

describe("condense output", () => {
	test("json, markdown, and per-issue bodies are byte-identical across runs", async () => {
		const firstOut = await temporaryDirectory();
		const secondOut = await temporaryDirectory();
		const exportDir = await writeExport(populatedScopes());
		const first = await condense({ exportDir, labelCatalogPath: LABEL_CATALOGUE, outputDir: firstOut });
		const second = await condense({ exportDir, labelCatalogPath: LABEL_CATALOGUE, outputDir: secondOut });

		expect(renderCondenseJson(second)).toBe(renderCondenseJson(first));
		expect(renderCondenseMarkdown(second)).toBe(renderCondenseMarkdown(first));

		const listing = (await fs.readdir(firstOut)).sort();
		expect(listing).toEqual(["condense-plan.json", "condense-plan.md", "issues"]);
		expect((await fs.readdir(secondOut)).sort()).toEqual(listing);
		for (const name of ["condense-plan.json", "condense-plan.md"]) {
			expect(await fs.readFile(path.join(secondOut, name), "utf8")).toBe(
				await fs.readFile(path.join(firstOut, name), "utf8"),
			);
		}
		const bodies = (await fs.readdir(path.join(firstOut, "issues"))).sort();
		expect(bodies).toEqual(first.issues.map(issue => `${issue.key}.md`).sort());
		for (const name of bodies) {
			expect(await fs.readFile(path.join(secondOut, "issues", name), "utf8")).toBe(
				await fs.readFile(path.join(firstOut, "issues", name), "utf8"),
			);
		}
	});

	test("no wall-clock time leaks into the plan", async () => {
		const { plan } = await populatedPlan();
		const serialised = renderCondenseJson(plan);
		expect(plan.exportGeneratedAt).toBe("2026-08-28T23:20:17.216Z");
		expect(serialised).not.toContain(
			new Date().getFullYear() === 2026 ? "PLACEHOLDER" : String(new Date().getFullYear()),
		);
		expect(plan.exportManifestSha256).toMatch(/^[0-9a-f]{64}$/);
	});

	test("issues are ordered by their first source message", async () => {
		const { plan } = await populatedPlan();
		const firsts = plan.issues.map(issue => BigInt(issue.sources[0]?.messageId ?? "0"));
		expect(firsts).toEqual([...firsts].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
	});

	test("the markdown carries a runnable gh issue create line per issue", async () => {
		const { plan } = await populatedPlan();
		const markdown = renderCondenseMarkdown(plan);
		for (const issue of plan.issues) {
			expect(markdown).toContain(`--body-file issues/${issue.key}.md`);
			for (const label of issue.labels) expect(markdown).toContain(`--label '${label}'`);
		}
		expect(markdown).toContain("gh issue create --repo Hunter-124/CloudCastle");
		expect(markdown).toContain("Nothing here has been filed.");
	});

	test("the CLI writes the plan and exits 0", async () => {
		const exportDir = await writeExport(populatedScopes());
		const outputDir = await temporaryDirectory();
		expect(await runCondenseCli(["--export-dir", exportDir, "--labels", LABEL_CATALOGUE, "--out", outputDir])).toBe(
			0,
		);
		expect((await fs.readdir(outputDir)).sort()).toEqual(["condense-plan.json", "condense-plan.md", "issues"]);
	});
});
