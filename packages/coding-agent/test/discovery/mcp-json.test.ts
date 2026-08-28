import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type MCPServer, mcpCapability } from "@chudware/coding-agent/capability/mcp";
import { loadCapability } from "@chudware/coding-agent/discovery";
import { removeWithRetries } from "@chudware/utils";

async function loadStandaloneMcpConfig(cwd: string): Promise<MCPServer[]> {
	const result = await loadCapability<MCPServer>(mcpCapability.id, {
		cwd,
		providers: ["mcp-json"],
	});
	return result.items;
}

function envPlaceholder(name: string): string {
	return `\${${name}}`;
}

describe("standalone mcp.json oauth env expansion", () => {
	let tempDir = "";
	const originalEnv = {
		CHUDCODE_OAUTH_TOKEN_URL: process.env.CHUDCODE_OAUTH_TOKEN_URL,
		CHUDCODE_OAUTH_CLIENT_ID: process.env.CHUDCODE_OAUTH_CLIENT_ID,
		CHUDCODE_OAUTH_CLIENT_SECRET: process.env.CHUDCODE_OAUTH_CLIENT_SECRET,
		CHUDCODE_OAUTH_REDIRECT_URI: process.env.CHUDCODE_OAUTH_REDIRECT_URI,
		CHUDCODE_OAUTH_CALLBACK_PATH: process.env.CHUDCODE_OAUTH_CALLBACK_PATH,
		CHUDCODE_MCP_HEADER: process.env.CHUDCODE_MCP_HEADER,
		CHUDCODE_MCP_URL: process.env.CHUDCODE_MCP_URL,
		CHUDCODE_MCP_ENV: process.env.CHUDCODE_MCP_ENV,
	};

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chudcode-mcp-json-"));
		process.env.CHUDCODE_OAUTH_TOKEN_URL = "https://provider.example/token";
		process.env.CHUDCODE_OAUTH_CLIENT_ID = "oauth-client-id";
		process.env.CHUDCODE_OAUTH_CLIENT_SECRET = "oauth-client-secret";
		process.env.CHUDCODE_OAUTH_REDIRECT_URI = "https://public.example/oauth/callback";
		process.env.CHUDCODE_OAUTH_CALLBACK_PATH = "/oauth/callback";
		process.env.CHUDCODE_MCP_HEADER = "Bearer test-token";
		process.env.CHUDCODE_MCP_URL = "https://mcp.example.com";
		process.env.CHUDCODE_MCP_ENV = "env-value";
	});

	afterEach(async () => {
		await removeWithRetries(tempDir);
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	test("expands standalone auth and oauth fields alongside existing env-expanded fields", async () => {
		await fs.writeFile(
			path.join(tempDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					figma: {
						url: `${envPlaceholder("CHUDCODE_MCP_URL")}/mcp`,
						headers: { Authorization: envPlaceholder("CHUDCODE_MCP_HEADER") },
						env: { MCP_VALUE: envPlaceholder("CHUDCODE_MCP_ENV") },
						auth: {
							type: "oauth",
							tokenUrl: envPlaceholder("CHUDCODE_OAUTH_TOKEN_URL"),
							clientId: envPlaceholder("CHUDCODE_OAUTH_CLIENT_ID"),
							clientSecret: envPlaceholder("CHUDCODE_OAUTH_CLIENT_SECRET"),
						},
						oauth: {
							clientId: envPlaceholder("CHUDCODE_OAUTH_CLIENT_ID"),
							clientSecret: envPlaceholder("CHUDCODE_OAUTH_CLIENT_SECRET"),
							redirectUri: envPlaceholder("CHUDCODE_OAUTH_REDIRECT_URI"),
							callbackPort: 4317,
							callbackPath: envPlaceholder("CHUDCODE_OAUTH_CALLBACK_PATH"),
						},
					},
				},
			}),
		);

		const [server] = await loadStandaloneMcpConfig(tempDir);
		expect(server).toBeDefined();
		expect(server?.url).toBe("https://mcp.example.com/mcp");
		expect(server?.headers).toEqual({ Authorization: "Bearer test-token" });
		expect(server?.env).toEqual({ MCP_VALUE: "env-value" });
		expect(server?.auth).toEqual({
			type: "oauth",
			tokenUrl: "https://provider.example/token",
			clientId: "oauth-client-id",
			clientSecret: "oauth-client-secret",
		});
		expect(server?.oauth).toEqual({
			clientId: "oauth-client-id",
			clientSecret: "oauth-client-secret",
			redirectUri: "https://public.example/oauth/callback",
			callbackPort: 4317,
			callbackPath: "/oauth/callback",
		});
	});

	test("expands only the standalone oauth fields that are present", async () => {
		await fs.writeFile(
			path.join(tempDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					slack: {
						url: "https://slack.example.com/mcp",
						oauth: {
							redirectUri: envPlaceholder("CHUDCODE_OAUTH_REDIRECT_URI"),
							callbackPath: envPlaceholder("CHUDCODE_OAUTH_CALLBACK_PATH"),
						},
					},
				},
			}),
		);

		const [server] = await loadStandaloneMcpConfig(tempDir);
		expect(server).toBeDefined();
		expect(server?.oauth).toEqual({
			redirectUri: "https://public.example/oauth/callback",
			callbackPath: "/oauth/callback",
		});
		expect(server?.auth).toBeUndefined();
	});
});
