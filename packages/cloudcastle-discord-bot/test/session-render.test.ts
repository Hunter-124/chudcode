import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_MESSAGE_CHARS, type SessionSnapshot } from "../src/bridge-protocol";
import { embedHash, renderSessionEmbed, renderTail } from "../src/session-render";

const FENCE_LINE = /^ {0,3}(`{3,8}|~{3,8})/;
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

async function temporaryDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(tmpdir(), "session-render-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
	return {
		sessionId: "11111111-2222-4333-8444-555555555555",
		host: "garrison-pc",
		sessionFile: "/home/g/.chudcode/agent/sessions/-g-CloudCastle/2026-08-28_s.jsonl",
		cwd: "/home/g/CloudCastle",
		project: "CloudCastle",
		title: "Restructure admin rail navigation",
		model: "anthropic/claude-opus-5",
		status: "running",
		startedAt: "2026-08-28T10:00:00.000Z",
		updatedAt: "2026-08-28T10:25:00.000Z",
		messageCount: 42,
		costUsd: 1.2345678,
		tokensIn: 328_214,
		tokensOut: 4_561,
		lastTool: "read",
		lastText: "Reading the rail component to find where the active item is computed.",
		originCommandId: null,
		requestedBy: null,
		channelId: "1542474553320542300",
		...overrides,
	};
}

interface RenderedEmbed {
	title: string;
	description?: string;
	color: number;
	fields: { name: string; value: string; inline: boolean }[];
	footer: { text: string };
}

function rendered(input: SessionSnapshot): RenderedEmbed {
	return renderSessionEmbed(input) as unknown as RenderedEmbed;
}

/** Everything Discord counts against the 6000-character whole-embed ceiling. */
function embedTotal(embed: RenderedEmbed): number {
	let total = embed.title.length + (embed.description?.length ?? 0) + embed.footer.text.length;
	for (const field of embed.fields) total += field.name.length + field.value.length;
	return total;
}

function fieldValue(embed: RenderedEmbed, name: string): string | undefined {
	return embed.fields.find(field => field.name === name)?.value;
}

describe("renderSessionEmbed", () => {
	test("carries every fact a reader needs, plus a correlating footer", () => {
		const embed = rendered(snapshot());

		expect(embed.title).toBe("Restructure admin rail navigation");
		expect(embed.description).toBe("Reading the rail component to find where the active item is computed.");
		expect(fieldValue(embed, "Status")).toBe("running");
		expect(fieldValue(embed, "Host")).toBe("garrison-pc");
		expect(fieldValue(embed, "Project")).toBe("CloudCastle");
		expect(fieldValue(embed, "Model")).toBe("anthropic/claude-opus-5");
		expect(fieldValue(embed, "Messages")).toBe("42");
		expect(fieldValue(embed, "Cost")).toBe("$1.2346");
		expect(fieldValue(embed, "Tokens")).toBe("328,214 in / 4,561 out");
		expect(fieldValue(embed, "Last tool")).toBe("`read`");
		// Session duration from the snapshot's own timestamps, never the wall clock.
		expect(fieldValue(embed, "Elapsed")).toBe("25m 0s");
		expect(embed.footer.text).toBe("11111111-2222-4333-8444-555555555555 · garrison-pc");
	});

	test("titles fall back to the project when the session has no title", () => {
		expect(rendered(snapshot({ title: null })).title).toBe("CloudCastle");
		expect(rendered(snapshot({ title: "   " })).title).toBe("CloudCastle");
	});

	test("colours by status", () => {
		expect(rendered(snapshot({ status: "running" })).color).toBe(0x2ecc71);
		expect(rendered(snapshot({ status: "idle" })).color).toBe(0x95a5a6);
		expect(rendered(snapshot({ status: "complete" })).color).toBe(0x3498db);
		expect(rendered(snapshot({ status: "interrupted" })).color).toBe(0xf39c12);
		expect(rendered(snapshot({ status: "aborted" })).color).toBe(0xe74c3c);
		expect(rendered(snapshot({ status: "error" })).color).toBe(0xe74c3c);
		expect(rendered(snapshot({ status: "unknown" })).color).toBe(0x4f545c);
	});

	test("omits fields whose data is absent rather than printing zeroes", () => {
		const embed = rendered(
			snapshot({ model: null, costUsd: null, tokensIn: null, tokensOut: null, lastTool: null, lastText: null }),
		);

		expect(embed.fields.map(field => field.name)).toEqual(["Status", "Host", "Project", "Messages", "Elapsed"]);
		expect(embed.description).toBeUndefined();
	});

	test("reports unknown elapsed for unusable timestamps instead of NaN", () => {
		expect(fieldValue(rendered(snapshot({ startedAt: "not a date" })), "Elapsed")).toBe("unknown");
		expect(
			fieldValue(rendered(snapshot({ startedAt: "2026-08-28T10:00:00.000Z", updatedAt: "2026-08-28T09:00:00.000Z" })), "Elapsed"),
		).toBe("unknown");
	});

	test("formats longer elapsed spans", () => {
		const spans: [string, string][] = [
			["2026-08-28T10:00:12.000Z", "12s"],
			["2026-08-28T13:31:00.000Z", "3h 31m"],
			["2026-08-31T02:00:00.000Z", "2d 16h"],
		];
		for (const [updatedAt, expected] of spans) {
			expect(fieldValue(rendered(snapshot({ updatedAt })), "Elapsed")).toBe(expected);
		}
	});

	test("stays inside every Discord limit on pathological input", () => {
		const embed = rendered(
			snapshot({
				title: "T".repeat(10_000),
				lastText: "X".repeat(10_000),
				model: "M".repeat(5_000),
				lastTool: "L".repeat(5_000),
				project: "P".repeat(10_000),
				host: "H".repeat(10_000),
				sessionId: "S".repeat(10_000),
			}),
		);

		expect(embed.title.length).toBe(256);
		expect(embed.title.endsWith("…")).toBe(true);
		expect(embed.description?.length).toBeLessThanOrEqual(4096);
		expect(embed.footer.text.length).toBeLessThanOrEqual(2048);
		expect(embed.fields.length).toBeLessThanOrEqual(25);
		for (const field of embed.fields) {
			expect(field.name.length).toBeLessThanOrEqual(256);
			expect(field.value.length).toBeLessThanOrEqual(1024);
			expect(field.value.length).toBeGreaterThan(0);
		}
		expect(embedTotal(embed)).toBeLessThanOrEqual(6000);
	});

	test("keeps the whole-embed total under the ceiling even when the facts alone are huge", () => {
		// Seven fields at the 1024-char value limit already exceed 6000 characters,
		// so the ceiling can only hold if trailing facts are dropped.
		const huge = "V".repeat(4_000);
		const embed = rendered(
			snapshot({
				title: huge,
				host: huge,
				project: huge,
				model: huge,
				lastTool: huge,
				lastText: huge,
				sessionId: huge,
			}),
		);

		expect(embedTotal(embed)).toBeLessThanOrEqual(6000);
		// The status is the first fact, so it survives the trimming.
		expect(embed.fields[0]?.name).toBe("Status");
	});
});

describe("embedHash", () => {
	test("is stable under key reordering and across repeated renders", () => {
		const first = renderSessionEmbed(snapshot());
		const second = renderSessionEmbed(snapshot());
		const reordered = Object.fromEntries(Object.entries(first).reverse());

		expect(embedHash(first)).toBe(embedHash(second));
		expect(embedHash(reordered)).toBe(embedHash(first));
		expect(embedHash({ a: 1, b: { c: 2, d: [3, 4] } })).toBe(embedHash({ b: { d: [3, 4], c: 2 }, a: 1 }));
	});

	test("changes for a real change and ignores keys Discord would not send", () => {
		const base = renderSessionEmbed(snapshot());

		expect(embedHash(renderSessionEmbed(snapshot({ status: "idle" })))).not.toBe(embedHash(base));
		expect(embedHash(renderSessionEmbed(snapshot({ messageCount: 43 })))).not.toBe(embedHash(base));
		expect(embedHash(renderSessionEmbed(snapshot({ lastTool: "bash" })))).not.toBe(embedHash(base));
		expect(embedHash({ ...base, extra: undefined })).toBe(embedHash(base));
		// Array order is meaningful, unlike key order.
		expect(embedHash({ a: [1, 2] })).not.toBe(embedHash({ a: [2, 1] }));
	});
});

let messageCounter = 0;

function messageLine(role: string, content: unknown): string {
	messageCounter++;
	return `${JSON.stringify({
		type: "message",
		id: `m${messageCounter}`,
		parentId: null,
		timestamp: "2026-08-28T10:05:00.000Z",
		message: { role, content, timestamp: 1_790_000_000_000 },
	})}\n`;
}

async function transcript(lines: string[]): Promise<SessionSnapshot> {
	const directory = await temporaryDirectory();
	const file = path.join(directory, "tail.jsonl");
	await fs.writeFile(file, lines.join(""));
	return snapshot({ sessionFile: file });
}

describe("renderTail", () => {
	test("returns the last turns as Discord-ready strings", async () => {
		const session = await transcript([
			messageLine("user", "first prompt"),
			messageLine("assistant", [{ type: "text", text: "first answer" }]),
			messageLine("user", [{ type: "text", text: "second prompt" }]),
			messageLine("assistant", [{ type: "text", text: "second answer" }]),
		]);

		const chunks = await renderTail(session, 2);

		// Two short turns fit in one Discord message; boundaries stay visible.
		expect(chunks.length).toBe(1);
		expect(chunks[0]).toBe("**user**\nsecond prompt\n\n**assistant**\nsecond answer");
		expect(chunks[0]).not.toContain("first");
	});

	test("summarises a turn that only called tools, and skips non-conversation roles", async () => {
		const session = await transcript([
			messageLine("assistant", [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }]),
			`${JSON.stringify({ type: "custom", id: "x", parentId: null, timestamp: "z", customType: "session_exit" })}\n`,
			messageLine("toolResult", [{ type: "text", text: "output" }]),
		]);

		expect(await renderTail(session, 5)).toEqual(["**assistant**\n_calling `bash`_"]);
	});

	test("returns nothing for an unreadable file or a non-positive limit", async () => {
		const session = await transcript([messageLine("user", "hello")]);

		expect(await renderTail(snapshot({ sessionFile: "/nonexistent/nope.jsonl" }), 5)).toEqual([]);
		expect(await renderTail(session, 0)).toEqual([]);
		expect(await renderTail(session, -1)).toEqual([]);
	});

	test("chunks a long fenced code block without ever splitting the fence", async () => {
		const codeLines = Array.from({ length: 140 }, (_, index) => `const line${index} = ${index}; // ${"x".repeat(30)}`);
		const session = await transcript([
			messageLine("assistant", [{ type: "text", text: `Here is the fix:\n\n\`\`\`typescript\n${codeLines.join("\n")}\n\`\`\`\n\nDone.` }]),
		]);

		const chunks = await renderTail(session, 1);

		expect(chunks.length).toBeGreaterThan(3);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
			// Balanced fences per chunk: nothing Discord renders holds half a block.
			const fences = chunk.split("\n").filter(line => FENCE_LINE.test(line));
			expect(fences.length % 2).toBe(0);
			expect(fences.length).toBeGreaterThan(0);
		}
		// Continuation chunks reopen the block with its language intact.
		for (const chunk of chunks.slice(1)) expect(chunk.startsWith("```typescript\n")).toBe(true);

		// Every code line survives, exactly once, in order.
		const emitted = chunks
			.flatMap(chunk => chunk.split("\n"))
			.filter(line => line.startsWith("const line"));
		expect(emitted).toEqual(codeLines);
		expect(chunks[0].startsWith("**assistant**\nHere is the fix:")).toBe(true);
		expect(chunks[chunks.length - 1].endsWith("Done.")).toBe(true);
	});

	test("hard-splits a single line longer than a Discord message", async () => {
		const session = await transcript([messageLine("assistant", [{ type: "text", text: "y".repeat(5_000) }])]);

		const chunks = await renderTail(session, 1);

		expect(chunks.length).toBeGreaterThan(2);
		for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
		expect(chunks.join("").split("y").length - 1).toBe(5_000);
	});

	test("closes a fence the transcript itself left dangling", async () => {
		const session = await transcript([
			messageLine("assistant", [{ type: "text", text: "look:\n```sh\nrm -rf /" }]),
			messageLine("user", "no"),
		]);

		const chunks = await renderTail(session, 2);

		for (const chunk of chunks) {
			const fences = chunk.split("\n").filter(line => FENCE_LINE.test(line));
			expect(fences.length % 2).toBe(0);
		}
		expect(chunks[0]).toContain("rm -rf /\n```");
	});
});
