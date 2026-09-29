import type { Settings } from "../config/settings";
import { localBackend } from "./local-backend";
import { offBackend } from "./off-backend";
import { getMemoryBackendIds, getRegisteredMemoryBackend } from "./registry";
import type { MemoryBackend } from "./types";

/**
 * Pick the active memory backend for a Settings instance.
 *
 * Extension registrations take precedence over built-ins, including when an
 * extension intentionally uses a built-in id. Built-ins keep their lazy
 * loading and no-op behavior.
 */
export async function resolveMemoryBackend(settings: Settings): Promise<MemoryBackend> {
	const id = settings.get("memory.backend");
	const registered = getRegisteredMemoryBackend(id);
	if (registered) return registered.backend;
	// Keep optional heavy backend dependencies lazy exactly as before.
	if (id === "hindsight") return (await import("../hindsight/backend")).hindsightBackend;
	if (id === "mnemo") return (await import("../mnemo/backend")).mnemopiBackend;
	if (id === "sharpshooter") return (await import("../sharpshooter/backend")).sharpshooterBackend;
	if (id === "local") return localBackend;
	if (id === "off") return offBackend;
	throw new Error(`Unknown memory backend "${id}". Available backends: ${getMemoryBackendIds().join(", ")}`);
}
