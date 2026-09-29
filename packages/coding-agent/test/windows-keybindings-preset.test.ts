import { afterEach, describe, expect, it } from "bun:test";
import { Editor, Input, setKeybindings } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { defaultEditorTheme } from "../../tui/test/test-themes";

const selectAll = "\x01";
const selectLeft = "\x1b[1;2D";
const ctrlC = "\x03";
const ctrlX = "\x18";
const ctrlV = "\x16";

function activate(preset: "default" | "windows", overrides = {}): KeybindingsManager {
	const bindings = KeybindingsManager.inMemory(overrides, preset);
	setKeybindings(bindings);
	return bindings;
}

afterEach(() => setKeybindings(KeybindingsManager.inMemory()));

describe("Windows editing preset", () => {
	it("is opt-in: Ctrl+A remains a line motion and Shift+Left does not select by default", () => {
		activate("default");
		const editor = new Editor(defaultEditorTheme);
		editor.setText("abc");
		editor.handleInput(selectLeft);
		expect(editor.getSelectedText()).toBeUndefined();
		editor.handleInput(selectAll);
		expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
		expect(editor.getSelectedText()).toBeUndefined();
	});

	it("selects, cuts, undoes and pastes through Windows chords without stealing suspend or image paste", () => {
		const bindings = activate("windows");
		const editor = new Editor(defaultEditorTheme);
		let clipboard = "";
		editor.onCopy = text => {
			clipboard = text;
		};
		editor.onPaste = () => editor.pasteText(clipboard);
		editor.setText("abc");
		editor.handleInput(selectAll);
		editor.handleInput(ctrlX);
		expect(clipboard).toBe("abc");
		expect(editor.getText()).toBe("");
		editor.handleInput("\x1a");
		expect(editor.getText()).toBe("abc");
		editor.handleInput(selectAll);
		editor.handleInput(ctrlV);
		expect(editor.getText()).toBe("abc");
		expect(bindings.matches("\x1a", "app.suspend")).toBe(false);
		expect(bindings.matches(ctrlV, "app.clipboard.pasteImage")).toBe(false);
	});

	it("honors a user override through preset flips while single-line Input adopts the selected mode", () => {
		const bindings = activate("windows", { "tui.editor.selectAll": "f9" });
		const input = new Input();
		input.setValue("abc");
		input.handleInput(selectAll);
		expect(input.getSelectedText()).toBeUndefined();
		input.handleInput("\x1b[20~");
		expect(input.getSelectedText()).toBe("abc");
		bindings.setPreset("default");
		input.setValue("abc");
		input.handleInput(selectLeft);
		expect(input.getSelectedText()).toBeUndefined();
		bindings.setPreset("windows");
		input.handleInput(selectLeft);
		expect(input.getSelectedText()).toBe("c");
		input.handleInput("\x1b[20~");
		expect(input.getSelectedText()).toBe("abc");
	});

	it("routes Ctrl+C to copying only when a selection exists", () => {
		activate("windows");
		const input = new Input();
		let cancelled = false;
		let copied = "";
		input.onEscape = () => {
			cancelled = true;
		};
		input.onCopy = text => {
			copied = text;
		};
		input.setValue("abc");
		input.handleInput(ctrlC);
		expect(cancelled).toBe(true);
		cancelled = false;
		input.handleInput(selectLeft);
		input.handleInput(ctrlC);
		expect(copied).toBe("c");
		expect(cancelled).toBe(false);
	});
});
