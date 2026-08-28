import { describe, expect, test } from "bun:test";
import type { DocumentSnapshot, FileChange, FileStamp } from "../src/protocol";
import type { DesktopClient } from "../src/web/desktop-client";
import {
	applyLocalEdit,
	firstChangedLine,
	isPromptLikeTarget,
	openDocumentState,
	resolveExternalDocument,
	saveEditorDocument,
} from "../src/web/editor/EditorWorkspace";
import { agentFileMotionClass, executeFileAction } from "../src/web/editor/FileTree";

const initialStamp: FileStamp = { sha256: "old-sha", size: 12, mtimeNs: 1, generation: 1 };
const savedStamp: FileStamp = { sha256: "saved-sha", size: 20, mtimeNs: 2, generation: 2 };

function document(text = "const value = 1;\n", stamp = initialStamp): DocumentSnapshot {
	return {
		id: "doc-1",
		uri: "file:///workspace/src/value.ts",
		language: "typescript",
		text,
		stamp,
		dirty: false,
		conflict: false,
	};
}

function mockClient(handler: (method: string, params: unknown) => unknown | Promise<unknown>) {
	return { request: handler } as unknown as DesktopClient;
}

describe("editor document lifecycle", () => {
	test("opens, edits, and saves with the read stamp as the CAS precondition", async () => {
		const requests: Array<{ method: string; params: unknown }> = [];
		const client = mockClient((method, params) => {
			requests.push({ method, params });
			return { stamp: savedStamp };
		});
		const opened = openDocumentState(document());
		const edited = applyLocalEdit(opened, "const value = 2;\n");
		expect(edited.dirty).toBe(true);

		const result = await saveEditorDocument(client, "workspace-1", edited, edited.text);
		expect(result.error).toBeUndefined();
		expect(result.state.dirty).toBe(false);
		expect(result.state.conflict).toBe(false);
		expect(result.state.snapshot.stamp).toEqual(savedStamp);
		expect(requests).toEqual([{
			method: "workspace.write",
			params: {
				workspaceId: "workspace-1",
				uri: "file:///workspace/src/value.ts",
				text: "const value = 2;\n",
				expectedSha256: "old-sha",
			},
		}]);
	});

	test("a failed CAS enters conflict without dropping the local buffer", async () => {
		const client = mockClient(() => Promise.reject(new Error("File changed since it was read")));
		const edited = applyLocalEdit(openDocumentState(document()), "local unsaved text\n");
		const result = await saveEditorDocument(client, "workspace-1", edited, edited.text);
		expect(result.error).toBeInstanceOf(Error);
		expect(result.state.conflict).toBe(true);
		expect(result.state.dirty).toBe(true);
		expect(result.state.text).toBe("local unsaved text\n");
	});

	test("dirty external edits never replace text, while clean edits reload and preserve view state", () => {
		const disk = document("const value = 3;\n", { ...savedStamp, sha256: "external-sha" });
		const dirty = applyLocalEdit(openDocumentState(document()), "local\n");
		const conflict = resolveExternalDocument(dirty, disk);
		expect(conflict.replaceModel).toBe(false);
		expect(conflict.state.conflict).toBe(true);
		expect(conflict.state.text).toBe("local\n");

		const viewState = { cursorState: [], viewState: {}, contributionsState: {} } as never;
		const clean = { ...openDocumentState(document("first\nsecond\n")), viewState };
		const reloaded = resolveExternalDocument(clean, document("first\nchanged\n", savedStamp));
		expect(reloaded.replaceModel).toBe(true);
		expect(reloaded.changedLine).toBe(2);
		expect(reloaded.state.text).toBe("first\nchanged\n");
		expect(reloaded.state.viewState).toBe(viewState);
	});

	test("tab dirty state clears when the buffer returns to its baseline", () => {
		const opened = openDocumentState(document("baseline"));
		expect(applyLocalEdit(opened, "changed").dirty).toBe(true);
		expect(applyLocalEdit(opened, "baseline").dirty).toBe(false);
		expect(firstChangedLine("same", "same")).toBeUndefined();
	});
});

describe("workspace file actions", () => {
	test("create, rename, copy, trash, and reveal call real desktop protocol methods", async () => {
		const requests: Array<{ method: string; params: unknown }> = [];
		const client = mockClient((method, params) => { requests.push({ method, params }); return {}; });
		await executeFileAction(client, "workspace-1", { kind: "create", uri: "file:///workspace/new.ts", directory: false });
		await executeFileAction(client, "workspace-1", { kind: "rename", from: "file:///workspace/new.ts", to: "file:///workspace/renamed.ts" });
		await executeFileAction(client, "workspace-1", { kind: "copy", from: "file:///workspace/renamed.ts", to: "file:///workspace/copy.ts", recursive: false });
		await executeFileAction(client, "workspace-1", { kind: "remove", uri: "file:///workspace/copy.ts" });
		await executeFileAction(client, "workspace-1", { kind: "reveal", uri: "file:///workspace/renamed.ts" });
		expect(requests.map(request => request.method)).toEqual([
			"workspace.create", "workspace.rename", "workspace.copy", "workspace.remove", "workspace.reveal",
		]);
		expect(requests[3]?.params).toEqual({ workspaceId: "workspace-1", uri: "file:///workspace/copy.ts", mode: "trash" });
	});
});

describe("focus and agent-change presentation", () => {
	test("prompt-like controls isolate editor shortcuts", () => {
		const input = { matches: (selector: string) => selector.includes("input") } as unknown as EventTarget;
		const editorCanvas = { matches: () => false } as unknown as EventTarget;
		expect(isPromptLikeTarget(input)).toBe(true);
		expect(isPromptLikeTarget(editorCanvas)).toBe(false);
		expect(isPromptLikeTarget(null)).toBe(false);
	});

	test("agent file changes receive shared motion classes while external changes do not", () => {
		const agentChange: FileChange = { kind: "modified", uri: "file:///workspace/src/value.ts", origin: "agent" };
		const externalChange: FileChange = { ...agentChange, origin: "external" };
		expect(agentFileMotionClass(agentChange)).toContain("motion-file-modified");
		expect(agentFileMotionClass(agentChange)).toContain("motion-file-recent");
		expect(agentFileMotionClass(externalChange)).toBe("");
	});

	test("editor highlights settle immediately under reduced motion", async () => {
		const css = await Bun.file(new URL("../src/web/editor/editor.css", import.meta.url)).text();
		expect(css).toContain("@media (prefers-reduced-motion: reduce)");
		expect(css).toContain(".agent-line-change");
		expect(css).toContain("animation: none");
		expect(css).toContain("transition: none");
	});
});
