import { describe, expect, test } from "bun:test";
import path from "node:path";
import { CHANNELS } from "../src/channels";
import {
	type ApprovalMode,
	DEVBOT_PERMISSIONS,
	DevbotConfigError,
	loadDevbotConfig,
	resolveWorkspace,
} from "../src/devbot-config";

const OPERATOR = "111122223333444455";
const SECOND_OPERATOR = "555566667777888899";

/** An absolute path for whichever platform runs the suite. Never touched on disk. */
const ABSOLUTE_ROOT = process.platform === "win32" ? "C:\\repo" : "/repo";

const CHUDCODE = path.join(ABSOLUTE_ROOT, "chudcode");
const CLOUDCASTLE = path.join(ABSOLUTE_ROOT, "CloudCastle");

/**
 * The smallest environment `loadDevbotConfig` accepts, with overrides spread on
 * top so each test states only the variable it is about. The ambient
 * `process.env` is never consulted: the parser is always handed an object.
 */
function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
	return {
		CC_DEVBOT_OPERATORS: OPERATOR,
		CC_DEVBOT_WORKSPACES: `chudcode=${CHUDCODE}`,
		...overrides,
	};
}

describe("DEVBOT_PERMISSIONS", () => {
	test("matches the nine bits the invite URL documents", () => {
		// Recomputed from the bit numbers rather than copied from the constant, so
		// editing one without the other fails here instead of on Discord's OAuth page.
		const bits =
			(1n << 6n) | // Add Reactions
			(1n << 10n) | // View Channels
			(1n << 11n) | // Send Messages
			(1n << 14n) | // Embed Links
			(1n << 15n) | // Attach Files
			(1n << 16n) | // Read Message History
			(1n << 34n) | // Manage Threads
			(1n << 35n) | // Create Public Threads
			(1n << 38n); // Send Messages in Threads
		expect(DEVBOT_PERMISSIONS).toBe("326417632320");
		expect(DEVBOT_PERMISSIONS).toBe(bits.toString());
	});
});

describe("loadDevbotConfig defaults", () => {
	test("a minimal environment is enough to run", () => {
		const config = loadDevbotConfig(env());
		expect(config.approvalMode).toBe("yolo");
		expect(config.maxSessions).toBe(3);
		expect(config.idleTimeoutMs).toBe(1_800_000);
		expect(config.turnTimeoutMs).toBe(1_800_000);
		expect(config.model).toBeUndefined();
		expect(config.sessionsChannelId).toBe(CHANNELS.sessions.id);
		expect(config.agentCommand[0]).toBe("bun");
		expect(config.agentCommand[1]?.endsWith(path.join("packages", "coding-agent", "src", "cli.ts"))).toBe(true);
	});

	test("CC_DEVBOT_MODEL is trimmed and blank means unset", () => {
		expect(loadDevbotConfig(env({ CC_DEVBOT_MODEL: "  anthropic/claude-opus-5  " })).model).toBe(
			"anthropic/claude-opus-5",
		);
		expect(loadDevbotConfig(env({ CC_DEVBOT_MODEL: "   " })).model).toBeUndefined();
	});
});

describe("operator allowlist", () => {
	test("an absent or empty allowlist refuses to start", () => {
		expect(() => loadDevbotConfig(env({ CC_DEVBOT_OPERATORS: undefined }))).toThrow(DevbotConfigError);
		expect(() => loadDevbotConfig(env({ CC_DEVBOT_OPERATORS: "" }))).toThrow(DevbotConfigError);
		expect(() => loadDevbotConfig(env({ CC_DEVBOT_OPERATORS: "  ,  " }))).toThrow(/at least one Discord user id/);
	});

	test("anything that is not a snowflake is rejected rather than ignored", () => {
		expect(() => loadDevbotConfig(env({ CC_DEVBOT_OPERATORS: "hunter" }))).toThrow(DevbotConfigError);
		expect(() => loadDevbotConfig(env({ CC_DEVBOT_OPERATORS: "12" }))).toThrow(/not a Discord user id/);
		expect(() => loadDevbotConfig(env({ CC_DEVBOT_OPERATORS: `${OPERATOR},hunter` }))).toThrow(DevbotConfigError);
	});

	test("several ids parse, whitespace is tolerated, duplicates collapse", () => {
		const config = loadDevbotConfig(
			env({ CC_DEVBOT_OPERATORS: `  ${OPERATOR} ,  ${SECOND_OPERATOR}  , ${OPERATOR}` }),
		);
		expect(config.operators.has(OPERATOR)).toBe(true);
		expect(config.operators.has(SECOND_OPERATOR)).toBe(true);
		expect(config.operators.size).toBe(2);
	});
});

describe("workspace parsing", () => {
	test("an absent or empty workspace list refuses to start", () => {
		expect(() => loadDevbotConfig(env({ CC_DEVBOT_WORKSPACES: undefined }))).toThrow(DevbotConfigError);
		expect(() => loadDevbotConfig(env({ CC_DEVBOT_WORKSPACES: "" }))).toThrow(DevbotConfigError);
		expect(() => loadDevbotConfig(env({ CC_DEVBOT_WORKSPACES: " , " }))).toThrow(/at least one name=absolute-path/);
	});

	test("an entry without a name=path pair is rejected", () => {
		expect(() => loadDevbotConfig(env({ CC_DEVBOT_WORKSPACES: CHUDCODE }))).toThrow(/must be name=absolute-path/);
		expect(() => loadDevbotConfig(env({ CC_DEVBOT_WORKSPACES: `=${CHUDCODE}` }))).toThrow(
			/must be name=absolute-path/,
		);
	});

	test("a relative path is rejected, because a session must not escape a known root", () => {
		expect(() => loadDevbotConfig(env({ CC_DEVBOT_WORKSPACES: "chudcode=chudcode" }))).toThrow(/must be absolute/);
		expect(() => loadDevbotConfig(env({ CC_DEVBOT_WORKSPACES: "chudcode=../chudcode" }))).toThrow(/must be absolute/);
	});

	test("a duplicate name is rejected rather than silently shadowed", () => {
		expect(() =>
			loadDevbotConfig(env({ CC_DEVBOT_WORKSPACES: `chudcode=${CHUDCODE},chudcode=${CLOUDCASTLE}` })),
		).toThrow(/declares chudcode twice/);
	});

	test("an illegal name is rejected", () => {
		expect(() => loadDevbotConfig(env({ CC_DEVBOT_WORKSPACES: `Bad Name=${CHUDCODE}` }))).toThrow(
			/must be alphanumeric/,
		);
		expect(() => loadDevbotConfig(env({ CC_DEVBOT_WORKSPACES: `../etc=${CHUDCODE}` }))).toThrow(
			/must be alphanumeric/,
		);
	});

	test("names are lowercased, because they are typed on a phone", () => {
		const config = loadDevbotConfig(env({ CC_DEVBOT_WORKSPACES: `CloudCastle=${ABSOLUTE_ROOT}` }));
		expect(config.workspaces).toHaveLength(1);
		expect(config.workspaces[0]?.name).toBe("cloudcastle");
		expect(config.workspaces[0]?.path).toBe(path.resolve(ABSOLUTE_ROOT));
	});
});

describe("default workspace", () => {
	const two = `chudcode=${CHUDCODE},cloudcastle=${CLOUDCASTLE}`;

	test("omitting the variable takes the first declared workspace", () => {
		expect(loadDevbotConfig(env({ CC_DEVBOT_WORKSPACES: two })).defaultWorkspace.name).toBe("chudcode");
	});

	test("the variable can select a later workspace", () => {
		const config = loadDevbotConfig(env({ CC_DEVBOT_WORKSPACES: two, CC_DEVBOT_DEFAULT_WORKSPACE: "cloudcastle" }));
		expect(config.defaultWorkspace.name).toBe("cloudcastle");
	});

	test("naming a workspace that does not exist refuses to start", () => {
		expect(() =>
			loadDevbotConfig(env({ CC_DEVBOT_WORKSPACES: two, CC_DEVBOT_DEFAULT_WORKSPACE: "elsewhere" })),
		).toThrow(/names no workspace/);
	});
});

describe("approval mode", () => {
	test("each documented mode is accepted", () => {
		for (const mode of ["always-ask", "write", "yolo"] satisfies ApprovalMode[]) {
			expect(loadDevbotConfig(env({ CC_DEVBOT_APPROVAL_MODE: mode })).approvalMode).toBe(mode);
		}
	});

	test("anything else refuses to start rather than falling back", () => {
		expect(() => loadDevbotConfig(env({ CC_DEVBOT_APPROVAL_MODE: "read-only" }))).toThrow(DevbotConfigError);
		expect(() => loadDevbotConfig(env({ CC_DEVBOT_APPROVAL_MODE: "YOLO" }))).toThrow(/must be one of/);
	});
});

describe("positive integer limits", () => {
	const limits = [
		{ variable: "CC_DEVBOT_MAX_SESSIONS", read: "maxSessions" },
		{ variable: "CC_DEVBOT_IDLE_TIMEOUT_MS", read: "idleTimeoutMs" },
		{ variable: "CC_DEVBOT_TURN_TIMEOUT_MS", read: "turnTimeoutMs" },
	] as const;

	for (const { variable, read } of limits) {
		test(`${variable} accepts a positive integer`, () => {
			expect(loadDevbotConfig(env({ [variable]: "7" }))[read]).toBe(7);
		});

		test(`${variable} rejects zero, negatives, fractions, and words`, () => {
			for (const bad of ["0", "-1", "1.5", "lots"]) {
				expect(() => loadDevbotConfig(env({ [variable]: bad }))).toThrow(DevbotConfigError);
			}
			expect(() => loadDevbotConfig(env({ [variable]: "0" }))).toThrow(/must be a positive integer/);
		});
	}
});

describe("resolveWorkspace", () => {
	const config = loadDevbotConfig(env({ CC_DEVBOT_WORKSPACES: `chudcode=${CHUDCODE},cloudcastle=${CLOUDCASTLE}` }));

	test("no name means the default workspace", () => {
		expect(resolveWorkspace(config, undefined)).toBe(config.defaultWorkspace);
		expect(resolveWorkspace(config, "")).toBe(config.defaultWorkspace);
	});

	test("a known name resolves in any case", () => {
		expect(resolveWorkspace(config, "cloudcastle")?.name).toBe("cloudcastle");
		expect(resolveWorkspace(config, "CloudCastle")?.name).toBe("cloudcastle");
	});

	test("an unknown name resolves to nothing and never to the default", () => {
		// A silent fallback would run a prompt aimed at one checkout inside another.
		expect(resolveWorkspace(config, "elsewhere")).toBeUndefined();
		expect(resolveWorkspace(config, "../etc")).toBeUndefined();
	});
});

describe("token file and state directory", () => {
	test("the token path defaults under the devbot directory and can be overridden", () => {
		const override = path.join(ABSOLUTE_ROOT, "secrets", "bot-token");
		expect(loadDevbotConfig(env({ CC_DEVBOT_TOKEN_FILE: override })).tokenFile).toBe(path.resolve(override));
		const fallback = loadDevbotConfig(env()).tokenFile;
		expect(path.basename(fallback)).toBe("discord-token");
		expect(fallback.endsWith(path.join("cloudcastle", "devbot", "discord-token"))).toBe(true);
	});

	test("the state directory defaults under the devbot directory and can be overridden", () => {
		const override = path.join(ABSOLUTE_ROOT, "devbot-state");
		expect(loadDevbotConfig(env({ CC_DEVBOT_STATE_DIR: override })).stateDir).toBe(path.resolve(override));
		const fallback = loadDevbotConfig(env()).stateDir;
		expect(path.basename(fallback)).toBe("state");
		expect(fallback.endsWith(path.join("cloudcastle", "devbot", "state"))).toBe(true);
	});
});
