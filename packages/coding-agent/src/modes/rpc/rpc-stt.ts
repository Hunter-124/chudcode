import { Buffer } from "node:buffer";
import type { ModelRegistry } from "../../config/model-registry";
import { resolveRoleChain } from "../../config/model-resolver";
import { roleCandidatePool } from "../../config/model-roles";
import type { Settings } from "../../config/settings";
import { shutdownSttClient } from "../../stt/asr-client";
import { resolveSttModelSpec } from "../../stt/models";
import { cfgSttEnabled } from "../../stt/settings";
import { STTController, type SttCallbacks, type SttState, type SttTarget } from "../../stt/stt-controller";
import type {
	RpcExtensionUIRequest,
	RpcSttCancelResult,
	RpcSttStartResult,
	RpcSttStatus,
	RpcSttStopResult,
} from "./rpc-types";

export const RPC_STT_TEXT_MAX_BYTES = 64 * 1024;
export const RPC_STT_ERROR_MAX_BYTES = 2 * 1024;

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
	if (bounded.length > 0 && /[\uD800-\uDBFF]/.test(bounded.at(-1) ?? "")) bounded = bounded.slice(0, -1);
	return bounded;
}

/** Never expose raw worker/provider exceptions across the embedding boundary. */
export function sanitizeRpcSttError(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error || "Speech-to-text failed");
	return boundUtf8(
		raw
			.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
			.replace(/([?&](?:api[_-]?key|access[_-]?token|auth|key|secret|signature|token)=)[^&\s]+/gi, "$1[REDACTED]")
			.replace(/\b(Bearer|Basic)\s+[a-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
			.replace(/\b((?:api[_-]?key|access[_-]?token|authorization|secret|token)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
			.replace(/\b(?:sk|key|token|secret)-[a-z0-9_-]{8,}\b/gi, "[REDACTED]") || "Speech-to-text failed",
		RPC_STT_ERROR_MAX_BYTES,
	);
}

/** A bounded in-memory editor: never submit recognized speech as a prompt. */
export class RpcSttEditor implements SttTarget {
	#committed = "";
	#volatile = "";
	constructor(readonly onChange: (text: string) => void) {}
	get text(): string {
		return this.#committed + this.#volatile;
	}
	reset(): void {
		this.#committed = "";
		this.#volatile = "";
		this.onChange("");
	}
	setVolatileText(text: string): void {
		this.#volatile = boundUtf8(text, RPC_STT_TEXT_MAX_BYTES - Buffer.byteLength(this.#committed));
		this.onChange(this.text);
	}
	clearVolatileText(): void {
		this.#volatile = "";
		this.onChange(this.text);
	}
	commitVolatileText(text: string): void {
		this.#volatile = "";
		this.#append(text);
	}
	submit(): void {
		/* The host decides when to send the transcript. */
	}
	deleteBeforeCursor(count: number): void {
		if (!Number.isFinite(count) || count <= 0) return;
		this.#committed = this.#committed.slice(0, Math.max(0, this.#committed.length - Math.floor(count)));
		this.onChange(this.text);
	}
	#append(text: string): void {
		this.#committed += boundUtf8(text, RPC_STT_TEXT_MAX_BYTES - Buffer.byteLength(this.#committed));
		this.onChange(this.text);
	}
}

export interface RpcSttController {
	readonly state: SttState;
	start(target: SttTarget, callbacks: SttCallbacks): Promise<void>;
	stop(): Promise<void>;
	dispose(): void;
}

export interface RpcSttServiceOptions {
	controllerFactory?: () => RpcSttController;
	isAvailable?: () => boolean;
	model?: () => string;
	terminateWorker?: () => Promise<void>;
}

type RpcSttNotification =
	| { method: "set_editor_text"; text: string }
	| { method: "setStatus"; statusKey: string; statusText: string | undefined }
	| { method: "notify"; message: string; notifyType: "error" };

/** Owns one capture per RPC process; status and cancel can overtake slow start/stop. */
export class RpcSttService {
	#controller: RpcSttController;
	readonly #controllerFactory: () => RpcSttController;
	readonly #editor: RpcSttEditor;
	readonly #output: (frame: RpcExtensionUIRequest) => void;
	readonly #isAvailable: () => boolean;
	readonly #model: () => string;
	readonly #terminateWorker: () => Promise<void>;
	#activeTask: Promise<void> | null = null;
	#cancelActive: (() => void) | null = null;
	#lastError: string | undefined;
	#disposed = false;
	#disposePromise: Promise<void> | null = null;
	#notificationId = 0;

	constructor(
		output: (frame: RpcExtensionUIRequest) => void,
		settings: Settings,
		registry: ModelRegistry,
		options: RpcSttServiceOptions = {},
	) {
		this.#output = output;
		this.#controllerFactory = options.controllerFactory ?? (() => new STTController({ settings, registry }));
		this.#controller = this.#controllerFactory();
		this.#isAvailable = options.isAvailable ?? (() => cfgSttEnabled.get(settings));
		this.#model =
			options.model ??
			(() => {
				const selected = resolveRoleChain(
					"dictation",
					settings,
					roleCandidatePool("dictation", settings, registry),
				)[0]?.model;
				return selected?.api === "openai-transcriptions" ? selected.id : resolveSttModelSpec(selected?.id).key;
			});
		this.#terminateWorker = options.terminateWorker ?? shutdownSttClient;
		this.#editor = new RpcSttEditor(text => this.#emit({ method: "set_editor_text", text }));
	}

	status(): RpcSttStatus {
		return {
			ok: true,
			available: !this.#disposed && this.#isAvailable(),
			state: this.#controller.state,
			model: boundUtf8(this.#model(), 128),
			...(this.#lastError ? { error: this.#lastError } : {}),
		};
	}

	async start(): Promise<RpcSttStartResult> {
		this.#assertOpen();
		if (!this.#isAvailable()) throw new Error("Speech-to-text is disabled or unavailable");
		if (this.#activeTask || this.#controller.state !== "idle") throw new Error("Speech capture is already active");
		this.#lastError = undefined;
		this.#editor.reset();
		const controller = this.#controller;
		const task = controller.start(this.#editor, this.#callbacks(controller));
		const pending = task.then(
			() => undefined,
			() => undefined,
		);
		const cancellation = Promise.withResolvers<void>();
		const cancel = () => cancellation.reject(new Error("Speech capture was cancelled"));
		this.#activeTask = pending;
		this.#cancelActive = cancel;
		void pending.then(() => {
			if (this.#controller !== controller || this.#disposed) controller.dispose();
		});
		try {
			await Promise.race([task, cancellation.promise]);
			if (this.#controller !== controller || this.#disposed) throw new Error("Speech capture was cancelled");
			if (controller.state !== "recording") throw new Error(this.#lastError ?? "Speech capture could not start");
			return { ok: true, state: "recording", model: boundUtf8(this.#model(), 128) };
		} finally {
			if (this.#activeTask === pending) this.#activeTask = null;
			if (this.#cancelActive === cancel) this.#cancelActive = null;
		}
	}

	async stop(): Promise<RpcSttStopResult> {
		this.#assertOpen();
		if (this.#activeTask || this.#controller.state !== "recording")
			throw new Error("Speech capture is not recording");
		this.#lastError = undefined;
		const controller = this.#controller;
		const task = controller.stop();
		const pending = task.then(
			() => undefined,
			() => undefined,
		);
		const cancellation = Promise.withResolvers<void>();
		const cancel = () => cancellation.reject(new Error("Speech capture was cancelled"));
		this.#activeTask = pending;
		this.#cancelActive = cancel;
		void pending.then(() => {
			if (this.#controller !== controller || this.#disposed) controller.dispose();
		});
		try {
			await Promise.race([task, cancellation.promise]);
			if (this.#controller !== controller || this.#disposed) throw new Error("Speech capture was cancelled");
			if (this.#lastError) throw new Error(this.#lastError);
			return { ok: true, text: this.#editor.text, state: "idle" };
		} finally {
			if (this.#activeTask === pending) this.#activeTask = null;
			if (this.#cancelActive === cancel) this.#cancelActive = null;
		}
	}

	async cancel(): Promise<RpcSttCancelResult> {
		if (this.#disposed) return { ok: true, state: "idle" };
		if (this.#activeTask || this.#controller.state !== "idle") {
			this.#controller.dispose();
			this.#cancelActive?.();
			this.#activeTask = null;
			this.#controller = this.#controllerFactory();
		}
		this.#lastError = undefined;
		this.#editor.reset();
		this.#emit({ method: "setStatus", statusKey: "stt", statusText: undefined });
		return { ok: true, state: "idle" };
	}

	dispose(): Promise<void> {
		if (!this.#disposePromise) this.#disposePromise = this.#close();
		return this.#disposePromise;
	}

	async #close(): Promise<void> {
		this.#disposed = true;
		this.#controller.dispose();
		this.#cancelActive?.();
		this.#activeTask = null;
		await this.#terminateWorker();
	}

	#assertOpen(): void {
		if (this.#disposed) throw new Error("Speech-to-text service is disposed");
	}
	#callbacks(controller: RpcSttController): SttCallbacks {
		return {
			showWarning: message => {
				if (this.#disposed || this.#controller !== controller) return;
				const safe = sanitizeRpcSttError(message);
				this.#lastError = safe;
				this.#emit({ method: "notify", message: safe, notifyType: "error" });
			},
			showStatus: message => {
				if (this.#disposed || this.#controller !== controller) return;
				this.#emit({ method: "setStatus", statusKey: "stt", statusText: boundUtf8(message, 512) || undefined });
			},
			onStateChange: state => {
				if (this.#disposed || this.#controller !== controller) return;
				this.#emit({
					method: "setStatus",
					statusKey: "stt",
					statusText:
						state === "recording" ? "Listening…" : state === "transcribing" ? "Transcribing…" : undefined,
				});
			},
		};
	}
	#emit(frame: RpcSttNotification): void {
		this.#output({
			type: "extension_ui_request",
			id: `stt_${++this.#notificationId}`,
			...frame,
		} as RpcExtensionUIRequest);
	}
}
