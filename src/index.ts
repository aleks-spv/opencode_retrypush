import type { Plugin } from "@opencode-ai/plugin";

const plugin: Plugin = async ({ client }) => {
  return {
    "command.execute.before": async (input, output) => {
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

      // Replace the command template with the prior request. Reusing its part
      // preserves the IDs OpenCode assigned for this command execution.
      const commandTextPart = output.parts.find((part) => part.type === "text");
      if (!commandTextPart || commandTextPart.type !== "text") return;

      commandTextPart.text = lastUserText;
      output.parts.splice(0, output.parts.length, commandTextPart);
    },
  };
};

export default plugin;
