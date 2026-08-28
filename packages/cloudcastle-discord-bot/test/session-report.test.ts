import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CHANNELS } from "../src/channels";
import { runReportCli } from "../src/report-cli";
import {
	buildSessionRecord,
	emitSessionReport,
	formatDuration,
	renderSessionReport,
	type SessionInput,
} from "../src/session-report";

const TOKEN = "aVeryLongWebhookTokenSegment_0123456789";
const URL_OK = `https://discord.com/api/webhooks/1542631105608556574/${TOKEN}`;

interface EmbedField {
	name: string;
	value: string;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

async function temporaryDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(tmpdir(), "session-report-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

const INPUT: SessionInput = {
	repo: "CloudCastle",
	branch: "main",
	model: "claude-opus-5",
	sessionId: "sess-9",
	startedAt: "2026-08-27T10:00:00.000Z",
	endedAt: "2026-08-27T11:23:45.000Z",
	filesTouched: ["src/b.ts", "src/a.ts", "src/b.ts", "  "],
	commits: [
		{ sha: "02868fbfa1", subject: "wire the bridge" },
		{ sha: "02868fbfa1", subject: "duplicate" },
	],
	tools: [
		{ name: "edit", count: 3 },
		{ name: "bash", count: 3 },
		{ name: "edit", count: 2 },
	],
	notes: "Implemented the tracking bridge.",
};

function countingFetch(responses: Array<{ status: number; body: string }>) {
	let calls = 0;
	const fetchImpl = (async () => {
		calls++;
		const next = responses.shift();
		if (!next) throw new Error("unexpected extra request");
		return new Response(next.body, { status: next.status });
	}) as unknown as typeof globalThis.fetch;
	return { count: () => calls, fetchImpl };
}

describe("buildSessionRecord", () => {
	test("is deterministic: identical input yields identical bytes and digest", () => {
		const first = buildSessionRecord(INPUT);
		const second = buildSessionRecord({ ...INPUT, filesTouched: ["src/a.ts", "src/b.ts"] });
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
		expect(first.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	test("normalises files, commits, tools, and duration", () => {
		const record = buildSessionRecord(INPUT);
		expect(record.files_touched).toEqual(["src/a.ts", "src/b.ts"]);
		expect(record.commits).toEqual([{ sha: "02868fbfa1", subject: "wire the bridge" }]);
		// Merged by name, ordered by count then name, so the ordering never depends on collection order.
		expect(record.tools).toEqual([
			{ name: "edit", count: 5 },
			{ name: "bash", count: 3 },
		]);
		expect(record.duration_seconds).toBe(5025);
		expect(record.channel_id).toBe(CHANNELS.sessions.id);
	});

	test("changing any field changes the digest", () => {
		expect(buildSessionRecord(INPUT).digest).not.toBe(buildSessionRecord({ ...INPUT, branch: "wip" }).digest);
	});

	test("rejects impossible inputs", () => {
		expect(() => buildSessionRecord({ ...INPUT, startedAt: "yesterday" })).toThrow(/ISO 8601/);
		expect(() => buildSessionRecord({ ...INPUT, endedAt: "2026-08-27T09:00:00.000Z" })).toThrow(/must not precede/);
		expect(() => buildSessionRecord({ ...INPUT, repo: "  " })).toThrow(/repo is required/);
	});
});

describe("renderSessionReport", () => {
	test("is pure and deterministic", () => {
		const record = buildSessionRecord(INPUT);
		expect(JSON.stringify(renderSessionReport(record))).toBe(JSON.stringify(renderSessionReport(record)));
	});

	test("carries the session facts and suppresses mentions", () => {
		const payload = renderSessionReport(buildSessionRecord(INPUT));
		const embed = (payload.embeds ?? [])[0];
		expect(embed.title).toBe("Session — CloudCastle");
		expect(embed.description).toBe("Implemented the tracking bridge.");
		expect(payload.allowed_mentions).toEqual({ parse: [] });
		const rendered = JSON.stringify(payload);
		expect(rendered).toContain("claude-opus-5");
		expect(rendered).toContain("1h 23m 45s");
		expect(rendered).toContain("src/a.ts");
		expect(rendered).toContain("wire the bridge");
		expect(rendered).toContain("edit ×5");
	});

	test("respects Discord embed limits when a session touched far too much", () => {
		const record = buildSessionRecord({
			...INPUT,
			notes: "n".repeat(9000),
			filesTouched: Array.from({ length: 400 }, (_, index) => `src/generated/module-${index}.ts`),
		});
		const embed = (renderSessionReport(record).embeds ?? [])[0];
		expect(String(embed.title).length).toBeLessThanOrEqual(256);
		expect(String(embed.description).length).toBe(4096);
		expect(String(embed.description).endsWith("…")).toBe(true);
		// Shape is produced by renderSessionReport in this package, not by external input.
		const fields = embed.fields as unknown as EmbedField[];
		expect(fields.length).toBeLessThanOrEqual(25);
		for (const field of fields) expect(field.value.length).toBeLessThanOrEqual(1024);
		expect(fields.some(field => field.value.includes("more"))).toBe(true);
	});
});

describe("formatDuration", () => {
	test("reads as a duration at every scale", () => {
		expect(formatDuration(0)).toBe("0s");
		expect(formatDuration(45)).toBe("45s");
		expect(formatDuration(605)).toBe("10m 05s");
		expect(formatDuration(5025)).toBe("1h 23m 45s");
	});
});

describe("emitSessionReport", () => {
	test("writes the JSON record and posts the same session", async () => {
		const outPath = path.join(await temporaryDirectory(), "nested", "session.json");
		const { count, fetchImpl } = countingFetch([{ status: 200, body: '{"id":"1700000000000000009"}' }]);
		const result = await emitSessionReport({
			input: INPUT,
			outPath,
			webhookUrl: URL_OK,
			dependencies: { fetch: fetchImpl, secretObfuscator: undefined },
		});
		expect(result.delivered).toBe(true);
		expect(result.messageId).toBe("1700000000000000009");
		expect(count()).toBe(1);
		const written: unknown = JSON.parse(await fs.readFile(outPath, "utf8"));
		if (!written || typeof written !== "object" || !("digest" in written)) throw new Error("record is not an object");
		expect(written.digest).toBe(result.record.digest);
	});

	test("keeps the evidence when Discord refuses the delivery", async () => {
		const outPath = path.join(await temporaryDirectory(), "session.json");
		const { fetchImpl } = countingFetch([{ status: 400, body: '{"message":"bad"}' }]);
		const result = await emitSessionReport({
			input: INPUT,
			outPath,
			webhookUrl: URL_OK,
			dependencies: { fetch: fetchImpl, secretObfuscator: undefined },
		});
		expect(result.wrote).toBe(true);
		expect(result.delivered).toBe(false);
		expect(result.deliveryError).toContain("HTTP 400");
		expect(result.deliveryError).not.toContain(TOKEN);
		await fs.access(outPath);
	});

	test("screens the credential out of the committed record, not just the wire body", async () => {
		const outPath = path.join(await temporaryDirectory(), "session.json");
		const { fetchImpl } = countingFetch([{ status: 200, body: '{"id":"3"}' }]);
		const result = await emitSessionReport({
			input: { ...INPUT, notes: "exported GITHUB_TOKEN=ghp_FAKECREDENTIAL0123456789 by accident" },
			outPath,
			webhookUrl: URL_OK,
			dependencies: {
				fetch: fetchImpl,
				secretObfuscator: { obfuscate: text => text.replaceAll("ghp_FAKECREDENTIAL0123456789", "***") },
			},
		});
		expect(result.redactedPaths).toEqual(["$.notes"]);
		expect(result.record.notes).toMatch(/^\[REDACTED sha256:[0-9a-f]{64}]$/);
		const onDisk = await fs.readFile(outPath, "utf8");
		expect(onDisk).not.toContain("ghp_FAKECREDENTIAL0123456789");
		// The digest covers the screened content, so record and embed describe one session.
		expect(onDisk).toContain(result.record.digest);
	});
});

describe("runReportCli", () => {
	const baseArgv = [
		"--repo",
		"CloudCastle",
		"--branch",
		"main",
		"--model",
		"claude-opus-5",
		"--started",
		"2026-08-27T10:00:00.000Z",
		"--ended",
		"2026-08-27T11:23:45.000Z",
		"--file",
		"src/a.ts",
		"--commit",
		"02868fbfa1:wire the bridge",
		"--tool",
		"edit:3",
	];

	test("--dry-run posts nothing and writes nothing", async () => {
		const outPath = path.join(await temporaryDirectory(), "session.json");
		const { count, fetchImpl } = countingFetch([]);
		const out: string[] = [];
		const code = await runReportCli([...baseArgv, "--out", outPath, "--dry-run"], {
			env: {},
			dependencies: { fetch: fetchImpl, secretObfuscator: undefined },
			stdout: text => out.push(text),
			stderr: text => out.push(text),
		});
		expect(code).toBe(0);
		expect(count()).toBe(0);
		expect(out.join("")).toContain("Dry run: nothing was posted.");
		await expect(fs.access(outPath)).rejects.toThrow();
	});

	test("exits 0 and never prints the webhook token on success", async () => {
		const outPath = path.join(await temporaryDirectory(), "session.json");
		const { count, fetchImpl } = countingFetch([{ status: 200, body: '{"id":"12"}' }]);
		const out: string[] = [];
		const code = await runReportCli([...baseArgv, "--out", outPath], {
			env: { DISCORD_WEBHOOK_SESSIONS: URL_OK },
			dependencies: { fetch: fetchImpl, secretObfuscator: undefined },
			stdout: text => out.push(text),
			stderr: text => out.push(text),
		});
		expect(code).toBe(0);
		expect(count()).toBe(1);
		const printed = out.join("");
		expect(printed).toContain("message 12");
		expect(printed).toContain("<redacted>");
		expect(printed).not.toContain(TOKEN);
	});

	test("exits 2 when the record was written but the delivery failed", async () => {
		const outPath = path.join(await temporaryDirectory(), "session.json");
		const { fetchImpl } = countingFetch([{ status: 500, body: "" }, { status: 500, body: "" }, { status: 500, body: "" }]);
		const out: string[] = [];
		const code = await runReportCli([...baseArgv, "--out", outPath], {
			env: { DISCORD_WEBHOOK_SESSIONS: URL_OK },
			dependencies: { fetch: fetchImpl, secretObfuscator: undefined, sleep: async () => undefined },
			stdout: text => out.push(text),
			stderr: text => out.push(text),
		});
		expect(code).toBe(2);
		await fs.access(outPath);
	});

	test("exits 1 on a missing credential, a bad credential, and a usage error", async () => {
		const quiet = { stdout: () => undefined, stderr: () => undefined };
		expect(await runReportCli(baseArgv, { env: {}, ...quiet })).toBe(1);
		expect(await runReportCli(baseArgv, { env: { DISCORD_WEBHOOK_SESSIONS: "http://evil.example/x" }, ...quiet })).toBe(1);
		expect(await runReportCli(["--repo", "CloudCastle"], { env: { DISCORD_WEBHOOK_SESSIONS: URL_OK }, ...quiet })).toBe(1);
		expect(await runReportCli([...baseArgv, "--nope", "x"], { env: { DISCORD_WEBHOOK_SESSIONS: URL_OK }, ...quiet })).toBe(
			1,
		);
	});
});
