import { afterEach, describe, expect, it } from "bun:test";
import { Editor } from "@oh-my-pi/pi-tui";
import { Input } from "@oh-my-pi/pi-tui/components/input";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@oh-my-pi/pi-tui/keybindings";
import { defaultEditorTheme } from "./test-themes";

const UNDO = "\x1b[45;5u"; // Ctrl+-
const REDO = "\x1b-"; // legacy ESC + printable Alt+-

describe("editor redo", () => {
	afterEach(() => setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS)));

	it("replays successive edits and their cursor positions in order", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.handleInput("first ");
		editor.handleInput("second");
		editor.handleInput(UNDO);
		expect(editor.getText()).toBe("first ");
		editor.handleInput(UNDO);
		expect(editor.getText()).toBe("");
		editor.handleInput(REDO);
		expect(editor.getText()).toBe("first ");
		editor.handleInput(REDO);
		expect(editor.getText()).toBe("first second");
		expect(editor.getCursor()).toEqual({ line: 0, col: 12 });
	});

	it("retains redo through no-op deletes but discards it after a fresh edit", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.handleInput("a");
		editor.handleInput(UNDO);
		editor.handleInput("\x7f"); // Backspace at empty buffer
		editor.handleInput(REDO);
		expect(editor.getText()).toBe("a");
		editor.handleInput(UNDO);
		editor.handleInput("b");
		editor.handleInput(REDO);
		expect(editor.getText()).toBe("b");
	});

	it("does not restore an uncommitted dictation preview", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.handleInput("a");
		editor.setVolatileText("preview");
		editor.handleInput(UNDO);
		editor.handleInput(REDO);
		expect(editor.getText()).toBe("a");
	});

	it("uses a custom redo chord instead of the default when remapped", () => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.editor.redo": "f8" }));
		const editor = new Editor(defaultEditorTheme);
		editor.handleInput("a");
		editor.handleInput(UNDO);
		editor.handleInput(REDO);
		expect(editor.getText()).toBe("");
		editor.handleInput("\x1b[19~"); // F8
		expect(editor.getText()).toBe("a");
	});
});

describe("single-line input redo", () => {
	it("recovers an accidental undo without restoring replaced field values", () => {
		const input = new Input();
		input.handleInput("first");
		input.handleInput(UNDO);
		input.handleInput(REDO);
		expect(input.getValue()).toBe("first");
		input.setValue("replacement");
		input.handleInput(UNDO);
		input.handleInput(REDO);
		expect(input.getValue()).toBe("replacement");
	});

	it("preserves redo when a pasted payload sanitizes to nothing", () => {
		const input = new Input();
		input.handleInput("a");
		input.handleInput(UNDO);
		input.handleInput("\x1b[200~\n\x1b[201~");
		input.handleInput(REDO);
		expect(input.getValue()).toBe("a");
	});
});
