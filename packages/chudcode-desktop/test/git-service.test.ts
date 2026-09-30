import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUnifiedDiff } from "../src/services/git-diff";
import { GitGraphAdapter } from "../src/services/git-graph";
import { GitCommandError, GitService } from "../src/services/git-service";

const GIT = Bun.which("git")!;
let temporaryRoot = "";
let repositoryRoot = "";
let git: GitService;

async function directGit(
	cwd: string,
	args: readonly string[],
	accepted = [0],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const subprocess = Bun.spawn({ cmd: [GIT, ...args], cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(subprocess.stdout).text(),
		new Response(subprocess.stderr).text(),
		subprocess.exited,
	]);
	if (!accepted.includes(exitCode)) throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr}`);
	return { stdout, stderr, exitCode };
}

async function commitFile(path: string, content: string, message: string): Promise<void> {
	await writeFile(join(repositoryRoot, path), content);
	await git.stage([path]);
	await git.commit(message);
}

beforeEach(async () => {
	temporaryRoot = await mkdtemp(join(tmpdir(), "chudcode-git-service-"));
	repositoryRoot = join(temporaryRoot, "repo with spaces");
	git = await GitService.init(repositoryRoot);
	await directGit(repositoryRoot, ["config", "user.name", "Chudcode Test"]);
	await directGit(repositoryRoot, ["config", "user.email", "test@chudcode.invalid"]);
});

afterEach(async () => {
	await rm(temporaryRoot, { recursive: true, force: true });
});

describe("GitService", () => {
	test("discovers repositories and safely stages paths with spaces and leading dashes", async () => {
		const spaced = "space name.txt";
		const dashed = "-dash.txt";
		await writeFile(join(repositoryRoot, spaced), "space\n");
		await writeFile(join(repositoryRoot, dashed), "dash\n");

		const discovered = await GitService.discover(repositoryRoot);
		expect(discovered.root).toBe(repositoryRoot);
		let snapshot = await discovered.snapshot();
		expect(snapshot.files.map(file => file.path)).toEqual([dashed, spaced]);
		expect(snapshot.files.every(file => file.untracked)).toBe(true);

		snapshot = await discovered.stage([spaced, dashed]);
		expect(snapshot.files.map(file => [file.path, file.staged])).toEqual([
			[dashed, "added"],
			[spaced, "added"],
		]);
		snapshot = await discovered.unstage([spaced, dashed]);
		expect(snapshot.files.every(file => file.untracked && file.staged === "")).toBe(true);
		snapshot = await discovered.stage([]);
		expect(snapshot.files.every(file => file.staged === "added")).toBe(true);
		snapshot = await discovered.unstage([]);
		expect(snapshot.files.every(file => file.untracked)).toBe(true);
	});

	test("commits, lists branches/remotes, and builds stable parent graph", async () => {
		await commitFile("history.txt", "one\n", "first");
		const first = (await git.log(1))[0]!;
		await commitFile("history.txt", "two\n", "second");
		const commits = await git.log();
		expect(commits[0]!.parents).toEqual([first.hash]);
		expect(commits[0]!.refs.some(ref => ref.includes("main"))).toBe(true);

		await git.createBranch("topic/work");
		expect((await git.branches()).find(branch => branch.name === "topic/work")?.current).toBe(true);
		await directGit(repositoryRoot, ["remote", "add", "origin", repositoryRoot]);
		expect(await git.remotes()).toEqual([{ name: "origin", fetchUrl: repositoryRoot, pushUrl: repositoryRoot }]);
		await git.fetch("origin");
		expect((await git.branches()).some(branch => branch.remote && branch.name === "origin/main")).toBe(true);

		const graph = new GitGraphAdapter();
		const firstGraph = graph.snapshot(commits);
		const secondGraph = graph.snapshot(commits);
		expect(firstGraph.nodes[0]!.id).toBe(`git:${commits[0]!.hash}`);
		expect(firstGraph.edges[0]!.id).toBe(`git-parent:${commits[0]!.hash}:${first.hash}`);
		expect(secondGraph.revision).toBe(2);
		expect(secondGraph.nodes.every(node => node.state === "stable")).toBe(true);
		expect(secondGraph.nodes[0]!.meta).toMatchObject({ priorRevision: 1, currentRevision: 2 });
		expect(typeof secondGraph.nodes[0]!.meta?.changeIdentity).toBe("string");
	});

	test("parses unified hunks with stable IDs and old/new line numbers", () => {
		const unified = [
			'diff --git "a/space name.txt" "b/space name.txt"',
			"index 1111111..2222222 100644",
			'--- "a/space name.txt"',
			'+++ "b/space name.txt"',
			"@@ -1,3 +1,3 @@",
			" same",
			"-before",
			"+after",
			" last",
			"",
		].join("\n");
		const first = parseUnifiedDiff(unified);
		const second = parseUnifiedDiff(unified);
		expect(first).toEqual(second);
		expect(first.files[0]).toMatchObject({
			oldPath: "space name.txt",
			newPath: "space name.txt",
			status: "modified",
		});
		expect(first.files[0]!.hunks[0]!.lines.map(line => [line.kind, line.oldLine, line.newLine])).toEqual([
			["context", 1, 1],
			["deletion", 2, null],
			["addition", null, 2],
			["context", 3, 3],
		]);
	});

	test("stages, unstages, and reverts a selected hunk round-trip", async () => {
		const hunkPath = "-hunks with space.txt";
		const original = `${Array.from({ length: 24 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
		await commitFile(hunkPath, original, "hunk base");
		const changedLines = original.trimEnd().split("\n");
		changedLines[1] = "changed near start";
		changedLines[21] = "changed near end";
		const changed = `${changedLines.join("\n")}\n`;
		await writeFile(join(repositoryRoot, hunkPath), changed);

		let workingDiff = await git.parsedDiff(hunkPath);
		expect(workingDiff.files[0]!.hunks).toHaveLength(2);
		const firstHunk = workingDiff.files[0]!.hunks[0]!;
		await git.stageHunk(hunkPath, firstHunk.id);
		expect((await git.parsedDiff(hunkPath, true)).files[0]!.hunks).toHaveLength(1);
		expect((await git.parsedDiff(hunkPath)).files[0]!.hunks).toHaveLength(1);

		const stagedHunk = (await git.parsedDiff(hunkPath, true)).files[0]!.hunks[0]!;
		await git.unstageHunk(hunkPath, stagedHunk.id);
		workingDiff = await git.parsedDiff(hunkPath);
		expect(workingDiff.files[0]!.hunks).toHaveLength(2);

		const lastHunk = workingDiff.files[0]!.hunks[1]!;
		await git.revertHunk(hunkPath, lastHunk.id);
		expect(await readFile(join(repositoryRoot, hunkPath), "utf8")).toContain("line 22\n");
		expect((await git.parsedDiff(hunkPath)).files[0]!.hunks).toHaveLength(1);
	});

	test("reports conflicts and structured command errors", async () => {
		await commitFile("conflict.txt", "base\n", "base");
		await git.createBranch("side");
		await commitFile("conflict.txt", "side\n", "side change");
		await git.checkout("main");
		await commitFile("conflict.txt", "main\n", "main change");
		await directGit(repositoryRoot, ["merge", "side"], [0, 1]);

		const conflict = (await git.snapshot()).files.find(file => file.path === "conflict.txt");
		expect(conflict).toMatchObject({ staged: "unmerged", unstaged: "unmerged", untracked: false });

		try {
			await git.commit("conflicted");
			throw new Error("expected commit to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(GitCommandError);
			const failure = error as GitCommandError;
			expect(failure.code).toBe("GIT_COMMAND_FAILED");
			expect(failure.command[0]).toBe(GIT);
			expect(failure.stderrTail.length).toBeGreaterThan(0);
		}

		const cancellation = new AbortController();
		cancellation.abort();
		await expect(git.snapshot({ signal: cancellation.signal })).rejects.toMatchObject({ code: "GIT_CANCELLED" });
	});

	test("never shell-interprets path arguments", async () => {
		const hostile = "$(touch INJECTED); -hostile.txt";
		await writeFile(join(repositoryRoot, hostile), "literal\n");
		await git.stage([hostile]);
		expect((await git.snapshot()).files.find(file => file.path === hostile)?.staged).toBe("added");
		expect(await Bun.file(join(repositoryRoot, "INJECTED")).exists()).toBe(false);
	});
});
