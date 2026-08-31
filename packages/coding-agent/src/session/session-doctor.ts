import { constants as fsConstants, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@chudware/agent-core";
import * as snapcompact from "@chudware/snapcompact";
import { getBlobsDir, isRecord, stringifyJson } from "@chudware/utils";
import { BlobStore, isBlobRef, parseBlobRef } from "./blob-store";
import { CURRENT_SESSION_VERSION, type FileEntry, type SessionEntry, type SessionHeader } from "./session-entries";
import { parseSessionContent, resolveBlobRefsInEntries } from "./session-loader";
import { migrateToCurrentVersion } from "./session-migrations";
import { isPersistenceTruncatedString, prepareEntryForPersistence } from "./session-persistence";
import { FileSessionStorage, type SessionStorage } from "./session-storage";
import { type SessionTitleUpdate, serializeTitleSlot } from "./session-title-slot";

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

export interface SessionDoctorCounts {
	malformedRecords: number;
	malformedEntries: number;
	duplicateEntryIds: number;
	orphanedEntries: number;
	malformedToolCalls: number;
	orphanedToolCalls: number;
	orphanedToolResults: number;
	malformedImages: number;
	malformedBlobRefs: number;
	missingBlobs: number;
	invalidCompactions: number;
	truncatedCompactionImages: number;
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
	counts: SessionDoctorCounts;
	findings: SessionDoctorFinding[];
}

export interface SessionDoctorOptions {
	repair?: boolean;
	storage?: SessionStorage;
	blobStore?: BlobStore;
}

type ToolCallLocation = { entry: SessionEntry; blockIndex: number; id: string; malformed: boolean };
type ToolResultLocation = { entry: SessionEntry; toolCallId: string };

function isSessionHeader(value: unknown): value is SessionHeader {
	return isRecord(value) && value.type === "session" && typeof value.id === "string" && value.id.length > 0;
}

function isSessionEntry(value: unknown): value is SessionEntry {
	return (
		isRecord(value) &&
		typeof value.type === "string" &&
		value.type !== "session" &&
		typeof value.id === "string" &&
		value.id.length > 0 &&
		(value.parentId === null || typeof value.parentId === "string") &&
		typeof value.timestamp === "string"
	);
}

function isLegacySessionEntry(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.type === "string" &&
		value.type !== "session" &&
		typeof value.timestamp === "string"
	);
}

function finding(
	findings: SessionDoctorFinding[],
	code: SessionDoctorFindingCode,
	message: string,
	repairable: boolean,
	entryId?: string,
	findingPath?: string,
): void {
	findings.push({
		code,
		message,
		repairable,
		...(entryId ? { entryId } : {}),
		...(findingPath ? { path: findingPath } : {}),
	});
}

function messageOf(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type !== "message" || !isRecord(entry.message) || typeof entry.message.role !== "string") return undefined;
	return entry.message as AgentMessage;
}

function toolCallsOf(entry: SessionEntry): ToolCallLocation[] {
	const message = messageOf(entry);
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
	const calls: ToolCallLocation[] = [];
	for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
		const block = message.content[blockIndex];
		if (!isRecord(block) || block.type !== "toolCall") continue;
		const id = typeof block.id === "string" ? block.id : "";
		const name = typeof block.name === "string" ? block.name : "";
		calls.push({ entry, blockIndex, id, malformed: id.trim().length === 0 || name.trim().length === 0 });
	}
	return calls;
}

function toolResultOf(entry: SessionEntry): ToolResultLocation | undefined {
	const message = messageOf(entry);
	if (message?.role !== "toolResult") return undefined;
	return {
		entry,
		toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : "",
	};
}

function ancestorsOf(entry: SessionEntry, byId: ReadonlyMap<string, SessionEntry>): SessionEntry[] {
	const ancestors: SessionEntry[] = [];
	const seen = new Set<string>();
	let parentId = entry.parentId;
	while (parentId && !seen.has(parentId)) {
		seen.add(parentId);
		const parent = byId.get(parentId);
		if (!parent) break;
		ancestors.push(parent);
		parentId = parent.parentId;
	}
	return ancestors;
}

function inspectToolPairing(
	entries: readonly SessionEntry[],
	byId: ReadonlyMap<string, SessionEntry>,
	findings: SessionDoctorFinding[],
): { dangling: Set<string>; malformed: Set<string>; malformedResultEntries: Set<string> } {
	const calls = entries.flatMap(toolCallsOf);
	const callKey = (call: ToolCallLocation): string => `${call.entry.id}:${call.blockIndex}`;
	const pairedCalls = new Set<string>();
	const pairedResultsByCall = new Map<string, SessionEntry[]>();
	const malformed = new Set<string>();
	const malformedResultEntries = new Set<string>();

	for (const call of calls) {
		if (!call.malformed) continue;
		malformed.add(callKey(call));
		finding(
			findings,
			"malformed_tool_call",
			"Tool call has an empty or whitespace-only id or name.",
			true,
			call.entry.id,
			`message.content[${call.blockIndex}]`,
		);
	}

	for (const entry of entries) {
		const result = toolResultOf(entry);
		if (!result) continue;
		let matched: ToolCallLocation | undefined;
		const resultAncestors = ancestorsOf(entry, byId);
		const resultAncestorIds = new Set(resultAncestors.map(ancestor => ancestor.id));
		for (const ancestor of resultAncestors) {
			const candidates = toolCallsOf(ancestor).filter(call => call.id === result.toolCallId);
			for (const candidate of candidates) {
				const priorResults = pairedResultsByCall.get(callKey(candidate)) ?? [];
				const alreadyPairedOnBranch = priorResults.some(prior => {
					if (resultAncestorIds.has(prior.id)) return true;
					return ancestorsOf(prior, byId).some(priorAncestor => priorAncestor.id === entry.id);
				});
				if (!alreadyPairedOnBranch) {
					matched = candidate;
					break;
				}
			}
			if (matched || candidates.length > 0) break;
		}
		if (!matched) {
			finding(
				findings,
				"orphaned_tool_result",
				"Tool result has no matching tool call on its persisted branch.",
				false,
				entry.id,
				"message.toolCallId",
			);
			continue;
		}
		const matchedKey = callKey(matched);
		pairedCalls.add(matchedKey);
		const pairedResults = pairedResultsByCall.get(matchedKey);
		if (pairedResults) pairedResults.push(entry);
		else pairedResultsByCall.set(matchedKey, [entry]);
		if (matched.malformed) {
			malformedResultEntries.add(entry.id);
			finding(
				findings,
				"orphaned_tool_result",
				"Tool result is paired only with a malformed tool call and cannot remain on the provider wire.",
				true,
				entry.id,
				"message.toolCallId",
			);
		}
	}

	const dangling = new Set<string>();
	for (const call of calls) {
		const key = callKey(call);
		if (call.malformed || pairedCalls.has(key)) continue;
		dangling.add(key);
		finding(
			findings,
			"orphaned_tool_call",
			"Tool call has no matching tool result on any persisted branch.",
			true,
			call.entry.id,
			`message.content[${call.blockIndex}]`,
		);
	}
	return { dangling, malformed, malformedResultEntries };
}

interface ImageInspectionState {
	blobRefs: Array<{ ref: string; entryId: string; path: string }>;
}

function inspectImages(
	value: unknown,
	entryId: string,
	valuePath: string,
	findings: SessionDoctorFinding[],
	state: ImageInspectionState,
): void {
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			inspectImages(value[index], entryId, `${valuePath}[${index}]`, findings, state);
		}
		return;
	}
	if (!isRecord(value)) return;

	if (value.type === "image") {
		if (typeof value.data !== "string" || value.data.length === 0) {
			finding(findings, "malformed_image", "Image block has no non-empty string data.", false, entryId, valuePath);
		} else if (isPersistenceTruncatedString(value.data)) {
			finding(
				findings,
				"malformed_image",
				"Image data was truncated by an older persistence writer.",
				true,
				entryId,
				`${valuePath}.data`,
			);
		}
	}

	const blobCandidates: Array<readonly [string, unknown]> = [];
	if ("data" in value && (value.type === "image" || /\.frames\[\d+\]$/.test(valuePath))) {
		blobCandidates.push([`${valuePath}.data`, value.data]);
	}
	if ("image_url" in value) blobCandidates.push([`${valuePath}.image_url`, value.image_url]);
	if (value.type === "image_generation_call" && "result" in value) {
		blobCandidates.push([`${valuePath}.result`, value.result]);
	}
	for (const [candidatePath, candidate] of blobCandidates) {
		if (typeof candidate !== "string" || !isBlobRef(candidate)) continue;
		if (!parseBlobRef(candidate)) {
			finding(
				findings,
				"malformed_blob_ref",
				"Blob reference is not a canonical SHA-256 reference.",
				true,
				entryId,
				candidatePath,
			);
			continue;
		}
		state.blobRefs.push({ ref: candidate, entryId, path: candidatePath });
	}

	for (const [key, child] of Object.entries(value)) {
		inspectImages(child, entryId, valuePath ? `${valuePath}.${key}` : key, findings, state);
	}
}

function inspectCompactions(
	entries: readonly SessionEntry[],
	byId: ReadonlyMap<string, SessionEntry>,
	findings: SessionDoctorFinding[],
): void {
	for (const entry of entries) {
		if (entry.type !== "compaction") continue;
		if (typeof entry.summary !== "string" || typeof entry.firstKeptEntryId !== "string") {
			finding(
				findings,
				"invalid_compaction",
				"Compaction record is missing its summary or first-kept entry id.",
				false,
				entry.id,
			);
			continue;
		}
		const ancestorIds = new Set(ancestorsOf(entry, byId).map(ancestor => ancestor.id));
		if (!byId.has(entry.firstKeptEntryId) || !ancestorIds.has(entry.firstKeptEntryId)) {
			finding(
				findings,
				"invalid_compaction",
				"Compaction first-kept entry is missing or is not an ancestor.",
				false,
				entry.id,
				"firstKeptEntryId",
			);
		}
		if (
			entry.providerReplayThroughEntryId !== undefined &&
			(!byId.has(entry.providerReplayThroughEntryId) || !ancestorIds.has(entry.providerReplayThroughEntryId))
		) {
			finding(
				findings,
				"invalid_compaction",
				"Compaction provider replay boundary is missing or is not an ancestor.",
				false,
				entry.id,
				"providerReplayThroughEntryId",
			);
		}
		const archive = snapcompact.getPreservedArchive(entry.preserveData);
		if (!archive) continue;
		for (let index = 0; index < archive.frames.length; index++) {
			if (!isPersistenceTruncatedString(archive.frames[index]?.data)) continue;
			finding(
				findings,
				"truncated_compaction_image",
				"Compaction frame contains persistence-truncated image data.",
				true,
				entry.id,
				`preserveData.${snapcompact.PRESERVE_KEY}.frames[${index}].data`,
			);
		}
	}
}

function countFindings(findings: readonly SessionDoctorFinding[]): SessionDoctorCounts {
	const count = (code: SessionDoctorFindingCode): number => findings.filter(item => item.code === code).length;
	return {
		malformedRecords: count("malformed_jsonl"),
		malformedEntries: count("malformed_entry"),
		duplicateEntryIds: count("duplicate_entry_id"),
		orphanedEntries: count("orphaned_entry"),
		malformedToolCalls: count("malformed_tool_call"),
		orphanedToolCalls: count("orphaned_tool_call"),
		orphanedToolResults: count("orphaned_tool_result"),
		malformedImages: count("malformed_image"),
		malformedBlobRefs: count("malformed_blob_ref"),
		missingBlobs: count("missing_blob"),
		invalidCompactions: count("invalid_compaction"),
		truncatedCompactionImages: count("truncated_compaction_image"),
	};
}

function stripUnsafeToolCalls(
	entries: SessionEntry[],
	unsafeKeys: ReadonlySet<string>,
	malformedResultEntries: ReadonlySet<string>,
): boolean {
	let changed = false;
	const retained: SessionEntry[] = [];
	const removedIds = new Set<string>();
	for (const entry of entries) {
		if (malformedResultEntries.has(entry.id)) {
			removedIds.add(entry.id);
			changed = true;
			continue;
		}
		const message = messageOf(entry);
		if (entry.type !== "message" || message?.role !== "assistant" || !Array.isArray(message.content)) {
			retained.push(entry);
			continue;
		}
		let removed = false;
		const content = message.content
			.filter((block, blockIndex) => {
				if (!isRecord(block) || block.type !== "toolCall") return true;
				const drop = unsafeKeys.has(`${entry.id}:${blockIndex}`);
				if (drop) removed = true;
				return !drop;
			})
			.filter(block => !removed || !isRecord(block) || block.type !== "redactedThinking")
			.map(block => {
				if (!removed || !isRecord(block) || block.type !== "thinking" || !("thinkingSignature" in block))
					return block;
				return { ...block, thinkingSignature: undefined };
			});
		if (!removed) {
			retained.push(entry);
			continue;
		}
		changed = true;
		if (content.length === 0) {
			removedIds.add(entry.id);
			continue;
		}
		entry.message = { ...message, content } as AgentMessage;
		retained.push(entry);
	}
	if (!changed) return false;

	const parentByRemovedId = new Map<string, string | null>();
	for (const entry of entries) {
		if (removedIds.has(entry.id)) parentByRemovedId.set(entry.id, entry.parentId);
	}
	const retainedAncestor = (parentId: string | null): string | null => {
		const seen = new Set<string>();
		while (parentId && removedIds.has(parentId) && !seen.has(parentId)) {
			seen.add(parentId);
			parentId = parentByRemovedId.get(parentId) ?? null;
		}
		return parentId;
	};
	for (const entry of retained) entry.parentId = retainedAncestor(entry.parentId);
	entries.splice(0, entries.length, ...retained);
	return true;
}

function serializeEntries(
	entries: FileEntry[],
	blobStore: BlobStore,
	titleSlot: SessionTitleUpdate | undefined,
): string {
	const header = entries[0] as SessionHeader;
	const slot =
		titleSlot ??
		({
			title: header.title,
			source: header.titleSource,
			updatedAt: header.timestamp,
		} as const);
	let body = serializeTitleSlot(slot);
	for (const entry of entries) body += `${stringifyJson(prepareEntryForPersistence(entry, blobStore)) ?? "null"}\n`;
	return body;
}

async function reserveBackupPath(sessionFile: string, expectedContent: string): Promise<string> {
	const suffix = `${Date.now()}-${crypto.randomUUID()}`;
	const backupPath = path.join(path.dirname(sessionFile), `${path.basename(sessionFile)}.doctor-${suffix}.bak`);
	await fs.copyFile(sessionFile, backupPath, fsConstants.COPYFILE_EXCL);
	if ((await fs.readFile(backupPath, "utf8")) !== expectedContent) {
		await fs.unlink(backupPath);
		throw new Error("Session changed while the doctor was inspecting it; no repair was applied.");
	}
	return backupPath;
}

export async function doctorSessionFile(
	sessionFile: string,
	options: SessionDoctorOptions = {},
): Promise<SessionDoctorSummary> {
	const repair = options.repair === true;
	const storage = options.storage ?? new FileSessionStorage();
	const blobStore = options.blobStore ?? new BlobStore(getBlobsDir());
	const resolvedSessionFile = path.resolve(sessionFile);
	const original = await storage.readText(resolvedSessionFile);
	const loaded = parseSessionContent(original);
	const findings: SessionDoctorFinding[] = [];
	for (let index = 0; index < loaded.malformedRecords; index++) {
		finding(findings, "malformed_jsonl", "Malformed or interrupted JSONL record was skipped.", true);
	}
	const headerIndex = loaded.entries.findIndex(entry => isSessionHeader(entry));
	const header = headerIndex >= 0 ? (loaded.entries[headerIndex] as SessionHeader) : undefined;
	if (loaded.invalidHeader || headerIndex !== 0) {
		const recoverable = headerIndex > 0;
		finding(
			findings,
			"invalid_header",
			recoverable
				? "Valid session header appears after leading records; repair can restore it as the first record."
				: "Session header is missing or malformed; it cannot be reconstructed without inventing session metadata.",
			recoverable,
		);
	}
	const persistedVersion = header?.version ?? 1;
	const legacyV1 = persistedVersion < 2;
	const migrationNeeded = persistedVersion < CURRENT_SESSION_VERSION;
	const inspectionEntries: FileEntry[] = header ? [structuredClone(header)] : [];
	const malformedEntryIndexes = new Set<number>();
	for (let index = Math.max(1, headerIndex + 1); index < loaded.entries.length; index++) {
		const candidate = loaded.entries[index] as unknown;
		const valid = legacyV1 ? isLegacySessionEntry(candidate) : isSessionEntry(candidate);
		if (!valid) {
			malformedEntryIndexes.add(index);
			finding(
				findings,
				"malformed_entry",
				"JSONL record is not a valid session entry.",
				true,
				undefined,
				`entries[${index}]`,
			);
			continue;
		}
		inspectionEntries.push(structuredClone(candidate) as SessionEntry);
	}
	if (header) migrateToCurrentVersion(inspectionEntries);

	const validEntries: SessionEntry[] = [];
	const seenIds = new Set<string>();
	const duplicateIds = new Set<string>();
	for (const candidate of inspectionEntries.slice(1) as SessionEntry[]) {
		if (seenIds.has(candidate.id)) {
			duplicateIds.add(candidate.id);
			finding(
				findings,
				"duplicate_entry_id",
				"More than one session entry uses this id; automatic repair would make branch ownership ambiguous.",
				false,
				candidate.id,
			);
			continue;
		}
		seenIds.add(candidate.id);
		validEntries.push(candidate);
	}
	const byId = new Map(validEntries.map(entry => [entry.id, entry] as const));
	for (const entry of validEntries) {
		if (entry.parentId !== null && !byId.has(entry.parentId)) {
			finding(
				findings,
				"orphaned_entry",
				"Entry parent is missing; automatic repair would require inventing branch ancestry.",
				false,
				entry.id,
				"parentId",
			);
		}
	}

	const toolInspection = inspectToolPairing(validEntries, byId, findings);
	inspectCompactions(validEntries, byId, findings);
	const imageState: ImageInspectionState = { blobRefs: [] };
	for (const entry of validEntries) inspectImages(entry, entry.id, "", findings, imageState);
	const blobAvailability = await Promise.all(
		imageState.blobRefs.map(async item => {
			const hash = parseBlobRef(item.ref);
			return hash && !(await blobStore.has(hash)) ? item : undefined;
		}),
	);
	for (const item of blobAvailability) {
		if (!item) continue;
		finding(findings, "missing_blob", "Referenced image/blob payload is missing.", true, item.entryId, item.path);
	}

	let changed = false;
	let backupPath: string | null = null;
	if (repair && header && duplicateIds.size === 0) {
		const repairedEntries = structuredClone(inspectionEntries);
		const sessionEntries = repairedEntries.slice(1) as SessionEntry[];
		const unsafeToolCalls = new Set([...toolInspection.malformed, ...toolInspection.dangling]);
		const toolCallsChanged = stripUnsafeToolCalls(
			sessionEntries,
			unsafeToolCalls,
			toolInspection.malformedResultEntries,
		);
		repairedEntries.splice(1, repairedEntries.length - 1, ...sessionEntries);
		const repairedImages = await resolveBlobRefsInEntries(repairedEntries, blobStore);
		const repairableRecordDamage = loaded.malformedRecords > 0 || malformedEntryIndexes.size > 0 || headerIndex > 0;
		const truncatedCompaction = findings.some(item => item.code === "truncated_compaction_image");
		changed = repairableRecordDamage || toolCallsChanged || migrationNeeded || repairedImages || truncatedCompaction;
		if (changed) {
			const repairedBody = serializeEntries(repairedEntries, blobStore, loaded.titleSlot);
			backupPath = await reserveBackupPath(resolvedSessionFile, original);
			let commitAllowed = false;
			await storage.writeTextAtomic(resolvedSessionFile, repairedBody, {
				commitGuard: () => {
					commitAllowed = readFileSync(resolvedSessionFile, "utf8") === original;
					return commitAllowed;
				},
			});
			if (!commitAllowed) {
				throw new Error(
					`Session changed before repair commit; it was not replaced. Untouched backup: ${backupPath}`,
				);
			}
		}
	}

	const counts = countFindings(findings);
	const repairableFindingCount = findings.filter(item => item.repairable).length;
	const remainingFindingCount = changed ? findings.length - repairableFindingCount : findings.length;
	const status =
		changed && remainingFindingCount > 0
			? "repaired_with_issues"
			: changed
				? "repaired"
				: findings.length === 0
					? "healthy"
					: "issues";
	return {
		version: 1,
		mode: repair ? "repair" : "dry-run",
		status,
		sessionFile: resolvedSessionFile,
		outputPath: resolvedSessionFile,
		backupPath,
		changed,
		findingCount: findings.length,
		repairableFindingCount,
		remainingFindingCount,
		counts,
		findings,
	};
}
