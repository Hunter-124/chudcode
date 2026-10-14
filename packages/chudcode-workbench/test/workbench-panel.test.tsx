import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";
import { act, type ReactNode, useState } from "react";
import type { DesktopSessionInfo } from "../../chudcode-desktop/src/protocol";
import type { DesktopClient } from "../../chudcode-desktop/src/web/desktop-client";

const testWindow = parseHTML("<!doctype html><html><body></body></html>");
const browserGlobals = {
	window: testWindow,
	document: testWindow.document,
	Node: testWindow.Node,
	Element: testWindow.Element,
	HTMLElement: testWindow.HTMLElement,
	Event: testWindow.Event,
	IS_REACT_ACT_ENVIRONMENT: true,
} as const;
type BrowserGlobal = keyof typeof browserGlobals;
const previousGlobals = new Map<BrowserGlobal, PropertyDescriptor | undefined>(
	Object.keys(browserGlobals).map(key => [key as BrowserGlobal, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
function installBrowserGlobals(): void {
	for (const [key, value] of Object.entries(browserGlobals) as [BrowserGlobal, unknown][]) {
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
}
function restoreBrowserGlobals(): void {
	for (const [key, descriptor] of previousGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
}

installBrowserGlobals();
const { createRoot } = await import("react-dom/client");
const { SessionsView } = await import("../src/webview/WorkbenchPanel");
restoreBrowserGlobals();

beforeEach(installBrowserGlobals);
afterEach(restoreBrowserGlobals);

const session: DesktopSessionInfo = {
	id: "session-a",
	path: "/sessions/a.jsonl",
	cwd: "/workspace",
	title: "Session A",
	createdMs: 1,
	modifiedMs: 1,
	messageCount: 1,
	size: 1,
	status: "completed",
};

async function mount(element: ReactNode): Promise<{ container: HTMLElement; unmount(): Promise<void> }> {
	const fixture = testWindow.document.createElement("div");
	testWindow.document.body.appendChild(fixture);
	const container = fixture as unknown as HTMLElement;
	const root = createRoot(container);
	await act(async () => {
		root.render(element);
		await Promise.resolve();
	});
	return {
		container,
		async unmount(): Promise<void> {
			await act(async () => root.unmount());
			fixture.remove();
		},
	};
}

function keyboardEvent(key: string, init: { shiftKey?: boolean } = {}): InstanceType<typeof testWindow.Event> {
	const event = new testWindow.Event("keydown", { bubbles: true, cancelable: true });
	for (const [name, value] of Object.entries({ key, isComposing: false, shiftKey: false, ...init })) {
		Object.defineProperty(event, name, { configurable: true, value });
	}
	return event;
}

function inputReactProps(input: HTMLInputElement): { onChange(event: { target: HTMLInputElement }): void } {
	const key = Object.keys(input).find(candidate => candidate.startsWith("__reactProps$"));
	if (!key) throw new Error("React input props were not attached");
	return (input as unknown as Record<string, unknown>)[key] as {
		onChange(event: { target: HTMLInputElement }): void;
	};
}

function expectFocused(element: HTMLElement): void {
	expect(testWindow.document.activeElement === (element as unknown as typeof testWindow.document.activeElement)).toBe(
		true,
	);
}

describe("workbench session catalog keyboard focus", () => {
	it("restores the rename trigger after save and Escape without committing the cancelled title", async () => {
		const calls: Array<{ method: string; params: unknown }> = [];
		const client = {
			request: async (method: string, params: unknown) => {
				calls.push({ method, params });
				return {};
			},
		} as unknown as DesktopClient;
		const mounted = await mount(
			<SessionsView
				client={client}
				sessions={[session]}
				activePath={session.path}
				cwd={session.cwd}
				live
				onError={message => {
					throw new Error(message);
				}}
				onOpenChat={() => {}}
				onDelete={() => {}}
			/>,
		);
		try {
			const trigger = mounted.container.querySelector('button[aria-label="Rename session"]') as HTMLButtonElement;
			trigger.focus();
			await act(async () => trigger.click());
			const input = mounted.container.querySelector('form[aria-label="Rename session"] input') as HTMLInputElement;
			expectFocused(input);
			input.value = "Saved title";
			await act(async () => inputReactProps(input).onChange({ target: input }));
			const form = mounted.container.querySelector('form[aria-label="Rename session"]') as HTMLFormElement;
			await act(async () => {
				form.dispatchEvent(new testWindow.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
				await Promise.resolve();
			});
			expect(calls).toEqual([{ method: "session.rename", params: { path: session.path, title: "Saved title" } }]);
			expectFocused(trigger);

			await act(async () => trigger.click());
			const cancelledInput = mounted.container.querySelector(
				'form[aria-label="Rename session"] input',
			) as HTMLInputElement;
			cancelledInput.value = "Must not persist";
			await act(async () => inputReactProps(cancelledInput).onChange({ target: cancelledInput }));
			await act(async () => cancelledInput.dispatchEvent(keyboardEvent("Escape") as unknown as Event));
			expect(mounted.container.querySelector('form[aria-label="Rename session"]')).toBeNull();
			expect(calls).toHaveLength(1);
			expectFocused(trigger);
		} finally {
			await mounted.unmount();
		}
	});

	it("enters delete confirmation on Cancel, dismisses with Escape, and focuses the filter after deleting the final row", async () => {
		const calls: string[] = [];
		const client = {
			request: async (method: string) => {
				calls.push(method);
				return { deleted: true };
			},
		} as unknown as DesktopClient;
		function Catalog(): ReactNode {
			const [sessions, setSessions] = useState([session]);
			return (
				<SessionsView
					client={client}
					sessions={sessions}
					activePath={sessions[0]?.path ?? null}
					cwd={session.cwd}
					live
					onError={message => {
						throw new Error(message);
					}}
					onOpenChat={() => {}}
					onDelete={path => setSessions(current => current.filter(item => item.path !== path))}
				/>
			);
		}
		const mounted = await mount(<Catalog />);
		try {
			const trigger = mounted.container.querySelector('button[aria-label="Delete session"]') as HTMLButtonElement;
			trigger.focus();
			await act(async () => trigger.click());
			let dialog = mounted.container.querySelector('[role="alertdialog"]') as HTMLElement;
			let cancel = Array.from(dialog.querySelectorAll("button")).find(
				button => button.textContent === "Cancel",
			) as HTMLButtonElement;
			expectFocused(cancel);
			const firstAction = Array.from(dialog.querySelectorAll("button")).find(
				button => button.textContent === "Delete",
			) as HTMLButtonElement;
			await act(async () => cancel.dispatchEvent(keyboardEvent("Tab") as unknown as Event));
			expectFocused(firstAction);
			await act(async () => firstAction.dispatchEvent(keyboardEvent("Tab", { shiftKey: true }) as unknown as Event));
			expectFocused(cancel);
			await act(async () => dialog.dispatchEvent(keyboardEvent("Escape") as unknown as Event));
			expect(mounted.container.querySelector('[role="alertdialog"]')).toBeNull();
			expectFocused(trigger);
			expect(calls).toEqual([]);

			await act(async () => trigger.click());
			dialog = mounted.container.querySelector('[role="alertdialog"]') as HTMLElement;
			cancel = Array.from(dialog.querySelectorAll("button")).find(
				button => button.textContent === "Cancel",
			) as HTMLButtonElement;
			expectFocused(cancel);
			const confirm = Array.from(dialog.querySelectorAll("button")).find(
				button => button.textContent === "Delete",
			) as HTMLButtonElement;
			await act(async () => {
				confirm.click();
				await Promise.resolve();
			});
			expect(calls).toEqual(["session.delete"]);
			expect(mounted.container.textContent).toContain("Create a session to start working.");
			expectFocused(mounted.container.querySelector(".wb-filter input") as HTMLInputElement);
		} finally {
			await mounted.unmount();
		}
	});
});
