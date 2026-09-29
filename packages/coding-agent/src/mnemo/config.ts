import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MnemopiOptions } from "@chudware/mnemo";
import { getMemoriesDir, logger } from "@chudware/utils";
import type { Settings } from "../config/settings";

export type MnemopiLlmMode = "none" | "smol" | "remote";

export type MnemopiScoping = "global" | "per-project" | "per-project-tagged";

export type MnemopiProviderOptions = Pick<
	MnemopiOptions,
	"noEmbeddings" | "embeddingModel" | "embeddingApiUrl" | "embeddingApiKey" | "llm" | "debug"
>;

export interface MnemopiBackendConfig {
	dbPath: string;
	baseBank?: string;
	bank: string;
	globalBank?: string;
	retainBank?: string;
	recallBanks?: readonly string[];
	scoping?: MnemopiScoping;
	autoRecall: boolean;
	autoRetain: boolean;
	polyphonicRecall: boolean;
	enhancedRecall: boolean;
	proactiveLinking: boolean;
	retainEveryNTurns: number;
	recallLimit: number;
	recallContextTurns: number;
	recallMaxQueryChars: number;
	injectionTokenLimit: number;
	debug: boolean;
	providerOptions: MnemopiProviderOptions;
	llmMode: MnemopiLlmMode;
	llmBaseUrl?: string;
	llmApiKey?: string;
	llmModel?: string;
}

export function loadMnemopiConfig(settings: Settings, agentDir: string): MnemopiBackendConfig {
	const configuredDbPath = settings.get("mnemo.dbPath");
	const cwd = settings.getCwd();
	const scoping = settings.get("mnemo.scoping");
	const dbPath = configuredDbPath?.trim()
		? configuredDbPath
		: path.join(getMemoriesDir(agentDir), "mnemo", "mnemo.db");
	const scope = computeMnemopiBankScope(settings.get("mnemo.bank"), cwd, scoping);
	const recallBanks =
		scoping === "global" ? scope.recallBanks : extendRecallWithLegacyBanks(scope.recallBanks, dbPath, cwd);
	const llmMode = settings.get("mnemo.llmMode");
	const embeddingOverride = settings.get("mnemo.embeddingModel");
	const embeddingVariant = settings.get("mnemo.embeddingVariant");
	// Map the variant explicitly rather than indexing an object with the raw config
	// value (which could resolve an inherited property like `__proto__`); any value
	// other than the multilingual variant falls back to the English default.
	const variantModel =
		embeddingVariant === "multilingual" ? "intfloat/multilingual-e5-large" : "BAAI/bge-base-en-v1.5";
	// Precedence: explicit `mnemo.embeddingModel` setting > `MNEMOPI_EMBEDDING_MODEL`
	// env (documented model-level override) > variant-derived default. Without the env
	// term a variant default would silently shadow a user's configured env model.
	const embeddingModel = embeddingOverride?.trim() || process.env.MNEMOPI_EMBEDDING_MODEL?.trim() || variantModel;
	return {
		dbPath,
		baseBank: scope.baseBank,
		bank: scope.bank,
		globalBank: scope.globalBank,
		retainBank: scope.retainBank,
		recallBanks,
		scoping,
		autoRecall: settings.get("mnemo.autoRecall"),
		autoRetain: settings.get("mnemo.autoRetain"),
		polyphonicRecall: settings.get("mnemo.polyphonicRecall"),
		enhancedRecall: settings.get("mnemo.enhancedRecall"),
		proactiveLinking: settings.get("mnemo.proactiveLinking"),
		retainEveryNTurns: Math.max(1, Math.floor(settings.get("mnemo.retainEveryNTurns"))),
		recallLimit: Math.max(1, Math.floor(settings.get("mnemo.recallLimit"))),
		recallContextTurns: Math.max(1, Math.floor(settings.get("mnemo.recallContextTurns"))),
		recallMaxQueryChars: Math.max(256, Math.floor(settings.get("mnemo.recallMaxQueryChars"))),
		injectionTokenLimit: Math.max(256, Math.floor(settings.get("mnemo.injectionTokenLimit"))),
		debug: settings.get("mnemo.debug"),
		providerOptions: {
			noEmbeddings: settings.get("mnemo.noEmbeddings"),
			debug: settings.get("mnemo.debug"),
			embeddingModel,
			embeddingApiUrl: settings.get("mnemo.embeddingApiUrl"),
			embeddingApiKey: settings.get("mnemo.embeddingApiKey"),
			llm:
				llmMode === "remote"
					? {
							baseUrl: settings.get("mnemo.llmBaseUrl"),
							apiKey: settings.get("mnemo.llmApiKey"),
							model: settings.get("mnemo.llmModel"),
						}
					: false,
		},
		llmMode,
		llmBaseUrl: settings.get("mnemo.llmBaseUrl"),
		llmApiKey: settings.get("mnemo.llmApiKey"),
		llmModel: settings.get("mnemo.llmModel"),
	};
}

const DEFAULT_SHARED_BANK = "default";

// Cap legacy-bank scanning at session start so a pathological banks/
// directory cannot dominate startup latency.
const LEGACY_BANK_SCAN_LIMIT = 64;

export interface MnemopiBankScope {
	baseBank: string;
	bank: string;
	globalBank: string;
	retainBank: string;
	recallBanks: readonly string[];
}

/**
 * Resolve write/recall banks for a session.
 *
 * Mnemo has no tag-filtered recall, so `per-project-tagged` maps to a
 * project-local write bank plus a shared recall-visible bank. The project
 * bank is derived purely from {@link cwd} — see {@link projectBank} for the
 * stability contract.
 */
export function computeMnemopiBankScope(
	configured: string | undefined,
	cwd: string,
	scoping: MnemopiScoping,
): MnemopiBankScope {
	const project = projectBank(configured, cwd);
	const globalBank = sharedBank(configured);
	switch (scoping) {
		case "global":
			return {
				baseBank: globalBank,
				bank: globalBank,
				globalBank,
				retainBank: globalBank,
				recallBanks: [globalBank],
			};
		case "per-project":
			return {
				baseBank: globalBank,
				bank: project,
				globalBank,
				retainBank: project,
				recallBanks: [project],
			};
		case "per-project-tagged":
			return {
				baseBank: globalBank,
				bank: project,
				globalBank,
				retainBank: project,
				recallBanks: project === globalBank ? [project] : [project, globalBank],
			};
	}
}

function sharedBank(configured: string | undefined): string {
	return sanitizeBankName(configured) ?? DEFAULT_SHARED_BANK;
}

/**
 * Derive the per-project bank id from `cwd` alone.
 *
 * Earlier versions resolved the enclosing git root before hashing, which
 * made the bank id unstable: removing or adding a `.git` anywhere above the
 * cwd repointed the same conversation directory to a different bank and
 * fragmented memories (#2412). The git lookup is gone here; the rescue path
 * for already-fragmented installs lives in {@link extendRecallWithLegacyBanks}.
 */
function projectBank(configured: string | undefined, cwd: string): string {
	const projectRoot = path.resolve(cwd || ".");
	const project = projectBankSegment(projectRoot);
	const base = sanitizeBankName(configured);
	return limitBankName(base ? `${base}-${project}` : project);
}

/**
 * Per-project bank segment: `<sanitized-basename>-<Bun.hash(projectRoot).toString(36)>`,
 * clamped to the bank-name limit. Shared by mnemo bank scoping and the
 * sharpshooter project store so both subsystems key a project identically.
 */
export function projectBankSegment(projectRoot: string): string {
	const project = sanitizeBankName(path.basename(projectRoot)) ?? "default";
	return limitBankName(`${project}-${Bun.hash(projectRoot).toString(36)}`);
}

/**
 * Discover sibling banks under `<dbDir>/banks/` whose `working_memory` rows
 * all carry the active `cwd` in `metadata_json.$.cwd`, and add those safe
 * single-cwd banks to the recall set. This rescues memories stranded by a
 * previous, less-stable bank derivation (#2412) without recalling mixed-cwd
 * legacy banks wholesale under per-project isolation.
 *
 * Robust by design: a missing banks directory, unreadable bank dir, or
 * corrupt SQLite file is silently skipped. Scanning is capped at
 * {@link LEGACY_BANK_SCAN_LIMIT} to bound startup cost.
 */
export function extendRecallWithLegacyBanks(
	resolved: readonly string[],
	dbPath: string,
	cwd: string,
): readonly string[] {
	const banksDir = path.join(path.dirname(dbPath), "banks");
	const cwdAbs = path.resolve(cwd || ".");
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(banksDir, { withFileTypes: true });
	} catch {
		return resolved;
	}
	const have = new Set(resolved);
	const extras: string[] = [];
	let scanned = 0;
	for (const entry of entries) {
		if (!entry.isDirectory() || have.has(entry.name)) continue;
		if (scanned >= LEGACY_BANK_SCAN_LIMIT) break;
		scanned++;
		const candidate = path.join(banksDir, entry.name, "mnemo.db");
		if (bankOnlyHasCwd(candidate, cwdAbs)) extras.push(entry.name);
	}
	return extras.length === 0 ? resolved : [...resolved, ...extras];
}

function bankOnlyHasCwd(dbPath: string, cwd: string): boolean {
	let db: Database | undefined;
	try {
		db = new Database(dbPath, { readonly: true });
		const row = db
			.prepare<{ matching: number; unsafe: number }, [string, string]>(`
				SELECT
					SUM(CASE WHEN json_extract(metadata_json, '$.cwd') = ? THEN 1 ELSE 0 END) AS matching,
					SUM(CASE WHEN json_extract(metadata_json, '$.cwd') IS NULL OR json_extract(metadata_json, '$.cwd') <> ? THEN 1 ELSE 0 END) AS unsafe
				FROM working_memory
			`)
			.get(cwd, cwd);
		return (row?.matching ?? 0) > 0 && (row?.unsafe ?? 0) === 0;
	} catch (error) {
		logger.debug("Mnemo: legacy bank probe failed", { dbPath, error: String(error) });
		return false;
	} finally {
		try {
			db?.close();
		} catch {
			// nothing to do — read-only handle.
		}
	}
}

function sanitizeBankName(value: string | undefined): string | undefined {
	const raw = value?.trim();
	if (!raw) return undefined;
	const sanitized = raw.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized ? limitBankName(sanitized) : undefined;
}

function limitBankName(name: string): string {
	if (name.length <= 64) return name;
	const hash = Bun.hash(name).toString(36);
	const prefixLength = Math.max(1, 63 - hash.length);
	const prefix = name.slice(0, prefixLength).replace(/-+$/g, "") || "bank";
	return `${prefix}-${hash}`;
}

export function truncateApproxTokens(text: string, tokenLimit: number): string {
	const maxChars = Math.max(0, tokenLimit * 4);
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
