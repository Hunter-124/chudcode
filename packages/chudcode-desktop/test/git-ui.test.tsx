import { afterAll, describe, expect, it } from "bun:test";
import type { SessionSnapshot } from "@oh-my-pi/collab-web/session-client";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";
import { act, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GitSnapshot } from "../src/protocol";
import { parseUnifiedDiff } from "../src/services/git-diff";
import type { DesktopClient } from "../src/web/desktop-client";
import type { DesktopStoreSnapshot } from "../src/web/desktop-store";
import { DiffView, diffTransition, hunkUnsupportedReason } from "../src/web/git/DiffView";
import { GitPanel, groupGitFiles } from "../src/web/git/GitPanel";

const session: SessionSnapshot = {
	phase: "live",
	endedReason: null,
	header: null,
	entries: [],
	state: null,
	agents: [],
	progress: new Map(),
	lifecycle: new Map(),
	stream: null,
	streamDone: false,
	activeTools: new Map(),
	working: false,
	readOnly: false,
	uiRequest: null,
	notices: [],
};

const cleanSnapshot: GitSnapshot = {
	root: "/work",
	branch: "main",
	upstream: "origin/main",
	ahead: 0,
	behind: 0,
	files: [],
	commits: [],
};

function desktopSnapshot(git: GitSnapshot | null): DesktopStoreSnapshot {
	return {
		revision: 1,
		session,
		activeSessionPath: null,
		sessionTabs: [],
		sessionSnapshots: new Map(),
		sessions: [],
		workspaces: new Map(),
		workspaceEntries: new Map(),
		workspaceChanges: new Map(),
		documents: new Map(),
		git: git ? new Map([["workspace", git]]) : new Map(),
		terminals: new Map(),
		diagnostics: new Map(),
		graphs: new Map(),
		lastError: null,
	};
}

interface RecordedCall {
	method: string;
	params: unknown;
}

class FakeDesktopClient {
	readonly calls: RecordedCall[] = [];
	readonly #store: DesktopStoreSnapshot;
	readonly #failure: Error | null;

	constructor(snapshot: GitSnapshot | null, failure: Error | null = null) {
		this.#store = desktopSnapshot(snapshot);
		this.#failure = failure;
	}

	subscribe = (_listener: () => void): (() => void) => {
		return () => {};
	};

	getDesktopSnapshot = (): DesktopStoreSnapshot => this.#store;

	async request(method: string, params: unknown): Promise<unknown> {
		this.calls.push({ method, params });
		if (this.#failure) throw this.#failure;
		if (method === "git.branches") {
			return {
				branches: [
					{ name: "main", current: true, remote: false },
					{ name: "topic", current: false, remote: false },
				],
			};
		}
		if (method === "git.remotes") return { remotes: [] };
		if (method === "git.diff") return { unified: TEXT_DIFF };
		if (method === "git.commit") return { commit: cleanSnapshot.commits[0], snapshot: cleanSnapshot };
		return { snapshot: this.#store.git.get("workspace") ?? cleanSnapshot };
	}
}

const TEXT_DIFF = [
	"diff --git a/src/a.ts b/src/a.ts",
	"index 1111111..2222222 100644",
	"--- a/src/a.ts",
	"+++ b/src/a.ts",
	"@@ -1,2 +1,3 @@",
	" const a = 1;",
	"-old();",
	"+next();",
	"+added();",
	"",
].join("\n");

const UPDATED_DIFF = [
	"diff --git a/src/a.ts b/src/a.ts",
	"index 1111111..3333333 100644",
	"--- a/src/a.ts",
	"+++ b/src/a.ts",
	"@@ -1,2 +1,4 @@",
	" const a = 1;",
	"-old();",
	"+next();",
	"+added();",
	"+live();",
	"",
].join("\n");

const testWindow = parseHTML("<!doctype html><html><body></body></html>");
const browserGlobals = {
	window: testWindow,
	document: testWindow.document,
	Node: testWindow.Node,
	Element: testWindow.Element,
	HTMLElement: testWindow.HTMLElement,
	Event: testWindow.Event,
	navigator: testWindow.navigator,
	IS_REACT_ACT_ENVIRONMENT: true,
} as const;
type BrowserGlobal = keyof typeof browserGlobals;
const previousGlobals = new Map<BrowserGlobal, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries(browserGlobals) as [BrowserGlobal, unknown][]) {
	previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
// ReactDOM probes browser globals at initialization, so this test installs its DOM before loading the known module.
const { createRoot } = await import("react-dom/client");

afterAll(() => {
	for (const [key, descriptor] of previousGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

async function mount(element: ReactNode): Promise<{ container: HTMLElement; render(next: ReactNode): Promise<void>; unmount(): Promise<void> }> {
	const container = testWindow.document.createElement("div") as unknown as HTMLElement;
	testWindow.document.body.appendChild(container as unknown as InstanceType<typeof testWindow.HTMLElement>);
	const root = createRoot(container);
	const render = async (next: ReactNode): Promise<void> => {
		await act(async () => {
			root.render(next);
			await Promise.resolve();
		});
	};
	await render(element);
	return {
		container,
		render,
		async unmount(): Promise<void> {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

function reactProps<T>(element: Element): T {
	const key = Object.keys(element).find(candidate => candidate.startsWith("__reactProps$"));
	if (!key) throw new Error("React props were not attached");
	return (element as unknown as Record<string, unknown>)[key] as T;
}

describe("Git source control grouping and actions", () => {
	it("groups conflicts, staged, changes, and untracked without losing dual-state files", () => {
		const groups = groupGitFiles([
			{ path: "both.ts", staged: "modified", unstaged: "modified", untracked: false },
			{ path: "conflict.ts", staged: "unmerged", unstaged: "unmerged", untracked: false },
			{ path: "new.ts", staged: "", unstaged: "untracked", untracked: true },
		]);
		expect(groups.conflicts.map(file => file.path)).toEqual(["conflict.ts"]);
		expect(groups.staged.map(file => file.path)).toEqual(["both.ts"]);
		expect(groups.changes.map(file => file.path)).toEqual(["both.ts"]);
		expect(groups.untracked.map(file => file.path)).toEqual(["new.ts"]);
	});

	it("passes hostile filenames as request data rather than markup or command text", async () => {
		const hostile = `src/; $(touch owned) <img src=x onerror=alert(1)>.ts`;
		const snapshot = { ...cleanSnapshot, files: [{ path: hostile, staged: "", unstaged: "modified", untracked: false }] };
		const fake = new FakeDesktopClient(snapshot);
		const mounted = await mount(<GitPanel client={fake as unknown as DesktopClient} workspaceId="workspace" />);
		const stageButton = [...mounted.container.querySelectorAll("button")].find(button => button.getAttribute("aria-label") === `Stage ${hostile}`);
		expect(stageButton).toBeDefined();
		expect(mounted.container.querySelector("img")).toBeNull();
		await act(async () => stageButton!.click());
		expect(fake.calls).toContainEqual({ method: "git.stage", params: { workspaceId: "workspace", paths: [hostile] } });
		await mounted.unmount();
	});

	it("validates commits before dispatch and sends a trimmed message once staged content exists", async () => {
		const snapshot = { ...cleanSnapshot, files: [{ path: "ready.ts", staged: "modified", unstaged: "", untracked: false }] };
		const fake = new FakeDesktopClient(snapshot);
		const mounted = await mount(<GitPanel client={fake as unknown as DesktopClient} workspaceId="workspace" />);
		const textarea = mounted.container.querySelector("textarea") as HTMLTextAreaElement;
		const commitButton = [...mounted.container.querySelectorAll("button")].find(button => button.textContent?.startsWith("Commit "))!;
		expect(commitButton.hasAttribute("disabled")).toBe(true);
		await act(async () => {
			reactProps<{ onChange(event: { target: HTMLTextAreaElement }): void }>(textarea).onChange({ target: Object.assign(textarea, { value: "  ship it  " }) });
		});
		expect(commitButton.hasAttribute("disabled")).toBe(false);
		await act(async () => commitButton.click());
		expect(fake.calls).toContainEqual({ method: "git.commit", params: { workspaceId: "workspace", message: "ship it" } });
		await mounted.unmount();
	});

	it("routes whole-tree, checkout, and branch creation actions through typed Git methods", async () => {
		const snapshot = {
			...cleanSnapshot,
			files: [
				{ path: "staged.ts", staged: "modified", unstaged: "", untracked: false },
				{ path: "changed.ts", staged: "", unstaged: "modified", untracked: false },
			],
		};
		const fake = new FakeDesktopClient(snapshot);
		const mounted = await mount(<GitPanel client={fake as unknown as DesktopClient} workspaceId="workspace" />);
		const buttonNamed = (name: string) =>
			[...mounted.container.querySelectorAll("button")].find(button => button.textContent === name)!;

		await act(async () => buttonNamed("Unstage all").click());
		await act(async () => buttonNamed("Stage all").click());
		await act(async () => {
			const checkoutButtons = [...mounted.container.querySelectorAll("button")].filter(button => button.textContent === "Checkout");
			checkoutButtons.at(-1)!.click();
		});

		const branchInput = mounted.container.querySelector('input[placeholder="feature/name"]') as HTMLInputElement;
		await act(async () => {
			reactProps<{ onChange(event: { target: HTMLInputElement }): void }>(branchInput).onChange({
				target: Object.assign(branchInput, { value: "feature/safe" }),
			});
		});
		await act(async () => buttonNamed("Create branch").click());

		expect(fake.calls).toContainEqual({ method: "git.unstage", params: { workspaceId: "workspace", paths: [] } });
		expect(fake.calls).toContainEqual({ method: "git.stage", params: { workspaceId: "workspace", paths: [] } });
		expect(fake.calls).toContainEqual({ method: "git.checkout", params: { workspaceId: "workspace", ref: "topic" } });
		expect(fake.calls).toContainEqual({
			method: "git.branch.create",
			params: { workspaceId: "workspace", name: "feature/safe", checkout: true },
		});
		await mounted.unmount();
	});
});

describe("parsed diff behavior", () => {
	it("gates unsafe binary, rename, mode, and submodule hunks with an explanation", () => {
		const cases = [
			[
				"diff --git a/a.bin b/a.bin",
				"Binary files a/a.bin and b/a.bin differ",
				"",
			].join("\n"),
			[
				"diff --git a/old.ts b/new.ts",
				"similarity index 100%",
				"rename from old.ts",
				"rename to new.ts",
				"",
			].join("\n"),
			[
				"diff --git a/run.sh b/run.sh",
				"old mode 100644",
				"new mode 100755",
				"",
			].join("\n"),
			[
				"diff --git a/vendor b/vendor",
				"index 1111111..2222222 160000",
				"--- a/vendor",
				"+++ b/vendor",
				"@@ -1 +1 @@",
				"-Subproject commit 1111111",
				"+Subproject commit 2222222",
				"",
			].join("\n"),
		];
		for (const unified of cases) {
			const file = parseUnifiedDiff(unified).files[0]!;
			expect(hunkUnsupportedReason(file)).not.toBeNull();
			const html = renderToStaticMarkup(<DiffView unified={unified} path={file.newPath ?? file.oldPath ?? "file"} hunkActionsAvailable onHunkAction={() => {}} />);
			expect(html).toContain("Hunk actions unavailable");
			expect(html).not.toContain("Stage hunk");
		}
	});

	it("requires destructive revert confirmation before calling the backend", async () => {
		const requests: string[] = [];
		const mounted = await mount(
			<DiffView
				unified={TEXT_DIFF}
				path="src/a.ts"
				hunkActionsAvailable
				confirmRevert={() => false}
				onHunkAction={request => {
					requests.push(request.action);
				}}
			/>,
		);
		const hunkButton = mounted.container.querySelector(".git-hunk__select") as HTMLButtonElement;
		await act(async () => hunkButton.click());
		const revert = [...mounted.container.querySelectorAll("button")].find(button => button.textContent?.includes("Revert hunk"))!;
		await act(async () => revert.click());
		expect(requests).toEqual([]);
		await mounted.unmount();
	});

	it("marks live line revisions for motion and lets reduced motion snap", async () => {
		const before = parseUnifiedDiff(TEXT_DIFF);
		const after = parseUnifiedDiff(UPDATED_DIFF);
		const transition = diffTransition(before, after);
		expect(transition.entered.size).toBeGreaterThan(0);

		const mounted = await mount(<DiffView unified={TEXT_DIFF} revision={1} path="src/a.ts" />);
		await mounted.render(<DiffView unified={UPDATED_DIFF} revision={2} path="src/a.ts" reducedMotion />);
		const diff = mounted.container.querySelector(".git-diff")!;
		expect(diff.getAttribute("data-reduced-motion")).toBe("true");
		expect(mounted.container.querySelectorAll('[data-motion-state="new"]').length).toBeGreaterThan(0);
		expect(mounted.container.querySelectorAll(".motion-diff-line-enter").length).toBeGreaterThan(0);
		await mounted.unmount();
	});

	it("renders named parser and protocol error states", async () => {
		const malformed = renderToStaticMarkup(<DiffView unified={`${TEXT_DIFF}bad hunk line\n`} />);
		expect(malformed).toContain("Git diff unavailable");

		const fake = new FakeDesktopClient(null, new Error("git executable unavailable"));
		const mounted = await mount(<GitPanel client={fake as unknown as DesktopClient} workspaceId="workspace" />);
		expect(mounted.container.textContent).toContain("Source Control unavailable");
		expect(mounted.container.textContent).toContain("Local Git service: git executable unavailable");
		await mounted.unmount();
	});
});
