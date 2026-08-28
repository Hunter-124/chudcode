import { setTimeout as delay } from "node:timers/promises";

/**
 * Resolve after `ms` milliseconds.
 *
 * The single sleep seam for the whole repo: it keeps call sites host-agnostic
 * (no `Bun.sleep`) and gives tests one function to stub when they drive a
 * virtual clock, which spying on a runtime global used to provide.
 *
 * A pending sleep holds the event loop open, matching the timer semantics call
 * sites were written against. Pass `ref: false` for a sleep that must not keep
 * the process alive, or `signal` to reject early on abort.
 */
export function sleep(ms: number, options?: { signal?: AbortSignal; ref?: boolean }): Promise<void> {
	return delay(ms, undefined, options);
}

const SYNC_SLEEP_SLOT = new Int32Array(new SharedArrayBuffer(4));

/**
 * Block the calling thread for `ms` milliseconds.
 *
 * Replaces `Bun.sleepSync`. Only for the rare synchronous retry loop that has no
 * async seam (temp-directory removal, store compaction); everything else uses
 * {@link sleep}.
 */
export function sleepSync(ms: number): void {
	if (ms <= 0) return;
	Atomics.wait(SYNC_SLEEP_SLOT, 0, 0, ms);
}

/**
 * Wrap a promise with a timeout and optional abort signal.
 * Rejects with the given message if the timeout fires first.
 * Cleans up all listeners on settlement.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string, signal?: AbortSignal): Promise<T> {
	if (signal?.aborted) {
		const reason = signal.reason instanceof Error ? signal.reason : new Error("Aborted");
		return Promise.reject(reason);
	}

	const { promise: wrapped, resolve, reject } = Promise.withResolvers<T>();
	let settled = false;
	const timeoutId = setTimeout(() => {
		if (settled) return;
		settled = true;
		if (signal) signal.removeEventListener("abort", onAbort);
		reject(new Error(message));
	}, ms);

	const onAbort = () => {
		if (settled) return;
		settled = true;
		clearTimeout(timeoutId);
		reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
	};

	if (signal) {
		signal.addEventListener("abort", onAbort, { once: true });
	}

	promise.then(
		value => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			if (signal) signal.removeEventListener("abort", onAbort);
			resolve(value);
		},
		err => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			if (signal) signal.removeEventListener("abort", onAbort);
			reject(err);
		},
	);

	return wrapped;
}

/**
 * Coalesces rapid-fire writes into one deferred batch. `push` queues a value
 * and returns a promise for the batch flush; the first push of a batch arms a
 * timer (`delayMs`, or a microtask at 0), and every push before it fires joins
 * the same batch and shares the same promise. Used to keep hot paths off
 * synchronous storage (prompt history, model perf).
 */
export class AsyncDrain<T> {
	#queue?: T[];
	#promise = Promise.resolve();

	constructor(readonly delayMs: number = 0) {}

	/** Queue `value`; `hnd` receives the whole batch when the window closes. */
	push(value: T, hnd: (values: T[]) => Promise<void> | void): Promise<void> {
		let queue = this.#queue;
		if (!queue) {
			this.#queue = queue = [];
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			const exec = (): void => {
				try {
					if (this.#queue === queue) {
						this.#queue = undefined;
					}
					resolve(hnd(queue!));
				} catch (error) {
					reject(error);
				}
			};
			if (this.delayMs > 0) {
				setTimeout(exec, this.delayMs);
			} else {
				queueMicrotask(exec);
			}
			this.#promise = promise;
		}
		queue.push(value);
		return this.#promise;
	}
}
