import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import plugin from "../src/v2";
describe("v2 plugin behavior", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  async function createV2Context(
    options?: Record<string, unknown>,
    messages?: unknown[],
  ) {
    const hooks = new Map();
    const commands = new Map();
    const interrupts = new Map();
    const prompts = new Map<string, Record<string, unknown>>();
    const callOrder: string[] = [];
    const disposeMocks: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];

    const hookMock = vi.fn(async (name, callback) => {
      hooks.set(name, callback);
      const disp = vi.fn();
      disposeMocks.push({ dispose: disp });
      return { dispose: disp };
    });

    const transformMock = vi.fn(async (callback) => {
      const editor = {
        add: vi.fn((def) => {
          commands.set(def.name, def);
        }),
      };
      callback(editor);
      const disp = vi.fn();
      disposeMocks.push({ dispose: disp });
      return { dispose: disp };
    });

    const ctx = {
      options: options ?? {},
      session: {
        hook: hookMock,
        interrupt: vi.fn(async (input) => {
          interrupts.set(input.sessionID, input);
          callOrder.push("interrupt");
        }),
        context: vi.fn(async () => messages ?? []),
        prompt: vi.fn(async (input) => {
          prompts.set(input.sessionID, input);
          callOrder.push("prompt");
        }),
      },
      command: {
        transform: transformMock,
      },
    };

    const cleanup = await plugin.setup(ctx as any);
    return { ctx, hooks, commands, cleanup, interrupts, prompts, callOrder, disposeMocks };
  }

  it("does not call session API during setup when cap is null", async () => {
    const { ctx } = await createV2Context({ maxRetryWaitMs: false });
    expect(ctx.session.hook).not.toHaveBeenCalled();
  });

  it("registers retry hook with cap !== null", async () => {
    const { ctx, hooks } = await createV2Context({ maxRetryWaitMs: 60000 });
    expect(hooks.has("retry")).toBe(true);
  });

  it("does not register retry hook when cap is null", async () => {
    const { ctx, hooks } = await createV2Context({ maxRetryWaitMs: false });
    expect(hooks.has("retry")).toBe(false);
  });

  it("registers retry-now command always", async () => {
    const { commands } = await createV2Context({ maxRetryWaitMs: false });
    expect(commands.has("retry-now")).toBe(true);
  });

  it("caps delay exceeding 600k to 300k", async () => {
    const { hooks } = await createV2Context({ maxRetryWaitMs: 300000 });
    const retryHook = hooks.get("retry");

    const decision = { retry: true, delay: 600000 };
    retryHook({ attempt: 0, decision, error: new Error("test"), retry: true });
    expect(decision.delay).toBe(300000);
  });

  it("does not cap delay equal to cap", async () => {
    const { hooks } = await createV2Context({ maxRetryWaitMs: 300000 });
    const retryHook = hooks.get("retry");

    const decision = { retry: true, delay: 300000 };
    retryHook({ attempt: 0, decision, error: new Error("test"), retry: true });
    expect(decision.delay).toBe(300000);
  });

  it("does not cap delay less than cap", async () => {
    const { hooks } = await createV2Context({ maxRetryWaitMs: 300000 });
    const retryHook = hooks.get("retry");

    const decision = { retry: true, delay: 100000 };
    retryHook({ attempt: 0, decision, error: new Error("test"), retry: true });
    expect(decision.delay).toBe(100000);
  });

  it("does not mutate decision if retry: false", async () => {
    const { hooks } = await createV2Context({ maxRetryWaitMs: 300000 });
    const retryHook = hooks.get("retry");

    const decision = { retry: false } as any;
    retryHook({ attempt: 0, decision, error: new Error("test"), retry: false });
    expect(decision.delay).toBeUndefined();
  });

  it("respects MAX_AUTOMATIC_BOUNCES budget", async () => {
    const { hooks } = await createV2Context({ maxRetryWaitMs: 300000 });
    const retryHook = hooks.get("retry");

    const decision1 = { retry: true, delay: 600000 };
    const decision2 = { retry: true, delay: 600000 };
    const decision3 = { retry: true, delay: 600000 };
    const decision4 = { retry: true, delay: 600000 };

    retryHook({ attempt: 0, decision: decision1, error: new Error("test"), retry: true });
    retryHook({ attempt: 1, decision: decision2, error: new Error("test"), retry: true });
    retryHook({ attempt: 2, decision: decision3, error: new Error("test"), retry: true });
    retryHook({ attempt: 3, decision: decision4, error: new Error("test"), retry: true });

    expect(decision1.delay).toBe(300000);
    expect(decision2.delay).toBe(300000);
    expect(decision3.delay).toBe(300000);
    expect(decision4.delay).toBe(600000);
  });

  it("ignores usage-limit messages", async () => {
    const { hooks } = await createV2Context({ maxRetryWaitMs: 300000 });
    const retryHook = hooks.get("retry");

    const decision = { retry: true, delay: 600000 };
    retryHook({
      attempt: 0,
      decision,
      error: { message: "usage limit exceeded, please try again tomorrow" },
      retry: true,
    });
    expect(decision.delay).toBe(600000);
  });

  it("resets bounce counter on attempt change (P0-2 regression)", async () => {
    const { hooks } = await createV2Context({ maxRetryWaitMs: 300000 });
    const retryHook = hooks.get("retry");

    const results = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const decision = { retry: true, delay: 600000 };
      retryHook({ attempt, decision, error: new Error("test"), retry: true });
      results.push({ attempt, capped: decision.delay === 300000 });
    }

    expect(results[0].capped).toBe(true);
    expect(results[1].capped).toBe(true);
    expect(results[2].capped).toBe(true);
    expect(results[3].capped).toBe(false);
    expect(results[4].capped).toBe(false);
  });

  describe("retry-now command execute", () => {
    it("replays text of the last user message", async () => {
      const { ctx, commands } = await createV2Context(undefined, [
        { type: "assistant", id: "a1", text: "half" },
        { type: "user", id: "u1", text: "first", time: { created: 1 } },
        { type: "assistant", id: "a2", text: "rate limited" },
        { type: "user", id: "u2", text: "last", time: { created: 2 } },
      ]);
      await commands.get("retry-now")!.execute({ sessionID: "s1", prompt: { text: "" }, delivery: "steer" });
      expect(ctx.session.prompt).toHaveBeenCalledTimes(1);
      expect(ctx.session.prompt).toHaveBeenCalledWith(
        expect.objectContaining({ sessionID: "s1", text: "last" }),
      );
    });

    it("interrupts before prompting", async () => {
      const { commands, callOrder } = await createV2Context(undefined, [
        { type: "user", id: "u1", text: "last", time: { created: 1 } },
      ]);
      await commands.get("retry-now")!.execute({ sessionID: "s1", prompt: { text: "" }, delivery: "steer" });
      expect(callOrder).toEqual(["interrupt", "prompt"]);
    });

    it("forwards delivery from invocation", async () => {
      const { ctx, commands } = await createV2Context(undefined, [
        { type: "user", id: "u1", text: "last" },
      ]);
      await commands.get("retry-now")!.execute({ sessionID: "s1", prompt: { text: "" }, delivery: "queue" });
      expect(ctx.session.prompt).toHaveBeenCalledWith(
        expect.objectContaining({ sessionID: "s1", delivery: "queue" }),
      );
    });

    it("does not prompt when there is no user message", async () => {
      const errorSpy = vi.spyOn(console, 'error');
      try {
        const { ctx, commands } = await createV2Context(undefined, [
          { type: "assistant", id: "a1", text: "half" },
          { type: "system", id: "sys1", text: "info" },
        ]);
        await commands.get("retry-now")!.execute({ sessionID: "s1", prompt: { text: "" }, delivery: "steer" });
        expect(ctx.session.prompt).not.toHaveBeenCalled();
        expect(ctx.session.interrupt).toHaveBeenCalledTimes(1);
        expect(errorSpy).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    });

    it("does not send the id field", async () => {
      const { ctx, commands, prompts } = await createV2Context(undefined, [
        { type: "user", id: "u1", text: "last", time: { created: 1 } },
      ]);
      await commands.get("retry-now")!.execute({ sessionID: "s1", prompt: { text: "" }, delivery: "steer" });
      const payload = prompts.get("s1");
      expect(payload).not.toHaveProperty("id");
    });

    it("carries over uri file attachments and drops inline ones", async () => {
      const { ctx, commands, prompts } = await createV2Context(undefined, [
        {
          type: "user", id: "u1", text: "last", time: { created: 1 },
          files: [
            { data: "...", mime: "text/plain", source: { type: "uri" as const, uri: "file:///a.txt" }, name: "a.txt" },
            { data: "...", mime: "image/png", source: { type: "inline" as const } },
          ],
        },
      ]);
      await commands.get("retry-now")!.execute({ sessionID: "s1", prompt: { text: "" }, delivery: "steer" });
      const payload = prompts.get("s1");
      expect(payload).toHaveProperty("files");
      expect(payload).toHaveProperty("files.length", 1);
      expect(payload).toHaveProperty("files.0.uri", "file:///a.txt");
    });

    it("swallows errors from session.context", async () => {
      const { ctx, commands } = await createV2Context(undefined, []);
      ctx.session.context.mockRejectedValue(new Error("context fail"));
      await expect(
        commands.get("retry-now")!.execute({ sessionID: "s1", prompt: { text: "" }, delivery: "steer" }),
      ).resolves.toBeUndefined();
      expect(ctx.session.prompt).not.toHaveBeenCalled();
    });
  });

  describe("cleanup and bootstrap-lock invariant", () => {
    it("disposes every registration exactly once", async () => {
      const { cleanup, disposeMocks } = await createV2Context({ maxRetryWaitMs: 300000 });
      expect(disposeMocks).toHaveLength(2);
      if (typeof cleanup === "function") await cleanup();
      expect(disposeMocks[0].dispose).toHaveBeenCalledTimes(1);
      expect(disposeMocks[1].dispose).toHaveBeenCalledTimes(1);
    });

    it("continues disposing when one dispose throws", async () => {
      const { cleanup, disposeMocks } = await createV2Context({ maxRetryWaitMs: 300000 });
      disposeMocks[0].dispose.mockImplementationOnce(() => { throw new Error("boom"); });
      const run = async () => { if (typeof cleanup === "function") await cleanup(); };
      await expect(run()).resolves.toBeUndefined();
      expect(disposeMocks[0].dispose).toHaveBeenCalledTimes(1);
      expect(disposeMocks[1].dispose).toHaveBeenCalledTimes(1);
    });

    it("does not call any session method during setup when cap is set", async () => {
      const { ctx } = await createV2Context({ maxRetryWaitMs: 300000 });
      expect(ctx.session.hook).toHaveBeenCalled();
      expect(ctx.command.transform).toHaveBeenCalled();
      expect(ctx.session.interrupt).not.toHaveBeenCalled();
      expect(ctx.session.context).not.toHaveBeenCalled();
      expect(ctx.session.prompt).not.toHaveBeenCalled();
    });

    it("disposes only the command registration when cap is null", async () => {
      const { cleanup, disposeMocks } = await createV2Context({ maxRetryWaitMs: false });
      expect(disposeMocks).toHaveLength(1);
      if (typeof cleanup === "function") await cleanup();
      expect(disposeMocks[0].dispose).toHaveBeenCalledTimes(1);
    });
  });
});
