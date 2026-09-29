import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ImageAnalyzeTool } from "@oh-my-pi/pi-coding-agent/tools/image-analyze";
import { ensureVisionModels } from "@oh-my-pi/pi-coding-agent/tools/vision/models";
import { runVision } from "@oh-my-pi/pi-coding-agent/tools/vision/sidecar";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "chudcode-vision-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("vision sidecar shim", () => {
	it.skipIf(process.platform === "win32")("finds ONNX Runtime beside a symlinked sidecar's real path", async () => {
		const root = await temporaryDirectory();
		const bundle = path.join(root, "bundle");
		const bin = path.join(root, "bin");
		await fs.mkdir(bundle);
		await fs.mkdir(bin);
		await fs.writeFile(path.join(bundle, "libonnxruntime.so"), "test runtime");
		const sidecar = path.join(bundle, "chud-vision");
		await fs.writeFile(
			sidecar,
			'#!/bin/sh\nIFS= read -r request\nprintf \'{"ok":true,"ort":"%s"}\\n\' "$ORT_DYLIB_PATH"\n',
			{ mode: 0o700 },
		);
		const linked = path.join(bin, "chud-vision");
		await fs.symlink(sidecar, linked);

		const response = await runVision({ action: "diff" }, { binaryPath: linked });
		expect(response).toEqual({ ok: true, ort: path.join(bundle, "libonnxruntime.so") });
	});

	it.skipIf(process.platform === "win32")(
		"returns a precise offline provisioning hint for a missing model",
		async () => {
			const root = await temporaryDirectory();
			const sidecar = path.join(root, "chud-vision");
			const sha = "a".repeat(64);
			await fs.writeFile(
				sidecar,
				`#!/bin/sh\nprintf '%s\\n' '[{"id":"test","filename":"test.onnx","sha256":"${sha}","url":"https://example.invalid/test.onnx","bytes":4}]'\n`,
				{ mode: 0o700 },
			);
			const result = await ensureVisionModels(["test"], {
				binaryPath: sidecar,
				modelDir: path.join(root, "models"),
				autoDownload: false,
			});
			expect(result).toMatchObject({ ok: false, reason: "model_missing" });
			if (!result.ok) expect(result.hint).toContain("vision.autoDownload=true");
		},
	);

	it("reports a configured missing sidecar without touching the input image", async () => {
		const root = await temporaryDirectory();
		const previous = process.env.CHUDCODE_VISION_BIN;
		process.env.CHUDCODE_VISION_BIN = path.join(root, "missing-chud-vision");
		try {
			const session = { cwd: root, settings: Settings.isolated() } as ToolSession;
			const result = await new ImageAnalyzeTool(session).execute("missing", {
				action: "describe",
				path: path.join(root, "also-missing.png"),
			});
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(JSON.parse(text)).toMatchObject({ ok: false, reason: "sidecar_missing" });
		} finally {
			if (previous === undefined) delete process.env.CHUDCODE_VISION_BIN;
			else process.env.CHUDCODE_VISION_BIN = previous;
		}
	});
});
