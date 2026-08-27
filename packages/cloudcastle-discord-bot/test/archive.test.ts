import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportGuild, type ReadOnlyRest } from "../src/archive";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

async function temporaryDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(tmpdir(), "discord-archive-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

function message(id: string, channelId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id,
		channel_id: channelId,
		author: { id: "900", username: "archivist", global_name: null, bot: false },
		timestamp: "2026-08-27T00:00:00.000Z",
		edited_timestamp: null,
		content: `message ${id}`,
		tts: false,
		pinned: false,
		type: 0,
		embeds: [],
		reactions: [],
		attachments: [],
		...extra,
	};
}

function query(options?: { query?: URLSearchParams }): URLSearchParams {
	return options?.query ?? new URLSearchParams();
}

function baseRest(
	channels: Record<string, unknown>[],
	handler?: (route: string, options?: { query?: URLSearchParams }) => unknown | Promise<unknown>,
): ReadOnlyRest {
	return {
		async get(route, options) {
			const handled = await handler?.(route, options);
			if (handled !== undefined) return handled;
			if (route === "/guilds/1/channels") return channels;
			if (route === "/guilds/1/threads/active") return { threads: [] };
			if (route.includes("/threads/archived/") || route.includes("/users/@me/threads/archived/private")) {
				return { threads: [], has_more: false };
			}
			if (route.endsWith("/messages")) return [];
			if (route.endsWith("/pins")) return [];
			throw new Error(`unexpected read route ${route}`);
		},
	};
}

function dependencies(rest: ReadOnlyRest, fetchImpl: typeof fetch = fetch) {
	return {
		rest,
		fetch: fetchImpl,
		now: () => new Date("2026-08-27T12:00:00.000Z"),
		secretObfuscator: undefined,
	};
}

describe("exportGuild", () => {
	test("paginates messages with an exclusive upper cutoff and renders oldest first", async () => {
		const outputDir = await temporaryDirectory();
		const calls: Array<{ route: string; before: string | null }> = [];
		const firstPage = Array.from({ length: 100 }, (_, index) => message(String(200 - index), "10"));
		const rest = baseRest(
			[{ id: "10", type: 5, name: "updates", parent_id: null, permission_overwrites: [] }],
			(route, options) => {
				if (route !== "/channels/10/messages") return undefined;
				const before = query(options).get("before");
				calls.push({ route, before });
				if (before === "201") return firstPage;
				if (before === "101") return [message("100", "10")];
				return [];
			},
		);

		const manifest = await exportGuild({
			guildId: "1",
			outputDir,
			cutoffByChannel: { "10": "201" },
			dependencies: dependencies(rest),
		});

		expect(calls).toEqual([
			{ route: "/channels/10/messages", before: "201" },
			{ route: "/channels/10/messages", before: "101" },
		]);
		expect(manifest.scopes[0]?.message_ids).toEqual(Array.from({ length: 101 }, (_, index) => String(100 + index)));
		const jsonl = await fs.readFile(path.join(outputDir, manifest.scopes[0]?.jsonl_path ?? ""), "utf8");
		expect(JSON.parse(jsonl.split("\n")[0] ?? "{}").id).toBe("100");
	});

	test("discovers active, archived public, archived private, and joined-private threads", async () => {
		const outputDir = await temporaryDirectory();
		const thread = (id: string, type = 11) => ({
			id,
			type,
			name: `thread-${id}`,
			parent_id: "10",
			permission_overwrites: [],
			thread_metadata: { archive_timestamp: `2026-08-27T00:00:0${id}.000Z` },
		});
		const rest = baseRest(
			[{ id: "10", type: 0, name: "chat", parent_id: null, permission_overwrites: [] }],
			route => {
				if (route === "/guilds/1/threads/active") return { threads: [thread("11")] };
				if (route === "/channels/10/threads/archived/public") return { threads: [thread("12")], has_more: false };
				if (route === "/channels/10/threads/archived/private")
					return { threads: [thread("13", 12)], has_more: false };
				if (route === "/channels/10/users/@me/threads/archived/private")
					return { threads: [thread("14", 12)], has_more: false };
				return undefined;
			},
		);

		const manifest = await exportGuild({ guildId: "1", outputDir, dependencies: dependencies(rest) });

		expect(manifest.scopes.map(scope => scope.id)).toEqual(["10", "11", "12", "13", "14"]);
		expect(manifest.scopes.slice(1).every(scope => scope.kind === "thread" && scope.parent_id === "10")).toBe(true);
	});

	test("uses thread snowflakes to paginate joined private archives", async () => {
		const outputDir = await temporaryDirectory();
		const cursors: Array<string | null> = [];
		const page = Array.from({ length: 100 }, (_, index) => ({
			id: String(1000 + index),
			type: 12,
			name: `private-${index}`,
			parent_id: "10",
			permission_overwrites: [],
			thread_metadata: { archive_timestamp: `2026-08-27T00:00:${String(index).padStart(2, "0")}.000Z` },
		}));
		const rest = baseRest(
			[{ id: "10", type: 0, name: "chat", parent_id: null, permission_overwrites: [] }],
			(route, options) => {
				if (route !== "/channels/10/users/@me/threads/archived/private") return undefined;
				const before = query(options).get("before");
				cursors.push(before);
				return before === null ? { threads: page, has_more: true } : { threads: [], has_more: false };
			},
		);

		await exportGuild({ guildId: "1", outputDir, dependencies: dependencies(rest) });

		expect(cursors).toEqual([null, "1099"]);
	});

	test("archives voice text chats and records scope channel types", async () => {
		const outputDir = await temporaryDirectory();
		const rest = baseRest(
			[
				{ id: "20", type: 2, name: "meeting", parent_id: null, permission_overwrites: [] },
				{ id: "21", type: 13, name: "stage", parent_id: null, permission_overwrites: [] },
			],
			route => {
				if (route === "/channels/20/pins") return { items: [{ message: { id: "99" } }] };
				return undefined;
			},
		);

		const manifest = await exportGuild({ guildId: "1", outputDir, dependencies: dependencies(rest) });

		expect(manifest.scopes.map(scope => ({ id: scope.id, type: scope.type }))).toEqual([
			{ id: "20", type: 2 },
			{ id: "21", type: 13 },
		]);
		expect(manifest.scopes[0]?.pins).toEqual(["99"]);
	});

	test("downloads attachment bytes and completely paginates reaction users", async () => {
		const outputDir = await temporaryDirectory();
		const bytes = new TextEncoder().encode("exact attachment bytes\n");
		const firstUsers = Array.from({ length: 100 }, (_, index) => ({ id: String(1000 + index) }));
		const rest = baseRest(
			[{ id: "10", type: 5, name: "updates", parent_id: null, permission_overwrites: [] }],
			(route, options) => {
				if (route === "/channels/10/messages") {
					return [
						message("20", "10", {
							reactions: [{ emoji: { id: null, name: "✅" }, count: 101 }],
							attachments: [
								{
									id: "30",
									filename: "proof.txt",
									size: 999,
									url: "https://cdn.discordapp.com/attachments/proof",
								},
							],
						}),
					];
				}
				if (route.includes("/messages/20/reactions/"))
					return query(options).get("after") ? [{ id: "1100" }] : firstUsers;
				return undefined;
			},
		);
		const fetchImpl = (async (input: RequestInfo | URL) => {
			expect(String(input)).toBe("https://cdn.discordapp.com/attachments/proof");
			return new Response("exact attachment bytes\n", { status: 200 });
		}) as typeof fetch;

		const manifest = await exportGuild({ guildId: "1", outputDir, dependencies: dependencies(rest, fetchImpl) });
		const scope = manifest.scopes[0];
		const attachment = scope?.attachments[0];

		expect(scope?.reactions[0]?.user_ids).toHaveLength(101);
		expect(attachment?.size).toBe(bytes.length);
		expect(attachment?.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
		expect(new Uint8Array(await fs.readFile(path.join(outputDir, attachment?.relative_path ?? "")))).toEqual(bytes);
	});

	test("redacts screened fields and preserves exact records in encrypted quarantine input", async () => {
		const outputDir = await temporaryDirectory();
		const rest = baseRest([{ id: "10", type: 0, name: "chat", parent_id: null, permission_overwrites: [] }], route =>
			route === "/channels/10/messages" ? [message("20", "10", { content: "credential-value" })] : undefined,
		);
		let rawTar: Uint8Array<ArrayBufferLike> = new Uint8Array();
		const deps = dependencies(rest);

		const manifest = await exportGuild({
			guildId: "1",
			outputDir,
			ageRecipientFile: "/owner-only/recipient.txt",
			dependencies: {
				...deps,
				secretObfuscator: { obfuscate: value => value.replace("credential-value", "<secret>") },
				encryptTar: async tar => {
					rawTar = tar;
					return new Uint8Array([1, 2, 3]);
				},
			},
		});

		const jsonl = await fs.readFile(path.join(outputDir, manifest.scopes[0]?.jsonl_path ?? ""), "utf8");
		expect(jsonl).toContain("[REDACTED sha256:");
		expect(jsonl).not.toContain("credential-value");
		expect(new TextDecoder().decode(rawTar)).toContain("credential-value");
		expect(manifest.redactions).toHaveLength(1);
		expect(new Uint8Array(await fs.readFile(path.join(outputDir, "raw-secret-quarantine.tar.age")))).toEqual(
			new Uint8Array([1, 2, 3]),
		);
	});

	test("records unreadable scopes as blockers after writing the manifest", async () => {
		const outputDir = await temporaryDirectory();
		const forbidden = Object.assign(new Error("not allowed"), { status: 403, code: 50001 });
		const rest = baseRest(
			[{ id: "10", type: 5, name: "updates", parent_id: null, permission_overwrites: [] }],
			route => {
				if (route === "/channels/10/messages") throw forbidden;
				return undefined;
			},
		);

		const manifest = await exportGuild({ guildId: "1", outputDir, dependencies: dependencies(rest) });
		const persisted = JSON.parse(await fs.readFile(path.join(outputDir, "manifest.json"), "utf8"));

		expect(manifest.unresolved).toEqual([
			expect.objectContaining({ scope_id: "10", operation: "messages", status: 403, code: "50001" }),
		]);
		expect(manifest.scopes[0]?.errors).toHaveLength(1);
		expect(persisted.unresolved).toEqual(manifest.unresolved);
	});
});
