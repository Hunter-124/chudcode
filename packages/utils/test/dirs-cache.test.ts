import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	__resetDirsFromEnvForTests,
	getActiveProfile,
	getComposerCacheDir,
	getConfigDirName,
	getDocumentConversionCacheDir,
	getMarketplacesRegistryPath,
	getProfileRootDir,
	getSecretPlaceholderKeyPath,
	setAgentDir,
} from "@chudware/utils/dirs";
import { Snowflake } from "@chudware/utils/snowflake";

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}

describe("document conversion cache directory", () => {
	let tempRoot = "";
	let originalPiCodingAgentDir: string | undefined;
	let originalProfileEnv: string | undefined;
	let originalXdgCacheHome: string | undefined;

	beforeEach(async () => {
		originalPiCodingAgentDir = process.env.CHUDCODE_CODING_AGENT_DIR;
		originalProfileEnv = process.env.CHUDCODE_PROFILE;
		originalXdgCacheHome = process.env.XDG_CACHE_HOME;
		tempRoot = path.join(os.tmpdir(), "chud-utils-document-cache", Snowflake.next());
		await fs.mkdir(tempRoot, { recursive: true });
	});

	afterEach(async () => {
		restoreEnv("CHUDCODE_CODING_AGENT_DIR", originalPiCodingAgentDir);
		restoreEnv("CHUDCODE_PROFILE", originalProfileEnv);
		restoreEnv("XDG_CACHE_HOME", originalXdgCacheHome);
		__resetDirsFromEnvForTests();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("uses XDG_CACHE_HOME for the default agent dir when $XDG_CACHE_HOME/chudcode exists", async () => {
		if (process.platform === "win32") return;

		process.env.XDG_CACHE_HOME = path.join(tempRoot, "cache");
		await fs.mkdir(path.join(process.env.XDG_CACHE_HOME, "chudcode"), { recursive: true });

		const defaultAgentDir = path.join(os.homedir(), getConfigDirName(), "agent");
		setAgentDir(defaultAgentDir);

		expect(getDocumentConversionCacheDir()).toBe(
			path.join(process.env.XDG_CACHE_HOME, "chudcode", "cache", "document-conversions"),
		);
	});

	it("routes getComposerCacheDir to $XDG_CACHE_HOME/chudcode/cache/composer", async () => {
		if (process.platform === "win32") return;

		process.env.XDG_CACHE_HOME = path.join(tempRoot, "cache");
		await fs.mkdir(path.join(process.env.XDG_CACHE_HOME, "chudcode"), { recursive: true });

		const defaultAgentDir = path.join(os.homedir(), getConfigDirName(), "agent");
		setAgentDir(defaultAgentDir);

		expect(getComposerCacheDir()).toBe(path.join(process.env.XDG_CACHE_HOME, "chudcode", "cache", "composer"));
	});

	it("stays under a custom CHUDCODE_CODING_AGENT_DIR", () => {
		const customAgentDir = path.join(tempRoot, "custom-agent");

		setAgentDir(customAgentDir);

		expect(getDocumentConversionCacheDir()).toBe(path.join(customAgentDir, "cache", "document-conversions"));
	});
});

describe("test directory state cleanup", () => {
	it("restores the active profile from the current env after setAgentDir mutations", () => {
		const originalPiCodingAgentDir = process.env.CHUDCODE_CODING_AGENT_DIR;
		const originalProfileEnv = process.env.CHUDCODE_PROFILE;
		const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
		try {
			process.env.CHUDCODE_PROFILE = "cache-profile";
			delete process.env.CHUDCODE_CODING_AGENT_DIR;
			delete process.env.XDG_CACHE_HOME;
			__resetDirsFromEnvForTests();

			setAgentDir(path.join(os.tmpdir(), "chud-utils-document-cache", Snowflake.next(), "agent"));
			expect(getActiveProfile()).toBeUndefined();

			process.env.CHUDCODE_PROFILE = "cache-profile";
			delete process.env.CHUDCODE_CODING_AGENT_DIR;
			__resetDirsFromEnvForTests();

			expect(getActiveProfile()).toBe("cache-profile");
			expect(getDocumentConversionCacheDir()).toBe(
				path.join(getProfileRootDir("cache-profile"), "agent", "cache", "document-conversions"),
			);
		} finally {
			restoreEnv("CHUDCODE_CODING_AGENT_DIR", originalPiCodingAgentDir);
			restoreEnv("CHUDCODE_PROFILE", originalProfileEnv);
			restoreEnv("XDG_CACHE_HOME", originalXdgCacheHome);
			__resetDirsFromEnvForTests();
		}
	});
});

describe("legacy file adoption on XDG paths", () => {
	let tempRoot = "";
	let originalPiCodingAgentDir: string | undefined;
	let originalProfileEnv: string | undefined;
	let originalXdgStateHome: string | undefined;
	let originalXdgDataHome: string | undefined;
	let homedirSpy: Mock<() => string> | undefined;

	beforeEach(async () => {
		originalPiCodingAgentDir = process.env.CHUDCODE_CODING_AGENT_DIR;
		originalProfileEnv = process.env.CHUDCODE_PROFILE;
		originalXdgStateHome = process.env.XDG_STATE_HOME;
		originalXdgDataHome = process.env.XDG_DATA_HOME;
		tempRoot = path.join(os.tmpdir(), "chud-utils-xdg-adoption", Snowflake.next());
		await fs.mkdir(tempRoot, { recursive: true });
	});

	afterEach(async () => {
		homedirSpy?.mockRestore();
		homedirSpy = undefined;
		restoreEnv("CHUDCODE_CODING_AGENT_DIR", originalPiCodingAgentDir);
		restoreEnv("CHUDCODE_PROFILE", originalProfileEnv);
		restoreEnv("XDG_STATE_HOME", originalXdgStateHome);
		restoreEnv("XDG_DATA_HOME", originalXdgDataHome);
		__resetDirsFromEnvForTests();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	/** Rebuild the resolver with home at tempRoot, the default agent dir, and the given XDG env. */
	function activateTempHome(xdgEnv: Record<string, string>): void {
		homedirSpy = spyOn(os, "homedir").mockReturnValue(tempRoot);
		delete process.env.CHUDCODE_CODING_AGENT_DIR;
		delete process.env.CHUDCODE_PROFILE;
		delete process.env.XDG_STATE_HOME;
		delete process.env.XDG_DATA_HOME;
		for (const key in xdgEnv) {
			process.env[key] = xdgEnv[key];
		}
		__resetDirsFromEnvForTests();
	}

	it("adopts legacy files at the XDG paths without clobbering existing XDG files", async () => {
		if (process.platform === "win32") return;
		const xdgState = path.join(tempRoot, "xdg-state");
		const xdgData = path.join(tempRoot, "xdg-data");
		await fs.mkdir(path.join(xdgState, "chudcode"), { recursive: true });
		await fs.mkdir(path.join(xdgData, "chudcode"), { recursive: true });
		// Legacy layout: key under ~/.chudcode/agent, registry under ~/.chudcode.
		await fs.mkdir(path.join(tempRoot, ".chudcode", "agent"), { recursive: true });
		await fs.writeFile(path.join(tempRoot, ".chudcode", "agent", "secret-placeholder.key"), "legacy-key");
		await fs.writeFile(path.join(tempRoot, ".chudcode", "marketplaces.json"), '{"legacy":true}');
		// The XDG registry is already populated: adoption must not overwrite it.
		await fs.writeFile(path.join(xdgData, "chudcode", "marketplaces.json"), '{"xdg":true}');
		activateTempHome({ XDG_STATE_HOME: xdgState, XDG_DATA_HOME: xdgData });

		const key = getSecretPlaceholderKeyPath();
		const registry = getMarketplacesRegistryPath();
		expect(key).toBe(path.join(xdgState, "chudcode", "secret-placeholder.key"));
		expect(registry).toBe(path.join(xdgData, "chudcode", "marketplaces.json"));
		expect(await fs.readFile(key, "utf8")).toBe("legacy-key");
		expect(await fs.readFile(registry, "utf8")).toBe('{"xdg":true}');
	});

	it("keeps the legacy paths canonical when XDG is inactive", async () => {
		if (process.platform === "win32") return;
		activateTempHome({});
		expect(getSecretPlaceholderKeyPath()).toBe(path.join(tempRoot, ".chudcode", "agent", "secret-placeholder.key"));
		expect(getMarketplacesRegistryPath()).toBe(path.join(tempRoot, ".chudcode", "marketplaces.json"));
	});
});
