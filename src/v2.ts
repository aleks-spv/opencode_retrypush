/// <reference path="./types/opencode-v2.d.ts" />
import { define, type Plugin } from "@opencode/plugin";
import { parseMaxRetryWaitMs, shouldCapDelay, isUsageLimitMessage, MAX_AUTOMATIC_BOUNCES } from "./shared.js";

const plugin = define({
  id: "retry-now",
  setup: async (ctx) => {
    const cap = parseMaxRetryWaitMs(ctx.options);
    let attempt = -1;
    let bouncesInThisAttempt = 0;

    // Hook into session retry events to cap delays.
    await ctx.session.hook("retry", async (input) => {
      // Track attempt: if it changes, reset bounce counter.
      if (input.attempt !== attempt) {
        attempt = input.attempt;
        bouncesInThisAttempt = 0;
      }

      // Ignore usage-limit/free-limit retries — let OpenCode handle them.
      if (isUsageLimitMessage((input.error as any)?.message)) {
        return;
      }

      // Ignore if we've already bounced 3 times on this attempt.
      if (bouncesInThisAttempt >= MAX_AUTOMATIC_BOUNCES) {
        return;
      }

      // Only cap if the decision is to retry (has a delay).
      if (!input.decision.retry) {
        return;
      }

      // Cap the delay if it exceeds our limit.
      if (shouldCapDelay(input.decision.delay, cap)) {
        input.decision.delay = cap;
        bouncesInThisAttempt++;
      }
    });

    // Register the /retry-now command.
    await ctx.command.transform(async (editor) => {
      editor.add({
        name: "retry-now",
        description: "Retry the current session immediately",
        execute: async (invocation) => {
          // In V2, we can only retry the current session through prompt.
          // Simply replay the prompt to trigger immediate retry.
          await ctx.session.prompt({
            ...invocation.prompt,
            delivery: invocation.delivery,
          });
        },
      });
    });

    // Return cleanup function.
    return async () => {
      // No cleanup needed for this plugin.
    };
  },
});

export default plugin;
