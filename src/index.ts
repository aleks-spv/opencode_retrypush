import type { Plugin } from "@opencode-ai/plugin";

const plugin: Plugin = async ({ client }) => {
  return {
    "command.execute.before": async (input, _output) => {
      if (input.command !== "retry-now") return;

      const result = await client.session.messages({
        path: { id: input.sessionID },
      });

      const messages = result.data ?? [];

      // Find the last user message (list is oldest-first)
      let lastUserText: string | null = null;
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i] as any;
        if (msg.info?.role === "user") {
          const textPart = (msg.parts as any[]).find(
            (p: any) => p.type === "text"
          );
          if (textPart?.text) {
            lastUserText = textPart.text as string;
            break;
          }
        }
      }

      if (!lastUserText) return;

      // Re-send immediately, bypassing the rate-limit countdown
      await client.session.promptAsync({
        path: { id: input.sessionID },
        body: {
          parts: [{ type: "text", text: lastUserText }],
        },
      });
    },
  };
};

export default plugin;
