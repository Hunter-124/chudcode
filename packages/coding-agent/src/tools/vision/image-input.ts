import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { MAX_IMAGE_INPUT_BYTES } from "@oh-my-pi/pi-tui/chat/image-loading";
import { InternalUrlRouter } from "../../internal-urls/router";
import {
	type LoadedImageInput,
	loadImageAttachmentInput,
	loadImageInput,
	loadSvgImageInput,
} from "../../utils/image-loading";
import type { ToolSession } from "../index";
import { splitPathAndSelPreferringLiteral } from "../path-utils";

const ATTACHMENT_REFERENCE = /^\s*(?:\[?Image #([1-9]\d*)(?:,[^\]\n]*)?\]?|(?:attachment|image):\/\/([1-9]\d*))\s*$/i;

export interface LoadVisionImageOptions {
	session: ToolSession;
	path: string;
	autoResize?: boolean;
	excludeWebP?: boolean;
}

export type LoadVisionImageResult = { ok: true; image: LoadedImageInput } | { ok: false; reason: string; hint: string };

function attachmentIndex(input: string): number | undefined {
	const match = ATTACHMENT_REFERENCE.exec(input);
	const value = match?.[1] ?? match?.[2];
	return value ? Number(value) : undefined;
}

function internalResolutionContext(session: ToolSession, signal?: AbortSignal) {
	return {
		cwd: session.cwd,
		settings: session.settings,
		signal,
		sessionFile: session.getSessionFile?.() ?? undefined,
		localProtocolOptions: session.localProtocolOptions,
		skills: session.skills,
	};
}

/** Load filesystem, attachment, artifact://, or local:// images through the canonical image decoder. */
export async function loadVisionImage(options: LoadVisionImageOptions): Promise<LoadVisionImageResult> {
	try {
		const index = attachmentIndex(options.path);
		let image: LoadedImageInput | null;
		if (index !== undefined) {
			const attachment = options.session.getImageAttachments?.()[index - 1];
			if (!attachment) {
				return {
					ok: false,
					reason: "image_not_found",
					hint: `Image attachment #${index} is not available in this turn.`,
				};
			}
			image = await loadImageAttachmentInput({
				image: attachment.image,
				label: attachment.label,
				uri: attachment.uri,
				autoResize: options.autoResize ?? false,
				maxBytes: MAX_IMAGE_INPUT_BYTES,
				excludeWebP: options.excludeWebP,
			});
		} else if (options.path.startsWith("artifact://") || options.path.startsWith("local://")) {
			const target = await InternalUrlRouter.instance().target(
				options.path,
				internalResolutionContext(options.session),
			);
			if (target?.kind !== "file") {
				return {
					ok: false,
					reason: "image_not_found",
					hint: `${options.path} does not resolve to a regular file.`,
				};
			}
			const imageOptions = {
				path: target.path,
				resolvedPath: target.path,
				cwd: options.session.cwd,
				autoResize: options.autoResize ?? false,
				maxBytes: MAX_IMAGE_INPUT_BYTES,
				excludeWebP: options.excludeWebP,
			};
			image =
				target.sel?.toLowerCase() === "img"
					? await loadSvgImageInput(imageOptions)
					: await loadImageInput(imageOptions);
		} else {
			const target = await splitPathAndSelPreferringLiteral(options.path, options.session.cwd);
			const svg = target.sel?.toLowerCase() === "img";
			image = svg
				? await loadSvgImageInput({
						path: target.path,
						cwd: options.session.cwd,
						autoResize: options.autoResize ?? false,
						maxBytes: MAX_IMAGE_INPUT_BYTES,
						excludeWebP: options.excludeWebP,
					})
				: await loadImageInput({
						path: options.path,
						cwd: options.session.cwd,
						autoResize: options.autoResize ?? false,
						maxBytes: MAX_IMAGE_INPUT_BYTES,
						excludeWebP: options.excludeWebP,
					});
		}

		if (!image) {
			return {
				ok: false,
				reason: "unsupported_image",
				hint: "The input must be a PNG, JPEG, GIF, WEBP, or an SVG/SVGZ selected with :img.",
			};
		}
		return { ok: true, image };
	} catch (error) {
		return {
			ok: false,
			reason: "image_load_failed",
			hint: error instanceof Error ? error.message : String(error),
		};
	}
}

function extensionForMime(mimeType: string): string {
	switch (mimeType) {
		case "image/jpeg":
			return ".jpg";
		case "image/gif":
			return ".gif";
		case "image/webp":
			return ".webp";
		default:
			return ".png";
	}
}

export async function materializeLoadedImage(image: LoadedImageInput, label = "input"): Promise<string> {
	const filePath = path.join(
		os.tmpdir(),
		`chudcode-vision-${label}-${crypto.randomUUID()}${extensionForMime(image.mimeType)}`,
	);
	await fs.writeFile(filePath, Buffer.from(image.data, "base64"), { mode: 0o600 });
	return filePath;
}

export async function loadProcessedImage(
	filePath: string,
	options: { cwd: string; autoResize: boolean; excludeWebP?: boolean },
): Promise<LoadedImageInput | null> {
	return loadImageInput({
		path: filePath,
		resolvedPath: filePath,
		cwd: options.cwd,
		autoResize: options.autoResize,
		maxBytes: MAX_IMAGE_INPUT_BYTES,
		excludeWebP: options.excludeWebP,
	});
}

export function asImageContent(image: LoadedImageInput): ImageContent {
	return { type: "image", data: image.data, mimeType: image.mimeType };
}
