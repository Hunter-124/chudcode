import { afterAll, describe, expect, it, vi } from "bun:test";
import type { CollabUiResponseValue, ImageContent } from "@chudware/wire";
import { parseHTML } from "@chudware/utils/dom";
import { act, type KeyboardEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Composer, type ComposerProps, shouldSubmitOnEnter } from "../src/components/shell/Composer";
import type { SessionClient, SessionSnapshot, TranscriptResult } from "../src/lib/session-client";

type ClientCall =
	| { method: "prompt"; text: string; images?: ImageContent[] }
	| { method: "abort" }
	| { method: "ui-response"; reqId: number; value?: CollabUiResponseValue };

class FakeSessionClient implements SessionClient {
	readonly calls: ClientCall[] = [];

	constructor(readonly currentSnapshot: SessionSnapshot) {}

	subscribe(_listener: () => void): () => void {
		return () => {};
	}

	getSnapshot(): SessionSnapshot {
		return this.currentSnapshot;
	}

	sendPrompt(text: string, images?: ImageContent[]): void {
		this.calls.push(images && images.length > 0 ? { method: "prompt", text, images } : { method: "prompt", text });
	}

	sendAbort(): void {
		this.calls.push({ method: "abort" });
	}

	sendUiResponse(reqId: number, value?: CollabUiResponseValue): void {
		this.calls.push(value === undefined ? { method: "ui-response", reqId } : { method: "ui-response", reqId, value });
	}

	sendAgentCmd(_cmd: "chat" | "kill" | "revive", _agentId: string, _text?: string): void {}

	fetchTranscript(_agentId: string, _fromByte: number): Promise<TranscriptResult | null> {
		return Promise.resolve(null);
	}
}

function snapshot(uiRequest: SessionSnapshot["uiRequest"] = null): SessionSnapshot {
	return {
		phase: "live",
		endedReason: null,
		header: null,
		entries: [],
		state: { isStreaming: true, queuedMessageCount: 0, cwd: "/work", participants: [] },
		agents: [],
		progress: new Map(),
		lifecycle: new Map(),
		stream: null,
		streamDone: false,
		activeTools: new Map(),
		working: true,
		readOnly: false,
		uiRequest,
		notices: [],
	};
}

const client = new FakeSessionClient(snapshot());

const testWindow = parseHTML("<!doctype html><html><body></body></html>");
const browserGlobals = {
	window: testWindow,
	document: testWindow.document,
	Node: testWindow.Node,
	Element: testWindow.Element,
	HTMLElement: testWindow.HTMLElement,
	HTMLIFrameElement: testWindow.HTMLIFrameElement,
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

// ReactDOM probes browser globals during module initialization, so the DOM fixture must be installed first.
const { createRoot } = await import("react-dom/client");

afterAll(() => {
	for (const [key, descriptor] of previousGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

type DraftProps = Pick<ComposerProps, "draft" | "onDraftChange">;

interface MountedComposer {
	container: HTMLElement;
	render(nextSnapshot: SessionSnapshot, nextDraftProps?: DraftProps): Promise<void>;
	unmount(): Promise<void>;
}

async function mountComposer(
	fakeClient: SessionClient,
	initialSnapshot: SessionSnapshot,
	initialDraftProps: DraftProps = {},
): Promise<MountedComposer> {
	const container = testWindow.document.createElement("div") as unknown as HTMLElement;
	testWindow.document.body.appendChild(container as unknown as InstanceType<typeof testWindow.HTMLElement>);
	const root = createRoot(container);
	let draftProps = initialDraftProps;
	const render = async (nextSnapshot: SessionSnapshot, nextDraftProps?: DraftProps): Promise<void> => {
		if (nextDraftProps !== undefined) draftProps = nextDraftProps;
		await act(async () => {
			root.render(
				<Composer
					client={fakeClient}
					snapshot={nextSnapshot}
					draft={draftProps.draft}
					onDraftChange={draftProps.onDraftChange}
				/>,
			);
		});
	};
	await render(initialSnapshot, initialDraftProps);
	return {
		container,
		render,
		async unmount(): Promise<void> {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

interface TextareaReactProps {
	value: string;
	onChange(event: { target: HTMLTextAreaElement }): void;
	onKeyDown(event: KeyEvt): void;
}

function textareaReactProps(textarea: HTMLTextAreaElement): TextareaReactProps {
	const propsKey = Object.keys(textarea).find(key => key.startsWith("__reactProps$"));
	if (!propsKey) throw new Error("React textarea props were not attached");
	return (textarea as unknown as Record<string, unknown>)[propsKey] as TextareaReactProps;
}

async function editTextarea(
	textarea: HTMLTextAreaElement,
	value: string,
	selectionStart: number,
	selectionEnd: number,
): Promise<void> {
	textarea.value = value;
	textarea.selectionStart = selectionStart;
	textarea.selectionEnd = selectionEnd;
	await act(async () => {
		textareaReactProps(textarea).onChange({ target: textarea });
	});
}

describe("Composer host UI requests", () => {
	it("renders selectable ask responses for mobile guests", () => {
		const html = renderToStaticMarkup(
			<Composer
				client={client}
				snapshot={snapshot({
					reqId: 1,
					kind: "select",
					title: "Continue?",
					options: ["Yes", { label: "No", description: "Stop here" }],
					selectionMarker: "radio",
				})}
			/>,
		);

		expect(html).toContain("Continue?");
		expect(html).toContain("Yes");
		expect(html).toContain("Stop here");
	});

	it("renders a submit field for custom ask responses", () => {
		const html = renderToStaticMarkup(
			<Composer client={client} snapshot={snapshot({ reqId: 2, kind: "editor", title: "Other", prefill: "draft" })} />,
		);

		expect(html).toContain("Other");
		expect(html).toContain("draft");
		expect(html).toContain("Submit");
	});

	it("keeps the editor submit enabled for whitespace-only drafts", () => {
		const html = renderToStaticMarkup(
			<Composer client={client} snapshot={snapshot({ reqId: 3, kind: "editor", title: "Other", prefill: "   " })} />,
		);

		const submit = { found: false, disabled: false };
		new HTMLRewriter()
			.on('button[title="submit response"]', {
				element(el) {
					submit.found = true;
					submit.disabled = el.hasAttribute("disabled");
				},
			})
			.transform(html);

		expect(submit.found).toBe(true);
		expect(submit.disabled).toBe(false);
	});
});

describe("Composer SessionClient commands", () => {
	it("submits and clears an uncontrolled draft through the structural session seam", async () => {
		const current = snapshot();
		const fakeClient = new FakeSessionClient(current);
		const mounted = await mountComposer(fakeClient, current);
		try {
			const textarea = mounted.container.querySelector("textarea") as HTMLTextAreaElement;
			await editTextarea(textarea, "  hello from textarea  ", 8, 12);
			const preventDefault = vi.fn();
			await act(async () => {
				textareaReactProps(textarea).onKeyDown(keydown("Enter", { preventDefault }));
			});

			expect(preventDefault).toHaveBeenCalledTimes(1);
			expect(fakeClient.calls).toEqual([{ method: "prompt", text: "hello from textarea" }]);
			expect((mounted.container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
		} finally {
			await mounted.unmount();
		}
	});

	it("preserves the native textarea caret and range across interaction and prop rerenders", async () => {
		const current = snapshot();
		const fakeClient = new FakeSessionClient(current);
		const mounted = await mountComposer(fakeClient, current);
		try {
			const textarea = mounted.container.querySelector("textarea") as HTMLTextAreaElement;
			await editTextarea(textarea, "alpha beta gamma", 6, 10);
			const afterInput = mounted.container.querySelector("textarea") as HTMLTextAreaElement;
			expect(afterInput).toBe(textarea);
			expect(afterInput.value).toBe("alpha beta gamma");
			expect(afterInput.selectionStart).toBe(6);
			expect(afterInput.selectionEnd).toBe(10);

			await mounted.render({ ...current, working: false });
			const afterPropRender = mounted.container.querySelector("textarea") as HTMLTextAreaElement;
			expect(afterPropRender).toBe(textarea);
			expect(afterPropRender.value).toBe("alpha beta gamma");
			expect(afterPropRender.selectionStart).toBe(6);
			expect(afterPropRender.selectionEnd).toBe(10);
		} finally {
			await mounted.unmount();
		}
	});

	it("forwards select and cancel responses through sendUiResponse", async () => {
		const current = snapshot({
			reqId: 11,
			kind: "select",
			title: "Continue?",
			options: ["Yes", "No"],
			selectionMarker: "radio",
		});
		const fakeClient = new FakeSessionClient(current);
		const mounted = await mountComposer(fakeClient, current);
		try {
			const option = mounted.container.querySelector(".sh-ask-option") as HTMLElement;
			const cancel = Array.from(mounted.container.querySelectorAll("button")).find(button => button.textContent === "Cancel");
			expect(cancel).toBeDefined();
			await act(async () => {
				option.click();
				cancel?.click();
			});

			expect(fakeClient.calls).toEqual([
				{ method: "ui-response", reqId: 11, value: "Yes" },
				{ method: "ui-response", reqId: 11 },
			]);
		} finally {
			await mounted.unmount();
		}
	});

	it("forwards Stop through sendAbort", async () => {
		const current = snapshot();
		const fakeClient = new FakeSessionClient(current);
		const mounted = await mountComposer(fakeClient, current);
		try {
			const stop = mounted.container.querySelector('button[title="stop the current turn"]') as HTMLElement;
			await act(async () => stop.click());
			expect(fakeClient.calls).toEqual([{ method: "abort" }]);
		} finally {
			await mounted.unmount();
		}
	});
});

describe("Composer controlled drafts", () => {
	it("renders the active tab draft when controlled props switch", async () => {
		const current = snapshot();
		const fakeClient = new FakeSessionClient(current);
		const onDraftChange = vi.fn();
		const mounted = await mountComposer(fakeClient, current, { draft: "first tab", onDraftChange });
		try {
			const textarea = mounted.container.querySelector("textarea") as HTMLTextAreaElement;
			expect(textareaReactProps(textarea).value).toBe("first tab");

			await mounted.render(current, { draft: "second tab", onDraftChange });
			expect(mounted.container.querySelector("textarea")).toBe(textarea);
			expect(textareaReactProps(textarea).value).toBe("second tab");
		} finally {
			await mounted.unmount();
		}
	});

	it("routes controlled edits to the parent draft callback", async () => {
		const current = snapshot();
		const fakeClient = new FakeSessionClient(current);
		const onDraftChange = vi.fn();
		const mounted = await mountComposer(fakeClient, current, { draft: "before", onDraftChange });
		try {
			const textarea = mounted.container.querySelector("textarea") as HTMLTextAreaElement;
			await editTextarea(textarea, "after paste", 5, 5);
			expect(onDraftChange).toHaveBeenCalledTimes(1);
			expect(onDraftChange).toHaveBeenCalledWith("after paste");
		} finally {
			await mounted.unmount();
		}
	});

	it("clears the parent-owned draft after an accepted send", async () => {
		const current = snapshot();
		const fakeClient = new FakeSessionClient(current);
		const onDraftChange = vi.fn();
		const mounted = await mountComposer(fakeClient, current, { draft: "  send me  ", onDraftChange });
		try {
			const send = mounted.container.querySelector('button[title="send (Enter)"]') as HTMLElement;
			await act(async () => send.click());
			expect(fakeClient.calls).toEqual([{ method: "prompt", text: "send me" }]);
			expect(onDraftChange).toHaveBeenCalledTimes(1);
			expect(onDraftChange).toHaveBeenCalledWith("");
		} finally {
			await mounted.unmount();
		}
	});

	it("keeps local state when only onDraftChange is supplied", async () => {
		const current = snapshot();
		const fakeClient = new FakeSessionClient(current);
		const onDraftChange = vi.fn();
		const mounted = await mountComposer(fakeClient, current, { onDraftChange });
		try {
			const textarea = mounted.container.querySelector("textarea") as HTMLTextAreaElement;
			await editTextarea(textarea, "local draft", 11, 11);
			expect(textarea.value).toBe("local draft");
			expect(onDraftChange).not.toHaveBeenCalled();
		} finally {
			await mounted.unmount();
		}
	});
});

type KeyEvt = KeyboardEvent<HTMLTextAreaElement>;

function keydown(
	key: string,
	opts: { shiftKey?: boolean; isComposing?: boolean; preventDefault?: () => void } = {},
): KeyEvt {
	return {
		key,
		shiftKey: opts.shiftKey ?? false,
		nativeEvent: { isComposing: opts.isComposing ?? false },
		preventDefault: opts.preventDefault ?? (() => {}),
	} as KeyEvt;
}

describe("shouldSubmitOnEnter IME guard", () => {
	it("submits on a plain Enter with no composition", () => {
		expect(shouldSubmitOnEnter(keydown("Enter"), false)).toBe(true);
	});

	it("does not submit while nativeEvent.isComposing is true", () => {
		expect(shouldSubmitOnEnter(keydown("Enter", { isComposing: true }), false)).toBe(false);
	});

	it("does not submit while the WebKit composing ref is still set", () => {
		expect(shouldSubmitOnEnter(keydown("Enter"), true)).toBe(false);
	});

	it("does not submit on Shift+Enter (newline)", () => {
		expect(shouldSubmitOnEnter(keydown("Enter", { shiftKey: true }), false)).toBe(false);
	});

	it("ignores non-Enter keys", () => {
		expect(shouldSubmitOnEnter(keydown("a"), false)).toBe(false);
	});
});
