import * as fs from "node:fs/promises";
import type { GeneratedProvider } from "../src/models";

const DEFAULT_RUNS = 7;
const DEFAULT_PROVIDER = "openai";
const KIBIBYTE = 1024;
const SCENARIOS = ["providers", "provider", "all"] as const;

type Scenario = (typeof SCENARIOS)[number];

interface MemorySample {
	rss: number;
	heapUsed: number;
	external: number;
	pss: number | null;
	private: number | null;
	shared: number | null;
}

interface CatalogMapping {
	path: string;
	mappedBytes: number;
	sharedBytes: number;
	privateBytes: number;
	isFileBacked: boolean;
}

interface ProbeResult {
	mode: "probe";
	scenario: Scenario;
	provider: string;
	pid: number;
	providers: number;
	models: number;
	checksum: string;
	initial: MemorySample;
	addon: MemorySample;
	measured: MemorySample;
	addonDelta: MemorySample;
	catalogDelta: MemorySample;
	mapping: CatalogMapping | null;
}

interface ScenarioSummary {
	checksum: string;
	providers: number;
	models: number;
	addonMedian: MemorySample;
	catalogMedian: MemorySample;
	mapping: CatalogMapping | null;
}

interface ParentResult {
	mode: "parent";
	runs: number;
	provider: string;
	scenarios: Record<Scenario, ScenarioSummary>;
}

interface Arguments {
	probe: Scenario | null;
	provider: string;
	runs: number;
	holdMs: number;
}

function parseInteger(value: string | undefined, flag: string, minimum: number): number {
	if (value === undefined || !/^\d+$/.test(value)) throw new Error(`${flag} requires an integer`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${flag} must be at least ${minimum}`);
	return parsed;
}

function parseArguments(argv: string[]): Arguments {
	let probe: Scenario | null = null;
	let provider = DEFAULT_PROVIDER;
	let runs = DEFAULT_RUNS;
	let holdMs = 0;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		switch (argument) {
			case "--probe": {
				const value = argv[++index];
				if (!SCENARIOS.includes(value as Scenario)) {
					throw new Error(`--probe must be one of ${SCENARIOS.join("|")}`);
				}
				probe = value as Scenario;
				break;
			}
			case "--provider":
				provider = argv[++index] ?? "";
				if (provider.length === 0) throw new Error("--provider requires a non-empty provider ID");
				break;
			case "--runs":
				runs = parseInteger(argv[++index], "--runs", 1);
				if (runs % 2 === 0) throw new Error("--runs must be odd so the median is an observed run");
				break;
			case "--hold-ms":
				holdMs = parseInteger(argv[++index], "--hold-ms", 0);
				break;
			default:
				throw new Error(`Unknown argument: ${argument}`);
		}
	}
	return { probe, provider, runs, holdMs };
}

async function readSmapsRollup(): Promise<Pick<MemorySample, "pss" | "private" | "shared">> {
	if (process.platform !== "linux") return { pss: null, private: null, shared: null };
	try {
		const text = await fs.readFile("/proc/self/smaps_rollup", "utf8");
		const values = new Map<string, number>();
		for (const line of text.split("\n")) {
			const match = /^(Pss|Private_Clean|Private_Dirty|Shared_Clean|Shared_Dirty):\s+(\d+) kB$/.exec(line);
			if (match) values.set(match[1], Number(match[2]) * KIBIBYTE);
		}
		return {
			pss: values.get("Pss") ?? null,
			private: (values.get("Private_Clean") ?? 0) + (values.get("Private_Dirty") ?? 0),
			shared: (values.get("Shared_Clean") ?? 0) + (values.get("Shared_Dirty") ?? 0),
		};
	} catch {
		return { pss: null, private: null, shared: null };
	}
}

async function sampleMemory(): Promise<MemorySample> {
	const memory = process.memoryUsage();
	const smaps = await readSmapsRollup();
	return {
		rss: memory.rss,
		heapUsed: memory.heapUsed,
		external: memory.external,
		pss: smaps.pss,
		private: smaps.private,
		shared: smaps.shared,
	};
}

function subtractSample(after: MemorySample, before: MemorySample): MemorySample {
	const subtractNullable = (left: number | null, right: number | null): number | null =>
		left === null || right === null ? null : left - right;
	return {
		rss: after.rss - before.rss,
		heapUsed: after.heapUsed - before.heapUsed,
		external: after.external - before.external,
		pss: subtractNullable(after.pss, before.pss),
		private: subtractNullable(after.private, before.private),
		shared: subtractNullable(after.shared, before.shared),
	};
}

async function readCatalogMapping(): Promise<CatalogMapping | null> {
	if (process.platform !== "linux") return null;
	let text: string;
	try {
		text = await fs.readFile("/proc/self/smaps", "utf8");
	} catch {
		return null;
	}

	let currentPath: string | null = null;
	let currentInode = 0;
	let mappedBytes = 0;
	let sharedBytes = 0;
	let privateBytes = 0;
	let matchedPath: string | null = null;
	let matchedInode = 0;
	for (const line of text.split("\n")) {
		const header = /^[0-9a-f]+-[0-9a-f]+\s+\S+\s+\S+\s+\S+\s+(\d+)\s*(.*)$/.exec(line);
		if (header) {
			currentInode = Number(header[1]);
			currentPath = header[2] || null;
			continue;
		}
		if (currentPath === null || !/(?:^|\/)models\.bin(?:\s+\(deleted\))?$/.test(currentPath)) continue;
		const field = /^(Size|Shared_Clean|Shared_Dirty|Private_Clean|Private_Dirty):\s+(\d+) kB$/.exec(line);
		if (!field) continue;
		matchedPath = currentPath;
		matchedInode = currentInode;
		const bytes = Number(field[2]) * KIBIBYTE;
		switch (field[1]) {
			case "Size":
				mappedBytes += bytes;
				break;
			case "Shared_Clean":
			case "Shared_Dirty":
				sharedBytes += bytes;
				break;
			case "Private_Clean":
			case "Private_Dirty":
				privateBytes += bytes;
				break;
		}
	}
	return matchedPath === null
		? null
		: {
				path: matchedPath,
				mappedBytes,
				sharedBytes,
				privateBytes,
				isFileBacked: matchedInode !== 0,
			};
}

function checksumObserved(providers: string[], modelIds: ReadonlyMap<string, readonly string[]>): string {
	const hasher = new Bun.CryptoHasher("sha256");
	for (const provider of providers) {
		hasher.update(provider);
		hasher.update("\0");
		for (const modelId of modelIds.get(provider) ?? []) {
			hasher.update(modelId);
			hasher.update("\0");
		}
	}
	return hasher.digest("hex");
}

function printMemoryMetrics(prefix: string, sample: MemorySample): void {
	console.log(`METRIC ${prefix}_rss_bytes=${sample.rss}`);
	console.log(`METRIC ${prefix}_heap_bytes=${sample.heapUsed}`);
	console.log(`METRIC ${prefix}_external_bytes=${sample.external}`);
	if (sample.pss !== null) console.log(`METRIC ${prefix}_pss_bytes=${sample.pss}`);
	if (sample.private !== null) console.log(`METRIC ${prefix}_private_bytes=${sample.private}`);
	if (sample.shared !== null) console.log(`METRIC ${prefix}_shared_bytes=${sample.shared}`);
}

async function runProbe(scenario: Scenario, provider: string, holdMs: number): Promise<void> {
	Bun.gc(true);
	const initial = await sampleMemory();
	// Dynamic imports are the measurement boundary: static imports would charge
	// addon and catalog initialization to the process baseline.
	await import("@oh-my-pi/pi-natives");
	Bun.gc(true);
	const addon = await sampleMemory();
	const catalog = await import("../src/models");

	const observedProviders: string[] = [];
	const observedModels = new Map<string, string[]>();
	if (scenario === "providers") {
		observedProviders.push(...catalog.getBundledProviders());
	} else if (scenario === "provider") {
		observedProviders.push(provider);
		observedModels.set(
			provider,
			catalog.getBundledModels(provider as GeneratedProvider).map(model => model.id),
		);
	} else {
		observedProviders.push(...catalog.getBundledProviders());
		for (const providerId of observedProviders) {
			observedModels.set(
				providerId,
				catalog.getBundledModels(providerId as GeneratedProvider).map(model => model.id),
			);
		}
	}
	Bun.gc(true);
	const measured = await sampleMemory();
	const result: ProbeResult = {
		mode: "probe",
		scenario,
		provider,
		pid: process.pid,
		providers: observedProviders.length,
		models: Array.from(observedModels.values()).reduce((total, ids) => total + ids.length, 0),
		checksum: checksumObserved(observedProviders, observedModels),
		initial,
		addon,
		measured,
		addonDelta: subtractSample(addon, initial),
		catalogDelta: subtractSample(measured, addon),
		mapping: await readCatalogMapping(),
	};
	printMemoryMetrics("addon", result.addonDelta);
	printMemoryMetrics(`catalog_${scenario}`, result.catalogDelta);
	console.log(JSON.stringify(result));
	if (holdMs > 0) {
		console.log(`READY pid=${process.pid}`);
		await Bun.sleep(holdMs);
	}
}

function median(values: number[]): number {
	return values.toSorted((left, right) => left - right)[Math.floor(values.length / 2)];
}

function medianSample(samples: MemorySample[]): MemorySample {
	const nullableMedian = (key: "pss" | "private" | "shared"): number | null => {
		const values = samples.map(sample => sample[key]).filter(value => value !== null);
		return values.length === samples.length ? median(values) : null;
	};
	return {
		rss: median(samples.map(sample => sample.rss)),
		heapUsed: median(samples.map(sample => sample.heapUsed)),
		external: median(samples.map(sample => sample.external)),
		pss: nullableMedian("pss"),
		private: nullableMedian("private"),
		shared: nullableMedian("shared"),
	};
}

function probeCommand(): string[] {
	const entry = Bun.main;
	return entry === process.execPath || entry.startsWith("/$bunfs/")
		? [process.execPath]
		: [process.execPath, entry];
}

async function runChild(scenario: Scenario, provider: string): Promise<ProbeResult> {
	const child = Bun.spawn([...probeCommand(), "--probe", scenario, "--provider", provider], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) throw new Error(`Probe ${scenario} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`);
	const jsonLine = stdout
		.split("\n")
		.find(line => line.startsWith('{"mode":"probe"'));
	if (jsonLine === undefined) throw new Error(`Probe ${scenario} emitted no JSON result: ${stdout.trim()}`);
	return JSON.parse(jsonLine) as ProbeResult;
}

async function runParent(runs: number, provider: string): Promise<void> {
	const scenarioResults = {} as Record<Scenario, ScenarioSummary>;
	for (const scenario of SCENARIOS) {
		const probes: ProbeResult[] = [];
		for (let run = 0; run < runs; run += 1) probes.push(await runChild(scenario, provider));
		const checksums = new Set(probes.map(probe => probe.checksum));
		if (checksums.size !== 1) throw new Error(`Probe ${scenario} produced inconsistent correctness checksums`);
		const representative = probes[Math.floor(probes.length / 2)];
		scenarioResults[scenario] = {
			checksum: representative.checksum,
			providers: representative.providers,
			models: representative.models,
			addonMedian: medianSample(probes.map(probe => probe.addonDelta)),
			catalogMedian: medianSample(probes.map(probe => probe.catalogDelta)),
			mapping: probes.find(probe => probe.mapping !== null)?.mapping ?? null,
		};
		printMemoryMetrics(`addon_${scenario}_median`, scenarioResults[scenario].addonMedian);
		printMemoryMetrics(`catalog_${scenario}_median`, scenarioResults[scenario].catalogMedian);
	}
	const result: ParentResult = { mode: "parent", runs, provider, scenarios: scenarioResults };
	console.log(JSON.stringify(result, null, 2));
}

const args = parseArguments(process.argv.slice(2));
if (args.probe === null) await runParent(args.runs, args.provider);
else await runProbe(args.probe, args.provider, args.holdMs);
