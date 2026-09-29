import { describe, expect, it } from "bun:test";
import * as snapcompact from "@oh-my-pi/snapcompact";
import * as path from "node:path";
import { BlobStore } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { doctorSessionFile } from "@oh-my-pi/pi-coding-agent/session/session-doctor";
import { parseSessionContent } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { TempDir } from "@oh-my-pi/pi-utils";

const timestamp = "2026-08-30T12:00:00.000Z";
function fixture(dir: string, ...entries: unknown[]): string {
	return `${serializeTitleSlot({ updatedAt: timestamp })}${[
		{ type: "session", version: 3, id: "session", cwd: dir, timestamp },
		...entries,
	]
		.map(entry => JSON.stringify(entry))
		.join("\n")}\n`;
}

function userEntry(content: unknown = "hello") {
	return {
		type: "message",
		id: "user",
		parentId: null,
		timestamp,
		message: { role: "user", content, timestamp: Date.parse(timestamp) },
	};
}

describe("session doctor", () => {
	it("exposes explicit diagnosis and never mutates a dry-run session", async () => {
		using dir = TempDir.createSync("@session-doctor-");
		const file = path.join(dir.path(), "session.jsonl");
		const original = `${fixture(dir.path(), userEntry())}{interrupted\n`;
		await Bun.write(file, original);
		const summary = await doctorSessionFile(file);
		const frames: string[] = [];
		const result = await executeAcpBuiltinSlashCommand("/session doctor", {
			session: { isStreaming: false },
			sessionManager: { getSessionFile: () => file, flush: async () => {} },
			output: (text: string) => {
				frames.push(text);
			},
		} as unknown as SlashCommandRuntime);
		expect(result).toEqual({ consumed: true });
		expect(JSON.parse(frames.at(-1)!)).toMatchObject({ mode: "dry-run", status: "issues", changed: false });
		expect(summary).toMatchObject({ mode: "dry-run", status: "issues", changed: false, backupPath: null });
		expect(summary.counts.malformedRecords).toBe(1);
		expect(await Bun.file(file).text()).toBe(original);
	});

	it("repairs interrupted records atomically and leaves an untouched backup", async () => {
		using dir = TempDir.createSync("@session-doctor-");
		const file = path.join(dir.path(), "session.jsonl");
		const original = `${fixture(dir.path(), userEntry())}{interrupted\n`;
		await Bun.write(file, original);
		const summary = await doctorSessionFile(file, { repair: true });
		expect(summary).toMatchObject({ mode: "repair", status: "repaired", changed: true });
		expect(await Bun.file(summary.backupPath!).text()).toBe(original);
		expect(parseSessionContent(await Bun.file(file).text()).malformedRecords).toBe(0);
		expect((await doctorSessionFile(file, { repair: true })).status).toBe("healthy");
	});

	it("returns repair JSON on the command output channel and preserves its backup", async () => {
		using dir = TempDir.createSync("@session-doctor-");
		const file = path.join(dir.path(), "session.jsonl");
		const original = `${fixture(dir.path(), userEntry())}{interrupted\n`;
		await Bun.write(file, original);
		const frames: string[] = [];
		const result = await executeAcpBuiltinSlashCommand("/session doctor --repair", {
			session: { isStreaming: false },
			sessionManager: {
				getSessionFile: () => file,
				flush: async () => {},
				setSessionFile: async () => {},
			},
			output: (text: string) => {
				frames.push(text);
			},
		} as unknown as SlashCommandRuntime);
		expect(result).toEqual({ consumed: true });
		const summary = JSON.parse(frames.at(-1)!);
		expect(summary).toMatchObject({ mode: "repair", changed: true, status: "repaired" });
		expect(await Bun.file(summary.backupPath).text()).toBe(original);
	});

	it("does not invent a session header when none exists", async () => {
		using dir = TempDir.createSync("@session-doctor-");
		const file = path.join(dir.path(), "session.jsonl");
		const original = `${JSON.stringify(userEntry())}\n`;
		await Bun.write(file, original);
		const summary = await doctorSessionFile(file, { repair: true });
		expect(summary).toMatchObject({ status: "issues", changed: false, backupPath: null });
		expect(summary.findings.some(finding => finding.code === "invalid_header" && !finding.repairable)).toBe(true);
		expect(await Bun.file(file).text()).toBe(original);
	});

	it("removes only a dangling tool call, preserving assistant text and branch ancestry", async () => {
		using dir = TempDir.createSync("@session-doctor-");
		const file = path.join(dir.path(), "session.jsonl");
		const assistant = {
			type: "message",
			id: "assistant",
			parentId: "user",
			timestamp,
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Let me check." },
					{ type: "toolCall", id: "call", name: "read", arguments: {} },
				],
				timestamp: Date.parse(timestamp),
			},
		};
		const followup = {
			type: "message",
			id: "followup",
			parentId: "assistant",
			timestamp,
			message: { role: "user", content: "continue", timestamp: Date.parse(timestamp) },
		};
		await Bun.write(file, fixture(dir.path(), userEntry(), assistant, followup));
		const summary = await doctorSessionFile(file, { repair: true });
		const parsed = parseSessionContent(await Bun.file(file).text());
		expect(summary.counts.orphanedToolCalls).toBe(1);
		expect(summary.changed).toBe(true);
		expect(parsed.entries[2]).toMatchObject({ message: { content: [{ type: "text", text: "Let me check." }] } });
		expect(parsed.entries[3]).toMatchObject({ parentId: "assistant" });
	});

	it("accepts one call with distinct results on sibling branches", async () => {
		using dir = TempDir.createSync("@session-doctor-");
		const file = path.join(dir.path(), "session.jsonl");
		const assistant = {
			type: "message",
			id: "assistant",
			parentId: "user",
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }],
				timestamp: 1,
			},
		};
		const result = (id: string) => ({
			type: "message",
			id,
			parentId: "assistant",
			timestamp,
			message: {
				role: "toolResult",
				toolName: "read",
				toolCallId: "call",
				content: [{ type: "text", text: id }],
				timestamp: 2,
			},
		});
		await Bun.write(file, fixture(dir.path(), userEntry(), assistant, result("left"), result("right")));
		const summary = await doctorSessionFile(file, { repair: true });
		expect(summary.counts.orphanedToolResults).toBe(0);
		expect(summary.counts.orphanedToolCalls).toBe(0);
		expect(summary.changed).toBe(false);
	});

	it("restores a missing image as text and creates a repair backup", async () => {
		using dir = TempDir.createSync("@session-doctor-");
		const file = path.join(dir.path(), "session.jsonl");
		const ref = `blob:sha256:${"0".repeat(64)}`;
		await Bun.write(file, fixture(dir.path(), userEntry([{ type: "image", mimeType: "image/png", data: ref }])));
		const summary = await doctorSessionFile(file, {
			repair: true,
			blobStore: new BlobStore(path.join(dir.path(), "blobs")),
		});
		expect(summary.counts.missingBlobs).toBe(1);
		const parsed = parseSessionContent(await Bun.file(file).text());
		expect(parsed.entries[1]).toMatchObject({
			message: { content: [{ type: "text", text: "[Image unavailable: persisted image data is missing]" }] },
		});
		expect(summary.backupPath).not.toBeNull();
	});
	it("repairs a missing compaction frame without dropping its retained text", async () => {
		using dir = TempDir.createSync("@session-doctor-");
		const file = path.join(dir.path(), "session.jsonl");
		const frame = `blob:sha256:${"1".repeat(64)}`;
		const compaction = {
			type: "compaction",
			id: "compact",
			parentId: "user",
			timestamp,
			firstKeptEntryId: "user",
			summary: "carry context",
			tokensBefore: 200,
			preserveData: {
				[snapcompact.PRESERVE_KEY]: {
					frames: [{ data: frame, mimeType: "image/png", cols: 1, rows: 1, chars: 1 }],
					textHead: "retained details",
					textTail: "",
					totalChars: 16,
					truncatedChars: 0,
				},
			},
		};
		await Bun.write(file, fixture(dir.path(), userEntry(), compaction));
		const summary = await doctorSessionFile(file, {
			repair: true,
			blobStore: new BlobStore(path.join(dir.path(), "blobs")),
		});
		expect(summary.counts.missingBlobs).toBe(1);
		expect(summary.changed).toBe(true);
		const parsed = parseSessionContent(await Bun.file(file).text());
		const repaired = parsed.entries[2];
		expect(repaired?.type).toBe("compaction");
		if (repaired?.type !== "compaction") throw new Error("Expected compaction entry");
		expect(repaired.preserveData?.[snapcompact.PRESERVE_KEY]).toMatchObject({
			frames: [],
			textHead: "retained details",
		});
	});
});
