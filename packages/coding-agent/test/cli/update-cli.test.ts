import { afterEach, describe, expect, it, vi } from "bun:test";
import { PRODUCT_RELEASE_TAG_PREFIX } from "../../src/brand";
import { getLatestRelease, runUpdateCommand } from "../../src/cli/update-cli";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

describe("runUpdateCommand fetch cancellation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("checks release metadata with a timeout signal", async () => {
		let requestSignal: AbortSignal | undefined;
		vi.spyOn(console, "log").mockImplementation(() => {});
		const fetchStub = Object.assign(
			async (_input: FetchInput, init?: FetchInit) => {
				requestSignal = init?.signal ?? undefined;
				return Response.json({ version: "999.0.0" });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		await runUpdateCommand({ force: false, check: true });

		expect(requestSignal).toBeInstanceOf(AbortSignal);
	});
});

describe("getLatestRelease fork release channel", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function stubGithub(payload: unknown, init?: ResponseInit): string[] {
		const urls: string[] = [];
		const fetchStub = Object.assign(
			async (input: FetchInput) => {
				urls.push(String(input));
				if (init) return new Response(null, init);
				return Response.json(payload);
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
		return urls;
	}

	it("reads the fork's own GitHub release and never the npm registry or upstream repo", async () => {
		const urls = stubGithub({ tag_name: `${PRODUCT_RELEASE_TAG_PREFIX}0.3.0`, draft: false, prerelease: false });

		const release = await getLatestRelease();

		expect(release.version).toBe("0.3.0");
		expect(release.tag).toBe(`${PRODUCT_RELEASE_TAG_PREFIX}0.3.0`);
		// Binary distribution keeps the package-manager paths unreachable, so an
		// update can never run `bun add @chudware/coding-agent` over the fork.
		expect(release.dist).toBe("binary");
		expect(urls).toEqual(["https://api.github.com/repos/Hunter-124/chudcode/releases/latest"]);
		expect(urls[0]).not.toContain("registry.npmjs.org");
		expect(urls[0]).not.toContain("Hunter-124");
	});

	it("ignores an inherited upstream tag that is not namespaced to this fork", async () => {
		// The fork's 0.x line collides with 193 upstream `v0.*` tags, so an
		// un-prefixed tag must never be mistaken for a chudcode release.
		stubGithub({ tag_name: "v0.50.1", draft: false, prerelease: false });

		await expect(getLatestRelease()).rejects.toThrow(/No published release/);
	});

	it("refuses a prerelease on the stable channel", async () => {
		stubGithub({ tag_name: `${PRODUCT_RELEASE_TAG_PREFIX}0.4.0-rc.1`, draft: false, prerelease: true });

		await expect(getLatestRelease()).rejects.toThrow(/No published release/);
	});

	it("refuses a draft release", async () => {
		stubGithub({ tag_name: `${PRODUCT_RELEASE_TAG_PREFIX}0.4.0`, draft: true, prerelease: false });

		await expect(getLatestRelease()).rejects.toThrow(/No published release/);
	});

	it("takes the newest prerelease from the release list on the canary channel", async () => {
		const urls = stubGithub([
			{ tag_name: `${PRODUCT_RELEASE_TAG_PREFIX}0.4.0-canary.2`, draft: true, prerelease: true },
			{ tag_name: `${PRODUCT_RELEASE_TAG_PREFIX}0.4.0-canary.1`, draft: false, prerelease: true },
			{ tag_name: `${PRODUCT_RELEASE_TAG_PREFIX}0.3.0`, draft: false, prerelease: false },
		]);

		const release = await getLatestRelease({ channel: "canary" });

		// The draft is skipped even on canary; drafts have no downloadable assets.
		expect(release.version).toBe("0.4.0-canary.1");
		expect(urls[0]).toContain("/releases?per_page=");
	});

	it("reports rate limiting as actionable guidance instead of a bare status", async () => {
		stubGithub(null, { status: 403, statusText: "rate limit exceeded" });

		await expect(getLatestRelease()).rejects.toThrow(/GITHUB_TOKEN/);
	});

	it("reports a repository with no releases yet", async () => {
		stubGithub(null, { status: 404, statusText: "Not Found" });

		await expect(getLatestRelease()).rejects.toThrow(/No published release found/);
	});
});

describe("getLatestRelease proxy errors", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("translates Bun's UnsupportedProxyProtocol fetch failure into an actionable CLI message", async () => {
		const fetchStub = Object.assign(
			async () => {
				throw new Error(
					'UnsupportedProxyProtocol fetching "https://registry.npmjs.org/@chudware/coding-agent/latest". ' +
						"For more information, pass `verbose: true` in the second argument to fetch()",
				);
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		const err = await getLatestRelease({ timeoutMs: 5000 }).then(
			() => null,
			(e: unknown) => e as Error,
		);

		expect(err).toBeInstanceOf(Error);
		// The raw fetch() instruction the CLI user cannot act on must not leak through.
		expect(err?.message).not.toContain("verbose: true");
		expect(err?.message).not.toContain("fetch()");
		// Instead the user gets actionable guidance about supported proxy schemes.
		expect(err?.message).toMatch(/SOCKS/i);
		expect(err?.message).toMatch(/https?:\/\//i);
	});
});
