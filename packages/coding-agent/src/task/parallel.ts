import type { SemaphoreMemoryOptions } from "./types";

/**
 * Parallel execution with concurrency control.
 */
/** Result of parallel execution */
export interface ParallelResult<R> {
	/** Results array - undefined entries indicate tasks that were skipped due to abort */
	results: (R | undefined)[];
	/** Whether execution was aborted before all tasks completed */
	aborted: boolean;
}

/**
 * Execute items with a concurrency limit using a worker pool pattern.
 * Results are returned in the same order as input items.
 *
 * On abort: returns partial results with `aborted: true`. Completed tasks are preserved,
 * in-progress tasks will complete with their abort handling, skipped tasks are `undefined`.
 *
 * On error: fails fast - does not wait for other workers to complete.
 *
 * @param items - Items to process
 * @param concurrency - Maximum concurrent operations
 * @param fn - Async function to execute for each item; receives a worker signal that fires on abort or fail-fast so in-flight siblings can cancel
 * @param signal - Optional abort signal to stop scheduling new work
 */
export async function mapWithConcurrencyLimit<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number, signal: AbortSignal) => Promise<R>,
	signal?: AbortSignal,
): Promise<ParallelResult<R>> {
	const normalizedConcurrency = Number.isFinite(concurrency) ? Math.floor(concurrency) : items.length;
	const effectiveConcurrency = normalizedConcurrency > 0 ? normalizedConcurrency : items.length;
	const limit = Math.max(1, Math.min(effectiveConcurrency, items.length));
	const results: (R | undefined)[] = new Array(items.length);
	let nextIndex = 0;

	// Create internal abort controller to cancel workers on any rejection
	const abortController = new AbortController();
	const workerSignal = signal ? AbortSignal.any([signal, abortController.signal]) : abortController.signal;

	// Promise that rejects on first error - used to fail fast (not for abort)
	let rejectFirst: (error: unknown) => void;
	const firstErrorPromise = new Promise<never>((_, reject) => {
		rejectFirst = reject;
	});

	const worker = async (): Promise<void> => {
		while (true) {
			// On abort, stop picking up new work - but don't throw
			if (workerSignal.aborted) return;
			const index = nextIndex++;
			if (index >= items.length) return;
			try {
				results[index] = await fn(items[index], index, workerSignal);
			} catch (error) {
				// On abort, the fn itself handles it and returns a result
				// Only propagate non-abort errors
				if (!workerSignal.aborted) {
					abortController.abort();
					rejectFirst(error);
					throw error;
				}
			}
		}
	};

	// Create worker pool
	const workers = Array(limit)
		.fill(null)
		.map(() => worker());

	try {
		await Promise.race([Promise.all(workers), firstErrorPromise]);
	} catch (error) {
		// If aborted, don't rethrow - return partial results
		if (signal?.aborted) {
			return { results, aborted: true };
		}
		throw error;
	}

	return { results, aborted: signal?.aborted ?? false };
}

/** Result of a concurrency-limited operation that waits for every launched item. */
export interface ParallelSettledResult<R> {
	/** Settled results in original input order; absent entries were never launched after cancellation. */
	results: (PromiseSettledResult<R> | undefined)[];
	/** Whether cancellation prevented scheduling all items. */
	aborted: boolean;
}

/**
 * Execute items with a concurrency limit without failing fast. Rejections are
 * captured at their input position and already launched siblings always settle
 * before this function returns. Cancellation stops new launches but preserves
 * the settled state of every item that began.
 */
export async function mapWithConcurrencyLimitAllSettled<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number, signal: AbortSignal) => Promise<R>,
	signal?: AbortSignal,
): Promise<ParallelSettledResult<R>> {
	const normalizedConcurrency = Number.isFinite(concurrency) ? Math.floor(concurrency) : items.length;
	const effectiveConcurrency = normalizedConcurrency > 0 ? normalizedConcurrency : items.length;
	const limit = Math.max(1, Math.min(effectiveConcurrency, items.length));
	const results: (PromiseSettledResult<R> | undefined)[] = new Array(items.length);
	const workerSignal = signal ?? new AbortController().signal;
	let nextIndex = 0;

	const worker = async (): Promise<void> => {
		while (!workerSignal.aborted) {
			const index = nextIndex++;
			if (index >= items.length) return;
			try {
				results[index] = { status: "fulfilled", value: await fn(items[index], index, workerSignal) };
			} catch (reason) {
				results[index] = { status: "rejected", reason };
			}
		}
	};

	await Promise.all(Array.from({ length: limit }, () => worker()));
	return { results, aborted: workerSignal.aborted };
}

interface SemaphoreWaiter {
	resolve: () => void;
	reject: (reason?: unknown) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

/**
 * Counting semaphore for independently scheduled async work. An optional
 * memory policy reserves a conservative budget for every admitted holder.
 *
 * `max <= 0` (or any non-finite input) means the count ceiling is unbounded,
 * matching `task.maxConcurrency = 0`'s "Unlimited" semantics. Memory admission
 * remains independent of that count setting.
 */
export function normalizeConcurrencyLimit(max: number): number {
	const normalizedMax = Number.isFinite(max) ? Math.trunc(max) : 0;
	return normalizedMax > 0 ? normalizedMax : 0;
}

function normalizeMemoryMB(value: number): number {
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export class Semaphore {
	#max: number;
	#current = 0;
	#queue: SemaphoreWaiter[] = [];
	#minimumFreeMemoryMB: number;
	#memoryReservationMB: number;
	readonly #sampleAvailableMemoryMB: SemaphoreMemoryOptions["sampleAvailableMemoryMB"] | undefined;
	#draining = false;
	#drainAgain = false;

	constructor(max: number, memory?: SemaphoreMemoryOptions) {
		const normalizedMax = normalizeConcurrencyLimit(max);
		this.#max = normalizedMax > 0 ? normalizedMax : Number.POSITIVE_INFINITY;
		this.#minimumFreeMemoryMB = normalizeMemoryMB(memory?.minimumFreeMB ?? 0);
		this.#memoryReservationMB = normalizeMemoryMB(memory?.reservationMB ?? 0);
		this.#sampleAvailableMemoryMB = memory?.sampleAvailableMemoryMB;
	}

	/**
	 * Resolves after both the hard count ceiling and the memory reservation
	 * policy admit this holder. A cancelled waiter is removed without consuming
	 * either capacity.
	 */
	acquire(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.reject(semaphoreAbortReason(signal));

		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const waiter: SemaphoreWaiter = signal ? { resolve, reject, signal } : { resolve, reject };
		if (signal) {
			waiter.onAbort = () => {
				const index = this.#queue.indexOf(waiter);
				if (index < 0) return;
				this.#queue.splice(index, 1);
				reject(semaphoreAbortReason(signal));
				this.#scheduleDrain();
			};
			signal.addEventListener("abort", waiter.onAbort, { once: true });
		}
		this.#queue.push(waiter);
		this.#scheduleDrain();
		return promise;
	}

	release(): void {
		if (this.#current > 0) this.#current--;
		this.#scheduleDrain();
	}

	/**
	 * Adjust the independent hard count ceiling in place. Lowering it lets
	 * in-flight holders drain; raising it immediately reconsiders queued work.
	 */
	resize(max: number): void {
		const normalizedMax = normalizeConcurrencyLimit(max);
		this.#max = normalizedMax > 0 ? normalizedMax : Number.POSITIVE_INFINITY;
		this.#scheduleDrain();
	}

	/** Atomically apply changed memory floor and reservation settings. */
	resizeMemoryAdmission(minimumFreeMB: number, reservationMB: number): void {
		this.#minimumFreeMemoryMB = normalizeMemoryMB(minimumFreeMB);
		this.#memoryReservationMB = normalizeMemoryMB(reservationMB);
		this.#scheduleDrain();
	}

	/**
	 * Reconsider queued work after an event-driven platform pressure update.
	 * Completion and cancellation call this through `release()` automatically;
	 * platform adapters with their own notifications can call it directly.
	 */
	notifyMemoryCapacityChanged(): void {
		this.#scheduleDrain();
	}

	#scheduleDrain(): void {
		if (this.#draining) {
			this.#drainAgain = true;
			return;
		}
		this.#draining = true;
		void this.#drainQueue();
	}

	async #drainQueue(): Promise<void> {
		try {
			do {
				this.#drainAgain = false;
				while (this.#current < this.#max) {
					const waiter = this.#queue[0];
					if (!waiter) break;
					if (waiter.signal?.aborted) {
						this.#queue.shift();
						waiter.reject(semaphoreAbortReason(waiter.signal));
						continue;
					}
					if (!(await this.#hasMemoryCapacity())) break;
					// The head may have been cancelled while the sampler was pending.
					if (this.#queue[0] !== waiter) continue;
					this.#queue.shift();
					if (waiter.signal && waiter.onAbort) {
						waiter.signal.removeEventListener("abort", waiter.onAbort);
					}
					this.#current++;
					waiter.resolve();
				}
			} while (this.#drainAgain);
		} finally {
			this.#draining = false;
			if (this.#drainAgain) this.#scheduleDrain();
		}
	}

	async #hasMemoryCapacity(): Promise<boolean> {
		if ((this.#minimumFreeMemoryMB === 0 && this.#memoryReservationMB === 0) || !this.#sampleAvailableMemoryMB) {
			return true;
		}
		// The progress floor is deliberate: one task must run even when the host
		// starts below the configured floor, otherwise nothing can complete and
		// release capacity.
		if (this.#current === 0) return true;
		try {
			const availableMB = await this.#sampleAvailableMemoryMB();
			if (!Number.isFinite(availableMB) || availableMB < 0) return false;
			const reservationsAfterAdmissionMB = (this.#current + 1) * this.#memoryReservationMB;
			return availableMB >= this.#minimumFreeMemoryMB + reservationsAfterAdmissionMB;
		} catch {
			// Unknown pressure is treated conservatively while preserving the
			// one-task progress floor above.
			return false;
		}
	}
}

function semaphoreAbortReason(signal: AbortSignal): unknown {
	const reason = signal.reason;
	if (reason !== undefined) return reason;
	return new Error("Semaphore acquire aborted");
}
