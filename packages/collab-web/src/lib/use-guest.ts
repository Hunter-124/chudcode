/** React binding for any structural {@link SessionClient}. */
import { useSyncExternalStore } from "react";
import type { SessionClient, SessionSnapshot } from "./session-client";

export function useGuestSnapshot(client: SessionClient): SessionSnapshot {
	return useSyncExternalStore(
		listener => client.subscribe(listener),
		() => client.getSnapshot(),
		() => client.getSnapshot(),
	);
}
