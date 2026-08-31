import { AudioCapture } from "@chudware/natives";
import { logger } from "@chudware/utils";
import { settings } from "../config/settings";
import { type SttStreamHandle, sttClient } from "./asr-client";
import { downloadSttModel, isSttModelCached, type SttDownloadProgress } from "./downloader";
import { resolveSttModelSpec } from "./models";
import { evaluateSubmitTrigger } from "./submit-trigger";

export type SttState = "idle" | "recording" | "transcribing";

export interface SttControllerOptions {
	showWarning(msg: string): void;
	showStatus(msg: string): void;
	onStateChange(state: SttState): void;
	/** Force a redraw after async edits to the composer (live segment/preview inserts). */
	requestRender?(): void;
	/** Structured model progress for non-interactive hosts. */
	onProgress?(progress: SttDownloadProgress): void;
	/** Interactive composer submit triggers are disabled by headless RPC callers. */
	allowSubmitTrigger?: boolean;
	/** Sanitize native/worker failures before UI callbacks and logs (identity in interactive mode). */
	sanitizeError?(message: string): string;
}

/** The slice of the composer editor the controller drives. */
export interface SttEditor {
	insertText(text: string): void;
	setVolatileText(text: string): void;
	clearVolatileText(): void;
	commitVolatileText(text: string): void;
	submit(): void;
	deleteBeforeCursor(count: number): void;
}

export interface SttCaptureHandle {
	stop(): void;
}

export type SttCaptureFactory = (onAudio: (error: Error | null, samples: Float32Array) => void) => SttCaptureHandle;

/** Coordinates native microphone capture with incremental local transcription. */
export class STTController {
	#state: SttState = "idle";
	#resolvedModelKey: string | null = null;
	#toggling = false;
	#stopAfterStart = false;
	#disposed = false;
	readonly #createCapture: SttCaptureFactory;
	#startAbort: AbortController | null = null;

	// Live streaming capture.
	#stream: SttStreamHandle | null = null;
	#streamRecorder: SttCaptureHandle | null = null;
	#streamEditor: SttEditor | null = null;
	#streamCommitted = false;
	#streamAbort: AbortController | null = null;
	#streamUtterance = "";

	/** Creates a controller; tests may replace the hardware capture boundary. */
	constructor(createCapture: SttCaptureFactory = onAudio => new AudioCapture(16_000, onAudio)) {
		this.#createCapture = createCapture;
	}

	get state(): SttState {
		return this.#state;
	}

	#setState(state: SttState, options: SttControllerOptions): void {
		this.#state = state;
		options.onStateChange(state);
	}

	async toggle(editor: SttEditor, options: SttControllerOptions): Promise<void> {
		if (this.#toggling) {
			if (this.#state === "idle" || this.#state === "recording") this.#stopAfterStart = true;
			return;
		}
		this.#toggling = true;
		try {
			switch (this.#state) {
				case "idle":
					await this.#start(editor, options, false);
					break;
				case "recording":
					await this.#stop(options);
					break;
				case "transcribing":
					options.showStatus("Transcription in progress...");
					break;
			}
			if (this.#stopAfterStart && this.#state === "recording") {
				this.#stopAfterStart = false;
				await this.#stop(options);
			} else if (this.#state !== "recording") {
				this.#stopAfterStart = false;
			}
		} finally {
			this.#toggling = false;
		}
	}

	/** Start one explicit capture. Returns false when unavailable, cancelled, or already active. */
	async start(editor: SttEditor, options: SttControllerOptions): Promise<boolean> {
		if (this.#disposed) throw new Error("STT controller is disposed");
		if (this.#toggling || this.#state !== "idle") return false;
		this.#toggling = true;
		try {
			return await this.#start(editor, options, true);
		} finally {
			this.#toggling = false;
		}
	}

	/** Stop and flush an active capture. Returns false unless recording was active. */
	async stop(options: SttControllerOptions): Promise<boolean> {
		if (this.#disposed) throw new Error("STT controller is disposed");
		if (this.#toggling || this.#state !== "recording") return false;
		this.#toggling = true;
		try {
			await this.#stop(options);
			return true;
		} finally {
			this.#toggling = false;
		}
	}

	#safeError(message: string, options: SttControllerOptions): string {
		const safe = options.sanitizeError?.(message);
		return safe || message;
	}

	async #ensureDeps(options: SttControllerOptions, signal: AbortSignal, cancellable: boolean): Promise<boolean> {
		const modelKey = resolveSttModelSpec(settings.get("stt.modelName") as string | undefined).key;
		// Keyed on the model rather than a one-shot flag: switching stt.modelName
		// mid-session must re-run preflight so an uncached new tier downloads here
		// (with progress) instead of blocking silently at stop.
		if (this.#resolvedModelKey === modelKey) return true;
		let wroteStatus = false;
		try {
			// Only clear the status line when preflight emitted progress; the
			// cached-model fast path emits nothing.
			const status = (msg: string): void => {
				wroteStatus = true;
				options.showStatus(msg);
			};
			// Loading the multi-hundred-MB speech model into the worker is what made
			// the old "Checking STT dependencies…" step slow. Don't pay it before
			// recording: when the weights are already cached, start now and warm the
			// model in the background — the stream/transcribe paths load it on demand
			// (memoized in the worker) and it is hot by the time recording stops.
			// Only a genuine first-use download blocks, with explicit progress, so we
			// never record silently against missing weights.
			if (await isSttModelCached(modelKey)) {
				if (signal.aborted) return false;
				this.#warmModel(modelKey, options);
			} else {
				const progress = (event: SttDownloadProgress): void => {
					options.onProgress?.(event);
					status(`Downloading speech model ${event.label} (${event.percent}%)`);
				};
				if (cancellable) await downloadSttModel(modelKey, progress, { signal });
				else await downloadSttModel(modelKey, progress);
			}
			if (signal.aborted) return false;
			if (wroteStatus) options.showStatus("");
			this.#resolvedModelKey = modelKey;
			return true;
		} catch (err) {
			if (wroteStatus) options.showStatus("");
			if (signal.aborted || (err instanceof DOMException && err.name === "AbortError")) return false;
			const msg = this.#safeError(err instanceof Error ? err.message : "Failed to setup STT dependencies", options);
			options.showWarning(msg);
			logger.error("STT dependency setup failed", { error: msg });
			return false;
		}
	}

	/** Warm the speech model in the worker without blocking recording. The worker
	 *  memoizes the load, so the stream/transcribe path reuses it and the model is
	 *  hot by the time recording stops. Only called when the weights are already
	 *  cached, so no network fetch happens. On load failure (corrupt cache, OOM,
	 *  runtime install) invalidate the resolved key so the next toggle re-runs
	 *  preflight and retries instead of skipping it forever. */
	#warmModel(modelKey: string, options: SttControllerOptions): void {
		void downloadSttModel(modelKey).catch(err => {
			// Guard against a concurrent model switch clobbering a newer resolution.
			if (!this.#disposed && this.#resolvedModelKey === modelKey) this.#resolvedModelKey = null;
			logger.debug("stt: background model warmup failed", {
				error: this.#safeError(err instanceof Error ? err.message : String(err), options),
			});
		});
	}

	async #start(editor: SttEditor, options: SttControllerOptions, cancellable: boolean): Promise<boolean> {
		const abort = new AbortController();
		this.#startAbort = abort;
		try {
			if (!(await this.#ensureDeps(options, abort.signal, cancellable)) || abort.signal.aborted) return false;
			return await this.#startStreaming(editor, options, abort.signal);
		} finally {
			if (this.#startAbort === abort) this.#startAbort = null;
		}
	}

	async #stop(options: SttControllerOptions): Promise<void> {
		await this.#stopStreaming(options);
	}

	// ── Live streaming ──────────────────────────────────────────────

	/** Segment text gets a leading space once a prior segment is committed, so
	 *  phrases join naturally; the first phrase is inserted at the cursor as-is. */
	#prefixed(text: string): string {
		const normalized = text.replace(/\s+/g, " ").trim();
		if (!normalized) return "";
		return this.#streamCommitted ? ` ${normalized}` : normalized;
	}

	async #startStreaming(editor: SttEditor, options: SttControllerOptions, startSignal: AbortSignal): Promise<boolean> {
		if (startSignal.aborted) return false;
		const modelKey = resolveSttModelSpec(settings.get("stt.modelName") as string | undefined).key;
		const language = settings.get("stt.language") as string | undefined;
		this.#streamEditor = editor;
		this.#streamCommitted = false;
		this.#streamUtterance = "";
		this.#streamAbort = new AbortController();
		let stream: SttStreamHandle;
		try {
			stream = sttClient.startStream(modelKey, {
				language: language || undefined,
				signal: this.#streamAbort.signal,
				onPartial: text => {
					if (this.#disposed || this.#state !== "recording") return;
					this.#streamEditor?.setVolatileText(this.#prefixed(text));
					options.requestRender?.();
				},
				onSegment: text => {
					if (this.#disposed) return;
					const prefixed = this.#prefixed(text);
					if (prefixed) {
						this.#streamEditor?.commitVolatileText(prefixed);
						this.#streamCommitted = true;
						this.#streamUtterance += prefixed;
					} else {
						this.#streamEditor?.clearVolatileText();
					}
					options.requestRender?.();
				},
			});
		} catch (err) {
			this.#cleanupStream();
			if (startSignal.aborted) return false;
			const msg = this.#safeError(
				err instanceof Error ? err.message : "Failed to start speech recognition",
				options,
			);
			options.showWarning(msg);
			logger.error("STT recognition failed to start", { error: msg });
			return false;
		}
		this.#stream = stream;
		let recorder: SttCaptureHandle;
		try {
			recorder = this.#createCapture((error, samples) => {
				if (this.#disposed || this.#stream !== stream || this.#state !== "recording") return;
				if (error) {
					const message = this.#safeError(error.message, options);
					logger.error("Native microphone capture failed", { error: message });
					const activeRecorder = this.#streamRecorder;
					this.#streamRecorder = null;
					try {
						activeRecorder?.stop();
					} catch (cause) {
						logger.debug("stt: microphone cleanup failed", {
							error: this.#safeError(cause instanceof Error ? cause.message : String(cause), options),
						});
					}
					this.#streamAbort?.abort(error);
					stream.cancel();
					this.#streamEditor?.clearVolatileText();
					options.requestRender?.();
					this.#cleanupStream();
					this.#setState("idle", options);
					options.showWarning(message);
					return;
				}
				stream.pushAudio(samples);
			});
		} catch (err) {
			stream.cancel();
			this.#cleanupStream();
			if (startSignal.aborted) return false;
			const msg = this.#safeError(
				err instanceof Error ? err.message : "Failed to start microphone capture",
				options,
			);
			options.showWarning(msg);
			logger.error("STT recording failed to start", { error: msg });
			return false;
		}
		if (startSignal.aborted) {
			try {
				recorder.stop();
			} catch {
				// best effort cancellation
			}
			stream.cancel();
			this.#cleanupStream();
			return false;
		}
		this.#streamRecorder = recorder;
		this.#setState("recording", options);
		logger.debug("STT live recording started", { modelKey });
		return true;
	}

	async #stopStreaming(options: SttControllerOptions): Promise<void> {
		const stream = this.#stream;
		const recorder = this.#streamRecorder;
		if (!stream) {
			this.#setState("idle", options);
			return;
		}
		this.#setState("transcribing", options);
		// Stop the mic first so no further audio is fed, then flush the worker.
		try {
			recorder?.stop();
		} catch (err) {
			logger.debug("stt: streaming recorder stop failed", {
				error: this.#safeError(err instanceof Error ? err.message : String(err), options),
			});
		}
		this.#streamRecorder = null;

		let failed = false;
		let finalText = "";
		try {
			finalText = (await stream.stop()).trim();
		} catch (err) {
			failed = true;
			if (!this.#disposed) {
				const msg = this.#safeError(err instanceof Error ? err.message : "Transcription failed", options);
				options.showWarning(msg);
				logger.error("STT live transcription failed", { error: msg });
			}
		}
		if (this.#disposed) {
			this.#cleanupStream();
			return;
		}
		if (!this.#streamCommitted && finalText) {
			const prefixed = this.#prefixed(finalText);
			this.#streamEditor?.commitVolatileText(prefixed);
			this.#streamCommitted = true;
			this.#streamUtterance = prefixed;
		} else {
			this.#streamEditor?.clearVolatileText();
		}
		options.requestRender?.();
		if (!failed) options.showStatus(this.#streamCommitted ? "" : "No speech detected.");
		if (options.allowSubmitTrigger !== false && this.#streamCommitted && !failed && this.#streamEditor) {
			const trigger = settings.get("stt.submitTrigger");
			const { submit, trimTrailing } = evaluateSubmitTrigger(this.#streamUtterance, trigger);
			if (trimTrailing > 0) {
				this.#streamEditor.deleteBeforeCursor(trimTrailing);
			}
			if (submit) {
				this.#streamEditor.submit();
			}
		}

		this.#cleanupStream();
		this.#setState("idle", options);
	}

	#cleanupStream(): void {
		this.#stream = null;
		this.#streamRecorder = null;
		this.#streamEditor = null;
		this.#streamCommitted = false;
		this.#streamAbort = null;
		this.#streamUtterance = "";
	}

	/** Idempotently abort dependency setup, capture, and transcription without committing more text. */
	cancel(options?: SttControllerOptions): void {
		this.#stopAfterStart = false;
		this.#startAbort?.abort();
		this.#startAbort = null;
		if (this.#streamAbort) {
			this.#streamAbort.abort();
			this.#streamAbort = null;
		}
		this.#stream?.cancel();
		try {
			this.#streamRecorder?.stop();
		} catch {
			// best effort cleanup
		}
		this.#streamEditor?.clearVolatileText();
		this.#cleanupStream();
		if (this.#state !== "idle") {
			if (options) this.#setState("idle", options);
			else this.#state = "idle";
		}
		options?.requestRender?.();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.cancel();
		this.#resolvedModelKey = null;
	}
}
