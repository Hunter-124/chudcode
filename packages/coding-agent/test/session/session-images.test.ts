import { describe, expect, it } from "bun:test";
import { collectSessionImages } from "@oh-my-pi/pi-coding-agent/session/session-images";

describe("history image inventory", () => {
	it("numbers user and paired tool-result images in transcript encounter order", () => {
		const images = collectSessionImages([
			{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "first" }] },
			{ role: "assistant", content: [{ type: "toolCall", id: "call" }] },
			{
				role: "toolResult",
				toolCallId: "call",
				content: [{ type: "image", mimeType: "image/jpeg", data: "paired" }],
			},
			{
				role: "toolResult",
				toolCallId: "other",
				content: [{ type: "image", mimeType: "image/png", data: "orphan" }],
			},
		]);
		expect(images).toEqual([
			{ index: 1, role: "user", mimeType: "image/png", data: "first" },
			{ index: 2, role: "toolResult", mimeType: "image/jpeg", data: "paired" },
			{ index: 3, role: "toolResult", mimeType: "image/png", data: "orphan" },
		]);
	});
});
