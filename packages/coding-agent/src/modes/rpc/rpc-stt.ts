import { Buffer } from "node:buffer";
import { settings } from "../../config/settings";
import { shutdownSttClient } from "../../stt/asr-client";
import { resolveSttModelSpec } from "../../stt/models";
import { STTController, type SttControllerOptions, type SttEditor, type SttState } from "../../stt/stt-controller";
import type {
	RpcExtensionUIRequest,
	RpcSttCancelResult,
	RpcSttStartResult,
	RpcSttStatus,
	RpcSttStopResult,
} from "./rpc-types";

export const RPC_STT_TEXT_MAX_BYTES = 64 * 1024;
export const RPC_STT_ERROR_MAX_BYTES = 2 * 1024;
type RpcSttExtensionFrame = RpcExtensionUIRequest extends infer Request
	? Request extends RpcExtensionUIRequest
		? Omit<Request, "type" | "id">
		: never
	: never;

const RPC_STT_STATUS_KEY = "stt";

export interface RpcSttController {
	readonly state: SttState;
	start(editor: SttEditor, options: SttControllerOptions): Promise<boolean>;
	stop(options: SttControllerOptions): Promise<boolean>;
	cancel(options?: SttControllerOptions): void;
	dispose(): void;
}

export interface RpcSttServiceOptions {
	controller?: RpcSttController;
	isAvailable?: () => boolean;
	model?: () => string;
	terminateWorker?: () => Promise<void>;
}

function boundUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	let low = 0;
	let high = value.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
		else high = middle - 1;
	}
	let bounded = value.slice(0, low);
	if (bounded.length > 0) {
		const last = bounded.charCodeAt(bounded.length - 1);
		if (last >= 0xd800 && last <= 0xdbff) bounded = bounded.slice(0, -1);
	}
	return bounded;
}

/** Remove credential-shaped material before worker/native errors cross the RPC boundary. */
export function sanitizeRpcSttError(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error || "Speech-to-text failed");
	const sanitized = raw
		.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
		.replace(/([?&](?:api[_-]?key|access[_-]?token|auth|key|secret|signature|token)=)[^&\s]+/gi, "$1[REDACTED]")
		.replace(/\b(Bearer|Basic)\s+[a-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
		.replace(/\b((?:api[_-]?key|access[_-]?token|authorization|secret|token)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
		.replace(/\b(?:sk|key|token|secret)-[a-z0-9_-]{8,}\b/gi, "[REDACTED]");
	return boundUtf8(sanitized || "Speech-to-text failed", RPC_STT_ERROR_MAX_BYTES);
}

/** In-memory composer used by headless RPC speech capture. */
export class RpcSttEditor implements SttEditor {
	#committed = "";
	#volatile = "";
	readonly #onChange: (text: string) => void;

	constructor(onChange: (text: string) => void) {
		this.#onChange = onChange;
	}

	get text(): string {
		return this.#committed + this.#volatile;
	}

	reset(): void {
		this.#committed = "";
		this.#volatile = "";
		this.#onChange("");
	}

	insertText(text: string): void {
		this.#appendCommitted(text);
	}

	setVolatileText(text: string): void {
		const remaining = Math.max(0, RPC_STT_TEXT_MAX_BYTES - Buffer.byteLength(this.#committed, "utf8"));
		this.#volatile = boundUtf8(text, remaining);
		this.#onChange(this.text);
	}

	clearVolatileText(): void {
		if (!this.#volatile) return;
		this.#volatile = "";
		this.#onChange(this.text);
	}

	commitVolatileText(text: string): void {
		this.#volatile = "";
		this.#appendCommitted(text);
	}

	submit(): void {
		// Speech submit triggers are interactive-only; RPC returns the transcript to its host.
	}

	deleteBeforeCursor(count: number): void {
		if (!Number.isFinite(count) || count <= 0) return;
		this.#committed = this.#committed.slice(0, Math.max(0, this.#committed.length - Math.floor(count)));
		this.#onChange(this.text);
	}

	#appendCommitted(text: string): void {
		const remaining = Math.max(0, RPC_STT_TEXT_MAX_BYTES - Buffer.byteLength(this.#committed, "utf8"));
		this.#committed += boundUtf8(text, remaining);
		this.#onChange(this.text);
	}
}

/** Owns the single capture allowed in one RPC process and its extension notifications. */
export class RpcSttService {
	readonly #controller: RpcSttController;
	readonly #editor: RpcSttEditor;
	readonly #output: (frame: RpcExtensionUIRequest) => void;
	readonly #isAvailable: () => boolean;
	readonly #model: () => string;
	readonly #terminateWorker: () => Promise<void>;
	#activeTask: Promise<void> | null = null;
	#lastError: string | undefined;
	#progress: number | undefined;
	#disposed = false;
	#disposePromise: Promise<void> | null = null;
	#notificationId = 0;

	constructor(output: (frame: RpcExtensionUIRequest) => void, options: RpcSttServiceOptions = {}) {
		this.#output = output;
		this.#controller = options.controller ?? new STTController();
		this.#isAvailable = options.isAvailable ?? (() => settings.get("stt.enabled") === true);
		this.#model =
			options.model ?? (() => resolveSttModelSpec(settings.get("stt.modelName") as string | undefined).key);
		this.#terminateWorker = options.terminateWorker ?? shutdownSttClient;
		this.#editor = new RpcSttEditor(text => {
			this.#emit({ method: "set_editor_text", text });
		});
	}

	status(): RpcSttStatus {
		const available = !this.#disposed && this.#isAvailable();
		return {
			ok: true,
			available,
			state: this.#controller.state,
			model: boundUtf8(this.#model(), 128),
			...(this.#progress !== undefined ? { progress: this.#progress } : {}),
			...(this.#lastError ? { error: this.#lastError } : {}),
		};
	}

	async start(): Promise<RpcSttStartResult> {
		this.#assertOpen();
		if (!this.#isAvailable()) throw new Error("Speech-to-text is disabled or unavailable");
		if (this.#activeTask || this.#controller.state !== "idle") throw new Error("Speech capture is already active");

		this.#lastError = undefined;
		this.#progress = undefined;
		this.#editor.reset();
		let warning: string | undefined;
		const task = this.#controller.start(
			this.#editor,
			this.#controllerOptions(message => {
				warning = sanitizeRpcSttError(message);
				this.#lastError = warning;
			}),
		);
		const settled = task.then(
			() => undefined,
			() => undefined,
		);
		this.#activeTask = settled;
		try {
			const started = await task;
			if (!started) throw new Error(warning ?? "Speech capture was cancelled before it started");
			this.#progress = undefined;
			return { ok: true, state: "recording", model: boundUtf8(this.#model(), 128) };
		} finally {
			if (this.#activeTask === settled) this.#activeTask = null;
		}
	}

	async stop(): Promise<RpcSttStopResult> {
		this.#assertOpen();
		if (this.#activeTask || this.#controller.state !== "recording") {
			throw new Error("Speech capture is not recording");
		}
		let warning: string | undefined;
		const task = this.#controller.stop(
			this.#controllerOptions(message => {
				warning = sanitizeRpcSttError(message);
				this.#lastError = warning;
			}),
		);
		const settled = task.then(
			() => undefined,
			() => undefined,
		);
		this.#activeTask = settled;
		try {
			const stopped = await task;
			if (!stopped) throw new Error(warning ?? "Speech capture could not be stopped");
			if (warning) throw new Error(warning);
			this.#progress = undefined;
			return { ok: true, text: boundUtf8(this.#editor.text, RPC_STT_TEXT_MAX_BYTES), state: "idle" };
		} finally {
			if (this.#activeTask === settled) this.#activeTask = null;
		}
	}

	async cancel(): Promise<RpcSttCancelResult> {
		if (this.#disposed) return { ok: true, state: "idle" };
		this.#controller.cancel(this.#controllerOptions());
		await this.#activeTask;
		this.#progress = undefined;
		this.#lastError = undefined;
		this.#editor.reset();
		this.#emit({ method: "setStatus", statusKey: RPC_STT_STATUS_KEY, statusText: undefined });
		return { ok: true, state: "idle" };
	}

	dispose(): Promise<void> {
		if (!this.#disposePromise) this.#disposePromise = this.#dispose();
		return this.#disposePromise;
	}

	async #dispose(): Promise<void> {
		this.#disposed = true;
		this.#controller.cancel(this.#controllerOptions());
		await this.#activeTask;
		this.#controller.dispose();
		this.#activeTask = null;
		await this.#terminateWorker();
	}

	#assertOpen(): void {
		if (this.#disposed) throw new Error("Speech-to-text service is disposed");
	}

	#controllerOptions(onWarning?: (message: string) => void): SttControllerOptions {
		return {
			showWarning: message => {
				const safe = sanitizeRpcSttError(message);
				this.#lastError = safe;
				onWarning?.(safe);
				this.#emit({ method: "notify", message: safe, notifyType: "error" });
			},
			showStatus: message => {
				this.#emit({
					method: "setStatus",
					statusKey: RPC_STT_STATUS_KEY,
					statusText: boundUtf8(message, 512) || undefined,
				});
			},
			onStateChange: state => {
				const statusText =
					state === "recording" ? "Listening…" : state === "transcribing" ? "Transcribing…" : undefined;
				this.#emit({ method: "setStatus", statusKey: RPC_STT_STATUS_KEY, statusText });
			},
			allowSubmitTrigger: false,
			sanitizeError: sanitizeRpcSttError,
			onProgress: progress => {
				this.#progress = Math.max(0, Math.min(100, Math.round(progress.percent)));
				this.#emit({
					method: "setStatus",
					statusKey: RPC_STT_STATUS_KEY,
					statusText: `Downloading speech model ${boundUtf8(progress.label, 128)} (${this.#progress}%)`,
				});
			},
		};
	}

	#emit(frame: RpcSttExtensionFrame): void {
		this.#output({
			type: "extension_ui_request",
			id: `stt_${++this.#notificationId}`,
			...frame,
		} as RpcExtensionUIRequest);
	}
}
