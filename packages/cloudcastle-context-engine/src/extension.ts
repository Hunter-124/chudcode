import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createCloudCastleIncidentBackend } from "./backend";

/** Chudcode extension entrypoint. Registration ownership is tracked by the host loader. */
export default function cloudCastleContextExtension(chud: ExtensionAPI): void {
	chud.registerMemoryBackend(createCloudCastleIncidentBackend(process.env));
}
