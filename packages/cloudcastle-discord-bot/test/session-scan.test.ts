import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionStatus } from "../src/bridge-protocol";
import { defaultSessionsDir, readSessionSnapshot, scanSessions } from "../src/session-scan";

const HOST = "scan-test-host";
const SLOT_BYTES = 256;
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

async function temporaryDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(tmpdir(), "session-scan-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

/** The real fixed-width first line: JSON padded with spaces to exactly 256 bytes including the newline. */
function titleSlotLine(title: string): string {
	const updatedAt = "2026-08-28T00:00:00.000Z";
	const unpadded = JSON.stringify({ type: "title", v: 1, title, updatedAt, pad: "" });
	const pad = " ".repeat(Math.max(0, SLOT_BYTES - unpadded.length - 1));
	return `${JSON.stringify({ type: "title", v: 1, title, updatedAt, pad })}\n`;
}

interface SessionSpec {
	/** Omitted writes no title slot at all, the way pre-slot sessions look on disk. */
	slotTitle?: string;
	id?: string;
	timestamp?: string;
	cwd?: string;
	provider?: string;
	modelId?: string;
	headerTitle?: string;
	entries?: Record<string, unknown>[];
	mtime?: Date;
	/** Replaces header + entries entirely, for corrupt-file cases. */
	rawBody?: string;
}

async function writeSession(directory: string, name: string, spec: SessionSpec = {}): Promise<string> {
	const file = path.join(directory, name);
	await fs.mkdir(directory, { recursive: true });
	const lines: string[] = [];
	if (spec.slotTitle !== undefined) lines.push(titleSlotLine(spec.slotTitle));
	if (spec.rawBody === undefined) {
		const header: Record<string, unknown> = {
			type: "session",
			version: 3,
			id: spec.id ?? "11111111-2222-4333-8444-555555555555",
			timestamp: spec.timestamp ?? "2026-08-28T10:00:00.000Z",
			cwd: spec.cwd ?? directory,
		};
		if (spec.headerTitle !== undefined) header.title = spec.headerTitle;
		if (spec.provider !== undefined) header.provider = spec.provider;
		if (spec.modelId !== undefined) header.modelId = spec.modelId;
		lines.push(`${JSON.stringify(header)}\n`);
		for (const entry of spec.entries ?? []) lines.push(`${JSON.stringify(entry)}\n`);
	} else {
		lines.push(spec.rawBody);
	}
	await fs.writeFile(file, lines.join(""));
	if (spec.mtime) await fs.utimes(file, spec.mtime, spec.mtime);
	return file;
}

let entryCounter = 0;

function assistantEntry(fields: Record<string, unknown>): Record<string, unknown> {
	entryCounter++;
	return {
		type: "message",
		id: `a${entryCounter}`,
		parentId: null,
		timestamp: "2026-08-28T10:05:00.000Z",
		message: {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-5",
			...fields,
		},
	};
}

function userEntry(text: string): Record<string, unknown> {
	entryCounter++;
	return {
		type: "message",
		id: `u${entryCounter}`,
		parentId: null,
		timestamp: "2026-08-28T10:04:00.000Z",
		message: { role: "user", content: [{ type: "text", text }], timestamp: 1_790_000_000_000 },
	};
}

const COMPLETE_TURN = assistantEntry({ content: [{ type: "text", text: "done" }], stopReason: "stop" });

describe("readSessionSnapshot", () => {
	test("reads a header-only session with no entries", async () => {
		const directory = await temporaryDirectory();
		const file = await writeSession(directory, "2026-08-28_a.jsonl", {
			slotTitle: "Restructure the rail",
			cwd: "/tmp/whatever/widgets",
		});

		const snapshot = await readSessionSnapshot(file, HOST);

		expect(snapshot).not.toBeNull();
		expect(snapshot?.sessionId).toBe("11111111-2222-4333-8444-555555555555");
		expect(snapshot?.host).toBe(HOST);
		expect(snapshot?.sessionFile).toBe(file);
		expect(snapshot?.cwd).toBe("/tmp/whatever/widgets");
		expect(snapshot?.title).toBe("Restructure the rail");
		expect(snapshot?.startedAt).toBe("2026-08-28T10:00:00.000Z");
		expect(snapshot?.messageCount).toBe(0);
		expect(snapshot?.status).toBe("unknown");
		// Absent data is null, never a guess.
		expect(snapshot?.model).toBeNull();
		expect(snapshot?.costUsd).toBeNull();
		expect(snapshot?.tokensIn).toBeNull();
		expect(snapshot?.tokensOut).toBeNull();
		expect(snapshot?.lastTool).toBeNull();
		expect(snapshot?.lastText).toBeNull();
		expect(snapshot?.originCommandId).toBeNull();
		expect(snapshot?.requestedBy).toBeNull();
		// The JSONL records nothing about Discord channels; the agent's mirror
		// state owns that, so a scan must never invent one.
		expect(snapshot?.channelId).toBeNull();
	});

	test("returns null rather than throwing for files that are not sessions", async () => {
		const directory = await temporaryDirectory();
		const garbage = await writeSession(directory, "garbage.jsonl", { rawBody: "not json at all\nnor this\n" });
		const truncatedHeader = await writeSession(directory, "truncated.jsonl", {
			slotTitle: "t",
			rawBody: '{"type":"session","id":"missing-clo\n',
		});
		const noHeader = await writeSession(directory, "no-header.jsonl", {
			rawBody: `${JSON.stringify(userEntry("hi"))}\n`,
		});
		const headerWithoutId = await writeSession(directory, "no-id.jsonl", {
			rawBody: '{"type":"session","timestamp":"2026-08-28T10:00:00.000Z","cwd":"/x"}\n',
		});
		const empty = await writeSession(directory, "empty.jsonl", { rawBody: "" });

		expect(await readSessionSnapshot(garbage, HOST)).toBeNull();
		expect(await readSessionSnapshot(truncatedHeader, HOST)).toBeNull();
		expect(await readSessionSnapshot(noHeader, HOST)).toBeNull();
		expect(await readSessionSnapshot(headerWithoutId, HOST)).toBeNull();
		expect(await readSessionSnapshot(empty, HOST)).toBeNull();
		expect(await readSessionSnapshot(path.join(directory, "absent.jsonl"), HOST)).toBeNull();
		expect(await readSessionSnapshot(directory, HOST)).toBeNull();
	});

	test("titles: slot outranks the append-only history, which outranks the header", async () => {
		const directory = await temporaryDirectory();
		const changed = { type: "title_change", id: "t1", parentId: null, timestamp: "z", title: "Renamed later" };

		const withSlot = await writeSession(directory, "slot.jsonl", {
			slotTitle: "Current title",
			headerTitle: "Original title",
			entries: [changed],
		});
		const withoutSlot = await writeSession(directory, "no-slot.jsonl", {
			headerTitle: "Original title",
			entries: [changed],
		});
		const headerOnly = await writeSession(directory, "header-title.jsonl", { headerTitle: "Original title" });
		const blankSlot = await writeSession(directory, "blank-slot.jsonl", {
			slotTitle: "",
			headerTitle: "Original title",
		});
		const untitled = await writeSession(directory, "untitled.jsonl", { slotTitle: "" });

		expect((await readSessionSnapshot(withSlot, HOST))?.title).toBe("Current title");
		expect((await readSessionSnapshot(withoutSlot, HOST))?.title).toBe("Renamed later");
		expect((await readSessionSnapshot(headerOnly, HOST))?.title).toBe("Original title");
		expect((await readSessionSnapshot(blankSlot, HOST))?.title).toBe("Original title");
		expect((await readSessionSnapshot(untitled, HOST))?.title).toBeNull();
	});

	test("model comes from the newest model_change, then messages, then the header", async () => {
		const directory = await temporaryDirectory();
		const fromHeader = await writeSession(directory, "header.jsonl", {
			provider: "anthropic",
			modelId: "claude-sonnet-4-5",
		});
		const fromMessage = await writeSession(directory, "message.jsonl", {
			provider: "anthropic",
			modelId: "claude-sonnet-4-5",
			entries: [COMPLETE_TURN],
		});
		const fromChange = await writeSession(directory, "change.jsonl", {
			entries: [
				COMPLETE_TURN,
				{ type: "model_change", id: "m1", parentId: null, timestamp: "z", model: "openai/gpt-5" },
			],
		});

		expect((await readSessionSnapshot(fromHeader, HOST))?.model).toBe("anthropic/claude-sonnet-4-5");
		expect((await readSessionSnapshot(fromMessage, HOST))?.model).toBe("anthropic/claude-opus-5");
		expect((await readSessionSnapshot(fromChange, HOST))?.model).toBe("openai/gpt-5");
	});

	test("lastText is the newest assistant text, whitespace-collapsed and capped, and lastTool the newest tool", async () => {
		const directory = await temporaryDirectory();
		const file = await writeSession(directory, "text.jsonl", {
			entries: [
				assistantEntry({ content: [{ type: "text", text: "older" }], stopReason: "stop" }),
				assistantEntry({
					content: [
						{ type: "text", text: `  multi\n\nline   ${"x".repeat(400)}  ` },
						{ type: "toolCall", id: "c1", name: "bash", arguments: {} },
					],
					stopReason: "toolUse",
				}),
				{
					type: "message",
					id: "r1",
					parentId: null,
					timestamp: "z",
					message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [], isError: false },
				},
			],
		});

		const snapshot = await readSessionSnapshot(file, HOST);

		expect(snapshot?.lastText?.length).toBe(160);
		expect(snapshot?.lastText?.startsWith("multi line x")).toBe(true);
		expect(snapshot?.lastText?.endsWith("…")).toBe(true);
		expect(snapshot?.lastText).not.toContain("\n");
		// The tool result is newer than the tool call that produced it.
		expect(snapshot?.lastTool).toBe("read");
		expect(snapshot?.messageCount).toBe(3);
	});
});

describe("status derivation", () => {
	const cases: [string, Record<string, unknown>, SessionStatus][] = [
		[
			"assistant text with no pending tools",
			{ content: [{ type: "text", text: "ok" }], stopReason: "stop" },
			"complete",
		],
		["assistant stopReason error", { content: [], stopReason: "error", errorMessage: "boom" }, "error"],
		[
			"assistant stopReason aborted",
			{ content: [{ type: "text", text: "partial" }], stopReason: "aborted" },
			"aborted",
		],
		[
			"assistant stopReason length",
			{ content: [{ type: "text", text: "cut" }], stopReason: "length" },
			"interrupted",
		],
	];

	for (const [label, message, expected] of cases) {
		test(`${label} -> ${expected}`, async () => {
			const directory = await temporaryDirectory();
			// A fresh mtime must not turn a settled status into `running`.
			const file = await writeSession(directory, `${expected}.jsonl`, { entries: [assistantEntry(message)] });
			expect((await readSessionSnapshot(file, HOST))?.status).toBe(expected);
		});
	}

	test("a tail role the agent never yields on is unknown, not a guess", async () => {
		const directory = await temporaryDirectory();
		const file = await writeSession(directory, "developer.jsonl", {
			entries: [
				{
					type: "message",
					id: "d1",
					parentId: null,
					timestamp: "z",
					message: { role: "developer", content: "auto-continue", timestamp: 1 },
				},
			],
		});
		expect((await readSessionSnapshot(file, HOST))?.status).toBe("unknown");
	});

	test("a mid-turn tail is running while the file is fresh and idle once it is stale", async () => {
		const directory = await temporaryDirectory();
		const now = Date.now();
		const midTurns: [string, Record<string, unknown>[]][] = [
			["user prompt awaiting a reply", [userEntry("do the thing")]],
			[
				"assistant awaiting a tool result",
				[
					assistantEntry({
						content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }],
						stopReason: "toolUse",
					}),
				],
			],
			[
				"tool result awaiting the next turn",
				[
					{
						type: "message",
						id: "r9",
						parentId: null,
						timestamp: "z",
						message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [], isError: false },
					},
				],
			],
		];

		for (const [label, entries] of midTurns) {
			const fresh = await writeSession(directory, `fresh-${label.replace(/\s/g, "-")}.jsonl`, {
				entries,
				mtime: new Date(now - 1_000),
			});
			const justInside = await writeSession(directory, `inside-${label.replace(/\s/g, "-")}.jsonl`, {
				entries,
				mtime: new Date(now - 89_000),
			});
			const stale = await writeSession(directory, `stale-${label.replace(/\s/g, "-")}.jsonl`, {
				entries,
				mtime: new Date(now - 91_000),
			});

			expect((await readSessionSnapshot(fresh, HOST))?.status).toBe("running");
			expect((await readSessionSnapshot(justInside, HOST))?.status).toBe("running");
			expect((await readSessionSnapshot(stale, HOST))?.status).toBe("idle");
		}
	});

	test("a recorded session_exit rules out running however fresh the file is", async () => {
		const directory = await temporaryDirectory();
		const exit = {
			type: "custom",
			id: "x1",
			parentId: null,
			timestamp: "z",
			customType: "session_exit",
			data: { reason: "sighup", kind: "signal" },
		};
		const exited = await writeSession(directory, "exited.jsonl", {
			entries: [userEntry("do the thing"), exit],
			mtime: new Date(),
		});
		// A turn that resumed after the exit marker is live again.
		const resumed = await writeSession(directory, "resumed.jsonl", {
			entries: [userEntry("first"), exit, userEntry("second")],
			mtime: new Date(),
		});

		expect((await readSessionSnapshot(exited, HOST))?.status).toBe("idle");
		expect((await readSessionSnapshot(resumed, HOST))?.status).toBe("running");
	});
});

describe("usage accumulation", () => {
	test("sums cost and prompt-side/output tokens across assistant turns", async () => {
		const directory = await temporaryDirectory();
		const file = await writeSession(directory, "usage.jsonl", {
			entries: [
				assistantEntry({
					content: [{ type: "text", text: "one" }],
					stopReason: "stop",
					usage: {
						input: 100,
						output: 20,
						cacheRead: 1_000,
						cacheWrite: 10,
						totalTokens: 1_130,
						cost: { input: 0.001, output: 0.002, cacheRead: 0.003, cacheWrite: 0.004, total: 0.01 },
					},
				}),
				assistantEntry({
					content: [{ type: "text", text: "two" }],
					stopReason: "stop",
					usage: {
						input: 5,
						output: 7,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 12,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
					},
				}),
			],
		});

		const snapshot = await readSessionSnapshot(file, HOST);

		// Prompt side is input + cacheRead + cacheWrite: a cached session reports
		// input ~0 per turn and would otherwise look like it read nothing.
		expect(snapshot?.tokensIn).toBe(1_115);
		expect(snapshot?.tokensOut).toBe(27);
		expect(snapshot?.costUsd).toBeCloseTo(0.26, 10);
	});

	test("turns without usage leave the totals null rather than zero", async () => {
		const directory = await temporaryDirectory();
		const file = await writeSession(directory, "no-usage.jsonl", { entries: [COMPLETE_TURN] });

		const snapshot = await readSessionSnapshot(file, HOST);

		expect(snapshot?.messageCount).toBe(1);
		expect(snapshot?.costUsd).toBeNull();
		expect(snapshot?.tokensIn).toBeNull();
		expect(snapshot?.tokensOut).toBeNull();
	});
});

describe("project resolution", () => {
	test("names the git repo containing cwd, walking up from a subdirectory", async () => {
		const directory = await temporaryDirectory();
		const repo = path.join(directory, "CloudCastle");
		const deep = path.join(repo, "packages", "webservice", "src");
		await fs.mkdir(deep, { recursive: true });
		await fs.mkdir(path.join(repo, ".git"), { recursive: true });
		const file = await writeSession(directory, "repo.jsonl", { cwd: deep });

		expect((await readSessionSnapshot(file, HOST))?.project).toBe("CloudCastle");
	});

	test("follows a worktree's .git file, not just a .git directory", async () => {
		const directory = await temporaryDirectory();
		const worktree = path.join(directory, "wt-feature");
		await fs.mkdir(worktree, { recursive: true });
		await fs.writeFile(path.join(worktree, ".git"), "gitdir: /elsewhere/.git/worktrees/wt-feature\n");
		const file = await writeSession(directory, "worktree.jsonl", { cwd: worktree });

		expect((await readSessionSnapshot(file, HOST))?.project).toBe("wt-feature");
	});

	test("falls back to the basename outside a repo, and to a label when cwd is missing", async () => {
		const directory = await temporaryDirectory();
		const loose = path.join(directory, "loose", "scratchpad");
		await fs.mkdir(loose, { recursive: true });
		const file = await writeSession(directory, "loose.jsonl", { cwd: loose });
		const noCwd = await writeSession(directory, "no-cwd.jsonl", {
			rawBody: '{"type":"session","id":"abc","timestamp":"2026-08-28T10:00:00.000Z"}\n',
		});

		expect((await readSessionSnapshot(file, HOST))?.project).toBe("scratchpad");
		const headerless = await readSessionSnapshot(noCwd, HOST);
		expect(headerless?.cwd).toBe("");
		expect(headerless?.project).toBe("unknown");
	});
});

describe("bridge origin markers", () => {
	// Nothing writes these yet -- cc-agent recovers a session's channel from the
	// channel topic rather than appending to a log the session process owns. The
	// reader is here so the format works the day something does write it.
	test("reads commandId and requestedBy from the reserved custom entry", async () => {
		const directory = await temporaryDirectory();
		const file = await writeSession(directory, "origin.jsonl", {
			entries: [
				{
					type: "custom",
					id: "o1",
					parentId: null,
					timestamp: "z",
					customType: "cloudcastle_bridge_origin",
					data: { commandId: "cmd-7", requestedBy: "312400000000000000" },
				},
				COMPLETE_TURN,
			],
		});

		const snapshot = await readSessionSnapshot(file, HOST);

		expect(snapshot?.originCommandId).toBe("cmd-7");
		expect(snapshot?.requestedBy).toBe("312400000000000000");
	});

	test("reads the packed label spelling of the same marker", async () => {
		const directory = await temporaryDirectory();
		const both = await writeSession(directory, "label-both.jsonl", {
			entries: [
				{ type: "label", id: "l1", parentId: null, timestamp: "z", targetId: "h", label: "cc-origin:cmd-9:9001" },
			],
		});
		const idOnly = await writeSession(directory, "label-id.jsonl", {
			entries: [
				{ type: "label", id: "l2", parentId: null, timestamp: "z", targetId: "h", label: "cc-origin:cmd-9" },
			],
		});
		const unrelated = await writeSession(directory, "label-other.jsonl", {
			entries: [{ type: "label", id: "l3", parentId: null, timestamp: "z", targetId: "h", label: "interesting" }],
		});

		expect((await readSessionSnapshot(both, HOST))?.originCommandId).toBe("cmd-9");
		expect((await readSessionSnapshot(both, HOST))?.requestedBy).toBe("9001");
		expect((await readSessionSnapshot(idOnly, HOST))?.originCommandId).toBe("cmd-9");
		expect((await readSessionSnapshot(idOnly, HOST))?.requestedBy).toBeNull();
		expect((await readSessionSnapshot(unrelated, HOST))?.originCommandId).toBeNull();
	});
});

describe("scanSessions", () => {
	test("returns newest-updated first from project buckets and the root, capped by maxSessions", async () => {
		const root = await temporaryDirectory();
		const bucket = path.join(root, "-home-hunter-Desktop-CloudCastle");
		const now = Date.now();
		await writeSession(bucket, "oldest.jsonl", { id: "s-oldest", mtime: new Date(now - 400_000) });
		await writeSession(bucket, "middle.jsonl", { id: "s-middle", mtime: new Date(now - 300_000) });
		await writeSession(bucket, "newer.jsonl", { id: "s-newer", mtime: new Date(now - 200_000) });
		await writeSession(root, "newest.jsonl", { id: "s-newest", mtime: new Date(now - 100_000) });
		// Neither of these is a session file.
		await fs.writeFile(path.join(bucket, "newest.jsonl.176500.bak"), "backup\n");
		await fs.writeFile(path.join(bucket, "notes.txt"), "hello\n");

		const all = await scanSessions({ sessionsDir: root, host: HOST, maxSessions: 10 });
		const capped = await scanSessions({ sessionsDir: root, host: HOST, maxSessions: 2 });

		expect(all.map(snapshot => snapshot.sessionId)).toEqual(["s-newest", "s-newer", "s-middle", "s-oldest"]);
		expect(capped.map(snapshot => snapshot.sessionId)).toEqual(["s-newest", "s-newer"]);
		expect(all.every(snapshot => snapshot.host === HOST)).toBe(true);
	});

	test("skips unparseable files instead of letting them consume the cap", async () => {
		const root = await temporaryDirectory();
		const now = Date.now();
		await writeSession(root, "junk.jsonl", { rawBody: "junk\n", mtime: new Date(now - 1_000) });
		await writeSession(root, "good-a.jsonl", { id: "good-a", mtime: new Date(now - 2_000) });
		await writeSession(root, "good-b.jsonl", { id: "good-b", mtime: new Date(now - 3_000) });

		const snapshots = await scanSessions({ sessionsDir: root, host: HOST, maxSessions: 2 });

		expect(snapshots.map(snapshot => snapshot.sessionId)).toEqual(["good-a", "good-b"]);
	});

	test("a missing sessions directory and a non-positive cap both yield nothing", async () => {
		const root = await temporaryDirectory();
		await writeSession(root, "a.jsonl", {});

		expect(await scanSessions({ sessionsDir: path.join(root, "absent"), host: HOST })).toEqual([]);
		expect(await scanSessions({ sessionsDir: root, host: HOST, maxSessions: 0 })).toEqual([]);
	});

	test("memoizes on stat identity, so an unchanged file is not reparsed", async () => {
		const directory = await temporaryDirectory();
		const stamp = new Date("2026-01-01T00:00:00.000Z");
		const file = await writeSession(directory, "memo.jsonl", {
			entries: [assistantEntry({ content: [{ type: "text", text: "AAAAAAAA" }], stopReason: "stop" })],
			mtime: stamp,
		});

		const first = await readSessionSnapshot(file, HOST);
		expect(first?.lastText).toBe("AAAAAAAA");

		// Same byte length, same mtime: the only way the old text can still be
		// reported is a cache hit that never touched the file.
		const original = await fs.readFile(file, "utf8");
		await fs.writeFile(file, original.replace("AAAAAAAA", "BBBBBBBB"));
		await fs.utimes(file, stamp, stamp);
		expect((await readSessionSnapshot(file, HOST))?.lastText).toBe("AAAAAAAA");

		// A different size is a different identity, so the change is picked up.
		await fs.appendFile(
			file,
			`${JSON.stringify(assistantEntry({ content: [{ type: "text", text: "CCC" }], stopReason: "stop" }))}\n`,
		);
		await fs.utimes(file, stamp, stamp);
		expect((await readSessionSnapshot(file, HOST))?.lastText).toBe("CCC");
	});
});

describe("defaultSessionsDir", () => {
	test("honours an agent-directory override under either spelling", async () => {
		const chudcode = process.env.CHUDCODE_CODING_AGENT_DIR;
		const cloudcastle = process.env.CHUDCODE_AGENT_DIR;
		try {
			delete process.env.CHUDCODE_CODING_AGENT_DIR;
			delete process.env.CHUDCODE_AGENT_DIR;
			expect(path.basename(defaultSessionsDir())).toBe("sessions");

			process.env.CHUDCODE_AGENT_DIR = path.join(tmpdir(), "cc-agent-dir");
			expect(defaultSessionsDir()).toBe(path.join(tmpdir(), "cc-agent-dir", "sessions"));

			process.env.CHUDCODE_CODING_AGENT_DIR = path.join(tmpdir(), "chudcode-agent-dir");
			expect(defaultSessionsDir()).toBe(path.join(tmpdir(), "chudcode-agent-dir", "sessions"));
		} finally {
			if (chudcode === undefined) delete process.env.CHUDCODE_CODING_AGENT_DIR;
			else process.env.CHUDCODE_CODING_AGENT_DIR = chudcode;
			if (cloudcastle === undefined) delete process.env.CHUDCODE_AGENT_DIR;
			else process.env.CHUDCODE_AGENT_DIR = cloudcastle;
		}
	});
});
