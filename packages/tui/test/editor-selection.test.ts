import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Editor, Input } from "@oh-my-pi/pi-tui";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@oh-my-pi/pi-tui/keybindings";
import { defaultEditorTheme } from "./test-themes";

const keys = {
	left: "\x1b[D",
	selectLeft: "\x1b[1;2D",
	copy: "\x03",
	selectAll: "\x01",
	cut: "\x18",
	paste: "\x16",
	undo: "\x15",
} as const;

beforeEach(() => {
	setKeybindings(
		new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.editor.selectLeft": "shift+left",
			"tui.editor.selectRight": "shift+right",
			"tui.editor.selectUp": "shift+up",
			"tui.editor.selectWordLeft": "ctrl+shift+left",
			"tui.editor.selectToLineStart": "shift+home",
			"tui.editor.selectAll": "ctrl+a",
			"tui.input.copy": "ctrl+c",
			"tui.editor.cut": "ctrl+x",
			"tui.editor.paste": "ctrl+v",
			"tui.editor.undo": "ctrl+u",
		}),
	);
});

afterEach(() => {
	Input.setClipboardHooks(undefined);
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
});

describe("Editor text selection", () => {
	it("selects whole grapheme and replaces text spanning logical lines as one undo step", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("alpha\nbeta 👨‍👩‍👧");
		editor.handleInput(keys.selectLeft);
		expect(editor.getSelectedText()).toBe("👨‍👩‍👧");
		editor.handleInput(keys.selectAll);
		expect(editor.getSelectedText()).toBe("alpha\nbeta 👨‍👩‍👧");
		editor.handleInput("X");
		expect(editor.getText()).toBe("X");
		editor.handleInput(keys.undo);
		expect(editor.getText()).toBe("alpha\nbeta 👨‍👩‍👧");
		expect(editor.getSelection()).toBeUndefined();
	});

	it("copies and cuts exact multiline selection, and paste replaces selection", () => {
		const editor = new Editor(defaultEditorTheme);
		const clipboard: string[] = [];
		editor.onCopy = text => {
			clipboard.push(text);
		};
		editor.onPaste = () => editor.pasteText("NEW");
		editor.setText("alpha\nbeta");
		editor.handleInput(keys.selectAll);
		editor.handleInput(keys.copy);
		expect(clipboard).toEqual(["alpha\nbeta"]);
		expect(editor.getText()).toBe("alpha\nbeta");
		editor.handleInput(keys.cut);
		expect(editor.getText()).toBe("");
		editor.handleInput(keys.undo);
		expect(editor.getText()).toBe("alpha\nbeta");
		editor.handleInput(keys.selectAll);
		editor.handleInput(keys.paste);
		expect(editor.getText()).toBe("NEW");
	});

	it("expands selected image tokens atomically and clears selection on ordinary movement", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.atomicTokenPattern = /\[Image #\d+\]/g;
		editor.setText("a[Image #1]b");
		editor.handleInput(keys.selectLeft);
		editor.handleInput(keys.selectLeft);
		expect(editor.getSelectedText()).toBe("[Image #1]b");
		editor.handleInput(keys.left);
		expect(editor.getSelectedText()).toBeUndefined();
		editor.handleInput(keys.selectAll);
		editor.handleInput("X");
		expect(editor.getText()).toBe("X");
	});

	it("shows selection across wrapped rows and exposes native anchor", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setBorderVisible(false);
		editor.setPaddingX(0);
		editor.setText("abcdefghij\nklmnop");
		editor.handleInput(keys.selectAll);
		const painted = editor.render(5).join("\n");
		expect(painted).toContain("\x1b[7mabcde\x1b[27m");
		expect(painted).toContain("\x1b[7mklmno\x1b[27m");
		expect(editor.getSelection()).toEqual({ anchor: { line: 0, col: 0 }, cursor: { line: 1, col: 6 } });
	});
});

describe("single-line Input selection", () => {
	it("copies and cuts selected text without cancelling the focused prompt", () => {
		const input = new Input();
		const copied: string[] = [];
		let cancelled = false;
		input.onCopy = text => {
			copied.push(text);
		};
		input.onEscape = () => {
			cancelled = true;
		};
		input.setValue("abc");
		input.handleInput(keys.selectLeft);
		input.handleInput(keys.copy);
		expect(copied).toEqual(["c"]);
		expect(cancelled).toBe(false);
		input.handleInput(keys.cut);
		expect(input.getValue()).toBe("ab");
		input.handleInput(keys.undo);
		expect(input.getValue()).toBe("abc");
	});

	it("replaces an active grapheme selection with paste and highlights visible selection", () => {
		const input = new Input();
		input.setValue("a👨‍👩‍👧z");
		input.handleInput(keys.left);
		input.handleInput(keys.selectLeft);
		expect(input.getSelectedText()).toBe("👨‍👩‍👧");
		expect(input.render(30)[0]).toContain("\x1b[7m👨‍👩‍👧\x1b[27m");
		input.onPaste = () => input.pasteText("NEW");
		input.handleInput(keys.paste);
		expect(input.getValue()).toBe("aNEWz");
		expect(input.getSelectedText()).toBeUndefined();
	});

	it("uses the host clipboard for an overlay Input, but never cuts if copying fails", async () => {
		const input = new Input();
		let clipboard = "";
		Input.setClipboardHooks({
			copy: text => {
				clipboard = text;
			},
			readText: async () => clipboard,
		});
		input.setValue("abc");
		input.handleInput(keys.selectAll);
		input.handleInput(keys.cut);
		expect(input.getValue()).toBe("");
		expect(clipboard).toBe("abc");
		input.handleInput(keys.paste);
		await Promise.resolve();
		expect(input.getValue()).toBe("abc");
		Input.setClipboardHooks({
			copy: () => false,
			readText: async () => "",
		});
		input.handleInput(keys.selectAll);
		input.handleInput(keys.cut);
		expect(input.getValue()).toBe("abc");
	});

	it("never copies or cuts masked input secrets", () => {
		const input = new Input();
		input.mask = true;
		const copied: string[] = [];
		Input.setClipboardHooks({
			copy: text => {
				copied.push(text);
			},
			readText: async () => undefined,
		});
		input.setValue("private-token");
		input.handleInput(keys.selectAll);
		input.handleInput(keys.copy);
		input.handleInput(keys.cut);
		expect(copied).toEqual([]);
		expect(input.getValue()).toBe("private-token");
	});
});
