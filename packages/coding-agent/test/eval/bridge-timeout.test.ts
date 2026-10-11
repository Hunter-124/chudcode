import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Settings } from "../../src/config/settings";
import {
	EVAL_TIMEOUT_PAUSE_OP,
	EVAL_TIMEOUT_RESUME_OP,
	isEvalTimeoutControlEvent,
	withBridgeTimeoutPause,
} from "../../src/eval/bridge-timeout";
import { executeWithKernelBase, type GenericKernel } from "../../src/eval/executor-base";
import {
	formatKernelReplacedNotice,
	formatSessionKernelTimeoutAnnotation,
} from "../../src/eval/kernel-session-registry";
import { callSessionTool } from "../../src/eval/js/tool-bridge";
import type { JsStatusEvent } from "../../src/eval/js/shared/types";
import type { KernelDisplayOutput } from "../../src/eval/py/display";
import * as pyToolBridge from "../../src/eval/py/tool-bridge";
import { RpcHostToolBridge } from "../../src/modes/rpc/host-tools";
import type { RpcHostToolCallRequest, RpcHostToolCancelRequest } from "../../src/modes/rpc/rpc-types";
import type { ToolSession } from "../../src/tools";

/** Minimal `ToolSession` exposing `tools` to the eval tool bridge. */
function makeToolSession(...tools: AgentTool[]): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false }),
		taskDepth: 0,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getActiveModelString: () => "p/active",
		getModelString: () => "p/fallback",
		getArtifactsDir: () => null,
		getSessionId: () => "bridge-timeout-session",
		getEvalSessionId: () => "bridge-timeout-eval-session",
		getToolByName: name => tools.find(tool => tool.name === name),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(async () => {
	await pyToolBridge.disposePyToolBridge();
});

describe("withBridgeTimeoutPause", () => {
	it("emits one pause before the operation and one resume after it settles", async () => {
		const events: JsStatusEvent[] = [];

		const value = await withBridgeTimeoutPause(
			event => events.push(event),
			async () => {
				await Bun.sleep(80);
				return "done";
			},
			{ deferExternalAbort: true },
		);

		expect(value).toBe("done");
		expect(events.map(event => event.op)).toEqual([EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_RESUME_OP]);
		expect(events.every(event => event.deferExternalAbort === true)).toBe(true);

		const settledCount = events.length;
		await Bun.sleep(40);
		expect(events.length).toBe(settledCount);
	});

	it("resumes timeout accounting even when the operation throws", async () => {
		const events: JsStatusEvent[] = [];

		await expect(
			withBridgeTimeoutPause(
				event => events.push(event),
				async () => {
					await Bun.sleep(20);
					throw new Error("boom");
				},
			),
		).rejects.toThrow("boom");

		expect(events.map(event => event.op)).toEqual([EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_RESUME_OP]);
	});

	it("runs the operation without emitting when no status sink is wired", async () => {
		let ran = 0;

		const value = await withBridgeTimeoutPause(undefined, async () => {
			ran++;
			await Bun.sleep(20);
			return 42;
		});

		expect(value).toBe(42);
		expect(ran).toBe(1);
	});

	it("identifies timeout-control events as non-renderable status", () => {
		expect(isEvalTimeoutControlEvent({ op: EVAL_TIMEOUT_PAUSE_OP })).toBe(true);
		expect(isEvalTimeoutControlEvent({ op: EVAL_TIMEOUT_RESUME_OP })).toBe(true);
		expect(isEvalTimeoutControlEvent({ op: "agent", id: "subagent-1" })).toBe(false);
	});
});

class TestCancelledError extends Error {
	readonly timedOut: boolean;

	constructor(timedOut: boolean) {
		super(timedOut ? "timed out" : "cancelled");
		this.name = "TestCancelledError";
		this.timedOut = timedOut;
	}
}

it("defers external aborts until an in-flight agent bridge call resumes", async () => {
	const abortController = new AbortController();
	const entered = Promise.withResolvers<void>();
	const triggerAbort = Promise.withResolvers<void>();
	const observed = Promise.withResolvers<boolean>();
	const release = Promise.withResolvers<void>();
	const kernel: GenericKernel<Record<string, string | null>> = {
		async execute(_code, options) {
			entered.resolve();
			await triggerAbort.promise;
			options.onDisplay({
				type: "status",
				event: { op: EVAL_TIMEOUT_PAUSE_OP, deferExternalAbort: true },
			} satisfies KernelDisplayOutput);
			abortController.abort(new Error("external interrupt"));
			observed.resolve(options.signal?.aborted ?? false);
			await release.promise;
			options.onDisplay({
				type: "status",
				event: { op: EVAL_TIMEOUT_RESUME_OP, deferExternalAbort: true },
			} satisfies KernelDisplayOutput);
			return { status: "ok", cancelled: false, timedOut: false };
		},
	};

	const resultPromise = executeWithKernelBase({
		kernel,
		code: "agent('slow')",
		options: { signal: abortController.signal },
		runIdPrefix: "test",
		errorLogLabel: "test",
		cancelledErrorClass: TestCancelledError,
		buildKernelEnvPatch: () => ({}),
		formatKernelTimeoutAnnotation: () => "kernel timed out",
		formatTimeoutAnnotation: () => "timed out",
	});

	await entered.promise;
	triggerAbort.resolve();
	expect(await observed.promise).toBe(false);
	release.resolve();
	const result = await resultPromise;
	expect(result.cancelled).toBe(true);
	expect(result.exitCode).toBeUndefined();
});

it("does not defer external aborts for a completion bridge call", async () => {
	const abortController = new AbortController();
	const entered = Promise.withResolvers<void>();
	const triggerAbort = Promise.withResolvers<void>();
	const observed = Promise.withResolvers<boolean>();
	const release = Promise.withResolvers<void>();
	const kernel: GenericKernel<Record<string, string | null>> = {
		async execute(_code, options) {
			entered.resolve();
			await triggerAbort.promise;
			options.onDisplay({
				type: "status",
				event: { op: EVAL_TIMEOUT_PAUSE_OP },
			} satisfies KernelDisplayOutput);
			abortController.abort(new Error("external interrupt"));
			observed.resolve(options.signal?.aborted ?? false);
			await release.promise;
			options.onDisplay({
				type: "status",
				event: { op: EVAL_TIMEOUT_RESUME_OP },
			} satisfies KernelDisplayOutput);
			return { status: "ok", cancelled: false, timedOut: false };
		},
	};

	const resultPromise = executeWithKernelBase({
		kernel,
		code: "completion('slow')",
		options: { signal: abortController.signal },
		runIdPrefix: "test",
		errorLogLabel: "test",
		cancelledErrorClass: TestCancelledError,
		buildKernelEnvPatch: () => ({}),
		formatKernelTimeoutAnnotation: () => "kernel timed out",
		formatTimeoutAnnotation: () => "timed out",
	});

	await entered.promise;
	triggerAbort.resolve();
	expect(await observed.promise).toBe(true);
	release.resolve();
	const result = await resultPromise;
	expect(result.cancelled).toBe(true);
	expect(result.exitCode).toBeUndefined();
});

it("hands the tool bridge the unshielded signal so a deferred phase still cancels subagents", async () => {
	// Regression: the bridge used to receive the kernel shield, so `agent()`
	// fan-outs from a Python/Ruby/Julia cell survived a turn cancel and kept
	// running until they finished on their own.
	const abortController = new AbortController();
	const entered = Promise.withResolvers<void>();
	const observedKernelAbort = Promise.withResolvers<boolean>();
	const release = Promise.withResolvers<void>();
	let bridgeSignal: AbortSignal | undefined;
	const registerSpy = vi
		.spyOn(pyToolBridge, "registerPyToolBridge")
		.mockImplementation((_sessionId, _runId, entry) => {
			bridgeSignal = entry.signal;
			return () => {};
		});

	const kernel: GenericKernel<Record<string, string | null>> = {
		async execute(_code, options) {
			entered.resolve();
			options.onDisplay({
				type: "status",
				event: { op: EVAL_TIMEOUT_PAUSE_OP, deferExternalAbort: true },
			} satisfies KernelDisplayOutput);
			abortController.abort(new Error("external interrupt"));
			observedKernelAbort.resolve(options.signal?.aborted ?? false);
			await release.promise;
			options.onDisplay({
				type: "status",
				event: { op: EVAL_TIMEOUT_RESUME_OP, deferExternalAbort: true },
			} satisfies KernelDisplayOutput);
			return { status: "ok", cancelled: false, timedOut: false };
		},
	};

	const resultPromise = executeWithKernelBase({
		kernel,
		code: "agent('slow')",
		options: {
			signal: abortController.signal,
			toolSession: makeToolSession(),
			bridgeSessionId: "bridge-session",
		},
		runIdPrefix: "test",
		errorLogLabel: "test",
		cancelledErrorClass: TestCancelledError,
		buildKernelEnvPatch: () => ({}),
		formatKernelTimeoutAnnotation: () => "kernel timed out",
		formatTimeoutAnnotation: () => "timed out",
	});

	await entered.promise;
	// The kernel stays shielded mid-phase so the runtime can't die during an
	// isolation merge...
	expect(await observedKernelAbort.promise).toBe(false);
	// ...but everything dispatched through the bridge cancels right away.
	expect(registerSpy).toHaveBeenCalledTimes(1);
	expect(bridgeSignal?.aborted).toBe(true);

	release.resolve();
	const result = await resultPromise;
	expect(result.cancelled).toBe(true);
});

it("holds the cell open through a deferred phase while still aborting the tool at once", async () => {
	// Regression: the tool call and the wait-for-result race must use different
	// aborts. Sharing the raw signal answered the HTTP call the moment the turn
	// was cancelled, letting the cell settle and the bridge unregister on top of
	// an abort-insensitive isolation merge still rewriting the repo.
	//
	// The discriminator is the reply itself, not its timing: losing the race
	// makes the bridge answer `ok: false, aborted`, while a correctly deferred
	// wait answers with the tool's real value once the phase releases.
	const bridge = await pyToolBridge.ensurePyToolBridge();
	const abortController = new AbortController();
	const toolStarted = Promise.withResolvers<void>();
	const toolSawAbort = Promise.withResolvers<void>();
	const releaseTool = Promise.withResolvers<void>();

	// Stands in for `runStructuredSubagent`: observes its abort at once (the
	// subagent dies) but keeps working afterwards, exactly like a cherry-pick
	// that never looks at a signal.
	const parkedTool: AgentTool = {
		name: "merge",
		label: "Merge",
		description: "Parks until released, ignoring its abort",
		parameters: type({}),
		execute: async (_id, _args, signal) => {
			signal?.addEventListener("abort", () => toolSawAbort.resolve(), { once: true });
			toolStarted.resolve();
			await releaseTool.promise;
			return { content: [{ type: "text", text: "merged" }] };
		},
	};
	const toolSession = makeToolSession(parkedTool);

	const bridgeSessionId = `bridge-${crypto.randomUUID()}`;
	let reply: { ok: boolean; value?: unknown; error?: string } | undefined;
	const kernel: GenericKernel<Record<string, string | null>> = {
		async execute(_code, options) {
			options.onDisplay({
				type: "status",
				event: { op: EVAL_TIMEOUT_PAUSE_OP, deferExternalAbort: true },
			} satisfies KernelDisplayOutput);
			// Mirrors the Python prelude's blocking loopback call.
			const pending = fetch(`${bridge.url}/v1/tool`, {
				method: "POST",
				headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
				body: JSON.stringify({ session: bridgeSessionId, run: options.id, name: "merge", args: {} }),
			}).then(res => res.json() as Promise<{ ok: boolean; value?: unknown; error?: string }>);

			await toolStarted.promise;
			abortController.abort(new Error("external interrupt"));
			// The raw signal reached the tool: delegated work is already dying.
			await toolSawAbort.promise;

			releaseTool.resolve();
			reply = await pending;
			options.onDisplay({
				type: "status",
				event: { op: EVAL_TIMEOUT_RESUME_OP, deferExternalAbort: true },
			} satisfies KernelDisplayOutput);
			return { status: "ok", cancelled: false, timedOut: false };
		},
	};

	const result = await executeWithKernelBase({
		kernel,
		code: "agent('isolated')",
		options: { signal: abortController.signal, toolSession, bridgeSessionId },
		runIdPrefix: "test",
		errorLogLabel: "test",
		cancelledErrorClass: TestCancelledError,
		buildKernelEnvPatch: () => ({}),
		formatKernelTimeoutAnnotation: () => "kernel timed out",
		formatTimeoutAnnotation: () => "timed out",
	});

	// The host waited out the critical phase instead of bailing on the cancel.
	expect(reply).toEqual({ ok: true, value: "merged" });
	// ...and the turn is still reported as cancelled.
	expect(result.cancelled).toBe(true);
});
it("expires the wall-clock timeout through the shield so blocked bridge calls unwind instead of the kernel dying", async () => {
	// Regression: the cell timeout used to arm only a kernel-internal timer.
	// SIGINT then raised KeyboardInterrupt in the runner's main thread while
	// a runner worker thread stayed parked in a blocking urllib bridge call
	// nobody rejected; the runner wedged waiting for that thread,
	// never emitted `done`, and the 5s escalation killed the kernel with all
	// session state. The timeout must abort the same signals a turn cancel
	// does: the bridge's raced signal (rejecting in-flight calls) and the
	// kernel's execute signal (delivering SIGINT).
	const bridge = await pyToolBridge.ensurePyToolBridge();
	const toolSession = makeToolSession({
		name: "parked",
		label: "Parked",
		description: "Never settles on its own; the raced bridge abort must answer instead",
		parameters: type({}),
		execute: async () => {
			await new Promise<never>(() => {});
			throw new Error("unreachable");
		},
	});

	const bridgeSessionId = `bridge-${crypto.randomUUID()}`;
	let kernelAbortReason: unknown;
	const kernel: GenericKernel<Record<string, string | null>> = {
		async execute(_code, options) {
			// Mirrors the Python prelude: a worker thread blocked in a loopback
			// bridge call that only settles if the host rejects it.
			const pending = fetch(`${bridge.url}/v1/tool`, {
				method: "POST",
				headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
				body: JSON.stringify({ session: bridgeSessionId, run: options.id, name: "parked", args: {} }),
			}).then(res => res.json() as Promise<{ ok: boolean; error?: string }>);

			// Like the real runner, the cell only finishes once the timeout abort
			// arrives (SIGINT) AND the blocked bridge call has been answered.
			const aborted = Promise.withResolvers<void>();
			options.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
			await aborted.promise;
			kernelAbortReason = options.signal?.reason;
			const reply = await pending;
			expect(reply.ok).toBe(false);
			expect(reply.error).toContain("interrupted");
			return { status: "error", cancelled: true, timedOut: true };
		},
	};

	const result = await executeWithKernelBase({
		kernel,
		code: "import asyncio, threading\nt = threading.Thread(target=lambda: asyncio.run(tool.parked({})))\nt.start()\nt.join()",
		options: { timeoutMs: 100, toolSession, bridgeSessionId },
		runIdPrefix: "test",
		errorLogLabel: "test",
		cancelledErrorClass: TestCancelledError,
		buildKernelEnvPatch: () => ({}),
		formatKernelTimeoutAnnotation: () => "kernel timed out",
		formatTimeoutAnnotation: () => "timed out",
	});

	// The kernel saw a timeout abort, not a plain cancel...
	expect(kernelAbortReason).toBeInstanceOf(DOMException);
	expect((kernelAbortReason as DOMException).name).toBe("TimeoutError");
	// ...the cell settled as a timed-out cancellation with the kernel alive.
	expect(result.cancelled).toBe(true);
	expect(result.output).toContain("kernel timed out");
});

describe("timed-out cell annotation", () => {
	/** Run one cell that the eval watchdog times out, on a kernel in the given post-interrupt state. */
	async function timedOutCell(kernelState: { alive: boolean; answersProbe: boolean }, outputPreamble?: string) {
		const watchdog = new AbortController();
		const kernel: GenericKernel<Record<string, string | null>> = {
			async execute(_code, options) {
				await options.onChunk("partial output\n");
				watchdog.abort(new DOMException("Idle for 600s", "TimeoutError"));
				return { status: "error", cancelled: true, timedOut: true };
			},
			isAlive: () => kernelState.alive,
			probeAlive: async () => kernelState.answersProbe,
		};
		return await executeWithKernelBase({
			kernel,
			code: "long_study()",
			options: { signal: watchdog.signal, idleTimeoutMs: 600_000, outputPreamble },
			runIdPrefix: "test",
			errorLogLabel: "test",
			cancelledErrorClass: TestCancelledError,
			buildKernelEnvPatch: () => ({}),
			formatKernelTimeoutAnnotation: formatSessionKernelTimeoutAnnotation,
			formatTimeoutAnnotation: () => "timed out",
		});
	}

	it("says state is lost when the runner exits after it reports the interrupted cell", async () => {
		const result = await timedOutCell({ alive: false, answersProbe: false });
		expect(result.cancelled).toBe(true);
		expect(result.output).toContain(formatSessionKernelTimeoutAnnotation(600_000, "killed"));
		expect(result.output).not.toContain("still runs");
	});

	it("says state is kept only when the interrupted kernel answers the liveness probe", async () => {
		expect((await timedOutCell({ alive: true, answersProbe: true })).output).toContain(
			formatSessionKernelTimeoutAnnotation(600_000, "running"),
		);
		expect((await timedOutCell({ alive: true, answersProbe: false })).output).toContain(
			formatSessionKernelTimeoutAnnotation(600_000, "unresponsive"),
		);
	});

	it("puts the replacement-kernel notice before the cell output", async () => {
		const notice = formatKernelReplacedNotice("Python");
		const { output } = await timedOutCell({ alive: true, answersProbe: true }, notice);
		expect(output.indexOf(notice)).toBeGreaterThanOrEqual(0);
		expect(output.indexOf(notice)).toBeLessThan(output.indexOf("partial output"));
	});
});

describe("eval-bridged host tool calls", () => {
	/**
	 * A session with one RPC host tool (`simulate_motion`), a `write` stand-in
	 * whose `xd://` transport hands the device call to that host tool, and a
	 * built-in tool. Status events are recorded at the moment each tool works,
	 * so the test sees whether the cell watchdog was paused during that work.
	 */
	function harness() {
		const events: string[] = [];
		const frames: Array<RpcHostToolCallRequest | RpcHostToolCancelRequest> = [];
		const hostCall = Promise.withResolvers<RpcHostToolCallRequest>();
		const bridge = new RpcHostToolBridge(frame => {
			frames.push(frame);
			if (frame.type === "host_tool_call") {
				events.push("host-call");
				hostCall.resolve(frame);
			}
		});
		const [hostTool] = bridge.setTools([
			{
				name: "simulate_motion",
				label: "Simulate motion",
				description: "Runs a motion study in the host",
				parameters: { type: "object", properties: { steps: { type: "number" } }, additionalProperties: false },
			},
		]);
		const writeParams = type({ path: "string", content: "string" });
		const write: AgentTool<typeof writeParams> = {
			name: "write",
			label: "Write",
			description: "Dispatches xd:// device writes",
			parameters: writeParams,
			execute: async (id, args, signal) => hostTool.execute(id, JSON.parse(args.content), signal),
		};
		const builtin: AgentTool = {
			name: "builtin_work",
			label: "Builtin work",
			description: "Built-in work that runs inside the session",
			parameters: type({}),
			execute: async () => {
				events.push("builtin-work");
				return { content: [{ type: "text", text: "done" }] };
			},
		};
		const session: ToolSession = {
			...makeToolSession(hostTool, write, builtin),
			getHostToolSource: () => bridge,
		};
		const emitStatus = (event: JsStatusEvent): void => {
			if (isEvalTimeoutControlEvent(event)) events.push(event.op);
		};
		const answer = async (): Promise<void> => {
			const call = await hostCall.promise;
			bridge.handleResult({
				type: "host_tool_result",
				id: call.id,
				result: { content: [{ type: "text", text: "study complete" }] },
			});
		};
		return { events, frames, hostCall: hostCall.promise, session, emitStatus, answer };
	}

	for (const [label, name, args] of [
		["a direct host tool call", "simulate_motion", { steps: 19 }],
		["write xd://<host tool>", "write", { path: "xd://simulate_motion", content: JSON.stringify({ steps: 19 }) }],
	] as const) {
		it(`pauses the cell timeout for ${label} until the host answers`, async () => {
			const { events, session, emitStatus, answer } = harness();
			const call = callSessionTool(name, args, { session, emitStatus });
			await answer();
			expect(await call).toBe("study complete");
			expect(events).toEqual([EVAL_TIMEOUT_PAUSE_OP, "host-call", EVAL_TIMEOUT_RESUME_OP]);
		});
	}

	it("keeps built-in tool calls on the cell timeout", async () => {
		const { events, session, emitStatus } = harness();
		expect(await callSessionTool("builtin_work", {}, { session, emitStatus })).toBe("done");
		expect(events).toEqual(["builtin-work"]);
	});

	it("cancels the host tool when the turn is cancelled during the paused call", async () => {
		const { events, frames, hostCall, session, emitStatus } = harness();
		const turn = new AbortController();
		const call = callSessionTool(
			"write",
			{ path: "xd://simulate_motion", content: "{}" },
			{ session, emitStatus, signal: turn.signal },
		);
		const request = await hostCall;
		turn.abort(new Error("turn cancelled"));
		await expect(call).rejects.toThrow("aborted");
		expect(frames).toContainEqual(expect.objectContaining({ type: "host_tool_cancel", targetId: request.id }));
		// The watchdog resumes after the cancel, so the cell timeout counts again.
		expect(events).toEqual([EVAL_TIMEOUT_PAUSE_OP, "host-call", EVAL_TIMEOUT_RESUME_OP]);
	});
});
