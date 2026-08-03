import type { Plugin } from "@opencode-ai/plugin";

function asPromptParts(parts: any[]): any[] {
  return parts.map(({ id, sessionID, messageID, ...part }) => part);
}

async function lastUserParts(client: any, sessionID: string): Promise<any[] | null> {
  const result = await client.session.messages({
    path: { id: sessionID },
  });
  const messages = result.data ?? [];

  // Messages are oldest-first.
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as any;
    if (message.info?.role !== "user") continue;

    const parts = message.parts as any[];
    return parts.length > 0 ? asPromptParts(parts) : null;
  }

  return null;
}

const plugin: Plugin = async ({ client }) => {
  return {
    "command.execute.before": async (input, output) => {
      if (input.command !== "retry-now") return;

      const [currentParts, statusResult] = await Promise.all([
        lastUserParts(client, input.sessionID),
        client.session.status(),
      ]);

      const retrySessionIDs = Object.entries(statusResult.data ?? {})
        .filter(([, status]: [string, any]) => status.type === "retry")
        .map(([sessionID]) => sessionID);

      await Promise.allSettled(
        retrySessionIDs
          .filter((sessionID) => sessionID !== input.sessionID)
          .map(async (sessionID) => {
            const parts = await lastUserParts(client, sessionID);
            if (!parts) return;

            const currentStatus = await client.session.status();
            if (currentStatus.data?.[sessionID]?.type !== "retry") return;

            await client.session.abort({ path: { id: sessionID } });
            await client.session.promptAsync({
              path: { id: sessionID },
              body: { parts },
            });
          }),
      );

      if (!currentParts) return;

      const currentStatus = await client.session.status();
      if (currentStatus.data?.[input.sessionID]?.type === "retry") {
        await client.session.abort({ path: { id: input.sessionID } });
      }

      // Reuse the command's text-part ID. All other parts are prompt inputs, so
      // OpenCode assigns fresh IDs when it creates the replacement message.
      const commandTextPart = output.parts.find((part) => part.type === "text");
      const commandParts = currentParts.map((part) => ({ ...part }));
      const firstTextIndex = commandParts.findIndex((part) => part.type === "text");
      if (commandTextPart && commandTextPart.type === "text" && firstTextIndex !== -1) {
        commandParts[firstTextIndex] = { ...commandTextPart, ...commandParts[firstTextIndex] };
      }
      output.parts.splice(0, output.parts.length, ...(commandParts as typeof output.parts));
    },
  };
};

export default plugin;
