import { describe, expect, it, vi } from "vitest";
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

type TestSetup = {
  messages: Record<string, unknown[] | Error>;
  statuses?: Record<string, { type: string }>;
  statusResponses?: Record<string, { type: string }>[];
};

async function createHook({ messages, statuses = {}, statusResponses = [] }: TestSetup) {
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
  const hooks = await RetryNowPlugin({ client } as any);
  const hook = hooks["command.execute.before"];

  if (!hook) throw new Error("retry-now hook was not registered");
  return { client, hook };
}

function userMessage(text: string) {
  return { info: { role: "user" }, parts: [{ type: "text", text }] };
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
});
