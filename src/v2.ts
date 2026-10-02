import { Plugin } from "@opencode/plugin";
import { parseMaxRetryWaitMs, shouldCapDelay, isUsageLimitMessage, MAX_AUTOMATIC_BOUNCES } from "./shared.js";

const plugin = Plugin.define({
  id: "retry-now",
  setup: async (ctx) => {
    const cap = parseMaxRetryWaitMs(ctx.options);
    const registrations: Array<{ dispose: () => Promise<void> | void }> = [];

    // Hook into session retry events to cap delays.
    if (cap !== null) {
      try {
        const retryReg = await ctx.session.hook("retry", (input) => {
           try {
             // Ignore usage-limit/free-limit retries — let OpenCode handle them.
            const errorMessage = typeof input.error === "object" && input.error !== null && "message" in input.error
              ? (input.error as { message?: unknown }).message
              : undefined;
            if (isUsageLimitMessage(errorMessage)) {
              return;
            }

             // Ignore if we've reached the automatic retry limit.
             if (input.attempt >= MAX_AUTOMATIC_BOUNCES) {
               return;
             }

            // Only cap if the decision is to retry (has a delay).
            if (!input.decision.retry) {
              return;
            }

             // Cap the delay if it exceeds our limit.
             if (shouldCapDelay(input.decision.delay, cap)) {
               input.decision.delay = cap;
             }
          } catch (error) {
            console.error("[retry-now]", error instanceof Error ? error.message : String(error));
          }
        });
        registrations.push(retryReg);
      } catch (error) {
        console.error("[retry-now] failed to register retry hook:", error instanceof Error ? error.message : String(error));
      }
    }

    // Register the /retry-now command.
    try {
      const cmdReg = await ctx.command.transform((editor) => {
        editor.add({
          name: "retry-now",
          description: "Retry the current session immediately",
          execute: async (invocation) => {
            try {
              // In V2, we retry the current session by interrupting and replaying the prompt.
              await ctx.session.interrupt({ sessionID: invocation.sessionID });
               // TODO: R2.5 — replace with actual prompt from session context, not command invocation
               await ctx.session.prompt({
                 sessionID: invocation.sessionID,
                 id: crypto.randomUUID(),
                 text: String(invocation.prompt),
                 delivery: invocation.delivery,
               } as any);
            } catch (error) {
              console.error("[retry-now] command failed:", error instanceof Error ? error.message : String(error));
            }
          },
        });
      });
      registrations.push(cmdReg);
    } catch (error) {
      console.error("[retry-now] failed to register command:", error instanceof Error ? error.message : String(error));
    }

    return async () => {
      for (const reg of registrations) {
        try {
          await Promise.resolve(reg.dispose());
        } catch (error) {
          console.error("[retry-now] cleanup error:", error instanceof Error ? error.message : String(error));
        }
      }
    };
  },
});

export default plugin;
