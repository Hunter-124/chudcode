import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Editor, type EditorTheme, Input } from "@chudware/tui";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@chudware/tui/keybindings";
import { defaultEditorTheme } from "./test-themes";

const keys = {
	left: "\x1b[D",
	right: "\x1b[C",
	up: "\x1b[A",
	down: "\x1b[B",
	selectLeft: "\x1b[1;2D",
	selectRight: "\x1b[1;2C",
	selectUp: "\x1b[1;2A",
	selectDown: "\x1b[1;2B",
	selectWordLeft: "\x1b[1;6D",
	selectWordRight: "\x1b[1;6C",
	selectToLineStart: "\x1b[1;2H",
	selectToLineEnd: "\x1b[1;2F",
	selectAll: "\x01",
	copy: "\x03",
	cut: "\x18",
	paste: "\x16",
	undo: "\x15",
} as const;

function createEditor(theme: EditorTheme = defaultEditorTheme): Editor {
	return new Editor(theme);
}

describe("Editor selection", () => {
	beforeEach(() => {
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.editor.selectLeft": "shift+left",
				"tui.editor.selectRight": "shift+right",
				"tui.editor.selectUp": "shift+up",
				"tui.editor.selectDown": "shift+down",
				"tui.editor.selectWordLeft": "ctrl+shift+left",
				"tui.editor.selectWordRight": "ctrl+shift+right",
				"tui.editor.selectToLineStart": "shift+home",
				"tui.editor.selectToLineEnd": "shift+end",
				"tui.editor.selectAll": "ctrl+a",
				"tui.input.copy": "ctrl+c",
				"tui.editor.cut": "ctrl+x",
				"tui.editor.paste": "ctrl+v",
				"tui.editor.undo": "ctrl+u",
			}),
		);
	});

	afterEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});

	it("extends left and right by grapheme", () => {
		const editor = createEditor();
		editor.setText("abc");
		editor.handleInput(keys.selectLeft);
		expect(editor.getSelectedText()).toBe("c");
		editor.handleInput(keys.selectRight);
		expect(editor.getSelection()).toEqual({ anchor: { line: 0, col: 3 }, cursor: { line: 0, col: 3 } });
		expect(editor.getSelectedText()).toBeUndefined();
	});

	it("extends up and down across logical lines", () => {
		const up = createEditor();
		up.setText("ab\ncd");
		up.handleInput(keys.selectUp);
		expect(up.getSelectedText()).toBe("\ncd");

		const down = createEditor();
		down.setText("ab\ncd");
		down.handleInput(keys.up);
		down.handleInput(keys.selectDown);
		expect(down.getSelectedText()).toBe("\ncd");
	});

	it("extends by the editor's existing word boundaries in both directions", () => {
		const editor = createEditor();
		editor.setText("alpha beta gamma");
		editor.handleInput(keys.selectWordLeft);
		expect(editor.getSelectedText()).toBe("gamma");
		editor.handleInput(keys.selectWordLeft);
		expect(editor.getSelectedText()).toBe("beta gamma");
		editor.handleInput(keys.selectWordRight);
		expect(editor.getSelectedText()).toBe(" gamma");
	});

	it("extends to line boundaries", () => {
		const editor = createEditor();
		editor.setText("alpha beta");
		editor.handleInput(keys.left);
		editor.handleInput(keys.selectToLineStart);
		expect(editor.getSelectedText()).toBe("alpha bet");
		editor.handleInput(keys.selectToLineEnd);
		expect(editor.getSelectedText()).toBe("a");
	});

	it("selects the entire buffer and copies exact logical newlines", () => {
		const editor = createEditor();
		const copied: string[] = [];
		editor.onCopy = text => copied.push(text);
		editor.setText("first line\nsecond line\nthird");
		editor.handleInput(keys.selectAll);
		expect(editor.getSelectedText()).toBe("first line\nsecond line\nthird");
		editor.handleInput(keys.copy);
		expect(copied).toEqual(["first line\nsecond line\nthird"]);
	});

	it("copy with no selection is a harmless no-op", () => {
		const editor = createEditor();
		const copied: string[] = [];
		editor.onCopy = text => copied.push(text);
		editor.setText("draft");
		editor.handleInput(keys.copy);
		expect(copied).toEqual([]);
		expect(editor.getText()).toBe("draft");
	});

	it("cuts as one undo step", () => {
		const editor = createEditor();
		const copied: string[] = [];
		editor.onCopy = text => copied.push(text);
		editor.setText("keep me");
		editor.handleInput(keys.selectAll);
		editor.handleInput(keys.cut);
		expect(copied).toEqual(["keep me"]);
		expect(editor.getText()).toBe("");
		editor.handleInput(keys.undo);
		expect(editor.getText()).toBe("keep me");
		expect(editor.getSelection()).toBeUndefined();
		editor.handleInput(keys.undo);
		expect(editor.getText()).toBe("keep me");
	});

	it("paste replaces the active selection", () => {
		const editor = createEditor();
		editor.setText("before OLD after");
		for (let i = 0; i < 6; i++) editor.handleInput(keys.left);
		for (let i = 0; i < 3; i++) editor.handleInput(keys.selectLeft);
		editor.onPaste = () => editor.pasteText("NEW");
		editor.handleInput(keys.paste);
		expect(editor.getText()).toBe("before NEW after");
		expect(editor.getSelection()).toBeUndefined();
	});

	it("plain movement collapses selection", () => {
		const editor = createEditor();
		editor.setText("abcd");
		editor.handleInput(keys.selectLeft);
		editor.handleInput(keys.left);
		expect(editor.getSelection()).toBeUndefined();
		expect(editor.getSelectedText()).toBeUndefined();
	});

	it("typing replaces a multi-line selection", () => {
		const editor = createEditor();
		editor.setText("old\ntext");
		editor.handleInput(keys.selectAll);
		editor.handleInput("X");
		expect(editor.getText()).toBe("X");
		expect(editor.getSelection()).toBeUndefined();
	});

	it("selection crossing an image chip expands to the whole atom", () => {
		const editor = createEditor();
		editor.atomicTokenPattern = /\[Image #\d+\]/g;
		editor.setText("a[Image #1]b");
		editor.handleInput(keys.selectLeft);
		editor.handleInput(keys.selectLeft);
		expect(editor.getSelectedText()).toBe("[Image #1]b");
		editor.handleInput("X");
		expect(editor.getText()).toBe("aX");
		editor.handleInput(keys.undo);
		expect(editor.getText()).toBe("a[Image #1]b");
	});

	it("setText and undo never retain stale selection anchors", () => {
		const editor = createEditor();
		editor.setText("a much longer buffer");
		editor.handleInput(keys.selectAll);
		editor.setText("x");
		expect(editor.getSelection()).toBeUndefined();
		expect(() => editor.render(12)).not.toThrow();
		expect(editor.getText()).toBe("x");
	});

	it("visibly styles a selection across soft wraps and logical lines", () => {
		const hovered = (text: string): string => `\x1b[43m${text}\x1b[49m`;
		const theme: EditorTheme = {
			...defaultEditorTheme,
			selectList: { ...defaultEditorTheme.selectList, hovered },
		};
		const editor = createEditor(theme);
		editor.setBorderVisible(false);
		editor.setPaddingX(0);
		editor.setText("abcdefghij\nklmnop");
		editor.handleInput(keys.selectAll);
		const rendered = editor.render(5).join("\n");
		expect(rendered).toContain("\x1b[43m");
		expect(rendered.match(/\x1b\[43m/g)?.length).toBeGreaterThanOrEqual(3);
		expect(rendered).toContain("\x1b[43mabcde\x1b[49m");
		expect(rendered).toContain("\x1b[43mklmno\x1b[49m");
	});

	it("keeps selection styling visible on the software cursor cell", () => {
		const hovered = (text: string): string => `\x1b[43m${text}\x1b[49m`;
		const theme: EditorTheme = {
			...defaultEditorTheme,
			selectList: { ...defaultEditorTheme.selectList, hovered },
		};
		const editor = createEditor(theme);
		editor.focused = true;
		editor.setText("abc");
		editor.handleInput(keys.selectLeft);
		const rendered = editor.render(20).join("\n");
		expect(rendered).toContain("\x1b[7m\x1b[43mc\x1b[49m\x1b[0m");
	});

	it("applies the same selection clipboard contract to single-line Input", () => {
		const input = new Input();
		const copied: string[] = [];
		input.onCopy = text => copied.push(text);
		input.setValue("abc");
		input.handleInput(keys.selectLeft);
		expect(input.getSelection()).toEqual({ anchor: 3, cursor: 2 });
		input.handleInput(keys.copy);
		expect(copied).toEqual(["c"]);
		input.handleInput(keys.cut);
		expect(input.getValue()).toBe("ab");
		input.handleInput(keys.undo);
		expect(input.getValue()).toBe("abc");
		input.handleInput(keys.selectLeft);
		input.onPaste = () => input.pasteText("X");
		input.handleInput(keys.paste);
		expect(input.getValue()).toBe("aXc");
	});
});
