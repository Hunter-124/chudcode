import { describe, expect, test, vi } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { dispatchRpcInputFrame, type RpcInputFrameDeps } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import {
	RPC_STT_ERROR_MAX_BYTES,
	RPC_STT_TEXT_MAX_BYTES,
	RpcSttEditor,
	RpcSttService,
	sanitizeRpcSttError,
	type RpcSttController,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-stt";
import type { RpcCommand, RpcExtensionUIRequest, RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { SttCallbacks, SttTarget, SttState } from "@oh-my-pi/pi-coding-agent/stt/stt-controller";
import * as downloader from "@oh-my-pi/pi-coding-agent/stt/downloader";
import { STTController } from "@oh-my-pi/pi-coding-agent/stt/stt-controller";

class FakeCapture implements RpcSttController {
	state: SttState = "idle";
	target: SttTarget | undefined;
	callbacks: SttCallbacks | undefined;
	disposed = 0;
	async start(target: SttTarget, callbacks: SttCallbacks): Promise<void> {
		this.target = target;
		this.callbacks = callbacks;
		this.state = "recording";
		callbacks.onStateChange("recording");
	}
	async stop(): Promise<void> {
		this.state = "transcribing";
		this.callbacks?.onStateChange("transcribing");
		this.target?.commitVolatileText(" recognized words");
		this.state = "idle";
		this.callbacks?.onStateChange("idle");
	}
	dispose(): void {
		this.disposed++;
		this.state = "idle";
	}
}

function serviceWithCapture() {
	const captures: FakeCapture[] = [];
	const frames: RpcExtensionUIRequest[] = [];
	let workersStopped = 0;
	const service = new RpcSttService(
		frame => frames.push(frame),
		{} as AgentSession["settings"],
		{} as AgentSession["modelRegistry"],
		{
			controllerFactory: () => {
				const capture = new FakeCapture();
				captures.push(capture);
				return capture;
			},
			isAvailable: () => true,
			model: () => "whisper-base",
			terminateWorker: async () => {
				workersStopped++;
			},
		},
	);
	return { service, captures, frames, workersStopped: () => workersStopped };
}

describe("RPC speech-to-text boundary", () => {
	test("captures speech without submitting it as a prompt, and resets on cancel", async () => {
		const { service, captures, frames } = serviceWithCapture();
		try {
			expect(await service.start()).toEqual({ ok: true, state: "recording", model: "whisper-base" });
			captures[0]?.target?.setVolatileText("partial");
			expect(await service.stop()).toEqual({ ok: true, state: "idle", text: " recognized words" });
			expect(frames.some(frame => frame.method === "set_editor_text" && frame.text === "partial")).toBe(true);
			await service.start();
			expect(await service.cancel()).toEqual({ ok: true, state: "idle" });
			expect(service.status().state).toBe("idle");
			expect(captures).toHaveLength(2);
		} finally {
			await service.dispose();
		}
	});

	test("dispose is idempotent and terminates worker after capture", async () => {
		const { service, captures, workersStopped } = serviceWithCapture();
		await service.start();
		await service.dispose();
		await service.dispose();
		expect(captures[0]?.disposed).toBeGreaterThan(0);
		expect(workersStopped()).toBe(1);
		await expect(service.start()).rejects.toThrow("disposed");
	});

	test("bounds multibyte transcripts and scrubs secrets from errors", () => {
		const editor = new RpcSttEditor(() => {});
		editor.commitVolatileText("😀".repeat(RPC_STT_TEXT_MAX_BYTES));
		expect(Buffer.byteLength(editor.text)).toBeLessThanOrEqual(RPC_STT_TEXT_MAX_BYTES);
		expect(editor.text.endsWith("😀")).toBe(true);
		const error = sanitizeRpcSttError(
			"token-supersecret123 https://user:password@example.test/?token=raw " + "x".repeat(5000),
		);
		expect(error).not.toContain("supersecret123");
		expect(error).not.toContain("password");
		expect(error).not.toContain("token=raw");
		expect(Buffer.byteLength(error)).toBeLessThanOrEqual(RPC_STT_ERROR_MAX_BYTES);
	});

	test("cancel responds during unresolved first-use setup and cleans late capture", async () => {
		const preflight = Promise.withResolvers<void>();
		const cleaned = Promise.withResolvers<void>();
		const controllers: FakeCapture[] = [];
		const frames: RpcExtensionUIRequest[] = [];
		const service = new RpcSttService(
			frame => frames.push(frame),
			{} as AgentSession["settings"],
			{} as AgentSession["modelRegistry"],
			{
				controllerFactory: () => {
					const controller = new FakeCapture();
					const dispose = controller.dispose.bind(controller);
					controller.dispose = () => {
						dispose();
						if (controller.disposed >= 2) cleaned.resolve();
					};
					controller.start = async (target, callbacks) => {
						await preflight.promise;
						controller.state = "recording"; // Simulate a late completion despite disposal.
						controller.target = target;
						callbacks.onStateChange("recording");
					};
					controllers.push(controller);
					return controller;
				},
				isAvailable: () => true,
				model: () => "whisper-base",
				terminateWorker: async () => {},
			},
		);
		const starting = service.start();
		await Promise.resolve();
		expect(await service.cancel()).toEqual({ ok: true, state: "idle" });
		await expect(starting).rejects.toThrow("cancelled");
		const before = frames.length;
		preflight.resolve();
		await cleaned.promise;
		expect(controllers[0]?.state).toBe("idle");
		expect(frames).toHaveLength(before);
		await service.dispose();
	});

	test("shutdown terminates worker while a first-use download remains unresolved", async () => {
		const preflight = Promise.withResolvers<void>();
		let stopped = 0;
		const controller = new FakeCapture();
		controller.start = async () => {
			await preflight.promise;
		};
		const service = new RpcSttService(() => {}, {} as AgentSession["settings"], {} as AgentSession["modelRegistry"], {
			controllerFactory: () => controller,
			isAvailable: () => true,
			model: () => "whisper-base",
			terminateWorker: async () => {
				stopped++;
			},
		});
		const starting = service.start();
		await service.dispose();
		expect(stopped).toBe(1);
		await expect(starting).rejects.toThrow("cancelled");
		preflight.resolve();
	});

	test("disposed STTController cannot open a microphone after preflight finishes", async () => {
		const entered = Promise.withResolvers<void>();
		const download = Promise.withResolvers<void>();
		let captureCount = 0;
		vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(false);
		const workerDownload = vi.spyOn(downloader, "downloadSttModel").mockImplementation(async () => {
			entered.resolve();
			await download.promise;
		});
		const controller = new STTController(() => {
			captureCount++;
			return { stop: () => {} };
		});
		try {
			const opening = controller.start(
				{
					setVolatileText: () => {},
					clearVolatileText: () => {},
					commitVolatileText: () => {},
					submit: () => {},
					deleteBeforeCursor: () => {},
				},
				{ showWarning: () => {}, showStatus: () => {}, onStateChange: () => {} },
			);
			await entered.promise;
			controller.dispose();
			expect(workerDownload.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
			download.resolve();
			await opening;
			expect(captureCount).toBe(0);
		} finally {
			controller.dispose();
			download.resolve();
			vi.restoreAllMocks();
		}
	});

	test("background commands preserve request IDs when status overtakes start", async () => {
		const first = Promise.withResolvers<RpcResponse>();
		const outputs: RpcResponse[] = [];
		const tracked: Promise<void>[] = [];
		const deps: RpcInputFrameDeps = {
			handleCommand: (command: RpcCommand) =>
				command.type === "stt_start"
					? first.promise
					: Promise.resolve({
							id: command.id,
							type: "response",
							command: "stt_status",
							success: true,
							data: { ok: true, available: true, state: "idle", model: "whisper-base" },
						}),
			output: frame => outputs.push(frame as RpcResponse),
			errorResponse: (id, command, message) => ({ id, type: "response", command, success: false, error: message }),
			trackBackgroundTask: task => tracked.push(task),
			pendingExtensionRequests: new Map(),
			onHostToolResult: () => {},
			onHostToolUpdate: () => {},
			onHostUriResult: () => {},
		};
		dispatchRpcInputFrame({ id: "start", type: "stt_start" }, deps);
		dispatchRpcInputFrame({ id: "status", type: "stt_status" }, deps);
		await Promise.resolve();
		expect(outputs.map(output => output.id)).toEqual(["status"]);
		first.resolve({
			id: "start",
			type: "response",
			command: "stt_start",
			success: true,
			data: { ok: true, state: "recording", model: "whisper-base" },
		});
		await Promise.all(tracked);
		expect(outputs.map(output => output.id)).toEqual(["status", "start"]);
	});
});
