import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { auditProjectArtifacts } from "../src/context-curation/artifact-audit";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
	const root = await fs.mkdtemp(path.join(tmpdir(), "context-artifact-audit-"));
	roots.push(root);
	await run(root, ["git", "init", "--quiet"]);
	await fs.mkdir(path.join(root, "docs"), { recursive: true });
	await fs.mkdir(path.join(root, ".omp/context/generated"), { recursive: true });
	await fs.writeFile(path.join(root, "docs/active.md"), "# Active plan\n\nCurrent work.\n");
	await fs.writeFile(path.join(root, "docs/superseded.md"), "# Old plan\n\nStatus: superseded\n");
	await fs.writeFile(path.join(root, "docs/duplicate-a.md"), "# Exact duplicate\n");
	await fs.writeFile(path.join(root, "docs/duplicate-b.md"), "# Exact duplicate\n");
	const managedBody = "\n# Generated terminal plan\n";
	const digest = createHash("sha256").update(managedBody).digest("hex");
	await fs.writeFile(
		path.join(root, ".omp/context/generated/terminal.md"),
		`<!-- omp-managed-artifact:v1 sha256:${digest} terminal:true -->${managedBody}`,
	);
	await run(root, ["git", "add", "docs"]);
	return root;
}

async function run(cwd: string, command: string[]): Promise<void> {
	const process = Bun.spawn(command, { cwd, stdout: "ignore", stderr: "pipe" });
	const [exitCode, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
	if (exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${stderr}`);
}

describe("project artifact audit", () => {
	it("separates deletion-grade managed evidence from review-only suggestions", async () => {
		const root = await fixture();

		const report = await auditProjectArtifacts({ root, now: () => new Date("2026-08-27T00:00:00Z") });
		const byPath = new Map(report.decisions.map(decision => [decision.path, decision]));

		expect(byPath.get(".omp/context/generated/terminal.md")).toMatchObject({
			action: "remove",
			confidence: 1,
			managed: true,
			terminal: true,
		});
		expect(byPath.get("docs/superseded.md")).toMatchObject({ action: "archive", confidence: 0.95 });
		expect(byPath.get("docs/duplicate-b.md")).toMatchObject({
			action: "deduplicate",
			confidence: 0.9,
			duplicateOf: "docs/duplicate-a.md",
		});
		expect(byPath.get("docs/active.md")).toMatchObject({ action: "keep" });
		expect(report.removed).toEqual([]);
	});

	it("applies only hash-matched unreferenced OMP-managed removals", async () => {
		const root = await fixture();

		const report = await auditProjectArtifacts({ root, apply: true });

		expect(report.removed).toEqual([".omp/context/generated/terminal.md"]);
		await expect(fs.access(path.join(root, ".omp/context/generated/terminal.md"))).rejects.toThrow();
		await expect(fs.access(path.join(root, "docs/superseded.md"))).resolves.toBeNull();
		await expect(fs.access(path.join(root, "docs/duplicate-b.md"))).resolves.toBeNull();
	});

	it("refuses automatic cleanup when managed content changed or is referenced", async () => {
		const root = await fixture();
		const managedPath = path.join(root, ".omp/context/generated/terminal.md");
		await fs.appendFile(managedPath, "tampered\n");
		await fs.writeFile(path.join(root, "docs/reference.md"), "See .omp/context/generated/terminal.md\n");
		await run(root, ["git", "add", "docs/reference.md"]);

		const report = await auditProjectArtifacts({ root, apply: true });
		const decision = report.decisions.find(item => item.path === ".omp/context/generated/terminal.md");

		expect(decision).toMatchObject({ action: "review", confidence: 0 });
		expect(decision?.referencedBy).toContain("docs/reference.md");
		expect(report.removed).toEqual([]);
		await expect(fs.access(managedPath)).resolves.toBeNull();
	});
});
