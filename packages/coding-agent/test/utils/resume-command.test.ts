import { afterEach, describe, expect, it } from "bun:test";
import { PRODUCT_CLI_NAME } from "@chudware/coding-agent/brand";
import { resumeCommand } from "@chudware/coding-agent/utils/resume-command";
import { getActiveProfile, setProfile } from "@chudware/utils/dirs";

describe("resumeCommand", () => {
	const originalProfile = getActiveProfile();

	afterEach(() => {
		setProfile(originalProfile);
	});

	it("omits the profile flag in the default profile", () => {
		setProfile(undefined);
		expect(resumeCommand("abc123")).toBe(`${PRODUCT_CLI_NAME} --resume abc123`);
	});

	it("carries the active profile so the emitted hint is runnable verbatim", () => {
		// Profile sessions live in ~/.chudcode/profiles/<name>/agent, so a resume hint
		// without --profile fails with "Session not found" (issue #9018).
		setProfile("personal");
		expect(resumeCommand("abc123")).toBe(`${PRODUCT_CLI_NAME} --profile personal --resume abc123`);
	});
});
