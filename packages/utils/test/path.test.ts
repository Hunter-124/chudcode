import { describe, expect, it } from "bun:test";
import { stripWindowsExtendedLengthPathPrefix } from "../src/path";

describe("stripWindowsExtendedLengthPathPrefix", () => {
	it("removes drive and UNC extended-length prefixes on Windows", () => {
		expect(stripWindowsExtendedLengthPathPrefix("\\\\?\\C:\\Users\\Shi Xin\\chudcode.exe", "win32")).toBe(
			"C:\\Users\\Shi Xin\\chudcode.exe",
		);
		expect(stripWindowsExtendedLengthPathPrefix("\\\\?\\UNC\\server\\share\\chudcode.exe", "win32")).toBe(
			"\\\\server\\share\\chudcode.exe",
		);
	});

	it("leaves non-Windows paths unchanged", () => {
		const path = "\\\\?\\C:\\Users\\Shi Xin\\chudcode.exe";
		expect(stripWindowsExtendedLengthPathPrefix(path, "linux")).toBe(path);
	});
});
