import { describe, expect, test } from "bun:test";
import { CHANNELS, GUILD_ID, isChannelName, messageLink, webhookEnvVar } from "../src/channels";
import {
	assertWebhookUrl,
	editWebhookMessage,
	postWebhook,
	redactUrl,
	screenJson,
	WebhookError,
	type WebhookPayload,
} from "../src/notify";

const TOKEN = "aVeryLongWebhookTokenSegment_0123456789";
const URL_OK = `https://discord.com/api/webhooks/1542631105608556574/${TOKEN}`;

interface Call {
	url: string;
	method: string;
	body: unknown;
}

function recordingFetch(responses: Array<{ status: number; body: string; headers?: Record<string, string> }>) {
	const calls: Call[] = [];
	const fetchImpl = (async (input: Request | URL | string, init?: RequestInit) => {
		const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
		calls.push({ url, method: init?.method ?? "GET", body: JSON.parse(String(init?.body ?? "null")) });
		const next = responses.shift();
		if (!next) throw new Error("unexpected extra request");
		return new Response(next.body, { status: next.status, headers: next.headers });
	}) as unknown as typeof globalThis.fetch;
	return { calls, fetchImpl };
}

/** Trips on anything containing the literal fake credential, standing in for the real obfuscator. */
const fakeObfuscator = {
	obfuscate(text: string): string {
		return text.replaceAll("ghp_FAKECREDENTIAL0123456789", "***");
	},
};

describe("channels", () => {
	test("ids and webhook variables come from one place and are unique", () => {
		expect(GUILD_ID).toBe("1542474553320542278");
		const ids = Object.values(CHANNELS).map(channel => channel.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids.every(id => /^\d{17,20}$/.test(id))).toBe(true);
		expect(webhookEnvVar("sessions")).toBe("DISCORD_WEBHOOK_SESSIONS");
		expect(webhookEnvVar("board")).toBe("DISCORD_WEBHOOK_BOARD");
		// Intake channels are read-only to cc-track, so they must not offer egress.
		expect(webhookEnvVar("que")).toBeNull();
		expect(webhookEnvVar("problems")).toBeNull();
		expect(isChannelName("sessions")).toBe(true);
		expect(isChannelName("general")).toBe(false);
		expect(messageLink("sessions", "42")).toBe(
			"https://discord.com/channels/1542474553320542278/1542631105608556574/42",
		);
	});
});

describe("assertWebhookUrl", () => {
	test("rejects a host that is not discord.com", async () => {
		const evil = `https://discord.com.attacker.example/api/webhooks/1/${TOKEN}`;
		expect(() => assertWebhookUrl(evil)).toThrow(/host must be discord\.com/);
		const { calls, fetchImpl } = recordingFetch([]);
		await expect(postWebhook(evil, { content: "hi" }, { fetch: fetchImpl, secretObfuscator: undefined })).rejects.toThrow(
			WebhookError,
		);
		expect(calls).toHaveLength(0);
	});

	test("rejects plain http even on the allowed host", async () => {
		const insecure = `http://discord.com/api/webhooks/1/${TOKEN}`;
		expect(() => assertWebhookUrl(insecure)).toThrow(/must use https/);
		const { calls, fetchImpl } = recordingFetch([]);
		await expect(
			postWebhook(insecure, { content: "hi" }, { fetch: fetchImpl, secretObfuscator: undefined }),
		).rejects.toThrow(/must use https/);
		expect(calls).toHaveLength(0);
	});

	test("rejects ports, embedded credentials, and non-webhook paths", () => {
		expect(() => assertWebhookUrl(`https://discord.com:8443/api/webhooks/1/${TOKEN}`)).toThrow(/must not specify a port/);
		expect(() => assertWebhookUrl(`https://user:pw@discord.com/api/webhooks/1/${TOKEN}`)).toThrow(
			/must not embed credentials/,
		);
		expect(() => assertWebhookUrl("https://discord.com/api/v10/channels/1/messages")).toThrow(/path must be/);
		expect(() => assertWebhookUrl("not a url")).toThrow(/not a valid URL/);
		expect(assertWebhookUrl(URL_OK).hostname).toBe("discord.com");
	});
});

describe("redactUrl", () => {
	test("never leaks the token segment", () => {
		const redacted = redactUrl(URL_OK);
		expect(redacted).toBe("https://discord.com/api/webhooks/1542631105608556574/<redacted>");
		expect(redacted).not.toContain(TOKEN);
		expect(redactUrl(`${URL_OK}/messages/99?wait=true`)).toBe(
			"https://discord.com/api/webhooks/1542631105608556574/<redacted>/messages/99?wait=true",
		);
		// Anything unrecognised collapses rather than being echoed.
		expect(redactUrl(`some-other-secret-${TOKEN}`)).toBe("<redacted webhook url>");
	});

	test("an HTTP failure reports the status without the credential", async () => {
		const { fetchImpl } = recordingFetch([{ status: 403, body: '{"message":"Forbidden"}' }]);
		const error = (await postWebhook(URL_OK, { content: "hi" }, {
			fetch: fetchImpl,
			secretObfuscator: undefined,
		}).catch((thrown: unknown) => thrown)) as WebhookError;
		expect(error).toBeInstanceOf(WebhookError);
		expect(error.status).toBe(403);
		expect(error.message).toContain("<redacted>");
		expect(error.message).not.toContain(TOKEN);
	});
});

describe("postWebhook", () => {
	test("posts with wait=true and returns the created message id", async () => {
		const { calls, fetchImpl } = recordingFetch([{ status: 200, body: '{"id":"1700000000000000001"}' }]);
		const result = await postWebhook(
			URL_OK,
			{ content: "board rebuilt" },
			{ fetch: fetchImpl, secretObfuscator: undefined },
		);
		expect(result.messageId).toBe("1700000000000000001");
		expect(result.attempts).toBe(1);
		expect(calls).toHaveLength(1);
		expect(calls[0].method).toBe("POST");
		expect(new URL(calls[0].url).searchParams.get("wait")).toBe("true");
		expect(calls[0].body).toEqual({ content: "board rebuilt" });
	});

	test("retries a 429 after the retry_after the body asks for", async () => {
		const { calls, fetchImpl } = recordingFetch([
			{ status: 429, body: '{"message":"rate limited","retry_after":1.5,"global":false}' },
			{ status: 200, body: '{"id":"7"}' },
		]);
		const slept: number[] = [];
		const result = await postWebhook(
			URL_OK,
			{ content: "hi" },
			{
				fetch: fetchImpl,
				secretObfuscator: undefined,
				sleep: async milliseconds => {
					slept.push(milliseconds);
				},
			},
		);
		expect(slept).toEqual([1500]);
		expect(result.attempts).toBe(2);
		expect(result.messageId).toBe("7");
		expect(calls).toHaveLength(2);
	});

	test("falls back to the retry-after header and gives up after maxAttempts", async () => {
		const { calls, fetchImpl } = recordingFetch([
			{ status: 429, body: "", headers: { "retry-after": "2" } },
			{ status: 429, body: "", headers: { "retry-after": "2" } },
		]);
		const slept: number[] = [];
		await expect(
			postWebhook(
				URL_OK,
				{ content: "hi" },
				{
					fetch: fetchImpl,
					secretObfuscator: undefined,
					maxAttempts: 2,
					sleep: async milliseconds => {
						slept.push(milliseconds);
					},
				},
			),
		).rejects.toThrow(/HTTP 429/);
		expect(slept).toEqual([2000]);
		expect(calls).toHaveLength(2);
	});

	test("does not retry a 4xx that is not a rate limit", async () => {
		const { calls, fetchImpl } = recordingFetch([{ status: 400, body: '{"message":"bad"}' }]);
		await expect(postWebhook(URL_OK, { content: "hi" }, { fetch: fetchImpl, secretObfuscator: undefined })).rejects.toThrow(
			/HTTP 400/,
		);
		expect(calls).toHaveLength(1);
	});
});

describe("secret screening", () => {
	test("a credential in the body is replaced before the request is sent", async () => {
		const { calls, fetchImpl } = recordingFetch([{ status: 200, body: '{"id":"9"}' }]);
		const payload: WebhookPayload = {
			content: "deploy log",
			embeds: [
				{
					title: "Session",
					fields: [{ name: "env", value: "GITHUB_TOKEN=ghp_FAKECREDENTIAL0123456789" }],
				},
			],
		};
		const result = await postWebhook(URL_OK, payload, { fetch: fetchImpl, secretObfuscator: fakeObfuscator });
		const sent = JSON.stringify(calls[0].body);
		expect(sent).not.toContain("ghp_FAKECREDENTIAL0123456789");
		expect(sent).toContain("[REDACTED sha256:");
		expect(sent).toContain("deploy log");
		expect(result.redactedPaths).toEqual(["$.embeds[0].fields[0].value"]);
	});

	test("screenJson leaves clean text untouched and is a no-op without an obfuscator", () => {
		const payload: WebhookPayload = { content: "nothing secret here" };
		expect(screenJson(payload, fakeObfuscator)).toEqual({ value: payload, redactedPaths: [] });
		expect(screenJson({ content: "ghp_FAKECREDENTIAL0123456789" }, undefined).redactedPaths).toEqual([]);
	});
});

describe("editWebhookMessage", () => {
	test("patches the message path so the live board is edited, not reposted", async () => {
		const { calls, fetchImpl } = recordingFetch([{ status: 200, body: '{"id":"55"}' }]);
		const result = await editWebhookMessage(
			URL_OK,
			"55",
			{ content: "updated board" },
			{ fetch: fetchImpl, secretObfuscator: undefined },
		);
		expect(result.messageId).toBe("55");
		expect(calls[0].method).toBe("PATCH");
		expect(new URL(calls[0].url).pathname.endsWith("/messages/55")).toBe(true);
	});

	test("rejects a message id that is not a snowflake", async () => {
		await expect(editWebhookMessage(URL_OK, "../../guilds", {}, { secretObfuscator: undefined })).rejects.toThrow(
			/decimal snowflake/,
		);
	});
});
