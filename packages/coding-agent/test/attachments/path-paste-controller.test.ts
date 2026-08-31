import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CustomEditor } from "@chudware/coding-agent/modes/components/custom-editor";
import { InputController } from "@chudware/coding-agent/modes/controllers/input-controller";
import { getEditorTheme, initTheme } from "@chudware/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@chudware/coding-agent/modes/types";
import { CONVERTIBLE_EXTENSIONS } from "@chudware/coding-agent/utils/markit";

const temporaryRoots: string[] = [];

beforeAll(async () => {
	await initTheme(false);
});

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function createController(cwd: string) {
	const editor = new CustomEditor(getEditorTheme());
	const requestRender = vi.fn();
	const showStatus = vi.fn();
	const ctx = {
		editor,
		sessionManager: { getCwd: () => cwd },
		ui: { requestRender },
		showStatus,
	} as unknown as InteractiveModeContext;
	return { controller: new InputController(ctx), editor, requestRender, showStatus };
}

describe("markit paste classification", () => {
	it("routes every converter-backed document extension and rejects legacy binaries", () => {
		for (const extension of [".pdf", ".docx", ".pptx", ".xlsx", ".epub"]) {
			expect(CONVERTIBLE_EXTENSIONS.has(extension)).toBe(true);
		}
		expect(CONVERTIBLE_EXTENSIONS.has(".doc")).toBe(false);
		expect(CONVERTIBLE_EXTENSIONS.has(".txt")).toBe(false);
	});
});

describe("InputController.handlePathPaste", () => {
	it("attaches a folder by path with bounded, non-recursive direct-entry metadata", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "chudcode-folder-attachment-"));
		temporaryRoots.push(root);
		const folder = path.join(root, "Reference Material.png");
		await mkdir(path.join(folder, "nested"), { recursive: true });
		await writeFile(path.join(folder, "nested", "must-not-be-ingested.txt"), "private recursive contents");
		for (let i = 0; i < 10; i++) await writeFile(path.join(folder, `file-${i}.txt`), String(i));
		const { controller, editor, requestRender, showStatus } = createController(root);

		await controller.handlePathPaste(folder);

		expect(showStatus).not.toHaveBeenCalled();
		expect(requestRender).toHaveBeenCalledTimes(1);
		expect(editor.composerChips()).toMatchObject([
			{
				kind: "folder",
				n: 1,
				text: {
					path: { kind: "folder", sourcePath: folder },
				},
			},
		]);
		const expansion = editor.getExpandedText();
		expect(expansion).toContain(`path=${JSON.stringify(folder)}`);
		expect(expansion).toContain("bounded and non-recursive");
		expect(expansion).not.toContain("private recursive contents");
		expect(editor.pendingTexts[0]?.content.split("\n").length).toBeLessThanOrEqual(4);
	});

	it("converts a registered document only for preview and submits an exact read reference", async () => {
		const fixture = path.resolve(
			import.meta.dir,
			"../fixtures/pdf-inline-image-repro/bad-inline-image-delimiter.pdf",
		);
		const { controller, editor, requestRender, showStatus } = createController(path.dirname(fixture));

		await controller.handlePathPaste(fixture);

		expect(showStatus).not.toHaveBeenCalled();
		expect(requestRender).toHaveBeenCalledTimes(1);
		expect(editor.composerChips()).toMatchObject([
			{
				kind: "document",
				text: { path: { kind: "document", sourcePath: fixture } },
			},
		]);
		const expansion = editor.getExpandedText();
		expect(expansion).toContain(`path=${JSON.stringify(fixture)}`);
		expect(expansion).toContain("Use the read tool on this exact path");
		expect(editor.pendingTexts[0]?.content.length).toBeLessThanOrEqual(320);
	});

	it("surfaces unsupported and missing paths without degrading them to plaintext", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "chudcode-invalid-attachment-"));
		temporaryRoots.push(root);
		const unsupported = path.join(root, "legacy.doc");
		await writeFile(unsupported, "not a supported binary document");
		const missing = path.join(root, "missing.pdf");
		const { controller, editor, requestRender, showStatus } = createController(root);

		await controller.handlePathPaste(unsupported);
		await controller.handlePathPaste(missing);

		expect(editor.getText()).toBe("");
		expect(editor.pendingTexts).toEqual([]);
		expect(requestRender).not.toHaveBeenCalled();
		expect(showStatus.mock.calls.map(call => String(call[0]))).toEqual([
			expect.stringContaining("Unsupported attachment format .doc"),
			expect.stringContaining("Attachment path not found"),
		]);
	});

	it("routes Finder document URLs before their generated icon bitmap", async () => {
		const editor = new CustomEditor(getEditorTheme());
		const readImage = vi.fn(async () => ({ data: Buffer.from("finder icon"), mimeType: "image/png" }));
		const ctx = {
			editor,
			ui: { getFocused: () => null, requestRender: vi.fn() },
			showStatus: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new InputController(ctx, {
			readMacFileUrls: async () => ["file:///tmp/reference.pdf"],
			readImage,
			readText: async () => "",
		});
		const handlePathPaste = vi.spyOn(controller, "handlePathPaste").mockResolvedValue(undefined);

		expect(await controller.handleImagePaste()).toBe(true);
		expect(handlePathPaste).toHaveBeenCalledWith("/tmp/reference.pdf");
		expect(readImage).not.toHaveBeenCalled();
	});

	it("routes explicit clipboard-text folders through path handling instead of plaintext paste", async () => {
		const editor = new CustomEditor(getEditorTheme());
		const pasteText = vi.spyOn(editor, "pasteText");
		const ctx = {
			editor,
			ui: { getFocused: () => null, requestRender: vi.fn() },
			showStatus: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new InputController(ctx, {
			readMacFileUrls: async () => [],
			readImage: async () => null,
			readText: async () => "/tmp/Reference Material",
		});
		const handlePathPaste = vi.spyOn(controller, "handlePathPaste").mockResolvedValue(undefined);

		expect(await controller.handleImagePaste()).toBe(true);
		expect(handlePathPaste).toHaveBeenCalledWith("/tmp/Reference Material");
		expect(pasteText).not.toHaveBeenCalled();
	});
});
