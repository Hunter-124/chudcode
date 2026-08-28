import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@chudware/coding-agent/config/settings";
import { loadMnemopiConfig, type MnemopiBackendConfig } from "@chudware/coding-agent/mnemo/config";
import { getMemoriesDir } from "@chudware/utils";

// `mnemo.embeddingVariant` selects the concrete local embedding model, while an
// explicit `mnemo.embeddingModel` is an advanced override that wins. Scoping is
// pinned to "global" so the resolver stays pure (no legacy-bank disk probing).
function mnemopiConfigFor(
	overrides: Record<string, unknown>,
	agentDir = "/tmp/mnemo-config-test",
): MnemopiBackendConfig {
	const settings = Settings.isolated({ "mnemo.scoping": "global", ...overrides });
	return loadMnemopiConfig(settings, agentDir);
}

function embeddingModelFor(overrides: Record<string, unknown>): string | undefined {
	return mnemopiConfigFor(overrides).providerOptions.embeddingModel;
}

describe("loadMnemopiConfig embedding variant resolution", () => {
	it("maps the en variant to BAAI/bge-base-en-v1.5", () => {
		expect(embeddingModelFor({ "mnemo.embeddingVariant": "en" })).toBe("BAAI/bge-base-en-v1.5");
	});

	it("maps the multilingual variant to intfloat/multilingual-e5-large", () => {
		expect(embeddingModelFor({ "mnemo.embeddingVariant": "multilingual" })).toBe("intfloat/multilingual-e5-large");
	});

	it("lets an explicit embeddingModel override win over the variant", () => {
		expect(
			embeddingModelFor({
				"mnemo.embeddingVariant": "multilingual",
				"mnemo.embeddingModel": "openai/text-embedding-3-small",
			}),
		).toBe("openai/text-embedding-3-small");
	});

	it("ignores a blank override and falls back to the variant", () => {
		expect(embeddingModelFor({ "mnemo.embeddingVariant": "en", "mnemo.embeddingModel": "   " })).toBe(
			"BAAI/bge-base-en-v1.5",
		);
	});

	it("honors MNEMOPI_EMBEDDING_MODEL when no explicit model setting is present", () => {
		const previous = process.env.MNEMOPI_EMBEDDING_MODEL;
		process.env.MNEMOPI_EMBEDDING_MODEL = "BAAI/bge-large-en-v1.5";
		try {
			// The documented env override must not be shadowed by the variant default.
			expect(embeddingModelFor({ "mnemo.embeddingVariant": "en" })).toBe("BAAI/bge-large-en-v1.5");
		} finally {
			if (previous === undefined) delete process.env.MNEMOPI_EMBEDDING_MODEL;
			else process.env.MNEMOPI_EMBEDDING_MODEL = previous;
		}
	});

	it("lets an explicit embeddingModel setting win over the env var", () => {
		const previous = process.env.MNEMOPI_EMBEDDING_MODEL;
		process.env.MNEMOPI_EMBEDDING_MODEL = "BAAI/bge-large-en-v1.5";
		try {
			expect(embeddingModelFor({ "mnemo.embeddingModel": "openai/text-embedding-3-small" })).toBe(
				"openai/text-embedding-3-small",
			);
		} finally {
			if (previous === undefined) delete process.env.MNEMOPI_EMBEDDING_MODEL;
			else process.env.MNEMOPI_EMBEDDING_MODEL = previous;
		}
	});
});

describe("loadMnemopiConfig database path resolution", () => {
	it("resolves a blank dbPath to persistent agent storage", () => {
		const agentDir = "/tmp/mnemo-blank-db-path-test";
		const defaultPath = path.join(getMemoriesDir(agentDir), "mnemo", "mnemo.db");

		expect(mnemopiConfigFor({ "mnemo.dbPath": "" }, agentDir).dbPath).toBe(defaultPath);
		expect(mnemopiConfigFor({ "mnemo.dbPath": " \t " }, agentDir).dbPath).toBe(defaultPath);
	});
});
