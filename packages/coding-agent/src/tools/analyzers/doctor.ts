import type { ToolSession } from "..";
import { runCommand } from "./process";

export interface ToolProbeSpec {
	name: string;
	command?: string;
	versionArgs: string[];
	versionRegex?: RegExp;
}

export interface ToolProbe {
	name: string;
	found: boolean;
	path?: string;
	version?: string;
}

export async function probeTools(
	specs: ToolProbeSpec[],
	options: { cwd?: string; signal?: AbortSignal; session?: ToolSession } = {},
): Promise<ToolProbe[]> {
	return Promise.all(
		specs.map(async spec => {
			const executable = spec.command ?? spec.name;
			const resolved = Bun.which(executable);
			if (!resolved) return { name: spec.name, found: false } satisfies ToolProbe;
			const result = await runCommand([resolved, ...spec.versionArgs], {
				cwd: options.cwd,
				signal: options.signal,
				timeoutMs: 10_000,
				captureBytes: 64 * 1024,
				session: options.session,
				artifactType: "doctor",
			});
			const output = `${result.stdout}\n${result.stderr}`.trim();
			const match = spec.versionRegex?.exec(output);
			const version = match?.[1] ?? match?.[0] ?? output.split(/\r?\n/, 1)[0]?.trim();
			return { name: spec.name, found: true, path: resolved, version: version || undefined } satisfies ToolProbe;
		}),
	);
}

export function missingTool(name: string, hint: string): { ok: false; reason: string; hint: string } {
	return { ok: false, reason: `${name.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}_missing`, hint };
}
