import type { Plugin } from "@opencode-ai/plugin";
import type {
  Part,
  TextPartInput,
  FilePartInput,
  AgentPartInput,
  SubtaskPartInput,
  SessionStatus,
  RetryPart,
} from "@opencode-ai/sdk";

/** Types accepted by session.promptAsync / session.prompt. */
type PromptPart = TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput;

const ALLOWED_PART_TYPES = new Set<string>(["text", "file", "agent", "subtask"]);

/** Strip server-only fields and keep only prompt-compatible parts. */
function toPromptParts(parts: Part[]): PromptPart[] {
  return parts
    .filter((p) => ALLOWED_PART_TYPES.has(p.type))
    .map(({ id: _id, sessionID: _sid, messageID: _mid, ...rest }) => rest as PromptPart);
}

type LastUserPrompt = {
  parts: PromptPart[];
  agent?: string;
  model?: { providerID: string; modelID: string };
};

/**
 * Find the user message that triggered the current retry.
 *
 * Strategy: locate the latest `RetryPart` in the session history, then walk
 * backwards to find the user message that immediately precedes it.  This is
 * more reliable than blindly grabbing the last user message, which may be a
 * queued follow-up or a different command entirely.
 */
async function lastUserPrompt(
  client: { session: { messages: (args: { path: { id: string }; query?: { directory?: string } }) => Promise<{ data?: unknown[] }> } },
  sessionID: string,
  directory?: string,
): Promise<LastUserPrompt | null> {
  const result = await client.session.messages({
    path: { id: sessionID },
    ...(directory ? { query: { directory } } : {}),
  });
  const messages = (result.data ?? []) as Array<{
    info?: { role?: string };
    parts: Part[];
  }>;

  // Walk backwards to find the latest RetryPart.
  let retryMessageIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i].parts ?? [];
    if (parts.some((p): p is RetryPart => p.type === "retry")) {
      retryMessageIndex = i;
      break;
    }
  }

  if (retryMessageIndex === -1) {
    // Fallback: no RetryPart found, use last user message.
    return lastUserPromptParts(client, sessionID, directory);
  }

  // Walk backwards from the retry message to find the user message.
  for (let i = retryMessageIndex - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.info?.role !== "user") continue;
    const parts = message.parts as any[];
    if (parts.length === 0) return null;

    const info = message.info as any;
    const prompt: LastUserPrompt = { parts: toPromptParts(parts) };

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

/** Fallback: grab the last user message (oldest-first ordering). */
async function lastUserPromptParts(
  client: { session: { messages: (args: { path: { id: string }; query?: { directory?: string } }) => Promise<{ data?: unknown[] }> } },
  sessionID: string,
  directory?: string,
): Promise<LastUserPrompt | null> {
  const result = await client.session.messages({
    path: { id: sessionID },
    ...(directory ? { query: { directory } } : {}),
  });
  const messages = (result.data ?? []) as Array<{
    info?: { role?: string };
    parts: Part[];
  }>;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.info?.role !== "user") continue;
    const parts = message.parts as any[];
    if (parts.length === 0) return null;

    const info = message.info as any;
    const prompt: LastUserPrompt = { parts: toPromptParts(parts) };

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

/** Log and surface errors from Promise.allSettled results. */
function logRejected(results: PromiseSettledResult<unknown>[], context: string): void {
  for (const r of results) {
    if (r.status === "rejected") {
      console.error(`[retry-now] ${context}:`, r.reason);
    }
  }
}

const plugin: Plugin = async ({ client, directory }) => {
  const dirQuery = directory ? { query: { directory } } : {};

  return {
    "command.execute.before": async (input, output) => {
      if (input.command !== "retry-now") return;

      // Get current session's user parts + all session statuses in parallel.
      const [currentPrompt, statusResult] = await Promise.all([
        lastUserPrompt(client, input.sessionID, directory),
        client.session.status(dirQuery),
      ]);

      const statuses = (statusResult.data ?? {}) as Record<string, SessionStatus>;
      const retrySessionIDs = Object.entries(statuses)
        .filter(([, s]) => s.type === "retry")
        .map(([id]) => id);

      // Retry every *other* rate-limited session.
      const otherResults = await Promise.allSettled(
        retrySessionIDs
          .filter((id) => id !== input.sessionID)
          .map(async (sessionID) => {
            const prompt = await lastUserPrompt(client, sessionID, directory);
            if (!prompt) return;

            // Re-check: only abort+replay if still in retry state.
            const currentStatus = await client.session.status(dirQuery);
            const sessionStatus = (currentStatus.data as Record<string, SessionStatus> | undefined)?.[sessionID];
            if (sessionStatus?.type !== "retry") return;

            await client.session.abort({ path: { id: sessionID }, ...dirQuery });
            await client.session.promptAsync({
              path: { id: sessionID },
              body: {
                ...(prompt.agent !== undefined ? { agent: prompt.agent } : {}),
                ...(prompt.model !== undefined ? { model: prompt.model } : {}),
                parts: prompt.parts,
              },
              ...dirQuery,
            });
          }),
      );
      logRejected(otherResults, "remote session retry");

      // Handle current session.
      if (!currentPrompt) return;

      const currentStatus = await client.session.status(dirQuery);
      const myStatus = (currentStatus.data as Record<string, SessionStatus> | undefined)?.[input.sessionID];
      if (myStatus?.type === "retry") {
        await client.session.abort({ path: { id: input.sessionID }, ...dirQuery });
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
