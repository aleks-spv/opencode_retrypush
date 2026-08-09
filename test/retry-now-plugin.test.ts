import { afterEach, describe, expect, it, vi } from "vitest";
import RetryNowPlugin from "../src/index";

const commandParts = [
  {
    id: "command-part",
    sessionID: "root",
    messageID: "command-message",
    type: "text" as const,
    text: "Retry the last failed request immediately.",
  },
];

type TestStatus = { type: string; [key: string]: unknown };

type TestSetup = {
  messages: Record<string, unknown[] | Error>;
  statuses?: Record<string, TestStatus>;
  statusResponses?: Record<string, TestStatus>[];
  options?: Record<string, unknown>;
};

async function createHook({ messages, statuses = {}, statusResponses = [], options }: TestSetup) {
  const client = {
    session: {
      messages: vi.fn().mockImplementation(({ path: { id } }) => {
        const result = messages[id] ?? [];
        if (result instanceof Error) return Promise.reject(result);
        return Promise.resolve({ data: result });
      }),
      status: vi.fn().mockImplementation(() => Promise.resolve({
        data: statusResponses.shift() ?? statuses,
      })),
      abort: vi.fn().mockResolvedValue({ data: true }),
      promptAsync: vi.fn().mockResolvedValue({}),
    },
  };
  const hooks = await RetryNowPlugin({ client } as any, options);
  const hook = hooks["command.execute.before"];
  const event = hooks.event;
  const dispose = hooks.dispose;

  if (!hook) throw new Error("retry-now hook was not registered");
  if (!event) throw new Error("event hook was not registered");
  if (!dispose) throw new Error("dispose hook was not registered");
  return { client, hook, event, dispose };
}

function userMessage(text: string) {
  return { info: { role: "user" }, parts: [{ type: "text", text }] };
}

function retryStatus(next: number, attempt = 1, extra: Record<string, unknown> = {}): TestStatus {
  return { type: "retry", attempt, message: "rate limited", next, ...extra };
}

afterEach(() => {
  vi.useRealTimers();
});

function sessionStatusEvent(sessionID: string, status: TestStatus) {
  return { event: { type: "session.status", properties: { sessionID, status } } } as any;
}

function sessionIdleEvent(sessionID: string) {
  return { event: { type: "session.idle", properties: { sessionID } } } as any;
}

function sessionDeletedEvent(sessionID: string) {
  return { event: { type: "session.deleted", properties: { info: { id: sessionID } } } } as any;
}

function sessionErrorEvent(sessionID: string) {
  return { event: { type: "session.error", properties: { sessionID } } } as any;
}

describe("retry-now plugin", () => {
  it("retries the current session through the normal command pipeline", async () => {
    const { client, hook } = await createHook({
      messages: { root: [userMessage("retry root")] },
    });
    const output = { parts: structuredClone(commandParts) } as any;

    await hook({ command: "retry-now", sessionID: "root", arguments: "" }, output);

    expect(output.parts).toEqual([{ ...commandParts[0], text: "retry root" }]);
    expect(client.session.abort).not.toHaveBeenCalled();
    expect(client.session.promptAsync).not.toHaveBeenCalled();
  });

  it("preserves every user part when rebuilding the current session prompt", async () => {
    const { hook } = await createHook({
      messages: {
        root: [{
          info: { role: "user" },
          parts: [
            { type: "text", text: "review this" },
            {
              id: "old-file-part",
              sessionID: "root",
              messageID: "old-message",
              type: "file",
              mime: "application/pdf",
              filename: "requirements.pdf",
              url: "file:///tmp/requirements.pdf",
            },
          ],
        }],
      },
    });
    const output = { parts: structuredClone(commandParts) } as any;

    await hook({ command: "retry-now", sessionID: "root", arguments: "" }, output);

    expect(output.parts).toEqual([
      { ...commandParts[0], text: "review this" },
      {
        type: "file",
        mime: "application/pdf",
        filename: "requirements.pdf",
        url: "file:///tmp/requirements.pdf",
      },
    ]);
  });

  it("retries every other rate-limited session, including child sessions", async () => {
    const { client, hook } = await createHook({
      messages: {
        root: [userMessage("retry root")],
        child: [userMessage("retry child")],
        grandchild: [userMessage("retry grandchild")],
      },
      statuses: {
        root: { type: "retry" },
        child: { type: "retry" },
        grandchild: { type: "retry" },
      },
    });
    const output = { parts: structuredClone(commandParts) } as any;

    await hook({ command: "retry-now", sessionID: "root", arguments: "" }, output);

    expect(output.parts).toEqual([{ ...commandParts[0], text: "retry root" }]);
    expect(client.session.abort).toHaveBeenCalledWith({ path: { id: "root" } });
    expect(client.session.abort).toHaveBeenCalledWith({ path: { id: "child" } });
    expect(client.session.abort).toHaveBeenCalledWith({ path: { id: "grandchild" } });
    expect(client.session.promptAsync).toHaveBeenCalledTimes(2);
    expect(client.session.promptAsync).toHaveBeenCalledWith({
      path: { id: "child" },
      body: { parts: [{ type: "text", text: "retry child" }] },
    });
    expect(client.session.promptAsync).toHaveBeenCalledWith({
      path: { id: "grandchild" },
      body: { parts: [{ type: "text", text: "retry grandchild" }] },
    });
  });

  it("does not retry sessions that are not waiting to retry", async () => {
    const { client, hook } = await createHook({
      messages: { root: [userMessage("retry root")], child: [userMessage("old child request")] },
      statuses: { child: { type: "idle" } },
    });
    const output = { parts: structuredClone(commandParts) } as any;

    await hook({ command: "retry-now", sessionID: "root", arguments: "" }, output);

    expect(client.session.abort).not.toHaveBeenCalled();
    expect(client.session.promptAsync).not.toHaveBeenCalled();
  });

  it("continues retrying other sessions when one session fails", async () => {
    const { client, hook } = await createHook({
      messages: {
        root: [userMessage("retry root")],
        broken: new Error("session unavailable"),
        healthy: [userMessage("retry healthy")],
      },
      statuses: { broken: { type: "retry" }, healthy: { type: "retry" } },
    });
    const output = { parts: structuredClone(commandParts) } as any;

    await hook({ command: "retry-now", sessionID: "root", arguments: "" }, output);

    expect(client.session.promptAsync).toHaveBeenCalledWith({
      path: { id: "healthy" },
      body: { parts: [{ type: "text", text: "retry healthy" }] },
    });
  });

  it("does not abort a session that left retry state before it is replayed", async () => {
    const { client, hook } = await createHook({
      messages: {
        root: [userMessage("retry root")],
        child: [userMessage("retry child")],
      },
      statusResponses: [
        { root: { type: "retry" }, child: { type: "retry" } },
        { root: { type: "retry" }, child: { type: "busy" } },
        { root: { type: "retry" }, child: { type: "busy" } },
      ],
    });
    const output = { parts: structuredClone(commandParts) } as any;

    await hook({ command: "retry-now", sessionID: "root", arguments: "" }, output);

    expect(client.session.abort).toHaveBeenCalledTimes(1);
    expect(client.session.abort).toHaveBeenCalledWith({ path: { id: "root" } });
    expect(client.session.promptAsync).not.toHaveBeenCalled();
  });

  it("preserves every user part when replaying a remote session", async () => {
    const filePart = {
      id: "old-file-part",
      sessionID: "child",
      messageID: "old-message",
      type: "file",
      mime: "application/pdf",
      filename: "requirements.pdf",
      url: "file:///tmp/requirements.pdf",
    };
    const { client, hook } = await createHook({
      messages: {
        root: [userMessage("retry root")],
        child: [{ info: { role: "user" }, parts: [userMessage("review this").parts[0], filePart] }],
      },
      statuses: { child: { type: "retry" } },
    });
    const output = { parts: structuredClone(commandParts) } as any;

    await hook({ command: "retry-now", sessionID: "root", arguments: "" }, output);

    expect(client.session.promptAsync).toHaveBeenCalledWith({
      path: { id: "child" },
      body: {
        parts: [
          { type: "text", text: "review this" },
          {
            type: "file",
            mime: "application/pdf",
            filename: "requirements.pdf",
            url: "file:///tmp/requirements.pdf",
          },
        ],
      },
    });
  });

  it("preserves the original subagent agent and model when replaying a remote session", async () => {
    const { client, hook } = await createHook({
      messages: {
        root: [userMessage("retry root")],
        child: [{
          info: {
            role: "user",
            agent: "research",
            model: { providerID: "anthropic", modelID: "claude-opus-4-20250514" },
          },
          parts: [{ type: "text", text: "investigate the bug" }],
        }],
      },
      statuses: { child: { type: "retry" } },
    });
    const output = { parts: structuredClone(commandParts) } as any;

    await hook({ command: "retry-now", sessionID: "root", arguments: "" }, output);

    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
    expect(client.session.promptAsync).toHaveBeenCalledWith({
      path: { id: "child" },
      body: {
        agent: "research",
        model: { providerID: "anthropic", modelID: "claude-opus-4-20250514" },
        parts: [{ type: "text", text: "investigate the bug" }],
      },
    });
  });

  it("preserves agent even when model is absent on the last user message", async () => {
    const { client, hook } = await createHook({
      messages: {
        root: [userMessage("retry root")],
        child: [{
          info: { role: "user", agent: "research" },
          parts: [{ type: "text", text: "investigate the bug" }],
        }],
      },
      statuses: { child: { type: "retry" } },
    });
    const output = { parts: structuredClone(commandParts) } as any;

    await hook({ command: "retry-now", sessionID: "root", arguments: "" }, output);

    expect(client.session.promptAsync).toHaveBeenCalledWith({
      path: { id: "child" },
      body: {
        agent: "research",
        parts: [{ type: "text", text: "investigate the bug" }],
      },
    });
  });

  it("omits agent and model from the replay body when absent on the last user message", async () => {
    const { client, hook } = await createHook({
      messages: {
        root: [userMessage("retry root")],
        child: [{
          info: { role: "user" },
          parts: [{ type: "text", text: "investigate the bug" }],
        }],
      },
      statuses: { child: { type: "retry" } },
    });
    const output = { parts: structuredClone(commandParts) } as any;

    await hook({ command: "retry-now", sessionID: "root", arguments: "" }, output);

    const call = client.session.promptAsync.mock.calls[0]?.[0] as { body: Record<string, unknown> };
    expect(call).toBeDefined();
    expect(call.body).toEqual({ parts: [{ type: "text", text: "investigate the bug" }] });
    expect("agent" in call.body).toBe(false);
    expect("model" in call.body).toBe(false);
  });
});

describe("automatic retry wait cap", () => {
  it("initializes without calling session status during plugin startup", async () => {
    vi.useFakeTimers();
    const neverResolves = new Promise<never>(() => {});
    const client = {
      session: {
        messages: vi.fn(),
        status: vi.fn(() => neverResolves),
        abort: vi.fn(),
        promptAsync: vi.fn(),
      },
    };
    const startup = RetryNowPlugin({ client } as any);

    const outcome = Promise.race([
      startup.then(() => "started"),
      new Promise((resolve) => {
        globalThis.setTimeout(() => resolve("blocked"), 100);
      }),
    ]);
    await Promise.resolve();
    vi.advanceTimersByTime(100);

    expect(await outcome).toBe("started");
    const hooks = await startup;
    expect(hooks["command.execute.before"]).toBeDefined();
    expect(hooks.event).toBeDefined();
    expect(hooks.dispose).toBeDefined();
    expect(client.session.status).not.toHaveBeenCalled();
  });

  it("arms a retry event, fires at five minutes, and preserves agent and model", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-09T12:00:00.000Z");
    const status = retryStatus(Date.now() + 600_000);
    const { client, event } = await createHook({
      messages: {
        child: [{
          info: {
            role: "user",
            agent: "research",
            model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
          },
          parts: [{ type: "text", text: "wait no longer than five minutes" }],
        }],
      },
      statuses: { child: status },
    });

    await event(sessionStatusEvent("child", status));

    await vi.advanceTimersByTimeAsync(299_999);
    expect(client.session.abort).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(client.session.abort).toHaveBeenCalledTimes(1);
    expect(client.session.abort).toHaveBeenCalledWith({ path: { id: "child" } });
    expect(client.session.promptAsync).toHaveBeenCalledWith({
      path: { id: "child" },
      body: {
        agent: "research",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
        parts: [{ type: "text", text: "wait no longer than five minutes" }],
      },
    });
  });

  it.each([300_000, 315_000, 330_000])(
    "does not arm a timer when the remaining wait is %s ms",
    async (remainingMs) => {
      vi.useFakeTimers();
      vi.setSystemTime("2026-08-09T12:00:00.000Z");
      const status = retryStatus(Date.now() + remainingMs);
      const { client, event } = await createHook({
        messages: { child: [userMessage("retry child")] },
        statuses: { child: status },
        options: { maxRetryWaitMs: 300_000 },
      });

      await event(sessionStatusEvent("child", status));
      await vi.advanceTimersByTimeAsync(400_000);

      expect(client.session.abort).not.toHaveBeenCalled();
      expect(client.session.promptAsync).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["action", "show_upgrade", "rate limited"],
    ["usage-limit message", undefined, "Free usage limit reached"],
  ])("does not arm usage-limit retries identified by %s", async (_case, action, message) => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-09T12:00:00.000Z");
    const { client, event } = await createHook({
      messages: { child: [userMessage("retry child")] },
    });

    await event(sessionStatusEvent("child", retryStatus(Date.now() + 600_000, 1, {
      ...(action !== undefined ? { action } : {}),
      message,
    })));
    await vi.advanceTimersByTimeAsync(600_000);

    expect(client.session.abort).not.toHaveBeenCalled();
    expect(client.session.promptAsync).not.toHaveBeenCalled();
  });

  it("replaces a pending timer with the newest retry attempt and timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-09T12:00:00.000Z");
    const currentStatuses: Record<string, TestStatus> = {};
    const { client, event } = await createHook({
      messages: { child: [userMessage("retry child")] },
      statuses: currentStatuses,
    });
    const newest = retryStatus(Date.now() + 600_000, 2, { next: Date.now() + 700_000 });

    await event(sessionStatusEvent("child", retryStatus(Date.now() + 600_000, 1, {
      next: Date.now() + 800_000,
    })));
    currentStatuses.child = newest;
    await event(sessionStatusEvent("child", newest));
    const statusesAfterArming = client.session.status.mock.calls.length;

    await vi.advanceTimersByTimeAsync(300_000);

    expect(client.session.status).toHaveBeenCalledTimes(statusesAfterArming + 1);
    expect(client.session.abort).toHaveBeenCalledTimes(1);
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
    expect(client.session.promptAsync).toHaveBeenCalledWith({
      path: { id: "child" },
      body: { parts: [{ type: "text", text: "retry child" }] },
    });
  });

  it("clears a pending timer when the session becomes busy", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-09T12:00:00.000Z");
    const { client, event } = await createHook({
      messages: { child: [userMessage("retry child")] },
    });

    await event(sessionStatusEvent("child", retryStatus(Date.now() + 600_000)));
    const statusesAfterArming = client.session.status.mock.calls.length;
    await event(sessionStatusEvent("child", { type: "busy" }));
    await vi.advanceTimersByTimeAsync(600_000);

    expect(client.session.status).toHaveBeenCalledTimes(statusesAfterArming);
    expect(client.session.abort).not.toHaveBeenCalled();
    expect(client.session.promptAsync).not.toHaveBeenCalled();
  });

  it("does not act when the attempt or scheduled timestamp drifts before the timer fires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-09T12:00:00.000Z");
    const currentStatuses: Record<string, TestStatus> = {};
    const { client, event } = await createHook({
      messages: { child: [userMessage("retry child")] },
      statuses: currentStatuses,
    });

    await event(sessionStatusEvent("child", retryStatus(Date.now() + 600_000, 1)));
    currentStatuses.child = retryStatus(Date.now() + 700_000, 2);
    await vi.advanceTimersByTimeAsync(300_000);

    expect(client.session.abort).not.toHaveBeenCalled();
    expect(client.session.promptAsync).not.toHaveBeenCalled();
  });

  it("lets the native retry fire when less than thirty seconds remain", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-09T12:00:00.000Z");
    const currentStatuses: Record<string, TestStatus> = {};
    const { client, event } = await createHook({
      messages: { child: [userMessage("retry child")] },
      statuses: currentStatuses,
    });
    const armed = retryStatus(Date.now() + 320_000);

    await event(sessionStatusEvent("child", armed));
    currentStatuses.child = armed;
    await vi.advanceTimersByTimeAsync(300_000);

    expect(client.session.abort).not.toHaveBeenCalled();
    expect(client.session.promptAsync).not.toHaveBeenCalled();
  });

  it("stops after three consecutive bounces despite busy transitions and resets on terminal idle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-09T12:00:00.000Z");
    const currentStatuses: Record<string, TestStatus> = {};
    const { client, event } = await createHook({
      messages: { child: [userMessage("retry child")] },
      statuses: currentStatuses,
    });
    const bounceAndFailAgain = async (attempt: number) => {
      const status = retryStatus(Date.now() + 600_000, attempt);
      currentStatuses.child = status;
      await event(sessionStatusEvent("child", status));
      await vi.advanceTimersByTimeAsync(300_000);
      await event(sessionStatusEvent("child", { type: "busy" }));
    };

    await bounceAndFailAgain(1);
    await bounceAndFailAgain(2);
    await bounceAndFailAgain(3);
    expect(client.session.abort).toHaveBeenCalledTimes(3);

    // The fourth retry exceeds the automatic bounce budget, so the native
    // long-lived retry is left alone.
    currentStatuses.child = retryStatus(Date.now() + 600_000, 4);
    await event(sessionStatusEvent("child", currentStatuses.child));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(client.session.abort).toHaveBeenCalledTimes(3);
    expect(client.session.promptAsync).toHaveBeenCalledTimes(3);

    // A terminal successful idle resets the budget; a mere busy transition does
    // not, because every replayed attempt becomes busy before it may fail.
    await event(sessionIdleEvent("child"));
    currentStatuses.child = retryStatus(Date.now() + 600_000, 5);
    await event(sessionStatusEvent("child", currentStatuses.child));
    await vi.advanceTimersByTimeAsync(300_000);
    expect(client.session.abort).toHaveBeenCalledTimes(4);
    expect(client.session.promptAsync).toHaveBeenCalledTimes(4);
  });

  it("clears the pending timer on transient idle without resetting an in-flight bounce", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-09T12:00:00.000Z");
    const currentStatuses: Record<string, TestStatus> = {};
    const { client, event } = await createHook({
      messages: { child: [userMessage("retry child")] },
      statuses: currentStatuses,
    });
    const status = retryStatus(Date.now() + 600_000);

    currentStatuses.child = status;
    await event(sessionStatusEvent("child", status));
    await event(sessionIdleEvent("child"));
    await vi.advanceTimersByTimeAsync(600_000);

    expect(client.session.abort).not.toHaveBeenCalled();
    expect(client.session.promptAsync).not.toHaveBeenCalled();
  });

  it("fires at the first threshold that can still act before the native retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-09T12:00:00.000Z");
    const status = retryStatus(Date.now() + 330_001);
    const { client, event } = await createHook({
      messages: { child: [userMessage("retry child")] },
      statuses: { child: status },
    });

    await event(sessionStatusEvent("child", status));
    await vi.advanceTimersByTimeAsync(300_000);

    expect(client.session.abort).toHaveBeenCalledTimes(1);
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
  });

  it("honors a custom positive retry wait cap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-09T12:00:00.000Z");
    const status = retryStatus(Date.now() + 500_000);
    const { client, event } = await createHook({
      messages: { child: [userMessage("retry child")] },
      statuses: { child: status },
      options: { maxRetryWaitMs: 60_000 },
    });

    await event(sessionStatusEvent("child", status));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(client.session.abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(client.session.abort).toHaveBeenCalledTimes(1);
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
  });

  it("caps a 16-second native retry at a configured 10-second cap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-09T12:00:00.000Z");
    const status = retryStatus(Date.now() + 16_000);
    const { client, event } = await createHook({
      messages: { child: [userMessage("retry child")] },
      statuses: { child: status },
      options: { maxRetryWaitMs: 10_000 },
    });

    await event(sessionStatusEvent("child", status));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(client.session.abort).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(client.session.abort).toHaveBeenCalledTimes(1);
    expect(client.session.promptAsync).toHaveBeenCalledWith({
      path: { id: "child" },
      body: { parts: [{ type: "text", text: "retry child" }] },
    });
  });

  it.each([
    [15_000, 0],
    [15_001, 1],
  ])("applies the 10-second cap's 5-second arm margin at %s ms", async (remainingMs, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-09T12:00:00.000Z");
    const status = retryStatus(Date.now() + remainingMs);
    const { client, event } = await createHook({
      messages: { child: [userMessage("retry child")] },
      statuses: { child: status },
      options: { maxRetryWaitMs: 10_000 },
    });

    await event(sessionStatusEvent("child", status));
    await vi.advanceTimersByTimeAsync(20_000);

    expect(client.session.abort).toHaveBeenCalledTimes(expected);
    expect(client.session.promptAsync).toHaveBeenCalledTimes(expected);
  });

  it("preserves a bounce while abort's transient idle is delivered during replay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-09T12:00:00.000Z");
    const currentStatuses: Record<string, TestStatus> = {};
    const { client, event } = await createHook({
      messages: { child: [userMessage("retry child")] },
      statuses: currentStatuses,
    });
    let resolveReplay!: (value: unknown) => void;
    client.session.promptAsync.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveReplay = resolve;
      }),
    );

    currentStatuses.child = retryStatus(Date.now() + 600_000, 1);
    await event(sessionStatusEvent("child", currentStatuses.child));
    vi.advanceTimersByTime(300_000);
    for (let i = 0; i < 20 && client.session.promptAsync.mock.calls.length === 0; i++) {
      await Promise.resolve();
    }
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);

    // Abort publishes idle before the replacement run publishes busy. This
    // lifecycle transition must not erase the committed bounce.
    await event(sessionIdleEvent("child"));
    resolveReplay({});
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(client.session.abort).toHaveBeenCalledTimes(1);

    const bounceAgain = async (attempt: number) => {
      await event(sessionStatusEvent("child", { type: "busy" }));
      const status = retryStatus(Date.now() + 600_000, attempt);
      currentStatuses.child = status;
      await event(sessionStatusEvent("child", status));
      await vi.advanceTimersByTimeAsync(300_000);
    };
    await bounceAgain(2);
    await bounceAgain(3);
    expect(client.session.abort).toHaveBeenCalledTimes(3);

    // Because the first bounce survived its transient idle, this fourth retry
    // exceeds the budget and returns control to OpenCode's native timer.
    currentStatuses.child = retryStatus(Date.now() + 600_000, 4);
    await event(sessionStatusEvent("child", currentStatuses.child));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(client.session.abort).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["deleted", sessionDeletedEvent],
    ["error", sessionErrorEvent],
  ])("clears a pending timer when the session is %s", async (_case, eventFor) => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-09T12:00:00.000Z");
    const retry = retryStatus(Date.now() + 600_000);
    const { client, event } = await createHook({
      messages: { child: [userMessage("retry child")] },
      statuses: { child: retry },
    });
    await event(sessionStatusEvent("child", retry));
    const statusesAfterArming = client.session.status.mock.calls.length;

    await event(eventFor("child"));
    await vi.advanceTimersByTimeAsync(600_000);

    expect(client.session.status).toHaveBeenCalledTimes(statusesAfterArming);
    expect(client.session.abort).not.toHaveBeenCalled();
    expect(client.session.promptAsync).not.toHaveBeenCalled();
  });

  it("dispose clears all pending retry timers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-09T12:00:00.000Z");
    const retry = retryStatus(Date.now() + 600_000);
    const { client, event, dispose } = await createHook({
      messages: { child: [userMessage("retry child")] },
      statuses: { child: retry },
    });

    await event(sessionStatusEvent("child", retry));
    await dispose();
    await vi.advanceTimersByTimeAsync(600_000);

    expect(client.session.abort).not.toHaveBeenCalled();
    expect(client.session.promptAsync).not.toHaveBeenCalled();
  });

  it.each([false, 0])("maxRetryWaitMs %s disables only the automatic cap", async (maxRetryWaitMs) => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-09T12:00:00.000Z");
    const { client, event, hook } = await createHook({
      messages: {
        root: [userMessage("retry root")],
        child: [userMessage("retry child")],
      },
      options: { maxRetryWaitMs },
    });

    await event(sessionStatusEvent("child", retryStatus(Date.now() + 600_000)));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(client.session.abort).not.toHaveBeenCalled();

    const output = { parts: structuredClone(commandParts) } as any;
    await hook(
      { command: "retry-now", sessionID: "root", arguments: "" },
      output,
    );
    expect(output.parts).toEqual([{ ...commandParts[0], text: "retry root" }]);
  });
});
