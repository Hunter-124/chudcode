#!/usr/bin/env bun
/**
 * Cross-runner release transport through the tag's DRAFT GitHub release.
 *
 * Release jobs run on three machines (Linux, Intel Mac, Windows). GitHub
 * workflow artifacts moved files between them, but artifacts count against the
 * account's Actions storage quota; a full quota blocked every release upload.
 * Release assets do not count against that quota, so producers attach files to
 * the tag's draft release and consumers download them from it. `publish`
 * removes the staging-only assets and makes the draft public.
 *
 * Usage (GITHUB_TOKEN and GITHUB_REPOSITORY from the job environment):
 *   bun scripts/ci-release-transport.ts draft   --tag <tag> [--target <sha>] (prints release-id=<id> to $GITHUB_OUTPUT)
 *   bun scripts/ci-release-transport.ts put     --release-id <id> --file <path> [--name <asset>]
 *   bun scripts/ci-release-transport.ts get     --release-id <id> --name <asset> --out <path>
 *   bun scripts/ci-release-transport.ts put-natives --release-id <id> --root <dir> --targets "<t>..."
 *   bun scripts/ci-release-transport.ts get-natives --release-id <id> --targets "<t>..." --out <dir>
 *   bun scripts/ci-release-transport.ts publish --release-id <id> --tag <tag>
 *
 * Native addons travel as `stage-natives-<target>--<file>` and land in
 * `<out>/natives-<target>/<file>`, the layout `bazel-natives.ts --source` reads.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PRODUCT_RELEASE_TAG_PREFIX, PRODUCT_SEMVER } from "../packages/coding-agent/src/brand";

const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";
const STAGE_NATIVES = "stage-natives-";

interface Asset {
	id: number;
	name: string;
	size: number;
}

interface Release {
	id: number;
	tag_name: string;
	draft: boolean;
	target_commitish: string;
}

function fail(message: string): never {
	console.error(`::error::${message}`);
	process.exit(1);
}

function env(name: string): string {
	const value = Bun.env[name]?.trim();
	if (!value) fail(`${name} is not set`);
	return value;
}

function args(argv: string[]): Map<string, string> {
	const out = new Map<string, string>();
	for (let i = 0; i < argv.length; i += 2) {
		const key = argv[i];
		const value = argv[i + 1];
		if (!key?.startsWith("--") || value === undefined) fail(`bad argument list near ${key ?? "<end>"}`);
		out.set(key.slice(2), value);
	}
	return out;
}

function required(opts: Map<string, string>, key: string): string {
	const value = opts.get(key);
	if (!value) fail(`--${key} is required`);
	return value;
}

const repo = (): string => env("GITHUB_REPOSITORY");

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAsset(value: unknown): Asset {
	if (
		!isRecord(value) ||
		typeof value.id !== "number" ||
		typeof value.name !== "string" ||
		typeof value.size !== "number"
	)
		fail(`unexpected release asset shape: ${JSON.stringify(value).slice(0, 200)}`);
	return { id: value.id, name: value.name, size: value.size };
}

function parseRelease(value: unknown): Release {
	if (
		!isRecord(value) ||
		typeof value.id !== "number" ||
		typeof value.tag_name !== "string" ||
		typeof value.draft !== "boolean" ||
		typeof value.target_commitish !== "string"
	)
		fail(`unexpected release shape: ${JSON.stringify(value).slice(0, 200)}`);
	return { id: value.id, tag_name: value.tag_name, draft: value.draft, target_commitish: value.target_commitish };
}

function parseList<T>(value: unknown, parse: (item: unknown) => T): T[] {
	if (!Array.isArray(value)) fail(`expected a JSON array, got ${JSON.stringify(value).slice(0, 200)}`);
	return value.map(parse);
}

async function request(url: string, init: RequestInit = {}, okStatuses = [200, 201, 204]): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${env("GITHUB_TOKEN")}`);
	headers.set("X-GitHub-Api-Version", "2022-11-28");
	if (!headers.has("Accept")) headers.set("Accept", "application/vnd.github+json");
	let last = "";
	for (let attempt = 1; attempt <= 5; attempt++) {
		const res = await fetch(url, { ...init, headers, redirect: "follow" });
		if (okStatuses.includes(res.status)) return res;
		last = `${res.status} ${await res.text().catch(() => "")}`.slice(0, 500);
		// 4xx other than rate limits will not change on retry.
		if (res.status < 500 && res.status !== 403 && res.status !== 429) break;
		await Bun.sleep(attempt * 3000);
	}
	fail(`${init.method ?? "GET"} ${url} failed: ${last}`);
}

async function listReleases(): Promise<Release[]> {
	const out: Release[] = [];
	for (let page = 1; page <= 10; page++) {
		const res = await request(`${API}/repos/${repo()}/releases?per_page=100&page=${page}`);
		const batch = parseList(await res.json(), parseRelease);
		out.push(...batch);
		if (batch.length < 100) break;
	}
	return out;
}

async function releaseById(id: string): Promise<Release> {
	const res = await request(`${API}/repos/${repo()}/releases/${id}`);
	return parseRelease(await res.json());
}

async function assets(id: string): Promise<Asset[]> {
	const out: Asset[] = [];
	for (let page = 1; page <= 10; page++) {
		const res = await request(`${API}/repos/${repo()}/releases/${id}/assets?per_page=100&page=${page}`);
		const batch = parseList(await res.json(), parseAsset);
		out.push(...batch);
		if (batch.length < 100) break;
	}
	return out;
}

async function deleteAsset(asset: Asset): Promise<void> {
	await request(`${API}/repos/${repo()}/releases/assets/${asset.id}`, { method: "DELETE" });
}

async function draft(tag: string, target?: string): Promise<void> {
	if (target && !/^[0-9a-f]{40}$/.test(target)) fail("--target must be a full Git commit SHA");
	const existing = (await listReleases()).filter(r => r.tag_name === tag);
	if (existing.some(r => !r.draft)) fail(`release ${tag} is already published`);
	if (target && existing.some(r => r.target_commitish !== target))
		fail(`draft release ${tag} belongs to a different source revision`);
	let id = existing[0]?.id;
	if (id === undefined) {
		const res = await request(`${API}/repos/${repo()}/releases`, {
			method: "POST",
			body: JSON.stringify({ tag_name: tag, name: tag, draft: true, target_commitish: target }),
		});
		id = parseRelease(await res.json()).id;
		console.log(`created draft release ${id} for ${tag}`);
	} else {
		console.log(`reusing draft release ${id} for ${tag}`);
	}
	const output = Bun.env.GITHUB_OUTPUT;
	if (output) await fs.appendFile(output, `release-id=${id}\n`);
	else console.log(`release-id=${id}`);
}

async function put(id: string, file: string, name: string): Promise<void> {
	if (!(await releaseById(id)).draft) fail(`refusing to modify published release ${id}`);
	const bytes = await fs.readFile(file);
	if (bytes.length === 0) fail(`${file} is empty`);
	for (const asset of await assets(id)) if (asset.name === name) await deleteAsset(asset);
	await request(`${UPLOADS}/repos/${repo()}/releases/${id}/assets?name=${encodeURIComponent(name)}`, {
		method: "POST",
		headers: { "Content-Type": "application/octet-stream" },
		body: bytes,
	});
	console.log(`uploaded ${name} (${bytes.length} bytes)`);
}

async function get(id: string, name: string, out: string): Promise<void> {
	const asset = (await assets(id)).find(a => a.name === name);
	if (!asset) fail(`release ${id} has no asset ${name}`);
	const res = await request(`${API}/repos/${repo()}/releases/assets/${asset.id}`, {
		headers: { Accept: "application/octet-stream" },
	});
	const bytes = new Uint8Array(await res.arrayBuffer());
	if (bytes.length !== asset.size) fail(`${name}: downloaded ${bytes.length} bytes, expected ${asset.size}`);
	await fs.mkdir(path.dirname(out), { recursive: true });
	await fs.writeFile(out, bytes);
	if (process.platform !== "win32" && !name.endsWith(".sha256") && !name.includes(".")) await fs.chmod(out, 0o755);
	console.log(`downloaded ${name} -> ${out}`);
}

function targetList(raw: string): string[] {
	const targets = raw.split(/\s+/).filter(Boolean);
	if (targets.length === 0) fail("--targets is empty");
	return targets;
}

async function putNatives(id: string, root: string, targets: string[]): Promise<void> {
	for (const target of targets) {
		const dir = path.join(root, `natives-${target}`);
		const files = (await fs.readdir(dir)).filter(f => f.endsWith(".node"));
		if (files.length === 0) fail(`${dir} has no .node file`);
		for (const file of files) await put(id, path.join(dir, file), `${STAGE_NATIVES}${target}--${file}`);
	}
}

async function getNatives(id: string, targets: string[], out: string): Promise<void> {
	const all = await assets(id);
	for (const target of targets) {
		const prefix = `${STAGE_NATIVES}${target}--`;
		const matches = all.filter(a => a.name.startsWith(prefix));
		if (matches.length === 0) fail(`release ${id} has no staged native addon for ${target}`);
		for (const asset of matches) {
			await get(id, asset.name, path.join(out, `natives-${target}`, asset.name.slice(prefix.length)));
		}
	}
}

async function publish(id: string, tag: string): Promise<void> {
	const expectedTag = `${PRODUCT_RELEASE_TAG_PREFIX}${PRODUCT_SEMVER}`;
	if (tag !== expectedTag)
		fail(`only the product release ${expectedTag} may become latest; ${tag} must remain a candidate`);
	const release = await releaseById(id);
	if (!release.draft) fail(`release ${id} is already published`);
	if (release.tag_name !== tag) fail(`release ${id} is for ${release.tag_name}, not ${tag}`);
	for (const asset of await assets(id)) if (asset.name.startsWith(STAGE_NATIVES)) await deleteAsset(asset);
	const notes = await request(`${API}/repos/${repo()}/releases/generate-notes`, {
		method: "POST",
		body: JSON.stringify({ tag_name: tag }),
	});
	const generated: unknown = await notes.json();
	const body = isRecord(generated) && typeof generated.body === "string" ? generated.body : "";
	await request(`${API}/repos/${repo()}/releases/${id}`, {
		method: "PATCH",
		body: JSON.stringify({ draft: false, name: tag, body, make_latest: "true" }),
	});
	console.log(`published ${tag} (release ${id})`);
}

const [command, ...rest] = process.argv.slice(2);
const opts = args(rest);
switch (command) {
	case "draft":
		await draft(required(opts, "tag"), opts.get("target"));
		break;
	case "put": {
		const file = required(opts, "file");
		await put(required(opts, "release-id"), file, opts.get("name") ?? path.basename(file));
		break;
	}
	case "get":
		await get(required(opts, "release-id"), required(opts, "name"), required(opts, "out"));
		break;
	case "put-natives":
		await putNatives(required(opts, "release-id"), required(opts, "root"), targetList(required(opts, "targets")));
		break;
	case "get-natives":
		await getNatives(required(opts, "release-id"), targetList(required(opts, "targets")), required(opts, "out"));
		break;
	case "publish":
		await publish(required(opts, "release-id"), required(opts, "tag"));
		break;
	default:
		fail(`unknown command ${command ?? "<none>"}`);
}
