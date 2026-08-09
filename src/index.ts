import type { Plugin } from "@opencode-ai/plugin";

const DEFAULT_MAX_RETRY_WAIT_MS = 300_000;
const RETRY_MIN_REMAINING_MS = 30_000;
const MAX_AUTOMATIC_BOUNCES = 3;

function asPromptParts(parts: any[]): any[] {
  return parts.map(({ id, sessionID, messageID, ...part }) => part);
}

type PromptModel = { providerID: string; modelID: string };

type LastUserPrompt = {
  parts: any[];
  agent?: string;
  model?: PromptModel;
};

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

const plugin: Plugin = async ({ client }, options) => {
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

      const prompt = await lastUserPrompt(client, sessionID);
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
            clearRetryTimer(sessionID);

            const prompt = await lastUserPrompt(client, sessionID);
            if (!prompt) return;

            const currentStatus = await client.session.status();
            if (currentStatus.data?.[sessionID]?.type !== "retry") return;

            await client.session.abort({ path: { id: sessionID } });
            await replayPrompt(client, sessionID, prompt);
          }),
      );

      if (!currentPrompt) return;

      const currentStatus = await client.session.status();
      if (currentStatus.data?.[input.sessionID]?.type === "retry") {
        clearRetryTimer(input.sessionID);
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
