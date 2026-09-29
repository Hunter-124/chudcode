import type { MemoryBackend } from "./types";

export const BUILTIN_MEMORY_BACKEND_IDS = ["off", "local", "hindsight", "mnemo", "sharpshooter"] as const;

export type BuiltinMemoryBackendId = (typeof BUILTIN_MEMORY_BACKEND_IDS)[number];

interface MemoryBackendRegistration {
	backend: MemoryBackend;
	sourceId: string;
	token: symbol;
}

export interface RegisteredMemoryBackend {
	backend: MemoryBackend;
	sourceId: string;
}

const registrationsById = new Map<string, MemoryBackendRegistration[]>();

function assertRegistrationInput(backend: MemoryBackend, sourceId: string): void {
	if (backend.id.length === 0 || backend.id !== backend.id.trim()) {
		throw new TypeError("Memory backend id must be a non-empty trimmed string");
	}
	if (sourceId.length === 0 || sourceId !== sourceId.trim()) {
		throw new TypeError("Memory backend source id must be a non-empty trimmed string");
	}
}

function removeRegistration(id: string, token: symbol): void {
	const registrations = registrationsById.get(id);
	if (!registrations) return;
	const remaining = registrations.filter(registration => registration.token !== token);
	if (remaining.length === 0) registrationsById.delete(id);
	else registrationsById.set(id, remaining);
}

/**
 * Register a backend owned by one extension source.
 *
 * Rebinding the same id from the same source is supported so separately bound
 * sessions can coexist. A different source attempting to claim that id is
 * rejected explicitly rather than depending on extension discovery order.
 */
export function registerMemoryBackend(backend: MemoryBackend, sourceId: string): () => void {
	assertRegistrationInput(backend, sourceId);
	const registrations = registrationsById.get(backend.id) ?? [];
	const conflicting = registrations.find(registration => registration.sourceId !== sourceId);
	if (conflicting) {
		throw new Error(
			`Memory backend "${backend.id}" is already registered by "${conflicting.sourceId}"; ` +
				`"${sourceId}" cannot replace it`,
		);
	}

	const token = Symbol(backend.id);
	registrations.push({ backend, sourceId, token });
	registrationsById.set(backend.id, registrations);
	return () => removeRegistration(backend.id, token);
}

/** Remove all registrations for an id owned by one source. */
export function unregisterMemoryBackend(id: string, sourceId: string): boolean {
	const registrations = registrationsById.get(id);
	if (!registrations) return false;
	const remaining = registrations.filter(registration => registration.sourceId !== sourceId);
	if (remaining.length === registrations.length) return false;
	if (remaining.length === 0) registrationsById.delete(id);
	else registrationsById.set(id, remaining);
	return true;
}

/** Remove every registration owned by one source without affecting other extensions. */
export function unregisterMemoryBackendsForSource(sourceId: string): void {
	for (const [id, registrations] of registrationsById) {
		const remaining = registrations.filter(registration => registration.sourceId !== sourceId);
		if (remaining.length === 0) registrationsById.delete(id);
		else if (remaining.length !== registrations.length) registrationsById.set(id, remaining);
	}
}

/** Return the active extension registration for an id, if present. */
export function getRegisteredMemoryBackend(id: string): RegisteredMemoryBackend | undefined {
	const registrations = registrationsById.get(id);
	const active = registrations?.at(-1);
	return active ? { backend: active.backend, sourceId: active.sourceId } : undefined;
}

/** Built-in and currently registered ids accepted by settings validation and selectors. */
export function getMemoryBackendIds(): readonly string[] {
	const ids: string[] = [...BUILTIN_MEMORY_BACKEND_IDS];
	for (const id of registrationsById.keys()) {
		if (!ids.includes(id)) ids.push(id);
	}
	return ids;
}
