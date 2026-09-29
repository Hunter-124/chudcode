import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Model } from "@chudware/ai";
import type { ModelRegistry } from "@chudware/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@chudware/coding-agent/config/settings";
import { getEnumValues } from "@chudware/coding-agent/config/settings-schema";
import { resolveMemoryBackend } from "@chudware/coding-agent/memory-backend";
import { computeMnemopiBankScope } from "@chudware/coding-agent/mnemo/config";
import { resolveSharpshooterModel } from "@chudware/coding-agent/sharpshooter/extract";
import {
	sharpshooterBankDir,
	sharpshooterBankId,
	sharpshooterMemoryFilePath,
	sharpshooterQueueDir,
} from "@chudware/coding-agent/sharpshooter/paths";
import {
	appendSharpshooterDelta,
	consumeSharpshooterDeltas,
	listSharpshooterDeltas,
	sharpshooterQueueDepth,
} from "@chudware/coding-agent/sharpshooter/queue";
import type { SharpshooterDelta } from "@chudware/coding-agent/sharpshooter/types";
import { TempDir } from "@chudware/utils";

let root: TempDir;
let agentDir: string;
let projectA: string;
let projectB: string;

beforeEach(async () => {
	resetSettingsForTest();
	root = await TempDir.create("@sharpshooter-");
	agentDir = root.join("agent");
	projectA = root.join("work", "6-axis");
	projectB = root.join("other", "6-axis");
	await fs.mkdir(projectA, { recursive: true });
	await fs.mkdir(projectB, { recursive: true });
});

afterEach(async () => {
	resetSettingsForTest();
	await root.remove();
});

function delta(sessionId: string, ts: number, statement: string): SharpshooterDelta {
	return {
		v: 1,
		kind: "architecture_decision",
		statement,
		source: "explicit_user",
		evidence: statement,
		friction: { corrective: true, regression: false, subtle: false },
		sessionId,
		ts,
	};
}

async function settingsFor(cwd: string, overrides: Record<string, unknown> = {}): Promise<Settings> {
	const settings = Settings.isolated({ "memory.backend": "sharpshooter", ...overrides } as never);
	await settings.reloadForCwd(cwd);
	return settings;
}

describe("sharpshooter project bank", () => {
	it("derives one bank per project folder under <agentDir>/memories/sharpshooter", () => {
		const bankA = sharpshooterBankDir(agentDir, projectA);
		expect(path.dirname(bankA)).toBe(path.join(agentDir, "memories", "sharpshooter"));
		expect(path.basename(bankA)).toStartWith("6-axis-");
		// Same basename, different folder: never pooled.
		expect(sharpshooterBankId(projectB)).not.toBe(sharpshooterBankId(projectA));
		// Equivalent spellings of the same folder resolve to the same bank.
		expect(sharpshooterBankId(`${projectA}/`)).toBe(sharpshooterBankId(projectA));
		expect(sharpshooterBankId(path.join(projectA, "sub", ".."))).toBe(sharpshooterBankId(projectA));
	});

	it("keys the project exactly like mnemo's per-project bank", () => {
		expect(sharpshooterBankId(projectA)).toBe(computeMnemopiBankScope(undefined, projectA, "per-project").bank);
	});
});

describe("sharpshooter delta queue", () => {
	it("lists deltas grouped per session, oldest first, and consume removes only what was read", async () => {
		await appendSharpshooterDelta(agentDir, projectA, delta("s2", 3_000, "later session"));
		await appendSharpshooterDelta(agentDir, projectA, delta("s1", 2_000, "second"));
		await appendSharpshooterDelta(agentDir, projectA, delta("s1", 1_000, "first"));
		await appendSharpshooterDelta(agentDir, projectB, delta("s1", 500, "other project"));

		const groups = await listSharpshooterDeltas(agentDir, projectA);
		expect(groups.map(group => group.sessionId)).toEqual(["s1", "s2"]);
		expect(groups[0]!.deltas.map(item => item.delta.statement)).toEqual(["first", "second"]);
		expect(await sharpshooterQueueDepth(agentDir, projectB)).toBe(1);

		// A delta landing after the consumer's snapshot must survive the consume.
		await appendSharpshooterDelta(agentDir, projectA, delta("s2", 4_000, "raced in"));
		await consumeSharpshooterDeltas(groups.flatMap(group => group.deltas.map(item => item.file)));

		const remaining = await listSharpshooterDeltas(agentDir, projectA);
		expect(remaining.map(group => group.sessionId)).toEqual(["s2"]);
		expect(remaining[0]!.deltas.map(item => item.delta.statement)).toEqual(["raced in"]);
		// Emptied session directories are pruned.
		expect(await Bun.file(path.join(sharpshooterQueueDir(agentDir, projectA), "s1")).exists()).toBe(false);
		expect(await sharpshooterQueueDepth(agentDir, projectB)).toBe(1);
	});

	it("never consumes torn entries and keeps path-hostile session ids inside the queue", async () => {
		const sessionDir = path.join(sharpshooterQueueDir(agentDir, projectA), "s1");
		await Bun.write(path.join(sessionDir, "0000000000-torn.json"), "{not json");
		await appendSharpshooterDelta(agentDir, projectA, delta("../../escape", 1, "hostile id"));

		const groups = await listSharpshooterDeltas(agentDir, projectA);
		expect(groups).toHaveLength(1);
		const [item] = groups[0]!.deltas;
		expect(path.dirname(path.dirname(item!.file))).toBe(sharpshooterQueueDir(agentDir, projectA));
		await consumeSharpshooterDeltas([item!.file]);
		expect(await Bun.file(path.join(sessionDir, "0000000000-torn.json")).exists()).toBe(true);
	});
});

describe("sharpshooter backend", () => {
	it("resolves by id and is accepted by the memory.backend setting", async () => {
		expect(getEnumValues("memory.backend")).toContain("sharpshooter");
		const settings = await settingsFor(projectA);
		const backend = await resolveMemoryBackend(settings);
		expect(backend.id).toBe("sharpshooter");
		await expect(backend.status!({ agentDir, cwd: projectA })).resolves.toMatchObject({
			backend: "sharpshooter",
			active: true,
			scope: sharpshooterBankId(projectA),
		});
	});

	it("injects the project's decision files in order and respects the token limit", async () => {
		const settings = await settingsFor(projectA);
		const backend = await resolveMemoryBackend(settings);
		expect(await backend.buildDeveloperInstructions(agentDir, settings)).toBeUndefined();

		await Bun.write(sharpshooterMemoryFilePath(agentDir, projectA, "style.md"), "- Tabs over spaces.\n");
		await Bun.write(sharpshooterMemoryFilePath(agentDir, projectA, "architecture.md"), "- Straight rear axle.\n");
		await Bun.write(sharpshooterMemoryFilePath(agentDir, projectB, "product.md"), "- Other project only.\n");

		const prompt = await backend.buildDeveloperInstructions(agentDir, settings);
		expect(prompt).toStartWith("Project decision memory (sharpshooter).");
		expect(prompt).toContain("## architecture\n\n- Straight rear axle.");
		expect(prompt).not.toContain("Other project only");
		expect(prompt!.indexOf("## architecture")).toBeLessThan(prompt!.indexOf("## style"));

		const limited = await settingsFor(projectA, { "sharpshooter.injectionTokenLimit": 10 });
		const truncated = await backend.buildDeveloperInstructions(agentDir, limited);
		expect(truncated!.length).toBeLessThanOrEqual(40);
		expect(truncated).toEndWith("…");
	});

	it("falls back to the session model when no sharpshooter model or smol role is configured", async () => {
		const settings = await settingsFor(projectA);
		const registry = { getAll: () => [], getAvailable: () => [] } as unknown as ModelRegistry;
		const sessionModel = { provider: "anthropic", id: "session-model" } as Model;
		expect(await resolveSharpshooterModel(settings, registry, sessionModel)).toBe(sessionModel);
		expect(await resolveSharpshooterModel(settings, registry)).toBeUndefined();
	});
});
