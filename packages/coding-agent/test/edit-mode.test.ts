import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type EditMode, type EditModeSessionLike, resolveEditMode } from "@chudware/coding-agent/utils/edit-mode";

const originalEditVariant = process.env.CHUDCODE_EDIT_VARIANT;
const originalStrictEditMode = process.env.CHUDCODE_STRICT_EDIT_MODE;

function restoreEnv(): void {
	if (originalEditVariant === undefined) {
		delete process.env.CHUDCODE_EDIT_VARIANT;
	} else {
		process.env.CHUDCODE_EDIT_VARIANT = originalEditVariant;
	}
	if (originalStrictEditMode === undefined) {
		delete process.env.CHUDCODE_STRICT_EDIT_MODE;
	} else {
		process.env.CHUDCODE_STRICT_EDIT_MODE = originalStrictEditMode;
	}
}

function createSession(args: {
	activeModel?: string;
	modelVariant?: EditMode | null;
	settingsMode?: EditMode;
}): EditModeSessionLike {
	return {
		getActiveModelString: () => args.activeModel,
		settings: {
			get: () => args.settingsMode ?? "hashline",
			getEditVariantForModel: () => args.modelVariant ?? null,
		},
	};
}

describe("resolveEditMode", () => {
	beforeEach(() => {
		delete process.env.CHUDCODE_EDIT_VARIANT;
		delete process.env.CHUDCODE_STRICT_EDIT_MODE;
	});

	afterEach(() => {
		restoreEnv();
	});

	test("falls back from hashline to sloppy for Kimi models", () => {
		delete process.env.CHUDCODE_EDIT_VARIANT;

		expect(resolveEditMode(createSession({ activeModel: "openrouter/moonshotai/Kimi-K2-Instruct" }))).toBe("sloppy");
	});

	test("falls back from hashline to sloppy for MiMo models", () => {
		delete process.env.CHUDCODE_EDIT_VARIANT;

		expect(resolveEditMode(createSession({ activeModel: "xiaomi/MiMo-V2.5-Pro" }))).toBe("sloppy");
	});

	test("falls back from hashline to sloppy for DeepSeek V4 Flash models", () => {
		delete process.env.CHUDCODE_EDIT_VARIANT;

		expect(resolveEditMode(createSession({ activeModel: "tensormesh/deepseek-ai/DeepSeek-V4-Flash" }))).toBe(
			"sloppy",
		);
	});

	test("falls back from hashline to sloppy for Step 3.7 Flash models", () => {
		delete process.env.CHUDCODE_EDIT_VARIANT;

		expect(resolveEditMode(createSession({ activeModel: "kilo/stepfun/step-3.7-flash:free" }))).toBe("sloppy");
	});

	test("does not exclude non-Kimi Moonshot models", () => {
		delete process.env.CHUDCODE_EDIT_VARIANT;

		expect(resolveEditMode(createSession({ activeModel: "moonshot/moonshot-v1-128k" }))).toBe("hashline");
	});

	test("keeps explicit model variants ahead of the Kimi fallback", () => {
		delete process.env.CHUDCODE_EDIT_VARIANT;

		expect(
			resolveEditMode(
				createSession({ activeModel: "openrouter/moonshotai/Kimi-K2-Instruct", modelVariant: "hashline" }),
			),
		).toBe("hashline");
	});

	test("keeps CHUDCODE_EDIT_VARIANT ahead of the Kimi fallback", () => {
		process.env.CHUDCODE_EDIT_VARIANT = "hashline";

		expect(resolveEditMode(createSession({ activeModel: "openrouter/moonshotai/Kimi-K2-Instruct" }))).toBe(
			"hashline",
		);
	});

	test("only falls back when the resolved mode is hashline", () => {
		delete process.env.CHUDCODE_EDIT_VARIANT;

		expect(
			resolveEditMode(
				createSession({ activeModel: "openrouter/moonshotai/Kimi-K2-Instruct", settingsMode: "apply_patch" }),
			),
		).toBe("apply_patch");
	});

	test("keeps strict edit mode ahead of the Kimi fallback", () => {
		delete process.env.CHUDCODE_EDIT_VARIANT;
		process.env.CHUDCODE_STRICT_EDIT_MODE = "1";

		expect(resolveEditMode(createSession({ activeModel: "openrouter/moonshotai/Kimi-K2-Instruct" }))).toBe(
			"hashline",
		);
	});
});
