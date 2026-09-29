import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { type } from "@oh-my-pi/omptype";
import { resizeImage } from "../utils/image-resize";
import type { ToolSession } from "./index";
import { asImageContent, loadProcessedImage, loadVisionImage, materializeLoadedImage } from "./vision/image-input";
import { ensureVisionModels } from "./vision/models";
import { resolveVisionSidecar, runVision, type VisionResponse } from "./vision/sidecar";
import { cfgVisionAutoDownload, cfgVisionModelDir } from "./settings";

const imageAnalyzeSchema = type({
	action: type.enumerated("describe", "classify", "detect", "ocr", "redact", "crop", "locate", "diff"),
	path: type("string").describe("image file, internal URL, attachment URI, or SVG/SVGZ path selected with :img"),
	"path_b?": type("string").describe("second image for diff"),
	"query?": type("string").describe("case-insensitive OCR text query for locate"),
	"template?": type("string").describe("template image path for locate"),
	"bbox?": type(["number", "number", "number", "number"]).describe("crop rectangle [x,y,width,height]"),
	"redact?": type({
		faces: "boolean?",
		emails: "boolean?",
		phones: "boolean?",
		cards: "boolean?",
		keys: "boolean?",
		all_text: "boolean?",
		"+": "reject",
	}).describe("redaction switches; faces, emails, phones, cards, and keys default true"),
	"attach?": type
		.enumerated("none", "processed")
		.describe("attach processed output to the result; defaults to processed for redact, crop, and diff"),
	"max_results?": type("number").describe("maximum results returned per result family; default 25, maximum 100"),
	"+": "reject",
});

export type ImageAnalyzeParams = typeof imageAnalyzeSchema.infer;

export interface ImageAnalyzeToolDetails {
	action: ImageAnalyzeParams["action"];
	ok: boolean;
	out?: string;
}

function boundedMaxResults(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 25;
	return Math.max(1, Math.min(100, Math.trunc(value)));
}

function modelIdsFor(params: ImageAnalyzeParams): string[] {
	switch (params.action) {
		case "classify":
			return ["mobilenetv4"];
		case "detect":
			return ["dfine_n_coco", "yunet"];
		case "ocr":
			return ["ppocr_det", "ppocr_rec", "ppocr_dict"];
		case "describe":
			return ["mobilenetv4", "dfine_n_coco", "yunet", "ppocr_det", "ppocr_rec", "ppocr_dict"];
		case "crop":
			return params.bbox ? [] : ["dfine_n_coco"];
		case "locate":
			return params.query ? ["ppocr_det", "ppocr_rec", "ppocr_dict"] : [];
		case "redact": {
			const redaction = params.redact;
			const needsFaces = redaction?.faces !== false;
			const needsText =
				redaction?.all_text === true ||
				redaction?.emails !== false ||
				redaction?.phones !== false ||
				redaction?.cards !== false ||
				redaction?.keys !== false;
			return [...(needsFaces ? ["yunet"] : []), ...(needsText ? ["ppocr_det", "ppocr_rec", "ppocr_dict"] : [])];
		}
		case "diff":
			return [];
	}
}

function boundResponse(response: VisionResponse, limit: number): VisionResponse {
	if (!response.ok) return response;
	const bounded: Record<string, unknown> = { ...response };
	for (const key of ["labels", "objects", "faces", "text_regions", "redactions", "matches", "regions"]) {
		const value = bounded[key];
		if (Array.isArray(value)) bounded[key] = value.slice(0, limit);
	}
	const fullText = bounded.full_text;
	if (typeof fullText === "string" && fullText.length > 64 * 1024) {
		bounded.full_text = `${fullText.slice(0, 64 * 1024)}\n… [truncated]`;
	}
	return bounded as VisionResponse;
}

function failure(reason: string, hint: string): VisionResponse {
	return { ok: false, reason, hint };
}

export class ImageAnalyzeTool implements AgentTool<typeof imageAnalyzeSchema, ImageAnalyzeToolDetails> {
	readonly name = "image_analyze";
	readonly approval = "read" as const;
	readonly label = "ImageAnalyze";
	readonly loadMode = "discoverable";
	readonly summary = "Classical and learned image analysis";
	readonly description =
		"Analyze images with the optional native chud-vision sidecar: classify, detect objects/faces, OCR, redact PII, crop, locate text/templates, diff, or produce a composite description. Expected sidecar/model unavailability is returned as structured JSON.";
	readonly parameters = imageAnalyzeSchema;
	readonly strict = false;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: ImageAnalyzeParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ImageAnalyzeToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<ImageAnalyzeToolDetails>> {
		let response: VisionResponse | undefined;
		let outputPath: string | undefined;
		const temporaryInputs: string[] = [];
		try {
			if (params.action === "diff" && !params.path_b) {
				response = failure("path_b_required", "diff requires path_b for the comparison image.");
				return this.result(params.action, response);
			}
			if (params.action === "locate" && !params.query && !params.template) {
				response = failure("locate_query_required", "locate requires query, template, or both.");
				return this.result(params.action, response);
			}
			if (
				params.attach === "processed" &&
				params.action !== "redact" &&
				params.action !== "crop" &&
				params.action !== "diff"
			) {
				response = failure(
					"processed_output_unavailable",
					"attach='processed' is only available for redact, crop, and diff.",
				);
				return this.result(params.action, response);
			}
			if (
				params.action === "crop" &&
				params.bbox &&
				(params.bbox.some(value => !Number.isFinite(value)) || params.bbox[2] <= 0 || params.bbox[3] <= 0)
			) {
				response = failure("invalid_bbox", "bbox values must be finite and its width and height must be positive.");
				return this.result(params.action, response);
			}

			const resolution = await resolveVisionSidecar();
			if (!resolution.ok) return this.result(params.action, resolution);

			const primary = await loadVisionImage({ session: this.session, path: params.path });
			if (!primary.ok) return this.result(params.action, primary);
			const primaryPath = await materializeLoadedImage(primary.image, "primary");
			temporaryInputs.push(primaryPath);

			let secondPath: string | undefined;
			if (params.path_b) {
				const second = await loadVisionImage({ session: this.session, path: params.path_b });
				if (!second.ok) return this.result(params.action, second);
				secondPath = await materializeLoadedImage(second.image, "secondary");
				temporaryInputs.push(secondPath);
			}

			let templatePath: string | undefined;
			if (params.template) {
				const template = await loadVisionImage({ session: this.session, path: params.template });
				if (!template.ok) return this.result(params.action, template);
				templatePath = await materializeLoadedImage(template.image, "template");
				temporaryInputs.push(templatePath);
			}
			const modelDirSetting = cfgVisionModelDir.get(this.session);
			const autoDownloadSetting = cfgVisionAutoDownload.get(this.session);
			const models = await ensureVisionModels(modelIdsFor(params), {
				binaryPath: resolution.path,
				nativeDirs: resolution.nativeDirs,
				modelDir: typeof modelDirSetting === "string" ? modelDirSetting : undefined,
				autoDownload: autoDownloadSetting !== false,
				signal,
			});
			if (!models.ok) return this.result(params.action, models);

			const attach =
				params.attach ??
				(params.action === "redact" || params.action === "crop" || params.action === "diff" ? "processed" : "none");
			if (
				params.action === "redact" ||
				params.action === "crop" ||
				(params.action === "diff" && attach === "processed")
			) {
				outputPath = path.join(os.tmpdir(), `chudcode-vision-${params.action}-${crypto.randomUUID()}.png`);
			}
			const maxResults = boundedMaxResults(params.max_results);
			response = await runVision(
				{
					action: params.action,
					path: primaryPath,
					...(secondPath ? { path_b: secondPath } : {}),
					...(templatePath ? { template: templatePath } : {}),
					...(params.query ? { query: params.query } : {}),
					...(params.bbox ? { bbox: params.bbox } : params.action === "crop" ? { auto: true } : {}),
					...(params.redact ? { redact: params.redact } : {}),
					...(outputPath ? { out: outputPath } : {}),
					model_dir: models.modelDir,
					max_results: maxResults,
					top_k: maxResults,
				},
				{ binaryPath: resolution.path, modelDir: models.modelDir, signal },
			);
			response = boundResponse(response, maxResults);
			if (response.ok && outputPath) {
				const outputStat = await fs.stat(outputPath).catch(() => null);
				if (!outputStat?.isFile()) {
					response = failure(
						"processed_image_missing",
						"chud-vision reported success but did not create the requested output image.",
					);
				}
			}

			let attachment: ImageContent | undefined;
			if (response.ok && attach === "processed" && outputPath) {
				const processed = await loadProcessedImage(outputPath, { cwd: this.session.cwd, autoResize: false });
				if (!processed) {
					response = failure(
						"processed_image_invalid",
						"chud-vision did not produce a supported processed image.",
					);
				} else {
					const resized = await resizeImage(asImageContent(processed));
					attachment = { type: "image", data: resized.data, mimeType: resized.mimeType };
				}
			}
			return this.result(params.action, response, outputPath, attachment);
		} catch (error) {
			response = signal?.aborted
				? failure("aborted", "The image analysis request was cancelled.")
				: failure("image_analysis_failed", error instanceof Error ? error.message : String(error));
			return this.result(params.action, response, outputPath);
		} finally {
			for (const filePath of temporaryInputs) await fs.rm(filePath, { force: true }).catch(() => {});
			if (response && !response.ok && outputPath) await fs.rm(outputPath, { force: true }).catch(() => {});
		}
	}

	private result(
		action: ImageAnalyzeParams["action"],
		response: VisionResponse,
		out?: string,
		image?: ImageContent,
	): AgentToolResult<ImageAnalyzeToolDetails> {
		return {
			content: [{ type: "text", text: JSON.stringify(response, null, 2) }, ...(image ? [image] : [])],
			details: { action, ok: response.ok, ...(out && response.ok ? { out } : {}) },
		};
	}
}
