import { describe, expect, it } from "bun:test";
import {
	type PowerInhibitorBackend,
	type PowerInhibitorHandle,
	type PowerInhibitorRequest,
	powerInhibitPlan,
	SleepInhibitor,
	selectPowerInhibitorBackend,
} from "../src/power";

/** Records every acquire/release so the mode decision and release count are observable. */
class RecordingBackend implements PowerInhibitorBackend {
	readonly id = "recording";
	readonly requests: PowerInhibitorRequest[] = [];
	releaseCalls = 0;

	constructor(readonly outcome: "handle" | "unsupported" | "throw" = "handle") {}

	acquire(request: PowerInhibitorRequest): PowerInhibitorHandle | undefined {
		this.requests.push(request);
		if (this.outcome === "throw") throw new Error("backend exploded");
		if (this.outcome === "unsupported") return undefined;
		return {
			release: () => {
				this.releaseCalls++;
			},
		};
	}
}

describe("powerInhibitPlan", () => {
	it("expands the cumulative enum so every level adds the lower levels", () => {
		expect(powerInhibitPlan("idle")).toEqual({ idle: true, display: false, system: false });
		expect(powerInhibitPlan("display")).toEqual({ idle: true, display: true, system: false });
		expect(powerInhibitPlan("system")).toEqual({ idle: true, display: true, system: true });
	});
});

describe("SleepInhibitor mode decision", () => {
	it("does not touch the backend when the mode is off", () => {
		const backend = new RecordingBackend();
		const inhibitor = new SleepInhibitor({ who: "omp", why: "test", backend });

		inhibitor.acquire("off");

		expect(backend.requests).toEqual([]);
		expect(inhibitor.active).toBe(false);
	});

	it("acquires with the requested level and identity when enabled", () => {
		const backend = new RecordingBackend();
		const inhibitor = new SleepInhibitor({ who: "omp", why: "agent turn in progress", backend });

		inhibitor.acquire("display");

		expect(backend.requests).toEqual([{ mode: "display", who: "omp", why: "agent turn in progress" }]);
		expect(inhibitor.active).toBe(true);
	});

	it("holds at most one inhibition across repeated acquires", () => {
		const backend = new RecordingBackend();
		const inhibitor = new SleepInhibitor({ who: "omp", why: "test", backend });

		inhibitor.acquire("idle");
		inhibitor.acquire("idle");
		inhibitor.acquire("system");

		expect(backend.requests).toHaveLength(1);
		inhibitor.release();
		expect(backend.releaseCalls).toBe(1);
	});

	it("stays inactive when the platform cannot inhibit, and release stays safe", () => {
		const backend = new RecordingBackend("unsupported");
		const inhibitor = new SleepInhibitor({ who: "omp", why: "test", backend });

		inhibitor.acquire("idle");

		expect(backend.requests).toHaveLength(1);
		expect(inhibitor.active).toBe(false);
		expect(() => inhibitor.release()).not.toThrow();
		expect(backend.releaseCalls).toBe(0);
	});

	it("never propagates a backend failure to the caller", () => {
		const backend = new RecordingBackend("throw");
		const inhibitor = new SleepInhibitor({ who: "omp", why: "test", backend });

		expect(() => inhibitor.acquire("idle")).not.toThrow();
		expect(inhibitor.active).toBe(false);
	});
});

describe("SleepInhibitor release idempotence", () => {
	it("releases the underlying handle exactly once no matter how often it is called", () => {
		const backend = new RecordingBackend();
		const inhibitor = new SleepInhibitor({ who: "omp", why: "test", backend });

		inhibitor.acquire("idle");
		inhibitor.release();
		inhibitor.release();
		inhibitor.release();

		expect(backend.releaseCalls).toBe(1);
		expect(inhibitor.active).toBe(false);
	});

	it("is a no-op before anything was ever acquired", () => {
		const backend = new RecordingBackend();
		const inhibitor = new SleepInhibitor({ who: "omp", why: "test", backend });

		inhibitor.release();

		expect(backend.releaseCalls).toBe(0);
		expect(backend.requests).toEqual([]);
	});

	it("can be re-acquired after release", () => {
		const backend = new RecordingBackend();
		const inhibitor = new SleepInhibitor({ who: "omp", why: "test", backend });

		inhibitor.acquire("idle");
		inhibitor.release();
		inhibitor.acquire("idle");

		expect(backend.requests).toHaveLength(2);
		expect(inhibitor.active).toBe(true);
		inhibitor.release();
		expect(backend.releaseCalls).toBe(2);
	});
});

describe("selectPowerInhibitorBackend", () => {
	it("resolves a backend for every supported platform and none elsewhere", () => {
		expect(selectPowerInhibitorBackend("linux")?.id).toBe("logind");
		expect(selectPowerInhibitorBackend("win32")?.id).toBe("win32-execution-state");
		expect(selectPowerInhibitorBackend("darwin")?.id).toBe("macos-power-assertion");
		expect(selectPowerInhibitorBackend("freebsd")).toBeUndefined();
	});
});
