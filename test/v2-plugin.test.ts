import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { MAX_AUTOMATIC_BOUNCES, parseMaxRetryWaitMs, shouldCapDelay, isUsageLimitMessage } from "../src/shared";
import plugin from "../src/v2";

describe("v2 plugin behavior", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  async function createV2Context(options?: Record<string, unknown>) {
    const hooks = new Map();
    const commands = new Map();
    const interrupts = new Map();
    const prompts = new Map();

    const ctx = {
      options: options || {},
      session: {
        hook: vi.fn(async (name, callback) => {
          hooks.set(name, callback);
          return { dispose: () => Promise.resolve() };
        }),
        interrupt: vi.fn(async (input) => {
          interrupts.set(input.sessionID, input);
        }),
        context: vi.fn(async () => []),
        prompt: vi.fn(async (input) => {
          prompts.set(input.sessionID, input);
        }),
      },
      command: {
        transform: vi.fn(async (callback) => {
          const editor = {
            add: vi.fn((def) => {
              commands.set(def.name, def);
            }),
          };
          callback(editor);
          return { dispose: () => Promise.resolve() };
        }),
      },
    };

    const cleanup = await plugin.setup(ctx);
    return { ctx, hooks, commands, cleanup, interrupts, prompts };
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
});
