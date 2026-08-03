import { describe, expect, it, vi } from "vitest";
import RetryNowPlugin from "../src/index";

const commandParts = [
  {
    id: "command-part",
    sessionID: "session-1",
    messageID: "command-message",
    type: "text" as const,
    text: "Retry the last failed request immediately.",
  },
];

async function createHook(messages: unknown[]) {
  const client = {
    session: {
      messages: vi.fn().mockResolvedValue({ data: messages }),
      promptAsync: vi.fn(),
    },
  };
  const hooks = await RetryNowPlugin({ client } as any);
  const hook = hooks["command.execute.before"];

  if (!hook) throw new Error("retry-now hook was not registered");
  return { client, hook };
}

describe("retry-now plugin", () => {
  it("replaces the command template with the latest user text", async () => {
    const { client, hook } = await createHook([
      { info: { role: "user" }, parts: [{ type: "text", text: "first request" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "response" }] },
      { info: { role: "user" }, parts: [{ type: "text", text: "retry this request" }] },
    ]);
    const output = { parts: structuredClone(commandParts) } as any;

    await hook({ command: "retry-now", sessionID: "session-1", arguments: "" }, output);

    expect(client.session.messages).toHaveBeenCalledWith({ path: { id: "session-1" } });
    expect(output.parts).toEqual([
      { ...commandParts[0], text: "retry this request" },
    ]);
    expect(client.session.promptAsync).not.toHaveBeenCalled();
  });

  it("does nothing for commands other than retry-now", async () => {
    const { client, hook } = await createHook([]);
    const output = { parts: structuredClone(commandParts) } as any;

    await hook({ command: "other-command", sessionID: "session-1", arguments: "" }, output);

    expect(client.session.messages).not.toHaveBeenCalled();
    expect(output.parts).toEqual(commandParts);
  });

  it("leaves the command template unchanged when no user text exists", async () => {
    const { hook } = await createHook([
      { info: { role: "assistant" }, parts: [{ type: "text", text: "response" }] },
    ]);
    const output = { parts: structuredClone(commandParts) } as any;

    await hook({ command: "retry-now", sessionID: "session-1", arguments: "" }, output);

    expect(output.parts).toEqual(commandParts);
  });
});
