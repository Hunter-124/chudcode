import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { setKeybindings } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme();
});
afterEach(() => setKeybindings(KeybindingsManager.inMemory()));

describe("Windows Ctrl+C safety", () => {
	it("copies a selected draft without invoking clear, then clears on Ctrl+C once selection is gone", () => {
		const bindings = KeybindingsManager.inMemory({}, "windows");
		setKeybindings(bindings);
		const editor = new CustomEditor(getEditorTheme());
		editor.setActionKeys("app.clear", bindings.getKeys("app.clear"));
		const copied: string[] = [];
		let clears = 0;
		editor.onCtrlC = () => {
			if (editor.hasSelection()) return false;
			clears++;
			editor.setText("");
			return true;
		};
		editor.onCopy = text => {
			copied.push(text);
		};
		editor.setText("do not delete this draft");
		editor.handleInput("\x1b[1;2D");
		editor.handleInput("\x03");
		expect(copied).toEqual(["t"]);
		expect(clears).toBe(0);
		expect(editor.getText()).toBe("do not delete this draft");
		editor.handleInput("\x1b[D");
		editor.handleInput("\x03");
		expect(clears).toBe(1);
		expect(editor.getText()).toBe("");
	});

	it("lets an in-progress hard abort win over copying a selected draft", () => {
		const bindings = KeybindingsManager.inMemory({}, "windows");
		setKeybindings(bindings);
		const editor = new CustomEditor(getEditorTheme());
		editor.setActionKeys("app.clear", bindings.getKeys("app.clear"));
		let aborted = false;
		let copied = false;
		editor.onCtrlC = () => {
			aborted = true;
			return true;
		};
		editor.onCopy = () => {
			copied = true;
		};
		editor.setText("important");
		editor.handleInput("\x01");
		editor.handleInput("\x03");
		expect(aborted).toBe(true);
		expect(copied).toBe(false);
		expect(editor.getText()).toBe("important");
	});

	it("keeps a legacy terminal Alt+K clear shortcut and accepts Ctrl+V as text paste", async () => {
		const bindings = KeybindingsManager.inMemory({}, "windows");
		setKeybindings(bindings);
		const editor = new CustomEditor(getEditorTheme());
		editor.setActionKeys("app.clear", bindings.getKeys("app.clear"));
		editor.setActionKeys("app.clipboard.pasteImage", bindings.getKeys("app.clipboard.pasteImage"));
		let cleared = false;
		let imagePasted = false;
		editor.onClear = () => {
			cleared = true;
		};
		editor.onPasteImage = async () => {
			imagePasted = true;
			return true;
		};
		editor.onPaste = () => editor.pasteText("replacement");
		editor.setText("original");
		editor.handleInput("\x01");
		editor.handleInput("\x16");
		expect(editor.getText()).toBe("replacement");
		expect(imagePasted).toBe(false);
		editor.handleInput("\x1bk");
		await Promise.resolve();
		expect(cleared).toBe(true);
	});

	it("holds submit behind an asynchronous clipboard read so the pasted selection is sent together", async () => {
		setKeybindings(KeybindingsManager.inMemory({}, "windows"));
		const editor = new CustomEditor(getEditorTheme());
		const clipboard = Promise.withResolvers<string>();
		const submitted: string[] = [];
		editor.onPaste = async () => editor.pasteText(await clipboard.promise);
		editor.onSubmit = value => {
			submitted.push(value);
		};
		editor.setText("old");
		editor.handleInput("\x01");
		editor.handleInput("\x16");
		editor.handleInput("\r");
		expect(submitted).toEqual([]);
		clipboard.resolve("new");
		await clipboard.promise;
		await Promise.resolve();
		await Promise.resolve();
		expect(submitted).toEqual(["new"]);
	});
});
