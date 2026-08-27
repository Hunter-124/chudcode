import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { FileChange } from "../src/protocol";
import { FileWatcher } from "../src/services/file-watcher";
import { checkIgnoredPaths, WorkspaceSearch } from "../src/services/workspace-search";
import { WorkspaceService, WorkspaceServiceError } from "../src/services/workspace-service";

let root: string;
let outside: string;
let workspace: WorkspaceService;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "chudcode-workspace-"));
	outside = await mkdtemp(path.join(tmpdir(), "chudcode-outside-"));
	workspace = await WorkspaceService.open(root, { maxReadBytes: 1024 });
});

afterEach(async () => {
	await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
});

function uri(relativePath: string): string {
	return pathToFileURL(path.join(root, relativePath)).href;
}

function flatten(batches: FileChange[][]): FileChange[] {
	return batches.flat();
}

describe("WorkspaceService", () => {
	test("canonicalizes a stable root identity and rejects lexical and symlink traversal", async () => {
		const reopened = await WorkspaceService.open(path.join(root, "."));
		expect(reopened.id).toBe(workspace.id);
		expect(reopened.rootPath).toBe(workspace.rootPath);

		await writeFile(path.join(outside, "secret.txt"), "do not disclose");
		await symlink(path.join(outside, "secret.txt"), path.join(root, "escape.txt"));

		await expect(workspace.read(uri("escape.txt"))).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
		await expect(workspace.read(path.join(root, "..", path.basename(outside), "secret.txt"))).rejects.toMatchObject({
			code: "PATH_OUTSIDE_WORKSPACE",
		});
	});

	test("performs atomic CAS writes without overwriting a conflicting external edit", async () => {
		await writeFile(path.join(root, "document.txt"), "initial");
		const snapshot = await workspace.read(uri("document.txt"));
		await writeFile(path.join(root, "document.txt"), "external edit");

		let conflict: unknown;
		try {
			await workspace.write(uri("document.txt"), "stale replacement", snapshot.stamp.sha256);
		} catch (error) {
			conflict = error;
		}
		expect(conflict).toBeInstanceOf(WorkspaceServiceError);
		expect(conflict).toMatchObject({ code: "CONFLICT" });
		expect(await Bun.file(path.join(root, "document.txt")).text()).toBe("external edit");
		expect((await Array.fromAsync(new Bun.Glob(".*.chudcode-*.tmp").scan({ cwd: root }))).length).toBe(0);
	});

	test("bounds text reads and explicitly rejects binary data", async () => {
		await writeFile(path.join(root, "large.txt"), "x".repeat(1025));
		await writeFile(path.join(root, "binary.dat"), Uint8Array.from([1, 0, 2]));
		await expect(workspace.read(uri("large.txt"))).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
		await expect(workspace.read(uri("binary.dat"))).rejects.toMatchObject({ code: "BINARY_FILE" });
	});

	test("provides create, stat, copy, rename, and permanent remove primitives", async () => {
		const created = await workspace.create(uri("one.txt"), { text: "one" });
		expect(created.stamp?.sha256).toHaveLength(64);
		expect((await workspace.stat(uri("one.txt"))).directory).toBe(false);

		await workspace.copy(uri("one.txt"), uri("two.txt"));
		const moved = await workspace.rename(uri("two.txt"), uri("moved.txt"));
		expect(moved.relativePath).toBe("moved.txt");
		expect(await workspace.remove(uri("moved.txt"), "permanent")).toBe(true);
		await expect(workspace.stat(uri("moved.txt"))).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
	});
});

describe("FileWatcher", () => {
	test("publishes one user change and suppresses only its matching filesystem generation", async () => {
		await writeFile(path.join(root, "owned.txt"), "before");
		const initial = await workspace.read(uri("owned.txt"));
		const batches: FileChange[][] = [];
		const watcher = new FileWatcher(workspace, changes => batches.push(changes), { coalesceMs: 0 });
		await watcher.captureBaseline();

		const stamp = await workspace.write(uri("owned.txt"), "after", initial.stamp.sha256, "user");
		await watcher.reconcileNow();
		watcher.flushNow();
		watcher.close();

		const changes = flatten(batches).filter(change => change.uri === uri("owned.txt"));
		expect(changes).toHaveLength(1);
		expect(changes[0]).toMatchObject({ kind: "modified", origin: "user", stamp: { generation: stamp.generation } });
	});

	test("classifies a dirty external edit as external", async () => {
		await writeFile(path.join(root, "dirty.txt"), "clean");
		const batches: FileChange[][] = [];
		const watcher = new FileWatcher(workspace, changes => batches.push(changes), { coalesceMs: 0 });
		await watcher.captureBaseline();
		await writeFile(path.join(root, "dirty.txt"), "externally dirty and longer");

		await watcher.reconcileNow();
		watcher.flushNow();
		watcher.close();
		expect(flatten(batches)).toContainEqual(
			expect.objectContaining({ kind: "modified", uri: uri("dirty.txt"), origin: "external" }),
		);
	});

	test("pairs an external rename and then reports deletion", async () => {
		await writeFile(path.join(root, "old.txt"), "content");
		const batches: FileChange[][] = [];
		const watcher = new FileWatcher(workspace, changes => batches.push(changes), { coalesceMs: 0 });
		await watcher.captureBaseline();
		await rename(path.join(root, "old.txt"), path.join(root, "new.txt"));
		await watcher.reconcileNow();
		watcher.flushNow();
		expect(flatten(batches)).toContainEqual(
			expect.objectContaining({ kind: "renamed", oldUri: uri("old.txt"), uri: uri("new.txt"), origin: "external" }),
		);

		batches.length = 0;
		await unlink(path.join(root, "new.txt"));
		await watcher.reconcileNow();
		watcher.flushNow();
		watcher.close();
		expect(flatten(batches)).toContainEqual(
			expect.objectContaining({ kind: "deleted", uri: uri("new.txt"), origin: "external" }),
		);
	});

	test("exposes watcher overflow as a rescan-required event", async () => {
		const batches: FileChange[][] = [];
		const watcher = new FileWatcher(workspace, changes => batches.push(changes), { coalesceMs: 0 });
		watcher.notifyOverflow();
		watcher.flushNow();
		watcher.close();
		expect(flatten(batches)).toEqual([{ kind: "rescan-required", uri: workspace.rootUri(), origin: "external" }]);
	});
});

describe("WorkspaceSearch", () => {
	test("excludes ignored files by default for filename and content searches", async () => {
		await Promise.all([mkdir(path.join(root, "ignored")), mkdir(path.join(root, "nested"))]);
		await writeFile(path.join(root, ".gitignore"), "ignored/\n*.tmp\n");
		await writeFile(path.join(root, "nested", ".gitignore"), "*.txt\n!keep.txt\n");
		await Promise.all([
			writeFile(path.join(root, "ignored", "secret.txt"), "needle hidden directory"),
			writeFile(path.join(root, "nested", "drop.txt"), "needle nested hidden"),
			writeFile(path.join(root, "nested", "keep.txt"), "needle nested visible"),
			writeFile(path.join(root, "discard.tmp"), "needle hidden extension"),
			writeFile(path.join(root, "visible.txt"), "needle visible"),
		]);
		const search = new WorkspaceSearch(workspace);

		const files = await search.search({ kind: "files", text: ".txt" });
		expect(files.map(result => result.preview).sort()).toEqual(["nested/keep.txt", "visible.txt"]);
		const filesIncludingIgnored = await search.search({ kind: "files", text: ".txt", includeIgnored: true });
		expect(filesIncludingIgnored.map(result => result.preview).sort()).toEqual(
			["ignored/secret.txt", "nested/drop.txt", "nested/keep.txt", "visible.txt"].sort(),
		);
		const content = await search.search({ kind: "content", text: "needle" });
		expect(content.map(result => result.uri).sort()).toEqual([uri("nested/keep.txt"), uri("visible.txt")].sort());
		const includingIgnored = await search.search({ kind: "content", text: "needle", includeIgnored: true });
		expect(includingIgnored.map(result => result.uri).sort()).toEqual(
			[
				uri("discard.tmp"),
				uri("ignored/secret.txt"),
				uri("nested/drop.txt"),
				uri("nested/keep.txt"),
				uri("visible.txt"),
			].sort(),
		);
	});

	test("classifies standalone-project ignores with the native fallback matcher", async () => {
		await Promise.all([mkdir(path.join(root, "ignored")), mkdir(path.join(root, "nested"))]);
		await writeFile(path.join(root, ".gitignore"), "ignored/\n*.tmp\n");
		await writeFile(path.join(root, "nested", ".gitignore"), "*.txt\n!keep.txt\n");
		await Promise.all([
			writeFile(path.join(root, "ignored", "secret.txt"), "hidden"),
			writeFile(path.join(root, "nested", "drop.txt"), "hidden"),
			writeFile(path.join(root, "nested", "keep.txt"), "visible"),
			writeFile(path.join(root, "discard.tmp"), "hidden"),
			writeFile(path.join(root, "visible.txt"), "visible"),
		]);

		const candidates = [
			"ignored",
			"ignored/secret.txt",
			"nested/drop.txt",
			"nested/keep.txt",
			"discard.tmp",
			"visible.txt",
		];
		expect([...(await checkIgnoredPaths(root, candidates))].sort()).toEqual(
			["discard.tmp", "ignored", "ignored/secret.txt", "nested/drop.txt"].sort(),
		);
	});

	test("bounds result count and supports cancellation", async () => {
		for (let index = 0; index < 8; index++)
			await writeFile(path.join(root, `match-${index}.txt`), `bounded ${index}`);
		const search = new WorkspaceSearch(workspace, { maxResults: 3, maxOutputBytes: 4096 });
		expect(await search.search({ kind: "files", text: "match", maxResults: 99 })).toHaveLength(3);
		expect(await search.search({ kind: "content", text: "bounded", maxResults: 2 })).toHaveLength(2);

		const controller = new AbortController();
		controller.abort();
		await expect(search.search({ kind: "files", text: "match" }, controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
	});
});
