import { afterEach, beforeEach, describe, expect, type Mock, test, vi } from "bun:test";
import { Settings, settings } from "@chudware/coding-agent/config/settings";
import { dispatchRpcInputFrame, type RpcInputFrameDeps } from "@chudware/coding-agent/modes/rpc/rpc-mode";
import {
	RPC_STT_ERROR_MAX_BYTES,
	RPC_STT_TEXT_MAX_BYTES,
	RpcSttEditor,
	RpcSttService,
	sanitizeRpcSttError,
} from "@chudware/coding-agent/modes/rpc/rpc-stt";
import type { RpcCommand, RpcExtensionUIRequest, RpcResponse } from "@chudware/coding-agent/modes/rpc/rpc-types";
import type { SttStreamOptions } from "@chudware/coding-agent/stt/asr-client";
import * as asrClient from "@chudware/coding-agent/stt/asr-client";
import * as downloader from "@chudware/coding-agent/stt/downloader";
import { STTController } from "@chudware/coding-agent/stt/stt-controller";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

function deferred<T>() {
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	return { promise, resolve, reject };
}

describe("RPC speech-to-text", () => {
	let settingsState: SettingsTestState | undefined;
	let service: RpcSttService | undefined;
	let streamOptions!: SttStreamOptions;
	let onAudio: ((error: Error | null, samples: Float32Array) => void) | undefined;
	let stopCapture: Mock<() => void>;
	let stopStream: Mock<() => Promise<string>>;
	let cancelStream: Mock<() => void>;
	let pushAudio: Mock<(samples: Float32Array) => void>;
	let frames: RpcExtensionUIRequest[];
	let terminateWorker: Mock<() => Promise<void>>;
	let isCachedSpy: Mock<typeof downloader.isSttModelCached>;
	let downloadModelSpy: Mock<typeof downloader.downloadSttModel>;

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		await Settings.init({ inMemory: true });
		settings.set("stt.enabled", true);
		settings.set("stt.modelName", "fast");
		settings.set("stt.submitTrigger", "never");
		frames = [];
		stopCapture = vi.fn();
		stopStream = vi.fn().mockResolvedValue("");
		cancelStream = vi.fn();
		pushAudio = vi.fn();
		terminateWorker = vi.fn().mockResolvedValue(undefined);
		isCachedSpy = vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(true);
		downloadModelSpy = vi.spyOn(downloader, "downloadSttModel").mockResolvedValue(undefined);
		vi.spyOn(asrClient.sttClient, "startStream").mockImplementation((_model, options) => {
			streamOptions = options ?? {};
			return { pushAudio, stop: stopStream, cancel: cancelStream };
		});
	});

	afterEach(async () => {
		await service?.dispose();
		service = undefined;
		restoreSettingsTestState(settingsState);
		vi.restoreAllMocks();
	});

	function makeService(available = true): RpcSttService {
		const controller = new STTController(callback => {
			onAudio = callback;
			return { stop: stopCapture };
		});
		service = new RpcSttService(frame => frames.push(frame), {
			controller,
			isAvailable: () => available,
			model: () => "fast",
			terminateWorker,
		});
		return service;
	}

	test("reports bounded idle status and refuses unavailable capture", async () => {
		const rpc = makeService(false);
		expect(rpc.status()).toEqual({ ok: true, available: false, state: "idle", model: "fast" });
		await expect(rpc.start()).rejects.toThrow("disabled or unavailable");
		expect(asrClient.sttClient.startStream).not.toHaveBeenCalled();
	});

	test("streams partials and committed segments, feeds audio, and returns the final transcript", async () => {
		const rpc = makeService();
		expect(await rpc.start()).toEqual({ ok: true, state: "recording", model: "fast" });
		onAudio?.(null, new Float32Array([0.25, -0.25]));
		expect(pushAudio).toHaveBeenCalledTimes(1);

		streamOptions.onPartial?.("hel");
		streamOptions.onSegment?.("hello", 0);
		streamOptions.onPartial?.("wor");
		streamOptions.onSegment?.("world", 1);
		stopStream.mockResolvedValue("hello world");

		expect(await rpc.stop()).toEqual({ ok: true, text: "hello world", state: "idle" });
		expect(stopCapture).toHaveBeenCalledTimes(1);
		expect(frames.some(frame => frame.method === "set_editor_text" && frame.text === "hello wor")).toBe(true);
		expect(frames.some(frame => frame.method === "setStatus" && frame.statusText === "Transcribing…")).toBe(true);
	});

	test("uses final worker text when no segment was committed", async () => {
		const rpc = makeService();
		stopStream.mockResolvedValue("final words");
		await rpc.start();
		expect(await rpc.stop()).toMatchObject({ text: "final words", state: "idle" });
	});

	test("cancel is idempotent from idle, recording, starting, and transcribing", async () => {
		const rpc = makeService();
		expect(await rpc.cancel()).toEqual({ ok: true, state: "idle" });

		await rpc.start();
		expect(await rpc.cancel()).toEqual({ ok: true, state: "idle" });
		expect(cancelStream).toHaveBeenCalledTimes(1);
		expect(stopCapture).toHaveBeenCalledTimes(1);

		await rpc.start();
		const transcription = deferred<string>();
		stopStream.mockReturnValue(transcription.promise);
		cancelStream.mockImplementation(() => transcription.resolve(""));
		const stopping = rpc.stop();
		await Promise.resolve();
		expect(rpc.status().state).toBe("transcribing");
		expect(await rpc.cancel()).toEqual({ ok: true, state: "idle" });
		await stopping;

		await rpc.dispose();
		expect(await rpc.cancel()).toEqual({ ok: true, state: "idle" });
	});

	test("cancel aborts model setup and concurrent starts are refused", async () => {
		isCachedSpy.mockResolvedValue(false);
		downloadModelSpy.mockImplementation((_model, onProgress, options) => {
			onProgress?.({
				status: "progress",
				percent: 37,
				loaded: 37,
				total: 100,
				repo: "model/repo",
				label: "Test model",
			});
			return new Promise<void>((_resolve, reject) => {
				options?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
					once: true,
				});
			});
		});
		const rpc = makeService();
		const starting = rpc.start();
		await Promise.resolve();
		expect(rpc.status()).toMatchObject({ state: "idle", progress: 37 });
		await expect(rpc.start()).rejects.toThrow("already active");
		await rpc.cancel();
		await expect(starting).rejects.toThrow("cancelled");
		expect(asrClient.sttClient.startStream).not.toHaveBeenCalled();
	});

	test("surfaces model progress and secret-safe failures through extension notifications", async () => {
		isCachedSpy.mockResolvedValue(false);
		downloadModelSpy.mockImplementation(async (_model, onProgress) => {
			onProgress?.({
				status: "progress",
				percent: 71,
				loaded: 71,
				total: 100,
				repo: "model/repo",
				label: "Test model",
			});
			throw new Error(
				"download failed for token-supersecret123 at https://user:password@example.test/model?token=raw",
			);
		});
		const rpc = makeService();
		await expect(rpc.start()).rejects.toThrow("[REDACTED]");
		const serialized = JSON.stringify({ status: rpc.status(), frames });
		expect(serialized).not.toContain("supersecret123");
		expect(serialized).not.toContain("password");
		expect(serialized).not.toContain("token=raw");
		expect(frames.some(frame => frame.method === "setStatus" && frame.statusText?.includes("71%"))).toBe(true);
		expect(frames.some(frame => frame.method === "notify" && frame.notifyType === "error")).toBe(true);
		expect(sanitizeRpcSttError("secret-abcdefghijk")).toBe("[REDACTED]");
	});

	test("dispose stops capture, cancels ASR, and terminates the shared worker once", async () => {
		const rpc = makeService();
		await rpc.start();
		await rpc.dispose();
		await rpc.dispose();
		expect(stopCapture).toHaveBeenCalledTimes(1);
		expect(cancelStream).toHaveBeenCalledTimes(1);
		expect(terminateWorker).toHaveBeenCalledTimes(1);
	});
});

describe("RPC STT bounds", () => {
	test("bounds multibyte transcript and error payloads without splitting text", () => {
		const editor = new RpcSttEditor(() => {});
		editor.commitVolatileText("😀".repeat(RPC_STT_TEXT_MAX_BYTES));
		expect(new TextEncoder().encode(editor.text).byteLength).toBeLessThanOrEqual(RPC_STT_TEXT_MAX_BYTES);
		expect(editor.text.endsWith("😀")).toBe(true);

		const error = sanitizeRpcSttError("x".repeat(RPC_STT_ERROR_MAX_BYTES * 2));
		expect(new TextEncoder().encode(error).byteLength).toBeLessThanOrEqual(RPC_STT_ERROR_MAX_BYTES);
	});
});

describe("RPC STT response correlation", () => {
	test("background speech commands retain request ids when responses settle out of order", async () => {
		const first = deferred<RpcResponse>();
		const second = deferred<RpcResponse>();
		const outputs: RpcResponse[] = [];
		const tracked: Promise<void>[] = [];
		const deps: RpcInputFrameDeps = {
			handleCommand: (command: RpcCommand) => (command.id === "first" ? first.promise : second.promise),
			output: frame => outputs.push(frame as RpcResponse),
			errorResponse: (id, command, message) => ({ id, type: "response", command, success: false, error: message }),
			trackBackgroundTask: task => tracked.push(task),
			pendingExtensionRequests: new Map(),
			onHostToolResult: () => {},
			onHostToolUpdate: () => {},
			onHostUriResult: () => {},
		};
		dispatchRpcInputFrame({ id: "first", type: "stt_start" }, deps);
		dispatchRpcInputFrame({ id: "second", type: "stt_status" }, deps);
		second.resolve({
			id: "second",
			type: "response",
			command: "stt_status",
			success: true,
			data: { ok: true, available: true, state: "idle", model: "fast" },
		});
		first.resolve({
			id: "first",
			type: "response",
			command: "stt_start",
			success: true,
			data: { ok: true, state: "recording", model: "fast" },
		});
		await Promise.all(tracked);
		expect(outputs.map(output => output.id)).toEqual(["second", "first"]);
	});
});
