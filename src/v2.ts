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
              await ctx.session.interrupt({ sessionID: invocation.sessionID });
              const messages = await ctx.session.context({ sessionID: invocation.sessionID });
              const lastUser = [...messages].reverse().find((message) => message.type === "user");
              if (!lastUser) return;

              const files: Array<{ uri: string; name?: string; description?: string; mention?: { start: number; end: number; text: string } }> = [];
              for (const f of lastUser.files ?? []) {
                if (f.source.type === "uri") {
                  files.push({ uri: f.source.uri, name: f.name, description: f.description, mention: f.mention });
                }
              }

              await ctx.session.prompt({
                sessionID: invocation.sessionID,
                text: lastUser.text,
                delivery: invocation.delivery,
                ...(lastUser.agents?.length ? { agents: lastUser.agents.map((a) => ({ name: a.name, mention: a.mention })) } : {}),
                ...(lastUser.skills?.length ? { skills: lastUser.skills.map((s) => ({ id: s.id, mention: s.mention })) } : {}),
                ...(files.length ? { files } : {}),
              });
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
