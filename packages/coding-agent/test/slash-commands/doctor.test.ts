import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BlobStore } from "@chudware/coding-agent/session/blob-store";
import { doctorSessionFile } from "@chudware/coding-agent/session/session-doctor";
import { parseSessionContent } from "@chudware/coding-agent/session/session-loader";
import { serializeTitleSlot } from "@chudware/coding-agent/session/session-title-slot";
import { BUILTIN_SESSION_SLASH_COMMANDS } from "@chudware/coding-agent/slash-commands/builtin-session";

const TIMESTAMP = "2026-08-30T12:00:00.000Z";
const SESSION_ID = "01994f17-6c00-7000-8000-000000000001";

let tempDir: string;
let blobStore: BlobStore;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chudcode-session-doctor-"));
	blobStore = new BlobStore(path.join(tempDir, "blobs"));
});

afterEach(async () => {
	await fs.rm(tempDir, { recursive: true, force: true });
});

function header() {
	return {
		type: "session" as const,
		version: 3,
		id: SESSION_ID,
		timestamp: TIMESTAMP,
		cwd: tempDir,
	};
}

function userEntry() {
	return {
		type: "message" as const,
		id: "user-1",
		parentId: null,
		timestamp: TIMESTAMP,
		message: { role: "user" as const, content: "hello", timestamp: Date.parse(TIMESTAMP) },
	};
}

function sessionBody(...entries: unknown[]): string {
	return `${serializeTitleSlot({ updatedAt: TIMESTAMP })}${[header(), ...entries]
		.map(entry => JSON.stringify(entry))
		.join("\n")}\n`;
}

async function writeSession(content: string): Promise<string> {
	const file = path.join(tempDir, "session.jsonl");
	await fs.writeFile(file, content);
	return file;
}

describe("session doctor", () => {
	it("is exposed as an explicit session subcommand", () => {
		const session = BUILTIN_SESSION_SLASH_COMMANDS.find(command => command.name === "session");
		expect(session?.subcommands).toContainEqual({
			name: "doctor",
			description: "Diagnose the persisted session; repair only with --repair",
			usage: "[--repair]",
		});
	});

	it("diagnoses malformed interrupted writes without mutating the file", async () => {
		const original = `${sessionBody(userEntry())}{interrupted\n`;
		const file = await writeSession(original);

		const summary = await doctorSessionFile(file, { blobStore });

		expect(summary.mode).toBe("dry-run");
		expect(summary.status).toBe("issues");
		expect(summary.changed).toBe(false);
		expect(summary.backupPath).toBeNull();
		expect(summary.outputPath).toBe(file);
		expect(summary.counts.malformedRecords).toBe(1);
		expect(await fs.readFile(file, "utf8")).toBe(original);
	});

	it("atomically repairs malformed records and preserves the untouched input as a backup", async () => {
		const original = `${sessionBody(userEntry())}{interrupted\n`;
		const file = await writeSession(original);

		const summary = await doctorSessionFile(file, { repair: true, blobStore });

		expect(summary.status).toBe("repaired");
		expect(summary.changed).toBe(true);
		expect(summary.backupPath).not.toBeNull();
		expect(await fs.readFile(summary.backupPath!, "utf8")).toBe(original);
		const repaired = parseSessionContent(await fs.readFile(file, "utf8"));
		expect(repaired.malformedRecords).toBe(0);
		expect(repaired.invalidHeader).toBe(false);
		expect(repaired.entries).toHaveLength(2);
	});

	it("is idempotent after repair", async () => {
		const file = await writeSession(`${sessionBody(userEntry())}{interrupted\n`);
		const first = await doctorSessionFile(file, { repair: true, blobStore });
		const repaired = await fs.readFile(file, "utf8");

		const second = await doctorSessionFile(file, { repair: true, blobStore });

		expect(first.changed).toBe(true);
		expect(second.status).toBe("healthy");
		expect(second.changed).toBe(false);
		expect(second.backupPath).toBeNull();
		expect(await fs.readFile(file, "utf8")).toBe(repaired);
	});

	it("reports an invalid header without inventing replacement metadata", async () => {
		const original = `${JSON.stringify(userEntry())}\n`;
		const file = await writeSession(original);

		const summary = await doctorSessionFile(file, { repair: true, blobStore });

		expect(summary.status).toBe("issues");
		expect(summary.changed).toBe(false);
		expect(summary.backupPath).toBeNull();
		expect(summary.findings.some(item => item.code === "invalid_header" && !item.repairable)).toBe(true);
		expect(await fs.readFile(file, "utf8")).toBe(original);
	});

	it("recovers a valid header stranded behind an interrupted leading record", async () => {
		const original = `${serializeTitleSlot({ updatedAt: TIMESTAMP })}${JSON.stringify({ partial: true })}\n${JSON.stringify(
			header(),
		)}\n${JSON.stringify(userEntry())}\n`;
		const file = await writeSession(original);

		const summary = await doctorSessionFile(file, { repair: true, blobStore });
		const repaired = parseSessionContent(await fs.readFile(file, "utf8"));

		expect(summary.status).toBe("repaired");
		expect(summary.backupPath).not.toBeNull();
		expect(await fs.readFile(summary.backupPath!, "utf8")).toBe(original);
		expect(repaired.invalidHeader).toBe(false);
		expect(repaired.entries[0]?.type).toBe("session");
		expect(repaired.entries).toHaveLength(2);
	});

	it("reports orphaned tool records and malformed image and compaction records", async () => {
		const assistant = {
			type: "message",
			id: "assistant-1",
			parentId: null,
			timestamp: TIMESTAMP,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
				stopReason: "toolUse",
				timestamp: Date.parse(TIMESTAMP),
			},
		};
		const orphanedResult = {
			type: "message",
			id: "result-1",
			parentId: null,
			timestamp: TIMESTAMP,
			message: {
				role: "toolResult",
				toolCallId: "missing-call",
				toolName: "read",
				content: [{ type: "text", text: "kept output" }],
				timestamp: Date.parse(TIMESTAMP),
			},
		};
		const compaction = {
			type: "compaction",
			id: "compaction-1",
			parentId: "assistant-1",
			timestamp: TIMESTAMP,
			summary: "summary",
			firstKeptEntryId: "missing-entry",
			tokensBefore: 100,
		};
		const malformedImage = {
			type: "message",
			id: "image-1",
			parentId: "compaction-1",
			timestamp: TIMESTAMP,
			message: {
				role: "user",
				content: [{ type: "image", data: 42, mimeType: "image/png" }],
				timestamp: Date.parse(TIMESTAMP),
			},
		};
		const file = await writeSession(sessionBody(assistant, orphanedResult, compaction, malformedImage));

		const summary = await doctorSessionFile(file, { blobStore });

		expect(summary.counts.orphanedToolCalls).toBe(1);
		expect(summary.counts.orphanedToolResults).toBe(1);
		expect(summary.counts.invalidCompactions).toBe(1);
		expect(summary.counts.malformedImages).toBe(1);
	});

	it("removes only an unpaired tool-call block and never fabricates a result", async () => {
		const assistant = {
			type: "message",
			id: "assistant-1",
			parentId: null,
			timestamp: TIMESTAMP,
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "I will inspect it." },
					{ type: "toolCall", id: "call-1", name: "read", arguments: {} },
				],
				stopReason: "toolUse",
				timestamp: Date.parse(TIMESTAMP),
			},
		};
		const file = await writeSession(sessionBody(assistant));

		const summary = await doctorSessionFile(file, { repair: true, blobStore });
		const repaired = parseSessionContent(await fs.readFile(file, "utf8"));
		const entry = repaired.entries[1];

		expect(summary.counts.orphanedToolCalls).toBe(1);
		expect(summary.changed).toBe(true);
		expect(repaired.entries).toHaveLength(2);
		expect(entry?.type).toBe("message");
		if (entry?.type !== "message" || entry.message.role !== "assistant") {
			throw new Error("Expected repaired assistant entry");
		}
		expect(entry.message.content).toEqual([{ type: "text", text: "I will inspect it." }]);
		expect(
			repaired.entries.some(candidate => candidate.type === "message" && candidate.message.role === "toolResult"),
		).toBe(false);
	});

	it("leaves a valid session byte-for-byte unchanged", async () => {
		const original = sessionBody(userEntry());
		const file = await writeSession(original);

		const summary = await doctorSessionFile(file, { repair: true, blobStore });

		expect(summary.status).toBe("healthy");
		expect(summary.findingCount).toBe(0);
		expect(summary.changed).toBe(false);
		expect(summary.backupPath).toBeNull();
		expect(await fs.readFile(file, "utf8")).toBe(original);
	});

	it("repairs missing persisted images without discarding the surrounding message", async () => {
		const missingRef = `blob:sha256:${"a".repeat(64)}`;
		const imageEntry = {
			...userEntry(),
			message: {
				role: "user" as const,
				content: [
					{ type: "text" as const, text: "before" },
					{ type: "image" as const, data: missingRef, mimeType: "image/png" },
				],
				timestamp: Date.parse(TIMESTAMP),
			},
		};
		const file = await writeSession(sessionBody(imageEntry));

		const summary = await doctorSessionFile(file, { repair: true, blobStore });
		const repaired = parseSessionContent(await fs.readFile(file, "utf8"));
		const message = repaired.entries[1];

		expect(summary.counts.missingBlobs).toBe(1);
		expect(summary.changed).toBe(true);
		expect(message?.type).toBe("message");
		if (message?.type !== "message" || message.message.role !== "user") {
			throw new Error("Expected repaired user message entry");
		}
		expect(message.message.content).toEqual([
			{ type: "text", text: "before" },
			{ type: "text", text: "[Image unavailable: persisted image data is missing]" },
		]);
	});
});
