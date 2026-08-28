// @ts-nocheck — example file; install @chudware/coding-agent before running
import type { ExtensionAPI } from "@chudware/coding-agent";

export default function myPlugin(chud: ExtensionAPI) {
  chud.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("my-plugin loaded from example marketplace!", "info");
  });
}
