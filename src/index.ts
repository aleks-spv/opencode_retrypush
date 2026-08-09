import type { Plugin } from "@opencode-ai/plugin";

function asPromptParts(parts: any[]): any[] {
  return parts.map(({ id, sessionID, messageID, ...part }) => part);
}

type PromptModel = { providerID: string; modelID: string };

type LastUserPrompt = {
  parts: any[];
  agent?: string;
  model?: PromptModel;
};

async function lastUserPrompt(client: any, sessionID: string): Promise<LastUserPrompt | null> {
  const result = await client.session.messages({
    path: { id: sessionID },
  });
  const messages = result.data ?? [];

  // Messages are oldest-first.
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as any;
    if (message.info?.role !== "user") continue;

    const parts = message.parts as any[];
    if (parts.length === 0) return null;

    const info = message.info as any;
    const prompt: LastUserPrompt = { parts: asPromptParts(parts) };

    if (typeof info.agent === "string") {
      prompt.agent = info.agent;
    }

    if (
      info.model &&
      typeof info.model === "object" &&
      typeof info.model.providerID === "string" &&
      typeof info.model.modelID === "string"
    ) {
      prompt.model = { providerID: info.model.providerID, modelID: info.model.modelID };
    }

    return prompt;
  }

  return null;
}

const plugin: Plugin = async ({ client }) => {
  return {
    "command.execute.before": async (input, output) => {
      if (input.command !== "retry-now") return;

      const [currentPrompt, statusResult] = await Promise.all([
        lastUserPrompt(client, input.sessionID),
        client.session.status(),
      ]);

      const retrySessionIDs = Object.entries(statusResult.data ?? {})
        .filter(([, status]: [string, any]) => status.type === "retry")
        .map(([sessionID]) => sessionID);

      await Promise.allSettled(
        retrySessionIDs
          .filter((sessionID) => sessionID !== input.sessionID)
          .map(async (sessionID) => {
            const prompt = await lastUserPrompt(client, sessionID);
            if (!prompt) return;

            const currentStatus = await client.session.status();
            if (currentStatus.data?.[sessionID]?.type !== "retry") return;

            await client.session.abort({ path: { id: sessionID } });
            await client.session.promptAsync({
              path: { id: sessionID },
              body: {
                ...(prompt.agent !== undefined ? { agent: prompt.agent } : {}),
                ...(prompt.model !== undefined ? { model: prompt.model } : {}),
                parts: prompt.parts,
              },
            });
          }),
      );

      if (!currentPrompt) return;

      const currentStatus = await client.session.status();
      if (currentStatus.data?.[input.sessionID]?.type === "retry") {
        await client.session.abort({ path: { id: input.sessionID } });
      }

      // Reuse the command's text-part ID. All other parts are prompt inputs, so
      // OpenCode assigns fresh IDs when it creates the replacement message.
      const commandTextPart = output.parts.find((part) => part.type === "text");
      const commandParts = currentPrompt.parts.map((part) => ({ ...part }));
      const firstTextIndex = commandParts.findIndex((part) => part.type === "text");
      if (commandTextPart && commandTextPart.type === "text" && firstTextIndex !== -1) {
        commandParts[firstTextIndex] = { ...commandTextPart, ...commandParts[firstTextIndex] };
      }
      output.parts.splice(0, output.parts.length, ...(commandParts as typeof output.parts));
    },
  };
};

export default plugin;
