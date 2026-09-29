import type { MemoryBackend } from "./types";

export const BUILTIN_MEMORY_BACKEND_IDS = ["off", "local", "hindsight", "mnemopi", "sharpshooter"] as const;
/** The setting's live enum vocabulary; CloudCastle is accepted before its extension finishes loading. */
const memoryBackendIds: string[] = [...BUILTIN_MEMORY_BACKEND_IDS, "cloudcastle-incident"];

interface Registration {
	backend: MemoryBackend;
	sourceId: string;
	token: symbol;
}

const registrations = new Map<string, Registration[]>();

/** Multiple sessions of the same extension may bind independently; unrelated sources cannot steal an id. */
export function registerMemoryBackend(backend: MemoryBackend, sourceId: string): () => void {
	if (!backend.id || backend.id !== backend.id.trim() || !sourceId || sourceId !== sourceId.trim()) {
		throw new TypeError("Memory backend id and source id must be non-empty trimmed strings");
	}
	const current = registrations.get(backend.id) ?? [];
	const conflict = current.find(entry => entry.sourceId !== sourceId);
	if (conflict) throw new Error(`Memory backend "${backend.id}" is already registered by "${conflict.sourceId}"`);
	const token = Symbol(backend.id);
	current.push({ backend, sourceId, token });
	registrations.set(backend.id, current);
	if (!memoryBackendIds.includes(backend.id)) memoryBackendIds.push(backend.id);
	return () => {
		const remaining = registrations.get(backend.id)?.filter(entry => entry.token !== token);
		if (!remaining?.length) {
			registrations.delete(backend.id);
			if (!BUILTIN_MEMORY_BACKEND_IDS.some(id => id === backend.id) && backend.id !== "cloudcastle-incident") {
				memoryBackendIds.splice(memoryBackendIds.indexOf(backend.id), 1);
			}
		} else registrations.set(backend.id, remaining);
	};
}

export function getRegisteredMemoryBackend(id: string): MemoryBackend | undefined {
	return registrations.get(id)?.at(-1)?.backend;
}

export function getMemoryBackendIds(): readonly string[] {
	return memoryBackendIds;
}
