// @ts-nocheck — example file; install @chudware/coding-agent before running
import type { ExtensionAPI } from "@chudware/coding-agent";

export default function helloExtension(chud: ExtensionAPI) {
  // Show a greeting whenever a session starts.
  chud.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Hello from hello-extension!", "info");
  });

  // Register a /hello slash command that sends a greeting into the conversation.
  chud.registerCommand("hello", {
    description: "Send a greeting into the conversation",
    handler: async (args, ctx) => {
      const name = args.trim() || "there";
      chud.sendMessage(
        {
          customType: "hello-extension",
          content: `Hello, ${name}!`,
          display: true,
          attribution: "user",
        },
        { triggerTurn: false }
      );
      ctx.ui.notify("Message sent!", "info");
    },
  });
}
