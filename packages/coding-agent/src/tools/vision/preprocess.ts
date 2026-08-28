import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { LoadedImageInput } from "../../utils/image-loading";
import { loadProcessedImage, materializeLoadedImage } from "./image-input";
import { ensureVisionModels } from "./models";
import { resolveVisionSidecar, runVision, type VisionFailure } from "./sidecar";

export type VisionPreprocessMode = "redact" | "crop" | "redact+crop";

export interface VisionPreprocessOptions {
	mode: VisionPreprocessMode;
	cwd: string;
	modelDir?: string;
	autoDownload?: boolean;
	autoResize: boolean;
	excludeWebP?: boolean;
	signal?: AbortSignal;
}

export type VisionPreprocessResult = { ok: true; image: LoadedImageInput } | VisionFailure;

/** Preprocess one already-loaded image while preserving structured degradation. */
export async function preprocessVisionImage(
	image: LoadedImageInput,
	options: VisionPreprocessOptions,
): Promise<VisionPreprocessResult> {
	const resolution = await resolveVisionSidecar();
	if (!resolution.ok) return resolution;

	let inputPath: string | undefined;
	const created: string[] = [];
	let currentPath: string | undefined;
	try {
		const modelIds =
			options.mode === "redact"
				? ["yunet", "ppocr_det", "ppocr_rec", "ppocr_dict"]
				: options.mode === "crop"
					? ["dfine_n_coco"]
					: ["yunet", "ppocr_det", "ppocr_rec", "ppocr_dict", "dfine_n_coco"];
		const models = await ensureVisionModels(modelIds, {
			binaryPath: resolution.path,
			nativeDirs: resolution.nativeDirs,
			modelDir: options.modelDir,
			autoDownload: options.autoDownload,
			signal: options.signal,
		});
		if (!models.ok) return models;

		inputPath = await materializeLoadedImage(image, "preprocess");
		currentPath = inputPath;
		for (const action of options.mode.split("+") as Array<"redact" | "crop">) {
			const out = path.join(os.tmpdir(), `chudcode-vision-${action}-${crypto.randomUUID()}.png`);
			created.push(out);
			const response = await runVision(
				{
					action,
					path: currentPath,
					out,
					model_dir: models.modelDir,
					...(action === "crop" ? { auto: true } : {}),
				},
				{
					binaryPath: resolution.path,
					modelDir: models.modelDir,
					signal: options.signal,
				},
			);
			if (!response.ok) return response;
			currentPath = out;
		}

		const processed = await loadProcessedImage(currentPath, {
			cwd: options.cwd,
			autoResize: options.autoResize,
			excludeWebP: options.excludeWebP,
		});
		if (!processed) {
			return {
				ok: false,
				reason: "processed_image_invalid",
				hint: "chud-vision completed but did not produce a supported image.",
			};
		}
		return { ok: true, image: processed };
	} catch (error) {
		if (options.signal?.aborted) return { ok: false, reason: "aborted", hint: "Image preprocessing was cancelled." };
		return {
			ok: false,
			reason: "preprocess_failed",
			hint: error instanceof Error ? error.message : String(error),
		};
	} finally {
		if (inputPath) await fs.rm(inputPath, { force: true }).catch(() => {});
		for (const filePath of created) await fs.rm(filePath, { force: true }).catch(() => {});
	}
}
