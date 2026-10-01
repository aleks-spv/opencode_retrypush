import { describe, it, expect, vi, afterEach } from "vitest";
import { MAX_AUTOMATIC_BOUNCES, parseMaxRetryWaitMs, shouldCapDelay, isUsageLimitMessage } from "../src/shared";

describe("v2 plugin behavior", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function createMockSetup() {
    const hooks = new Map();
    const commands = new Map();
    let attempt = -1;
    let bouncesInThisAttempt = 0;

    const setup = async (ctx) => {
      const cap = parseMaxRetryWaitMs(ctx.options);
      const registrations = [];

      if (cap !== null) {
        const retryReg = await ctx.session.hook("retry", (input) => {
          try {
            if (input.attempt !== attempt) {
              attempt = input.attempt;
              bouncesInThisAttempt = 0;
            }

            const errorMessage =
              typeof input.error === "object" && input.error !== null && "message" in input.error
                ? input.error.message
                : undefined;
            if (isUsageLimitMessage(errorMessage)) {
              return;
            }

            if (bouncesInThisAttempt >= MAX_AUTOMATIC_BOUNCES) {
              return;
            }

            if (!input.decision.retry) {
              return;
            }

            if (shouldCapDelay(input.decision.delay, cap)) {
              input.decision.delay = cap;
              bouncesInThisAttempt++;
            }
          } catch (error) {
            console.error("[retry-now]", error instanceof Error ? error.message : String(error));
          }
        });
        registrations.push(retryReg);
      }

      const cmdReg = await ctx.command.transform((editor) => {
        editor.add({
          name: "retry-now",
          description: "Retry the current session immediately",
          execute: async (invocation) => {
            try {
              await ctx.session.interrupt({ sessionID: invocation.sessionID });
              await ctx.session.prompt({
                sessionID: invocation.sessionID,
                prompt: invocation.prompt,
                delivery: invocation.delivery,
              });
            } catch (error) {
              console.error("[retry-now] command failed:", error instanceof Error ? error.message : String(error));
            }
          },
        });
      });
      registrations.push(cmdReg);

      return async () => {
        for (const reg of registrations) {
          try {
            await Promise.resolve(reg.dispose());
          } catch (error) {
            console.error("[retry-now] cleanup error:", error instanceof Error ? error.message : String(error));
          }
        }
      };
    };

    const ctx = {
      options: {},
      session: {
        hook: vi.fn(async (name, cb) => {
          hooks.set(name, cb);
          return { dispose: vi.fn() };
        }),
        interrupt: vi.fn(async () => undefined),
        prompt: vi.fn(async () => undefined),
      },
      command: {
        transform: vi.fn(async (cb) => {
          const editor = {
            add: (cmd) => {
              commands.set(cmd.name, cmd);
            },
          };
          cb(editor);
          return { dispose: vi.fn() };
        }),
      },
    };

    return { setup, ctx, hooks, commands };
  }

  it("does not call session API during setup", async () => {
    const { setup, ctx } = createMockSetup();
    await setup(ctx);
    expect(ctx.session.interrupt).not.toHaveBeenCalled();
    expect(ctx.session.prompt).not.toHaveBeenCalled();
  });

  it("registers retry hook with cap !== null", async () => {
    const { setup, ctx } = createMockSetup();
    ctx.options = { maxRetryWaitMs: 300000 };
    await setup(ctx);
    expect(ctx.session.hook).toHaveBeenCalledWith("retry", expect.any(Function));
  });

  it("does not register retry hook when cap === null", async () => {
    const { setup, ctx } = createMockSetup();
    ctx.options = { maxRetryWaitMs: false };
    await setup(ctx);
    expect(ctx.session.hook).not.toHaveBeenCalled();
  });

  it("caps delay > cap", async () => {
    const { setup, ctx, hooks } = createMockSetup();
    ctx.options = { maxRetryWaitMs: 300000 };
    await setup(ctx);
    const retryCallback = hooks.get("retry");
    const input = { attempt: 1, decision: { retry: true, delay: 600000 }, error: { message: "rate limited" } };
    retryCallback(input);
    expect(input.decision.delay).toBe(300000);
  });

  it("does not cap delay === cap", async () => {
    const { setup, ctx, hooks } = createMockSetup();
    ctx.options = { maxRetryWaitMs: 300000 };
    await setup(ctx);
    const retryCallback = hooks.get("retry");
    const input = { attempt: 1, decision: { retry: true, delay: 300000 }, error: { message: "rate limited" } };
    retryCallback(input);
    expect(input.decision.delay).toBe(300000);
  });

  it("does not cap delay < cap", async () => {
    const { setup, ctx, hooks } = createMockSetup();
    ctx.options = { maxRetryWaitMs: 300000 };
    await setup(ctx);
    const retryCallback = hooks.get("retry");
    const input = { attempt: 1, decision: { retry: true, delay: 60000 }, error: { message: "rate limited" } };
    retryCallback(input);
    expect(input.decision.delay).toBe(60000);
  });

  it("does not mutate decision when retry === false", async () => {
    const { setup, ctx, hooks } = createMockSetup();
    ctx.options = { maxRetryWaitMs: 300000 };
    await setup(ctx);
    const retryCallback = hooks.get("retry");
    const input = { attempt: 1, decision: { retry: false }, error: { message: "rate limited" } };
    retryCallback(input);
    expect("delay" in input.decision).toBe(false);
  });

  it("respects MAX_AUTOMATIC_BOUNCES budget", async () => {
    const { setup, ctx, hooks } = createMockSetup();
    ctx.options = { maxRetryWaitMs: 300000 };
    await setup(ctx);
    const retryCallback = hooks.get("retry");
    const input = { attempt: 1, decision: { retry: true, delay: 0 }, error: { message: "rate limited" } };
    for (let i = 0; i < MAX_AUTOMATIC_BOUNCES; i++) {
      input.decision.delay = 600000;
      retryCallback(input);
      expect(input.decision.delay).toBe(300000);
    }
    input.decision.delay = 600000;
    retryCallback(input);
    expect(input.decision.delay).toBe(600000);
  });

  it("ignores usage-limit errors", async () => {
    const { setup, ctx, hooks } = createMockSetup();
    ctx.options = { maxRetryWaitMs: 300000 };
    await setup(ctx);
    const retryCallback = hooks.get("retry");
    const input = { attempt: 1, decision: { retry: true, delay: 600000 }, error: { message: "usage limit reached" } };
    retryCallback(input);
    expect(input.decision.delay).toBe(600000);
  });

  it("ignores free-limit errors", async () => {
    const { setup, ctx, hooks } = createMockSetup();
    ctx.options = { maxRetryWaitMs: 300000 };
    await setup(ctx);
    const retryCallback = hooks.get("retry");
    const input = { attempt: 1, decision: { retry: true, delay: 600000 }, error: { message: "free limit exceeded" } };
    retryCallback(input);
    expect(input.decision.delay).toBe(600000);
  });

  it("registers retry-now command always", async () => {
    const { setup, ctx, commands } = createMockSetup();
    ctx.options = { maxRetryWaitMs: false };
    await setup(ctx);
    expect(ctx.command.transform).toHaveBeenCalled();
    expect(commands.has("retry-now")).toBe(true);
  });

  it("command calls session.interrupt then session.prompt", async () => {
    const { setup, ctx, commands } = createMockSetup();
    ctx.options = {};
    const cleanup = await setup(ctx);
    const cmd = commands.get("retry-now");
    const invocation = { sessionID: "session-123", prompt: { parts: [] }, delivery: "immediate" };
    await cmd.execute(invocation);
    expect(ctx.session.interrupt).toHaveBeenCalledWith({ sessionID: "session-123" });
    expect(ctx.session.prompt).toHaveBeenCalled();
    const promptCall = ctx.session.prompt.mock.calls[0][0];
    expect(promptCall.sessionID).toBe("session-123");
    await cleanup();
  });

  it("handles command execute errors gracefully", async () => {
    const { setup, ctx, commands } = createMockSetup();
    ctx.options = {};
    ctx.session.interrupt = vi.fn(async () => {
      throw new Error("interrupt failed");
    });
    const cleanup = await setup(ctx);
    const cmd = commands.get("retry-now");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(cmd.execute({ sessionID: "s1", prompt: {}, delivery: "immediate" })).resolves.toBeUndefined();
    errorSpy.mockRestore();
    await cleanup();
  });

  it("resets bounce counter on attempt change", async () => {
    const { setup, ctx, hooks } = createMockSetup();
    ctx.options = { maxRetryWaitMs: 300000 };
    await setup(ctx);
    const retryCallback = hooks.get("retry");
    const input = { attempt: 1, decision: { retry: true, delay: 600000 }, error: { message: "rate limited" } };
    for (let i = 0; i < MAX_AUTOMATIC_BOUNCES; i++) {
      retryCallback(input);
    }
    expect(input.decision.delay).toBe(300000);
    input.decision.delay = 600000;
    input.attempt = 2;
    retryCallback(input);
    expect(input.decision.delay).toBe(300000);
  });

  it("applies custom cap from options", async () => {
    const { setup, ctx, hooks } = createMockSetup();
    ctx.options = { maxRetryWaitMs: 10000 };
    await setup(ctx);
    const retryCallback = hooks.get("retry");
    const input = { attempt: 1, decision: { retry: true, delay: 60000 }, error: { message: "rate limited" } };
    retryCallback(input);
    expect(input.decision.delay).toBe(10000);
  });
});
