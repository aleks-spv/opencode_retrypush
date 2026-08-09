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

const DEFAULT_MAX_RETRY_WAIT_MS = 300_000;
const RETRY_MIN_REMAINING_MS = 30_000;
const MAX_AUTOMATIC_BOUNCES = 3;

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

type RetryStatus = {
  type: "retry";
  attempt: number;
  message?: string;
  next: number;
  action?: unknown;
};

type RetryTimer = {
  timer: ReturnType<typeof setTimeout>;
  attempt: number;
  next: number;
};

function maxRetryWaitMs(options: Record<string, unknown> | undefined): number | null {
  const value = options?.maxRetryWaitMs;
  if (value === false) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MAX_RETRY_WAIT_MS;
  return value > 0 ? value : null;
}

function retryStatus(status: unknown): RetryStatus | null {
  if (!status || typeof status !== "object") return null;

  const candidate = status as RetryStatus;
  if (
    candidate.type !== "retry" ||
    typeof candidate.attempt !== "number" ||
    !Number.isFinite(candidate.attempt) ||
    typeof candidate.next !== "number" ||
    !Number.isFinite(candidate.next)
  ) {
    return null;
  }

  return candidate;
}

function isUsageLimitRetry(status: RetryStatus): boolean {
  if (status.action) return true;
  return typeof status.message === "string" && /usage limit|free limit/i.test(status.message);
}

async function replayPrompt(client: any, sessionID: string, prompt: LastUserPrompt) {
  await client.session.promptAsync({
    path: { id: sessionID },
    body: {
      ...(prompt.agent !== undefined ? { agent: prompt.agent } : {}),
      ...(prompt.model !== undefined ? { model: prompt.model } : {}),
      parts: prompt.parts,
    },
  });
}

const plugin: Plugin = async ({ client, directory }, options) => {
  const dirQuery = directory ? { query: { directory } } : {};

  const retryWaitCap = maxRetryWaitMs(options);
  // A fixed 30s margin would make short caps mathematically inert. Scale it so
  // waits only slightly longer than the cap are still worth taking over.
  const retrySubstituteMargin = retryWaitCap === null ? 0 : Math.min(
    RETRY_MIN_REMAINING_MS,
    Math.max(1, retryWaitCap / 2),
  );
  const retryTimers = new Map<string, RetryTimer>();
  const automaticBounces = new Map<string, number>();
  const bouncesInFlight = new Set<string>();

  function clearRetryTimer(sessionID: string) {
    const scheduled = retryTimers.get(sessionID);
    if (!scheduled) return;
    clearTimeout(scheduled.timer);
    retryTimers.delete(sessionID);
  }

  function clearRetryState(sessionID: string, resetBounces = true) {
    clearRetryTimer(sessionID);
    if (resetBounces) {
      automaticBounces.delete(sessionID);
    }
  }

  async function fireRetry(sessionID: string, scheduled: RetryTimer) {
    if (retryTimers.get(sessionID) !== scheduled) return;
    retryTimers.delete(sessionID);

    const bounces = automaticBounces.get(sessionID) ?? 0;
    if (bounces >= MAX_AUTOMATIC_BOUNCES) return;

    bouncesInFlight.add(sessionID);
    try {
      const statusResult = await client.session.status();
      const status = retryStatus(statusResult.data?.[sessionID]);
      if (!status || status.attempt !== scheduled.attempt || status.next !== scheduled.next) return;
      if (status.next - Date.now() < retrySubstituteMargin) return;

      const prompt = await lastUserPrompt(client, sessionID, directory);
      if (!prompt) return;

      // Busy only means the replayed run started. The bounce budget resets on a
      // terminal idle/deleted/error transition; abort's transient idle must not
      // erase it while this operation is in flight.
      automaticBounces.set(sessionID, bounces + 1);
      await client.session.abort({ path: { id: sessionID } });
      await replayPrompt(client, sessionID, prompt);
    } catch {
      clearRetryState(sessionID);
    } finally {
      bouncesInFlight.delete(sessionID);
    }
  }

  function scheduleRetry(sessionID: string, statusValue: unknown) {
    clearRetryTimer(sessionID);

    if (retryWaitCap === null) return;

    const status = retryStatus(statusValue);
    if (!status || isUsageLimitRetry(status)) return;
    if ((automaticBounces.get(sessionID) ?? 0) >= MAX_AUTOMATIC_BOUNCES) return;
    if (status.next - Date.now() <= retryWaitCap + retrySubstituteMargin) return;

    const timer = setTimeout(() => {
      const scheduled = retryTimers.get(sessionID);
      if (scheduled) return fireRetry(sessionID, scheduled);
    }, retryWaitCap);
    timer.unref?.();

    retryTimers.set(sessionID, { timer, attempt: status.attempt, next: status.next });
  }

  // Do not query session status while OpenCode is loading plugins. That call
  // re-enters the same per-instance bootstrap lock that is waiting for this
  // plugin factory, deadlocking startup. OpenCode emits retry events after
  // load, and pending retry fibers are in-process, so no state needs syncing
  // at startup.

  return {
    event: async ({ event }) => {
      if (retryWaitCap === null) return;

      try {
        if (event.type === "session.status") {
          const sessionID = event.properties.sessionID;
          const status = event.properties.status as unknown;
          if (typeof sessionID !== "string") return;

          if ((status as any)?.type === "busy") {
            clearRetryTimer(sessionID);
          } else if ((status as any)?.type === "idle") {
            clearRetryTimer(sessionID);
            if (!bouncesInFlight.has(sessionID)) automaticBounces.delete(sessionID);
          } else {
            scheduleRetry(sessionID, status);
          }
          return;
        }

        if (event.type === "session.idle") {
          const sessionID = event.properties.sessionID;
          if (typeof sessionID !== "string") return;
          clearRetryTimer(sessionID);
          if (!bouncesInFlight.has(sessionID)) automaticBounces.delete(sessionID);
          return;
        }

        if (event.type === "session.deleted") {
          const sessionID = event.properties.info?.id;
          if (typeof sessionID === "string") clearRetryState(sessionID);
          return;
        }

        if (event.type === "session.error") {
          const sessionID = event.properties.sessionID;
          if (typeof sessionID === "string") clearRetryState(sessionID);
        }
      } catch {
        // The event hook is fire-and-forget; never let it reject into OpenCode.
      }
    },

    dispose: async () => {
      for (const { timer } of retryTimers.values()) {
        clearTimeout(timer);
      }
      retryTimers.clear();
      automaticBounces.clear();
      bouncesInFlight.clear();
    },

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
            clearRetryTimer(sessionID);

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
        clearRetryTimer(input.sessionID);
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
