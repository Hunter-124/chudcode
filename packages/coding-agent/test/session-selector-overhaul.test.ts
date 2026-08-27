import { beforeAll, describe, expect, it } from "bun:test";
import {
	formatSessionRelativeTime,
	getSessionTimeGroup,
	RECENT_SESSION_LIMIT,
	selectRecentSessions,
	SessionSelectorComponent,
} from "@oh-my-pi/pi-coding-agent/modes/components/session-selector";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";

const NOW = new Date();

function makeSession(id: string, modified: Date, overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		path: `/sessions/${id}.jsonl`,
		id,
		cwd: `/work/${id}-project`,
		created: modified,
		modified,
		messageCount: 1,
		size: 100,
		firstMessage: `First prompt for ${id}`,
		allMessagesText: `First prompt for ${id}`,
		...overrides,
	};
}

function calendarDaysAgo(days: number): Date {
	const date = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 12);
	date.setDate(date.getDate() - days);
	return date;
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function renderPlain(selector: SessionSelectorComponent, width = 160): string {
	return stripAnsi(selector.render(width).join("\n"));
}

function makeSelector(sessions: SessionInfo[], options: ConstructorParameters<typeof SessionSelectorComponent>[4] = {}) {
	return new SessionSelectorComponent(sessions, () => {}, () => {}, () => {}, {
		getTerminalRows: () => 40,
		...options,
	});
}

beforeAll(async () => {
	await initTheme(false);
});

describe("session time groups", () => {
	const today = makeSession("today", calendarDaysAgo(0));
	const yesterday = makeSession("yesterday", calendarDaysAgo(1));
	const fiveDays = makeSession("five-days", calendarDaysAgo(5));
	const thirtyDays = makeSession("thirty-days", calendarDaysAgo(30));

	it("places every calendar boundary in its named group", () => {
		expect(getSessionTimeGroup(today.modified, NOW)).toBe("Today");
		expect(getSessionTimeGroup(yesterday.modified, NOW)).toBe("Yesterday");
		expect(getSessionTimeGroup(fiveDays.modified, NOW)).toBe("Previous 7 days");
		expect(getSessionTimeGroup(thirtyDays.modified, NOW)).toBe("Older");

		const text = renderPlain(makeSelector([thirtyDays, fiveDays, yesterday, today]));
		const headings = ["Today", "Yesterday", "Previous 7 days", "Older"];
		for (const heading of headings) expect(text).toContain(heading);
		expect(headings.map(heading => text.indexOf(heading))).toEqual([...headings].map(heading => text.indexOf(heading)).sort((a, b) => a - b));
	});

	it("maps rendered rows past headers to the exact clicked session", () => {
		const selector = makeSelector([thirtyDays, fiveDays, yesterday, today]);
		const list = selector.getSessionList();
		const lines = list.render(120).map(stripAnsi);
		const headerLine = lines.findIndex(line => line.includes("Yesterday"));
		const sessionLine = lines.findIndex(line => line.includes("First prompt for yesterday"));
		expect(headerLine).toBeGreaterThanOrEqual(0);
		expect(list.hitTestSession(headerLine)).toBeUndefined();
		const hit = list.hitTestSession(sessionLine);
		expect(hit).toBeDefined();
		let selected: string | undefined;
		list.onSelect = session => {
			selected = session.id;
		};
		list.selectAndConfirm(hit!);
		expect(selected).toBe("yesterday");
	});

	it("keyboard navigation skips group headers", () => {
		const selector = makeSelector([thirtyDays, fiveDays, yesterday, today]);
		const list = selector.getSessionList();
		let selected: string | undefined;
		list.onSelect = session => {
			selected = session.id;
		};
		list.handleInput("\x1b[B");
		list.handleInput("\r");
		expect(selected).toBe("yesterday");
	});

	it("removes grouping while search ranking is active", () => {
		const oldMatch = makeSession("old-match", thirtyDays.modified, { title: "needle old" });
		const newMatch = makeSession("new-match", today.modified, { title: "needle new" });
		const selector = makeSelector([oldMatch, newMatch]);
		const list = selector.getSessionList();
		for (const character of "needle") list.handleInput(character);
		const text = stripAnsi(list.render(120).join("\n"));
		expect(text).not.toContain("Today");
		expect(text).not.toContain("Older");
		let selected: string | undefined;
		list.onSelect = session => {
			selected = session.id;
		};
		list.handleInput("\r");
		expect(selected).toBe("new-match");
	});
});

describe("recent sessions", () => {
	it("takes the ten genuinely newest sessions without mutating the source", () => {
		const sessions = Array.from({ length: 12 }, (_, index) =>
			makeSession(`s${index}`, new Date(NOW.getTime() - index * 60_000)),
		).reverse();
		const original = sessions.map(session => session.id);
		const recent = selectRecentSessions(sessions);
		expect(recent).toHaveLength(RECENT_SESSION_LIMIT);
		expect(recent.map(session => session.id)).toEqual(Array.from({ length: 10 }, (_, index) => `s${index}`));
		expect(sessions.map(session => session.id)).toEqual(original);
	});

	it("renders title fallback, relative time, project, count, and status in recency order", () => {
		const older = makeSession("older", calendarDaysAgo(1), {
			cwd: "/repos/legacy",
			messageCount: 3,
			firstMessage: "Fallback conversation title",
			status: "interrupted",
		});
		const newer = makeSession("newer", new Date(Date.now() - 3 * 60_000), {
			cwd: "/repos/current",
			messageCount: 8,
			title: "Named conversation",
			status: "complete",
		});
		const text = renderPlain(
			makeSelector([older, newer], { mode: "recent", title: "Recent Sessions", scopeLabel: false, showCwd: true }),
		);
		expect(text.indexOf("Named conversation")).toBeLessThan(text.indexOf("Fallback conversation title"));
		expect(text).toContain(formatSessionRelativeTime(newer.modified));
		expect(text).toContain("yesterday");
		expect(text).toContain("current");
		expect(text).toContain("8 msgs");
		expect(text).toContain("done");
		expect(text).toContain("legacy");
		expect(text).toContain("3 msgs");
		expect(text).toContain("interrupted");
	});

	it("dispatches /recent to the fast picker and clears the editor", async () => {
		let editorText = "/recent";
		let shown = 0;
		const ctx = {
			collabGuest: false,
			editor: {
				setText: (text: string) => {
					editorText = text;
				},
			},
			showRecentSessionSelector: () => {
				shown++;
			},
		} as unknown as InteractiveModeContext;
		expect(await executeBuiltinSlashCommand("/recent", { ctx })).toBe(true);
		expect(editorText).toBe("");
		expect(shown).toBe(1);
	});
});

describe("session inline actions", () => {
	const session = makeSession("action", calendarDaysAgo(0));

	it("forks the selected session and closes after success", async () => {
		let forked: string | undefined;
		let closed = 0;
		const selector = new SessionSelectorComponent([session], () => {}, () => closed++, () => {}, {
			onFork: async selected => {
				forked = selected.id;
				return true;
			},
		});
		selector.handleInput("\x06");
		await Promise.resolve();
		expect(forked).toBe("action");
		expect(closed).toBe(1);
	});

	it("renames the selected session through the inline editor", async () => {
		let renamed: { id: string; title: string } | undefined;
		const selector = makeSelector([session], {
			onRename: async (selected, title) => {
				renamed = { id: selected.id, title };
				return true;
			},
		});
		selector.handleInput("\x12");
		for (const character of "Renamed session") selector.handleInput(character);
		selector.handleInput("\r");
		await Promise.resolve();
		expect(renamed).toEqual({ id: "action", title: "Renamed session" });
		expect(renderPlain(selector)).toContain("Renamed session");
	});

	it("pins the selected session and exposes all action hints", async () => {
		let pinned: string | undefined;
		const selector = makeSelector([session], {
			onDelete: async () => true,
			onFork: async () => true,
			onRename: async () => true,
			onTogglePin: async selected => {
				pinned = selected.id;
				return true;
			},
			onCopyPath: async () => {},
		});
		selector.handleInput("\x10");
		await Promise.resolve();
		expect(pinned).toBe("action");
		const text = renderPlain(selector, 220);
		expect(text).toContain("Pinned session");
		expect(text).toContain("Ctrl+F fork");
		expect(text).toContain("Ctrl+R rename");
		expect(text).toContain("Ctrl+P pin/unpin");
		expect(text).toContain("Ctrl+Y copy path");
	});

	it("copies the selected session's path", async () => {
		let copied: string | undefined;
		const selector = makeSelector([session], {
			onCopyPath: async selected => {
				copied = selected.path;
			},
		});
		selector.handleInput("\x19");
		await Promise.resolve();
		expect(copied).toBe(session.path);
		expect(renderPlain(selector)).toContain("Copied session path");
	});
});
