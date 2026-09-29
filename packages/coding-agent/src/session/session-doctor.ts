import { constants as fsConstants, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { getBlobsDir, isRecord, stringifyJson } from "@oh-my-pi/pi-utils";
import { BlobStore, isBlobRef, parseBlobRef } from "./blob-store";
import { CURRENT_SESSION_VERSION, type FileEntry, type SessionEntry, type SessionHeader } from "./session-entries";
import { parseSessionContent, resolveBlobRefsInEntries } from "./session-loader";
import { migrateToCurrentVersion } from "./session-migrations";
import { isPersistenceTruncatedString, prepareEntryForPersistence } from "./session-persistence";
import { FileSessionStorage, type SessionStorage } from "./session-storage";
import { serializeTitleSlot } from "./session-title-slot";

export type SessionDoctorFindingCode =
	| "malformed_jsonl"
	| "invalid_header"
	| "malformed_entry"
	| "duplicate_entry_id"
	| "orphaned_entry"
	| "malformed_tool_call"
	| "orphaned_tool_call"
	| "orphaned_tool_result"
	| "malformed_image"
	| "malformed_blob_ref"
	| "missing_blob"
	| "invalid_compaction"
	| "truncated_compaction_image";
export interface SessionDoctorFinding {
	code: SessionDoctorFindingCode;
	message: string;
	repairable: boolean;
	entryId?: string;
	path?: string;
}
export interface SessionDoctorSummary {
	version: 1;
	mode: "dry-run" | "repair";
	status: "healthy" | "issues" | "repaired" | "repaired_with_issues";
	sessionFile: string;
	outputPath: string;
	backupPath: string | null;
	changed: boolean;
	findingCount: number;
	repairableFindingCount: number;
	remainingFindingCount: number;
	counts: Record<
		| "malformedRecords"
		| "malformedEntries"
		| "duplicateEntryIds"
		| "orphanedEntries"
		| "malformedToolCalls"
		| "orphanedToolCalls"
		| "orphanedToolResults"
		| "malformedImages"
		| "malformedBlobRefs"
		| "missingBlobs"
		| "invalidCompactions"
		| "truncatedCompactionImages",
		number
	>;
	findings: SessionDoctorFinding[];
}
export interface SessionDoctorOptions {
	repair?: boolean;
	storage?: SessionStorage;
	blobStore?: BlobStore;
}
const codes: Record<SessionDoctorFindingCode, keyof SessionDoctorSummary["counts"] | null> = {
	malformed_jsonl: "malformedRecords",
	invalid_header: null,
	malformed_entry: "malformedEntries",
	duplicate_entry_id: "duplicateEntryIds",
	orphaned_entry: "orphanedEntries",
	malformed_tool_call: "malformedToolCalls",
	orphaned_tool_call: "orphanedToolCalls",
	orphaned_tool_result: "orphanedToolResults",
	malformed_image: "malformedImages",
	malformed_blob_ref: "malformedBlobRefs",
	missing_blob: "missingBlobs",
	invalid_compaction: "invalidCompactions",
	truncated_compaction_image: "truncatedCompactionImages",
};
function isHeader(entry: unknown): entry is SessionHeader {
	return isRecord(entry) && entry.type === "session" && typeof entry.id === "string" && entry.id.length > 0;
}
function validEntry(entry: unknown, legacy: boolean): entry is SessionEntry {
	return (
		isRecord(entry) &&
		typeof entry.type === "string" &&
		entry.type !== "session" &&
		typeof entry.timestamp === "string" &&
		(legacy ||
			(typeof entry.id === "string" &&
				entry.id.length > 0 &&
				(entry.parentId === null || typeof entry.parentId === "string")))
	);
}
function ancestors(entry: SessionEntry, byId: ReadonlyMap<string, SessionEntry>): SessionEntry[] {
	const chain: SessionEntry[] = [];
	const visited = new Set<string>();
	let id = entry.parentId;
	while (id && !visited.has(id)) {
		visited.add(id);
		const parent = byId.get(id);
		if (!parent) break;
		chain.push(parent);
		id = parent.parentId;
	}
	return chain;
}
function message(entry: SessionEntry): AgentMessage | undefined {
	return entry.type === "message" && isRecord(entry.message) && typeof entry.message.role === "string"
		? (entry.message as AgentMessage)
		: undefined;
}
function calls(entry: SessionEntry): Array<{ index: number; id: string; malformed: boolean }> {
	const value = message(entry);
	if (value?.role !== "assistant" || !Array.isArray(value.content)) return [];
	return value.content.flatMap((block, index) =>
		isRecord(block) && block.type === "toolCall"
			? [
					{
						index,
						id: typeof block.id === "string" ? block.id : "",
						malformed: !String(block.id ?? "").trim() || !String(block.name ?? "").trim(),
					},
				]
			: [],
	);
}
function stripUnsafeCalls(
	entries: SessionEntry[],
	unsafe: ReadonlySet<string>,
	invalidResults: ReadonlySet<string>,
): boolean {
	let changed = false;
	const removed = new Map<string, string | null>();
	const retained: SessionEntry[] = [];
	for (const entry of entries) {
		if (invalidResults.has(entry.id)) {
			removed.set(entry.id, entry.parentId);
			changed = true;
			continue;
		}
		const value = message(entry);
		if (entry.type === "message" && value?.role === "assistant" && Array.isArray(value.content)) {
			const content = value.content.filter((block, index) => !unsafe.has(`${entry.id}:${index}`));
			if (content.length !== value.content.length) {
				changed = true;
				if (!content.length) {
					removed.set(entry.id, entry.parentId);
					continue;
				}
				entry.message = {
					...value,
					content: content
						.filter(block => block.type !== "redactedThinking")
						.map(block => (block.type === "thinking" ? { ...block, thinkingSignature: undefined } : block)),
				} as AgentMessage;
			}
		}
		retained.push(entry);
	}
	if (changed) {
		for (const entry of retained) {
			const seen = new Set<string>();
			while (entry.parentId && removed.has(entry.parentId) && !seen.has(entry.parentId)) {
				seen.add(entry.parentId);
				entry.parentId = removed.get(entry.parentId) ?? null;
			}
		}
		entries.splice(0, entries.length, ...retained);
	}
	return changed;
}

export async function doctorSessionFile(
	sessionFile: string,
	options: SessionDoctorOptions = {},
): Promise<SessionDoctorSummary> {
	const repair = options.repair === true;
	const storage = options.storage ?? new FileSessionStorage();
	const blobs = options.blobStore ?? new BlobStore(getBlobsDir());
	const file = path.resolve(sessionFile);
	const original = await storage.readText(file);
	const loaded = parseSessionContent(original);
	const findings: SessionDoctorFinding[] = [];
	const add = (
		code: SessionDoctorFindingCode,
		text: string,
		repairable: boolean,
		entryId?: string,
		where?: string,
	): void => {
		findings.push({
			code,
			message: text,
			repairable,
			...(entryId ? { entryId } : {}),
			...(where ? { path: where } : {}),
		});
	};
	for (let n = 0; n < loaded.malformedRecords; n++) add("malformed_jsonl", "Malformed JSONL record skipped.", true);
	const headerIndex = loaded.entries.findIndex(isHeader);
	const header = headerIndex >= 0 ? (loaded.entries[headerIndex] as SessionHeader) : undefined;
	if (loaded.invalidHeader || headerIndex !== 0)
		add(
			"invalid_header",
			headerIndex > 0 ? "Header is behind leading records." : "Session header is missing or malformed.",
			headerIndex > 0,
		);
	const legacy = (header?.version ?? 1) < 2;
	const migrate = (header?.version ?? CURRENT_SESSION_VERSION) < CURRENT_SESSION_VERSION;
	const entries: FileEntry[] = header ? [structuredClone(header)] : [];
	for (let index = Math.max(1, headerIndex + 1); index < loaded.entries.length; index++) {
		const candidate: unknown = loaded.entries[index];
		if (!validEntry(candidate, legacy)) {
			add("malformed_entry", "Invalid session entry.", true, undefined, `entries[${index}]`);
			continue;
		}
		entries.push(structuredClone(candidate));
	}
	if (header) migrateToCurrentVersion(entries);
	const valid: SessionEntry[] = [];
	const byId = new Map<string, SessionEntry>();
	let duplicate = false;
	for (const entry of entries.slice(1) as SessionEntry[]) {
		if (byId.has(entry.id)) {
			duplicate = true;
			add("duplicate_entry_id", "Duplicate entry id prevents safe repair.", false, entry.id);
			continue;
		}
		byId.set(entry.id, entry);
		valid.push(entry);
	}
	for (const entry of valid)
		if (entry.parentId && !byId.has(entry.parentId))
			add("orphaned_entry", "Parent entry is missing.", false, entry.id, "parentId");
	const allCalls = valid.flatMap(entry => calls(entry).map(call => ({ ...call, entry })));
	const paired = new Set<string>();
	const resultsByCall = new Map<string, SessionEntry[]>();
	const unsafe = new Set<string>();
	const invalidResults = new Set<string>();
	for (const call of allCalls)
		if (call.malformed) {
			unsafe.add(`${call.entry.id}:${call.index}`);
			add(
				"malformed_tool_call",
				"Tool call has an empty id or name.",
				true,
				call.entry.id,
				`message.content[${call.index}]`,
			);
		}
	for (const entry of valid) {
		const result = message(entry);
		if (result?.role !== "toolResult") continue;
		const chain = ancestors(entry, byId);
		const ancestorIds = new Set(chain.map(parent => parent.id));
		let call: (typeof allCalls)[number] | undefined;
		for (const ancestor of chain) {
			const candidates = allCalls.filter(
				candidate => candidate.entry.id === ancestor.id && candidate.id === result.toolCallId,
			);
			for (const candidate of candidates) {
				const prior = resultsByCall.get(`${candidate.entry.id}:${candidate.index}`) ?? [];
				if (
					prior.some(
						previous =>
							ancestorIds.has(previous.id) ||
							ancestors(previous, byId).some(previousAncestor => previousAncestor.id === entry.id),
					)
				)
					continue;
				call = candidate;
				break;
			}
			if (call || candidates.length > 0) break;
		}
		if (!call) {
			add("orphaned_tool_result", "Tool result has no matching call on this branch.", false, entry.id);
			continue;
		}
		const key = `${call.entry.id}:${call.index}`;
		paired.add(key);
		const previous = resultsByCall.get(key);
		if (previous) previous.push(entry);
		else resultsByCall.set(key, [entry]);
		if (call.malformed) {
			invalidResults.add(entry.id);
			add("orphaned_tool_result", "Result belongs to a malformed call.", true, entry.id);
		}
	}
	for (const call of allCalls)
		if (!call.malformed && !paired.has(`${call.entry.id}:${call.index}`)) {
			unsafe.add(`${call.entry.id}:${call.index}`);
			add(
				"orphaned_tool_call",
				"Tool call has no result on any branch.",
				true,
				call.entry.id,
				`message.content[${call.index}]`,
			);
		}
	const refs: Array<{ hash: string; entryId: string; where: string }> = [];
	const inspect = (value: unknown, id: string, where: string): void => {
		if (Array.isArray(value)) {
			value.forEach((child, n) => inspect(child, id, `${where}[${n}]`));
			return;
		}
		if (!isRecord(value)) return;
		if (value.type === "image" && (typeof value.data !== "string" || !value.data))
			add("malformed_image", "Image has no data.", false, id, where);
		if (value.type === "image" && isPersistenceTruncatedString(value.data))
			add("malformed_image", "Image data was truncated.", true, id, `${where}.data`);
		for (const [key, data] of Object.entries(value)) {
			if (
				typeof data === "string" &&
				isBlobRef(data) &&
				((key === "data" &&
					(value.type === "image" || /\.frames\[\d+\]$/.test(where) || /\.images\[\d+\]$/.test(where))) ||
					key === "image_url" ||
					(key === "result" && value.type === "image_generation_call"))
			) {
				const hash = parseBlobRef(data);
				if (hash) refs.push({ hash, entryId: id, where: `${where}.${key}` });
				else add("malformed_blob_ref", "Invalid blob reference.", true, id, `${where}.${key}`);
			}
			inspect(data, id, where ? `${where}.${key}` : key);
		}
	};
	for (const entry of valid) {
		if (entry.type === "compaction") {
			const chain = new Set(ancestors(entry, byId).map(parent => parent.id));
			if (
				typeof entry.summary !== "string" ||
				!chain.has(entry.firstKeptEntryId) ||
				(entry.providerReplayThroughEntryId !== undefined && !chain.has(entry.providerReplayThroughEntryId))
			)
				add("invalid_compaction", "Compaction boundary is invalid.", false, entry.id);
			const archive = snapcompact.getPreservedArchive(entry.preserveData);
			archive?.frames.forEach((frame, n) => {
				if (isPersistenceTruncatedString(frame.data))
					add("truncated_compaction_image", "Compaction image is truncated.", true, entry.id, `frames[${n}].data`);
			});
		}
		inspect(entry, entry.id, "");
	}
	await Promise.all(
		refs.map(async ref => {
			if (!(await blobs.has(ref.hash)))
				add("missing_blob", "Referenced image data is missing.", true, ref.entryId, ref.where);
		}),
	);
	let changed = false;
	let backupPath: string | null = null;
	if (repair && header && !duplicate) {
		const repaired = structuredClone(entries);
		const repairedEntries = repaired.slice(1) as SessionEntry[];
		const callsChanged = stripUnsafeCalls(repairedEntries, unsafe, invalidResults);
		repaired.splice(1, repaired.length - 1, ...repairedEntries);
		const imagesChanged = await resolveBlobRefsInEntries(repaired, blobs);
		changed =
			loaded.malformedRecords > 0 ||
			headerIndex > 0 ||
			findings.some(f => f.code === "malformed_entry" || f.code === "truncated_compaction_image") ||
			callsChanged ||
			imagesChanged ||
			migrate;
		if (changed) {
			const slot = loaded.titleSlot ?? {
				title: header.title,
				source: header.titleSource,
				updatedAt: header.timestamp,
			};
			const body =
				serializeTitleSlot(slot) +
				repaired.map(entry => `${stringifyJson(prepareEntryForPersistence(entry, blobs)) ?? "null"}\n`).join("");
			backupPath = path.join(
				path.dirname(file),
				`${path.basename(file)}.doctor-${Date.now()}-${crypto.randomUUID()}.bak`,
			);
			await fs.copyFile(file, backupPath, fsConstants.COPYFILE_EXCL);
			if ((await fs.readFile(backupPath, "utf8")) !== original) {
				await fs.unlink(backupPath);
				throw new Error("Session changed before doctor backup; no repair applied.");
			}
			let committed = false;
			await storage.writeTextAtomic(file, body, {
				commitGuard: () => {
					committed = readFileSync(file, "utf8") === original;
					return committed;
				},
			});
			if (!committed) throw new Error(`Session changed before repair commit; untouched backup: ${backupPath}`);
		}
	}
	const counts = Object.fromEntries(
		Object.values(codes)
			.filter((code): code is keyof SessionDoctorSummary["counts"] => code !== null)
			.map(code => [code, 0]),
	) as SessionDoctorSummary["counts"];
	for (const finding of findings) {
		const key = codes[finding.code];
		if (key) counts[key]++;
	}
	const repairableFindingCount = findings.filter(finding => finding.repairable).length;
	const remainingFindingCount = changed ? findings.length - repairableFindingCount : findings.length;
	return {
		version: 1,
		mode: repair ? "repair" : "dry-run",
		status: changed
			? remainingFindingCount
				? "repaired_with_issues"
				: "repaired"
			: findings.length
				? "issues"
				: "healthy",
		sessionFile: file,
		outputPath: file,
		backupPath,
		changed,
		findingCount: findings.length,
		repairableFindingCount,
		remainingFindingCount,
		counts,
		findings,
	};
}
