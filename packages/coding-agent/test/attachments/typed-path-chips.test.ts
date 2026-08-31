import { beforeAll, describe, expect, it } from "bun:test";
import { AttachmentChipsBand } from "@chudware/coding-agent/modes/components/attachment-chips";
import { CustomEditor, extractPastePathsFromText } from "@chudware/coding-agent/modes/components/custom-editor";
import { getEditorTheme, initTheme } from "@chudware/coding-agent/modes/theme/theme";
import { ImageBudget } from "@chudware/tui";

beforeAll(async () => {
	await initTheme(false);
});

describe("filesystem paste parsing", () => {
	it("keeps one unquoted absolute document or folder path with spaces intact", () => {
		expect(extractPastePathsFromText("/tmp/Quarterly Report/report.pdf")).toEqual([
			"/tmp/Quarterly Report/report.pdf",
		]);
		expect(extractPastePathsFromText("/tmp/Reference Material")).toEqual(["/tmp/Reference Material"]);
	});

	it("preserves explicit multi-path paste order", () => {
		expect(extractPastePathsFromText('"/tmp/one.pdf" "/tmp/two docs"')).toEqual(["/tmp/one.pdf", "/tmp/two docs"]);
	});

	it("routes an assembled bracketed document path through the async path callback", async () => {
		const editor = new CustomEditor(getEditorTheme());
		const received = Promise.withResolvers<string>();
		editor.onPastePath = pastedPath => received.resolve(pastedPath);

		editor.handleInput("\u001b[200~/tmp/reference.pdf\u001b[201~");

		expect(await received.promise).toBe("/tmp/reference.pdf");
		expect(editor.getText()).toBe("");
	});
});

describe("typed document and folder chips", () => {
	it("renders a removable document chip with a source hyperlink and read expansion", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.imageReferenceHyperlink = (label, index, links, renderLabel) => {
			const target = links?.[index - 1];
			return target ? `<${target}>${renderLabel(label)}</${target}>` : renderLabel(label);
		};
		const sourcePath = "/tmp/report.pdf";
		const sourceLink = "file:///tmp/report.pdf";
		const expansion = [
			"<document_attachment>",
			`path=${JSON.stringify(sourcePath)}`,
			"Attached by path. Use the read tool on this exact path.",
			"</document_attachment>",
		].join("\n");
		editor.insertPathAttachment(
			{
				kind: "document",
				title: "report.pdf",
				sourcePath,
				sourceLink,
				detail: "PDF · 42 B",
			},
			"Quarterly results preview",
			expansion,
		);

		expect(editor.composerChips()).toMatchObject([
			{
				kind: "document",
				n: 1,
				text: { path: { sourcePath, sourceLink } },
			},
		]);
		expect(editor.getExpandedText()).toBe(expansion);
		const token = editor.getText();
		expect(editor.decorateText(token, { line: 0, startCol: 0, endCol: token.length })).toContain(sourceLink);

		const band = new AttachmentChipsBand(editor, new ImageBudget(8), () => {});
		const rendered = band.render(80).map(Bun.stripANSI).join("\n");
		expect(rendered).toContain("report.pdf");
		expect(rendered).toContain("PDF");

		editor.setText("");
		expect(editor.composerChips()).toEqual([]);
		expect(editor.getExpandedText()).toBe("");
	});

	it("keeps monotonic identities after delete and re-paste while typing the replacement", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.insertPathAttachment(
			{
				kind: "document",
				title: "old.pdf",
				sourcePath: "/tmp/old.pdf",
				sourceLink: "file:///tmp/old.pdf",
				detail: "PDF",
			},
			"old preview",
			"old expansion",
		);
		editor.setText("");
		editor.insertPathAttachment(
			{
				kind: "folder",
				title: "sources",
				sourcePath: "/tmp/sources",
				sourceLink: "file:///tmp/sources",
				detail: "3 direct entries",
			},
			"3 direct entries\na.ts\nb.ts\nc.ts",
			"folder expansion",
		);

		expect(editor.pendingTexts.map(entry => entry.n)).toEqual([1, 2]);
		expect(editor.composerChips()).toMatchObject([{ kind: "folder", n: 2 }]);
		expect(editor.getExpandedText()).toBe("folder expansion");
		const band = new AttachmentChipsBand(editor, new ImageBudget(8), () => {});
		const rendered = band.render(80).map(Bun.stripANSI).join("\n");
		expect(rendered).toContain("sources");
		expect(rendered).toContain("3 direct");
	});
});
