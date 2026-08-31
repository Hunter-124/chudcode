import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@chudware/agent-core";
import type { AssistantMessage, ImageContent } from "@chudware/ai";
import { KeybindingsManager } from "@chudware/coding-agent/config/keybindings";
import { CopySelectorComponent } from "@chudware/coding-agent/modes/components/copy-selector";
import { CustomEditor } from "@chudware/coding-agent/modes/components/custom-editor";
import { chipLabel } from "@chudware/coding-agent/modes/composer-attachments";
import { InputController } from "@chudware/coding-agent/modes/controllers/input-controller";
import { getEditorTheme, initTheme } from "@chudware/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@chudware/coding-agent/modes/types";
import { buildCopyTargets } from "@chudware/coding-agent/modes/utils/copy-targets";
import { setKeybindings } from "@chudware/tui";

beforeAll(async () => {
	await initTheme(false);
});

afterEach(() => {
	vi.restoreAllMocks();
	setKeybindings(KeybindingsManager.inMemory());
});

describe("recoverable composer clearing", () => {
	it("restores a draft after the configured Ctrl+C clear action", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setActionKeys("app.clear", ["ctrl+c"]);
		editor.onClear = () => editor.clearDraft();
		editor.setActionKeys("app.draft.restore", ["alt+z"]);
		editor.onRestoreDraft = () => {
			editor.restoreDraft();
		};
		editor.handleInput("A long draft that must not be lost");

		editor.handleInput("\x03");
		expect(editor.getText()).toBe("");

		editor.handleInput("\x1bz");
		expect(editor.getText()).toBe("A long draft that must not be lost");
	});

	it("restores image, link, and text-attachment state without losing atom expansion", () => {
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "aGVsbG8=" };
		const editor = new CustomEditor(getEditorTheme());
		editor.setDraft("Review [Image #1]", [image]);
		editor.pendingImageLinks = ["local://draft-image.png"];
		editor.imageLinks = editor.pendingImageLinks;
		editor.insertTextAttachment("two visible lines", "<attachment>\ntwo visible lines\n</attachment>");
		const text = editor.getText();
		const expanded = editor.getExpandedText();

		editor.clearDraft();
		expect(editor.pendingImages).toEqual([]);
		expect(editor.pendingImageLinks).toEqual([]);
		expect(editor.pendingTexts).toEqual([]);

		expect(editor.restoreDraft()).toBe(true);
		expect(editor.getText()).toBe(text);
		expect(editor.getExpandedText()).toBe(expanded);
		expect(editor.pendingImages).toEqual([image]);
		expect(editor.pendingImageLinks).toEqual(["local://draft-image.png"]);
		expect(editor.imageLinks).toEqual(["local://draft-image.png"]);
		expect(editor.pendingTexts).toEqual([
			{
				n: 1,
				label: chipLabel("paste", 1),
				content: "two visible lines",
				lineCount: 1,
				charCount: 17,
			},
		]);
		editor.insertTextAttachment("next");
		expect(editor.pendingTexts.at(-1)?.n).toBe(2);
	});
});

describe("Windows Ctrl+C routing", () => {
	it("is a harmless no-op with no selection instead of clearing the draft", () => {
		const keybindings = KeybindingsManager.inMemory({}, "windows");
		setKeybindings(keybindings);
		const editor = new CustomEditor(getEditorTheme());
		const clear = vi.fn(() => editor.clearDraft());
		editor.setActionKeys("app.clear", keybindings.getKeys("app.clear"));
		editor.onClear = clear;
		editor.handleInput("Keep this Windows draft");

		editor.handleInput("\x03");

		expect(clear).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("Keep this Windows draft");
	});

	it("dispatches the legacy-terminal clean-copy picker fallback", () => {
		const editor = new CustomEditor(getEditorTheme());
		const showPicker = vi.fn();
		editor.setActionKeys("app.copy.picker", ["alt+c"]);
		editor.onCopyPicker = showPicker;

		editor.handleInput("\x1bc");

		expect(showPicker).toHaveBeenCalledTimes(1);
	});

	it("wires the resolved restore and clean-copy actions through InputController", () => {
		const keybindings = KeybindingsManager.inMemory({}, "windows");
		setKeybindings(keybindings);
		const editor = new CustomEditor(getEditorTheme());
		const showCopySelector = vi.fn();
		const showStatus = vi.fn();
		const requestRender = vi.fn();
		const ctx = {
			editor,
			keybindings,
			session: { extensionRunner: undefined },
			ui: {
				addInputListener: vi.fn(),
				addStartListener: vi.fn(),
				getFocused: () => editor,
				hasOverlay: () => false,
				requestRender,
				terminal: { write: vi.fn() },
			},
			showCopySelector,
			showStatus,
			showWarning: vi.fn(),
			isBashMode: false,
			isPythonMode: false,
			updateEditorBorderColor: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();

		editor.handleInput("\x1bc");
		expect(showCopySelector).toHaveBeenCalledTimes(1);

		editor.setText("restore through app.draft.restore");
		editor.clearDraft();
		editor.handleInput("\x1bz");
		expect(editor.getText()).toBe("restore through app.draft.restore");
		expect(showStatus).toHaveBeenCalledWith("Restored cleared draft");
		expect(requestRender).toHaveBeenCalled();
	});
});

describe("Ctrl+C hard abort", () => {
	it("sync-flushes before preserving the raw-mode process.exit(130) escape hatch", () => {
		const flushSync = vi.fn();
		const ctx = {
			isShuttingDown: true,
			sessionManager: { flushSync },
		} as unknown as InteractiveModeContext;
		const controller = new InputController(ctx);
		let exitCode: number | string | null | undefined;
		vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			exitCode = code;
			throw new Error("process.exit");
		});

		expect(() => controller.handleCtrlC()).toThrow("process.exit");
		expect(flushSync).toHaveBeenCalledTimes(1);
		expect(exitCode).toBe(130);
	});
});

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("clean-copy targets", () => {
	it("copies source text instead of rendered picker borders and hard wraps", () => {
		const sourceText =
			"This assistant sentence is deliberately long enough to hard-wrap inside the clean-copy picker's narrow preview.";
		const message = assistantMessage(sourceText);
		const target = buildCopyTargets({
			messages: [message as unknown as AgentMessage],
			getLastVisibleHandoffText: () => undefined,
		})[0];
		expect(target).toBeDefined();
		if (!target) throw new Error("Expected assistant message copy target");

		const rendered = Bun.stripANSI(
			new CopySelectorComponent([target], { onPick: () => {}, onCancel: () => {} }).render(28).join("\n"),
		);
		expect(rendered).toContain("│");
		expect(rendered.split("\n").length).toBeGreaterThan(1);
		expect(target.content).toBe(sourceText);
		expect(target.content).not.toContain("│");
		expect(target.content).not.toContain("\n");
	});
});
