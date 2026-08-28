import { describe, expect, it } from "bun:test";
import { spawnSync } from "../src/proc";

describe("spawnSync", () => {
	it("captures both streams and reports the exit status", () => {
		const result = spawnSync(["sh", "-c", "echo out; echo err 1>&2; exit 3"]);

		expect(result.stdout.toString()).toBe("out\n");
		expect(result.stderr.toString()).toBe("err\n");
		expect(result.exitCode).toBe(3);
		expect(result.success).toBe(false);
		expect(result.signalCode).toBeNull();
	});

	it("accepts the single-object call shape with cwd and env", () => {
		const result = spawnSync({
			cmd: ["sh", "-c", "printf %s \"$PROC_PROBE\"; pwd"],
			cwd: "/",
			env: { PROC_PROBE: "value", PATH: process.env.PATH },
			stdout: "pipe",
			stderr: "pipe",
		});

		expect(result.stdout.toString()).toBe("value/\n");
		expect(result.success).toBe(true);
	});

	it("throws on a missing executable instead of returning a failed result", () => {
		expect(() => spawnSync(["definitely-not-a-binary-xyz"])).toThrow(
			expect.objectContaining({ code: "ENOENT" }),
		);
	});

	it("reports the terminating signal", () => {
		const result = spawnSync(["sh", "-c", "kill -TERM $$"]);

		expect(result.signalCode).toBe("SIGTERM");
		expect(result.success).toBe(false);
	});

	it("reports a timeout as a result rather than throwing", () => {
		const result = spawnSync(["sh", "-c", "sleep 5"], { timeout: 150, stdout: "pipe", stderr: "pipe" });

		expect(result.exitedDueToTimeout).toBe(true);
		expect(result.exitCode).toBeNull();
		expect(result.success).toBe(false);
	});

	it("leaves the timeout marker false for an ordinary non-zero exit", () => {
		const result = spawnSync(["sh", "-c", "exit 1"], { timeout: 5_000 });

		expect(result.exitedDueToTimeout).toBe(false);
		expect(result.exitCode).toBe(1);
	});

	it("returns empty buffers for streams that were not piped", () => {
		const result = spawnSync(["sh", "-c", "echo swallowed"], { stdout: "ignore", stderr: "ignore" });

		expect(result.stdout.byteLength).toBe(0);
		expect(result.stderr.byteLength).toBe(0);
		expect(result.success).toBe(true);
	});

	it("rejects an empty command", () => {
		expect(() => spawnSync([])).toThrow(TypeError);
	});
});
