import { describe, expect, test } from "bun:test";
import { type ShakeWireMessage, shakeWireMessages } from "@oh-my-pi/pi-agent-core/compaction";

function fence(label: string, lines = 260): string {
	return `\`\`\`${label}\n${`${label} payload alpha beta gamma delta epsilon\n`.repeat(lines)}\`\`\``;
}

function toolResult(id: string, name: string, content: string): ShakeWireMessage {
	return {
		role: "tool",
		tool_call_id: id,
		tool_name: name,
		is_error: false,
		content,
	};
}

describe("shakeWireMessages", () => {
	test("empty input is a deep-equal copy with the stable empty notice", () => {
		const input: ShakeWireMessage[] = [];
		const result = shakeWireMessages({ messages: input });

		expect(result).toEqual({
			messages: [],
			savedTokens: 0,
			regions: [],
			placeholders: 0,
			notice: "nothing to shake",
		});
		expect(result.messages).not.toBe(input);
	});

	test("auto mode leaves a below-min-savings candidate unchanged and never aliases input", () => {
		const input: ShakeWireMessage[] = [
			{
				...toolResult("small", "measure", "small result ".repeat(50)),
				metadata: { nested: ["preserve", { value: 7 }] },
			},
			{ role: "user", content: `recent ${"tail ".repeat(16_000)}` },
		];
		const before = structuredClone(input);
		const result = shakeWireMessages({ messages: input });

		expect(result.messages).toEqual(before);
		expect(result.messages).not.toBe(input);
		expect(result.messages[0]).not.toBe(input[0]);
		expect(result.messages[0].metadata).not.toBe(input[0].metadata);
		expect(result.savedTokens).toBe(0);
		expect(result.regions).toEqual([]);
		expect(result.notice).toContain("minSavings not met");
		result.messages[0].metadata = { changed: true };
		expect(input).toEqual(before);
	});

	test("aggressive mode replaces a snake-case tool result without a fake recovery URL", () => {
		const body = "measured output alpha beta gamma ".repeat(1_000);
		const input: ShakeWireMessage[] = [
			{
				...toolResult("measure-1", "measure_part", body),
				provider_metadata: { trace: "keep" },
			},
		];
		const before = structuredClone(input);
		const result = shakeWireMessages({ messages: input, aggressive: true });

		expect(input).toEqual(before);
		expect(result.placeholders).toBe(1);
		expect(result.regions).toHaveLength(1);
		expect(result.regions[0]).toMatchObject({
			kind: "toolResult",
			message_index: 0,
			original_text: body,
			label: "measure_part",
			region_index: 1,
		});
		expect(result.regions[0].placeholder).toBe(`[shaken ~${result.regions[0].tokens} tokens]`);
		expect(result.regions[0].placeholder).not.toContain("artifact://");
		expect(result.messages[0]).toMatchObject({
			role: "tool",
			tool_call_id: "measure-1",
			tool_name: "measure_part",
			is_error: false,
			content: result.regions[0].placeholder,
			pruned_at: true,
			provider_metadata: { trace: "keep" },
		});
		expect(result.messages[0].prunedAt).toBeUndefined();
		expect(result.savedTokens).toBe(Math.max(0, result.regions[0].tokens - 16));
	});

	test("camel-only pruning style stays camel-case", () => {
		const input: ShakeWireMessage[] = [
			{
				role: "toolResult",
				toolCallId: "camel-1",
				toolName: "measure",
				isError: false,
				prunedAt: null,
				content: "camel payload ".repeat(200),
			},
		];
		const result = shakeWireMessages({ messages: input, aggressive: true });

		expect(result.placeholders).toBe(1);
		expect(result.messages[0].prunedAt).toBe(true);
		expect(result.messages[0].pruned_at).toBeUndefined();
		expect(input[0].prunedAt).toBeNull();
	});

	test("skill tools and paired OpenAI read(skill://...) results stay protected", () => {
		const input: ShakeWireMessage[] = [
			{
				role: "assistant",
				content: [],
				tool_calls: [
					{
						id: "read-skill",
						type: "function",
						function: { name: "read", arguments: JSON.stringify({ path: "skill://edit-part" }) },
					},
				],
			},
			{
				role: "tool",
				tool_call_id: "read-skill",
				content: "skill document ".repeat(1_000),
			},
			toolResult("direct-skill", "skill", "direct skill output ".repeat(1_000)),
		];
		const result = shakeWireMessages({ messages: input, aggressive: true });

		expect(result.placeholders).toBe(0);
		expect(result.messages).toEqual(input);
		expect(result.messages).not.toBe(input);
	});

	test("a fenced block in string content preserves head, tail, role, and unknown fields", () => {
		const block = fence("typescript");
		const input: ShakeWireMessage[] = [
			{
				role: "custom-planner",
				content: `HEAD\n${block}\nTAIL`,
				custom_meta: { source: "wire", flags: [1, 2, 3] },
			},
		];
		const result = shakeWireMessages({ messages: input, aggressive: true });

		expect(result.placeholders).toBe(1);
		expect(result.regions[0]).toMatchObject({
			kind: "block",
			message_index: 0,
			block_index: -1,
			original_text: block,
			label: "custom-planner",
		});
		expect(result.messages[0]).toMatchObject({
			role: "custom-planner",
			content: `HEAD\n${result.regions[0].placeholder}\nTAIL`,
			custom_meta: { source: "wire", flags: [1, 2, 3] },
		});
		expect(input[0].content).toContain("typescript payload");
	});

	test("assistant string content stays a string and reports the wire block index", () => {
		const block = fence("assistant");
		const result = shakeWireMessages({
			messages: [{ role: "assistant", content: `lead\n${block}\ntrail`, response_meta: { keep: true } }],
			aggressive: true,
		});

		expect(result.regions[0].block_index).toBe(-1);
		expect(result.messages[0]).toEqual({
			role: "assistant",
			content: `lead\n${result.regions[0].placeholder}\ntrail`,
			response_meta: { keep: true },
		});
	});

	test("a content-array text block shakes while image and custom blocks remain exact", () => {
		const block = fence("python");
		const image = { type: "image_url", image_url: { url: "data:image/png;base64,abc" }, detail: "high" };
		const custom = { type: "vendor_extension", payload: { nested: [true, null, "exact"] } };
		const input: ShakeWireMessage[] = [
			{
				role: "user",
				content: [image, { type: "text", text: `before\n${block}\nafter`, annotations: ["keep"] }, custom],
			},
		];
		const result = shakeWireMessages({ messages: input, aggressive: true });
		const content = result.messages[0].content;

		expect(Array.isArray(content)).toBe(true);
		if (!Array.isArray(content)) throw new Error("expected content array");
		expect(content[0]).toEqual(image);
		expect(content[2]).toEqual(custom);
		expect(content[1]).toEqual({
			type: "text",
			text: `before\n${result.regions[0].placeholder}\nafter`,
			annotations: ["keep"],
		});
		expect(input[0].content).not.toBe(content);
		if (!Array.isArray(input[0].content)) throw new Error("expected input content array");
		expect(input[0].content[1]).toMatchObject({ text: expect.stringContaining("python payload") });
	});

	test("keepBoundaryIndex excludes earlier messages and beyond-end boundaries exclude all messages", () => {
		const input = [
			toolResult("old", "measure", "old payload ".repeat(300)),
			toolResult("kept", "measure", "kept payload ".repeat(300)),
		];
		const bounded = shakeWireMessages({ messages: input, aggressive: true, keepBoundaryIndex: 1 });

		expect(bounded.placeholders).toBe(1);
		expect(bounded.regions[0].message_index).toBe(1);
		expect(bounded.messages[0].content).toBe(input[0].content);
		expect(bounded.messages[1].content).toBe(bounded.regions[0].placeholder);

		const beyond = shakeWireMessages({ messages: input, aggressive: true, keepBoundaryIndex: 99 });
		expect(beyond.placeholders).toBe(0);
		expect(beyond.messages).toEqual(input);

		const negative = shakeWireMessages({ messages: input, aggressive: true, keepBoundaryIndex: -1 });
		expect(negative.regions.map(region => region.message_index)).toEqual([0, 1]);
	});

	test("multiple blocks in one text slot apply high-start-first without offset drift", () => {
		const first = fence("first");
		const second = fence("second");
		const input: ShakeWireMessage[] = [
			{ role: "developer", content: [{ type: "text", text: `head\n${first}\nmiddle\n${second}\ntail` }] },
		];
		const result = shakeWireMessages({ messages: input, aggressive: true });

		expect(result.placeholders).toBe(2);
		expect(result.regions.map(region => region.original_text)).toEqual([first, second]);
		expect(result.regions[0].start).toBeLessThan(result.regions[1].start as number);
		const content = result.messages[0].content;
		if (!Array.isArray(content)) throw new Error("expected content array");
		expect(content[0]).toEqual({
			type: "text",
			text: `head\n${result.regions[0].placeholder}\nmiddle\n${result.regions[1].placeholder}\ntail`,
		});
	});
});
