import { describe, expect, it } from "bun:test";
import { mapWithConcurrencyLimitAllSettled, Semaphore } from "@chudware/coding-agent/task/parallel";

describe("mapWithConcurrencyLimitAllSettled", () => {
	it("waits for valid siblings after one item rejects and keeps input order", async () => {
		const started: number[] = [];
		const secondGate = Promise.withResolvers<void>();
		const secondStarted = Promise.withResolvers<void>();
		const thirdStarted = Promise.withResolvers<void>();
		const pending = mapWithConcurrencyLimitAllSettled([0, 1, 2], 2, async item => {
			started.push(item);
			if (item === 0) throw new Error("first failed");
			if (item === 1) {
				secondStarted.resolve();
				await secondGate.promise;
			}
			if (item === 2) thirdStarted.resolve();
			return `item-${item}`;
		});
		await secondStarted.promise;
		await thirdStarted.promise;
		secondGate.resolve();
		const settled = await pending;
		expect(started).toEqual([0, 1, 2]);
		expect(settled.results.map(result => result?.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
		const second = settled.results[1];
		const third = settled.results[2];
		expect(second).toEqual({ status: "fulfilled", value: "item-1" });
		expect(third).toEqual({ status: "fulfilled", value: "item-2" });
	});

	it("stops scheduling after cancellation while awaiting an already launched sibling", async () => {
		const controller = new AbortController();
		const release = Promise.withResolvers<void>();
		const firstStarted = Promise.withResolvers<void>();
		const started: number[] = [];
		const pending = mapWithConcurrencyLimitAllSettled(
			[0, 1],
			1,
			async item => {
				started.push(item);
				firstStarted.resolve();
				await release.promise;
				return item;
			},
			controller.signal,
		);

		await firstStarted.promise;
		controller.abort();
		release.resolve();
		const settled = await pending;

		expect(started).toEqual([0]);
		expect(settled.aborted).toBe(true);
		expect(settled.results).toEqual([{ status: "fulfilled", value: 0 }, undefined]);
	});
});

describe("Semaphore memory admission", () => {
	it("enforces the free-memory floor plus reservations independently of the hard count ceiling", async () => {
		let availableMB = 300;
		let sampleCount = 0;
		const thirdSampled = Promise.withResolvers<void>();
		const semaphore = new Semaphore(3, {
			minimumFreeMB: 100,
			reservationMB: 100,
			sampleAvailableMemoryMB: () => {
				sampleCount++;
				if (sampleCount === 2) thirdSampled.resolve();
				return availableMB;
			},
		});

		await semaphore.acquire();
		await semaphore.acquire();
		const third = semaphore.acquire();
		await thirdSampled.promise;
		let thirdAdmitted = false;
		void third.then(() => {
			thirdAdmitted = true;
		});
		await Promise.resolve();
		expect(thirdAdmitted).toBe(false);

		availableMB = 400;
		semaphore.notifyMemoryCapacityChanged();
		await third;
		expect(thirdAdmitted).toBe(true);

		const countLimited = new Semaphore(1, {
			minimumFreeMB: 100,
			reservationMB: 100,
			sampleAvailableMemoryMB: () => 10_000,
		});
		await countLimited.acquire();
		const secondCountPermit = countLimited.acquire();
		let secondCountAdmitted = false;
		void secondCountPermit.then(() => {
			secondCountAdmitted = true;
		});
		await Promise.resolve();
		expect(secondCountAdmitted).toBe(false);
		countLimited.release();
		await secondCountPermit;

		semaphore.release();
		semaphore.release();
		semaphore.release();
		countLimited.release();
	});

	it("keeps a one-task progress floor and removes cancelled waiters without leaking reservations", async () => {
		const lowMemorySampled = Promise.withResolvers<void>();
		const semaphore = new Semaphore(4, {
			minimumFreeMB: 1024,
			reservationMB: 1024,
			sampleAvailableMemoryMB: () => {
				lowMemorySampled.resolve();
				return 0;
			},
		});
		await semaphore.acquire();

		const cancelled = new AbortController();
		const cancelledPermit = semaphore.acquire(cancelled.signal);
		await lowMemorySampled.promise;
		cancelled.abort(new Error("cancel queued task"));
		await expect(cancelledPermit).rejects.toThrow("cancel queued task");

		const nextPermit = semaphore.acquire();
		semaphore.release();
		await nextPermit;
		semaphore.release();
	});
});
