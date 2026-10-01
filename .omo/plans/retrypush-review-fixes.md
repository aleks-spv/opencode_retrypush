---
slug: retrypush-review-fixes
status: approved
---

# Plan: retrypush-review-fixes

## Purpose

Fix every correctness bug found in the code review of `opencode_retrypush` (dual V1/V2
`/retry-now` plugin), and close the conformance gaps between the local restructured
implementation (`src/shared.ts` + `src/retry-cap.ts` + `src/v2.ts` + `src/index.ts`) and
upstream PR #2 (`fix: preserve original agent and model when replaying retrying sessions`,
https://github.com/aleks-spv/opencode_retrypush/pull/2, OPEN, not merged) and PR #3
(`feat: add configurable automatic retry wait cap`,
https://github.com/aleks-spv/opencode_retrypush/pull/3, OPEN, not merged, stacked on #2).

**PR conformance verdict (for the record):** the local code independently reimplements the
intent of PR #2 (Fix #1, agent/model preservation) and PR #3 (Fix #2, auto-cap) with a
different, dual V1/V2 architecture — but it regresses three things both PRs got right:
(a) PR #2/#3 re-fetch a **fresh** `session.status()` immediately before aborting each remote
session; local `src/index.ts:195-197` reuses the **stale** snapshot fetched before the loop,
making the recheck a no-op (see Fact F14). (b) PR #3's bounce budget always releases its
in-flight flag in a `finally` block; local `BounceBudget.commit()` sets `inFlight = true` and
nothing ever clears it back to `false` (Fact F10/F11). (c) PR #3 ships V1 auto-cap end-to-end
(event hook + timers); locally auto-cap exists **only** in V2 — V1 (the default export, the
one AGENTS.md says must work for "the assistant") has no auto-cap at all, and its own code
comment falsely claims V1 has no event API (Fact F19/F20). On top of the PR-conformance gaps,
the V2 adapter (which has no PR precedent — it's new local work) calls `@opencode/plugin`
APIs that do not exist in the installed 2.0.16 types at all (Fact F1-F9): wrong `session.prompt`
body shape, non-existent `agent`/`model` prompt fields, wrong plugin-options entry point, wrong
`event.subscribe` signature. These are P0: the V2 adapter cannot send a single prompt today.

## Non-goals / deferred (do NOT implement in this plan)

- **Do not migrate V2 auto-cap to the official `ctx.session.hook("retry", …)` API.** This hook
  exists in `@opencode/plugin` 2.0.16 (confirmed via `https://opencode.ai/v2/docs/build/plugins`
  and PR `anomalyco/opencode#45999`) and is architecturally cleaner than timer-based abort+replay.
  It is **not** adopted here because: (1) it requires live verification on a running OpenCode 2.x
  instance that this plan cannot perform, (2) whether the callback can `await` a signal/promise
  before setting `event.decision` is undocumented and unverified, (3) switching to it would drop
  the timer/abort/replay mechanism entirely, which is a much larger behavioral change than a bug
  fix. Fix the existing timer-based mechanism in this plan instead. Leave a `// TODO` pointing at
  this doc section for future work.
- Do not touch `toPromptParts` allowed-type set (`src/shared.ts:110-117`), do not add new npm
  runtime dependencies, do not change the `/retry-now` command markdown
  (`commands/retry-now.md`).

## Reference Fact Table

| Source path | Lines | Fact discovered | Relevance to plan |
|---|---|---|---|
| `node_modules/@opencode/client/dist/promise/generated/types.d.ts` | ~5369-5420 | `SessionPromptInput.text` is a plain `string` (TS indexed-access display artifact), NOT `{text, files}`. `files`, `agents`, `skills`, `delivery`, `resume` are sibling top-level fields, not nested inside `text`. | Fixes F1 — V2 `promptAsync` body shape |
| tsc probe (session output, verified live against installed types) | n/a | `ctx.session.prompt({sessionID,text:{text,files}})` → `TS2322` (object not assignable to string). `ctx.session.prompt({sessionID,text,agent:"a"})` → `TS2561` ('agent' unknown, did you mean 'agents'). `ctx.session.prompt({sessionID,text,files:[{uri}],delivery:"steer"})` → compiles clean. | Confirms F1 and that `files` (uri-based) and `delivery` are valid top-level fields |
| `node_modules/@opencode/client/dist/promise/generated/types.d.ts:5294-5313` | 5294-5313 | `SessionSwitchAgentInput = {sessionID; agent: string}`; `SessionSwitchModelInput = {sessionID; model: {id: string; providerID: string; variant?: string}}` | F2 — how to actually pass agent/model in V2 (via `switchAgent`/`switchModel`, not via `prompt`) |
| `node_modules/@opencode/plugin/dist/promise/session.d.ts` (fetched earlier, `SessionDomain`) | n/a | `SessionDomain = Pick<SessionApi, "create"\|"get"\|"switchAgent"\|"switchModel"\|"prompt"\|"generate"\|"command"\|"synthetic"\|"interrupt"\|"update"\|"move"\|"wait"\|"context"> & {hook: ModelHooks<SessionHooks>}` | Confirms `switchAgent`/`switchModel`/`interrupt`/`prompt`/`context` exist; **no `status()` / list-status method exists on V2 `ctx.session`** — the event stream is the *only* source of retry status in V2 |
| `node_modules/@opencode/plugin/dist/promise/plugin.d.ts` | full file (~40 lines) | `Context.options: PluginOptions` (`Record<string, any>`) is a **top-level context field**, NOT a 2nd argument to `setup`. `Plugin.define({id, setup: (context: Context) => ...})` — `setup` takes exactly one argument. | F3 — `src/v2.ts:388` `setup: async (ctx, options?) => …` never receives options; must read `ctx.options` |
| `node_modules/@opencode/client/dist/shared-events.d.ts:1-11` | 1-11 | `subscribe(options？: {signal？: AbortSignal; onActivity？: () => void}): AsyncIterable<V2Event>` — no topic-string parameter | F4 — `src/v2.ts:336` `this.ctx.event.subscribe("session.status")` is invalid; real call is `ctx.event.subscribe({signal})` and the stream carries **every** event type |
| `node_modules/@opencode/client/dist/promise/generated/types.d.ts:3301` | 3301 | `V2Event` union includes `SessionStatusUpdated{type:"session.status"}`, `SessionIdle{type:"session.idle"}`, `SessionExecutionFailed{type:"session.execution.failed"}`, `SessionExecutionInterrupted{type:"session.execution.interrupted"}`, `SessionDeleted{type:"session.deleted"}` — **no `"session.error"` member exists** | F5 — `src/v2.ts:325` `case "session.deleted": case "session.error":` — `session.error` is dead code, `session.execution.failed`/`interrupted` are the real terminal-failure events |
| `node_modules/@opencode/client/dist/promise/generated/types.d.ts:2396-2408`, `960-970` | 2396-2408, 960-970 | `SessionStatusUpdated.data = {sessionID, status}`; `SessionDeleted.data = {sessionID}` (both flat, matches local usage) | Confirms event `.data.sessionID` access pattern already used at `src/v2.ts:349-354` is correct — only the dispatch/case list is wrong |
| `node_modules/@opencode/client/dist/promise/generated/types.d.ts` (PromptFileAttachment, inline `SessionPromptInput.files`) | ~5470-5497 | Input file shape for `session.prompt` is `{uri, name?, description?, mention?}` — matches local `FileAttachment{uri,name?,description?}` shape already used | Confirms only the wrapper (`text:{...}`) was wrong, not the file mapping itself — narrows F1's fix |
| `src/v2.ts` | 67-74 | `V2SessionContext` interface: `prompt(args:{sessionID; text:{text; files?}})` — hand-written, does not match real SDK | F1 root cause |
| `src/v2.ts` | 211-234 | `promptAsync()` builds `promptArgs = {sessionID, text:{text, files}}`, conditionally injects `agent`/`model` into that same object at runtime — none of these fields exist on the real API | F1 + F2 root cause, silently swallowed by the outer `catch` in `fireAutoRetry` (line 301) and by `console.error` in the command handler (line 416) — **no prompt is ever actually sent by V2** |
| `src/v2.ts` | 382-390 | `setup: async (ctx: unknown, options?: {maxRetryWaitMs?: unknown}) => {...; new V2RetryClient(ctxV2, options)}` | F3 root cause — `options` param is always `undefined` at runtime because `Plugin.define`'s `setup` is called with one argument |
| `src/v2.ts` | 336 | `this.ctx.event.subscribe("session.status")` | F4 root cause |
| `src/v2.ts` | 344-361 | Background loop: `while(true){ try{...} catch{ break; } }` — on ANY stream error, the loop exits forever and silently stops all future status updates (auto-cap + manual `/retry-now` both go stale) | F6 — needs reconnect/backoff, not `break` |
| `src/v2.ts` | 307-330 | `handleEvent()` switch only handles `"session.status"`, `"session.deleted"`, `"session.error"` — never removes a deleted session's stale entry from `this.statusCache` | F7 — `statusCache` grows a permanent ghost `retry` entry for every deleted session; manual `/retry-now` (`v2.ts:401-406`) will keep trying to prompt sessions that no longer exist |
| `src/v2.ts` | 396-421 | V2 command handler's `execute: async () => {...}` loops `retryingSessionIds` and calls `client.promptAsync(...)` directly, **never calls `client.abort()` first** — unlike the V1 adapter (`index.ts:212-215`) and unlike the auto-cap path (`v2.ts:299`) | F8 — manual `/retry-now` in V2 does not interrupt the in-flight/waiting request before replaying, so the replay can be queued behind the native countdown instead of pre-empting it |
| `src/v2.ts` | 87-97 | `V2CommandTransformer.add({name,description,execute: () => Promise<void>})` — 0-arg `execute`, matches real `CommandDefinition.execute(input: CommandInvocation)` only because TS allows a callback with fewer declared params (sound narrowing) | Not a compile error, but means the handler cannot read `input.sessionID`/`input.delivery` — acceptable to leave as-is once F8 is fixed (out of scope to restructure further) |
| `src/retry-cap.ts` | 110-149 | `BounceBudget.commit()` (123-132) sets `existing.inFlight = true` and **no method ever sets it back to `false`**; `surviveTransientIdle()` (135-140) returns `b.inFlight`, which is permanently `true` after the first bounce | F10 — after one auto-retry, `surviveTransientIdle` always returns `true`, so `reset()` (called only when it returns `false`, see `v2.ts:316-318`) is unreachable via the idle path; only `session.deleted` (once F5's dead `session.error` branch is fixed) can ever reset the budget |
| `src/v2.ts` | 296-304 | `fireAutoRetry()` calls `this.budget.commit(id)` then attempts abort+prompt in a bare `try/catch` with **no `finally`** to release the in-flight flag | F11 — root cause pairing with F10; needs a `finally { this.budget.release(id) }` |
| `src/retry-cap.ts` | 94-99 | `isUsageLimit()` message regex is `/usage.?limit/i` | F12 — PR #3's equivalent guard matches `/usage limit\|free limit/i`; local regex misses "free limit" (OpenCode's `FreeUsageLimitError` message family, confirmed in `packages/opencode/src/session/retry.ts` fetched during review: `"Free limit reached"`) |
| `src/index.ts` | 174-184 | `command.execute.before`: fetches `statusResult` **once** (line 177) into `statuses`, derives `retrySessionIDs` by filtering `statuses` for `type==="retry"` (line 182-184) | F13 root cause — the recheck at line 196 reads the exact same `statuses` object these IDs were already filtered from |
| `src/index.ts` | 187-206 | Inside `Promise.allSettled(...)` map: line 196 `const sessionStatus = statuses[sessionID]; if (sessionStatus?.type !== "retry") return;` — always true, since `sessionID` came from `retrySessionIDs` which was filtered on this exact same `statuses` map moments earlier | F14 (TOCTOU no-op) — PR #2/#3 instead call `client.session.status(dirQuery)` **again**, per-session, right before `abort` |
| `src/index.ts` | 209-224 | After the remote-session loop: `if (!currentParts...) return;` (210) only guards on parts existing; `if (myStatus?.type === "retry") { await client.session.abort(...) }` (213-215) guards the abort; but `output.parts.splice(...)` (224) runs **unconditionally** after that `if`, regardless of `myStatus.type` | F15 — invoking `/retry-now` on a session that is NOT currently rate-limited (idle/busy) still resends its last user message, duplicating the request |
| `src/index.ts` | 179 | `const { parts: currentParts, agent: currentAgent, model: currentModel } = currentRetry ?? {};` | F16 — `currentAgent`/`currentModel` are destructured and never read anywhere below; V1's `command.execute.before` `output` type only exposes `{parts: Part[]}` (no agent/model field), so these truly cannot be forwarded for the *current* session — this is a real, documented V1 API limitation, not a bug to "fix" beyond removing dead code |
| `src/index.ts` | 68-75 and 82-89 | Identical JSDoc block ("Find the user message that triggered the current retry. Strategy: locate the latest `RetryPart`...") duplicated verbatim twice back-to-back | F17 — copy-paste leftover, delete lines 68-75 |
| `src/index.ts` | 33-38 | Comment: "`@opencode-ai/plugin` 1.x exposes no event subscription API, so manual status polling remains the consumer's responsibility" | F18 (false claim) — see F19 |
| `node_modules/@opencode-ai/plugin/dist/index.d.ts` (fetched during review) | ~174-178 | V1 `Hooks` interface has `event?: (input: {event: Event}) => Promise<void>` and `dispose?: () => Promise<void>` | F19 — V1 **does** have an event hook; PR #3 uses it successfully (verified by PR #3 author on OpenCode 1.18.9) |
| `node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:406-418` | 406-418 | V1 `EventSessionStatus{type:"session.status";properties:{sessionID;status}}`, `EventSessionIdle{type:"session.idle";properties:{sessionID}}` | F20 — event shapes V1 auto-cap must switch on (`properties`, not `data`, unlike V2) |
| `src/index.ts` | 167 | `const v1Plugin: V1Plugin = async ({ client, directory }) => {` | F21 — V1 plugin factory signature currently ignores the 2nd `options` argument entirely; needed to read `maxRetryWaitMs` for V1 auto-cap |
| `package.json` | 45-48 | `"dependencies": {"@opencode/ai": "file:../../../../tmp/tgz/ai.tgz", "@opencode/client": "file:../../../../tmp/tgz/client.tgz"}` — `/tmp/tgz` does not exist on this machine | F22 — `npm ci`/fresh install fails; `npm ls` already reports `invalid: @opencode/client@2.0.16` |
| `package.json` | 29-32 | `"peerDependencies": {"@opencode-ai/plugin": ">=1.15.0", "@opencode/plugin": ">=2.0.0"}` — both mandatory, no `peerDependenciesMeta` | F23 — a V1-only consumer is forced to have `@opencode/plugin` installed too (and vice versa) |
| `src/index.ts` | 22 | `import v2Plugin from "./v2.js";` (static, top-level) | F24 — every V1-only consumer's bundler/runtime pulls in the entire V2 module graph (which imports `@opencode/plugin`) even though V1 never calls it — compounds F23 |
| `README.md` | 40-47 | V2 config example: `{"plugin": [{"id": "...", "module": "...", "export": "v2"}]}` | F25 — real V2 config key is `"plugins"` (array), entries are `{"package": "...", "options": {...}}` per `https://opencode.ai/v2/docs/build/plugins` ("Overview" section, `plugins` in `opencode.json(c)`); there is no `id`/`module`/`export` shape in the real schema |
| `README.md` | 100-109 | Same wrong V2 config shape repeated for the `maxRetryWaitMs` example | Same as F25 |
| `README.md` | 111-113 | "The V1 adapter ... has no event subscription API" | Same false claim as F18, must be corrected together with the V1 auto-cap addition (Wave 5) |
| `test/v2-plugin.test.ts` | 72-82 | `promptAsync(...)` test asserts `sessionPrompt` was called with `{sessionID, text:{text:"hello", files:[]}}` — codifies the wrong contract (F1) | Must be rewritten once F1 is fixed, or it will pass against broken code forever |
| `src/retry-cap.ts` | 46-55 | `parseMaxRetryWaitMs` already correctly implements `false`/`<=0`→null, non-number→default — reusable as-is for V1 auto-cap (Wave 5) | No fix needed, confirms helper is shareable between V1 and V2 |

## Waves (dependency order)

Wave 0 → Wave 1 → Wave 2 → Wave 3 → Wave 4 → Wave 5 → Wave 6. Inside a wave, todos with
independent files run in parallel; todos touching the same file are sequential in the listed
order.

---

### Wave 0 — Baseline checkpoint (sequential, run first)

- [ ] **0.1 Record baseline build/test state before any edit.**
  - **What to do:** Run, in order: `cd /home/openchamber/workspaces/opencode_retrypush && npx tsc --noEmit` (expect exit 0, no output), then `npx vitest run` (expect `Test Files 3 passed (3)`, `Tests 92 passed (92)`). Record the exact numbers. Do not edit any file in this todo.
  - **Must NOT do:** Do not `git commit`, do not modify `package.json`/`tsconfig.json`/source files.
  - **Parallelization:** None — must run before any other wave.
  - **References:** `package.json:9-11` (scripts), earlier verified baseline: `tsc --noEmit` clean, `92 passed (92)`, `Test Files 3 passed (3)`.
  - **Recommended task executor category:** `junior`.
  - **Acceptance criteria:** `npx tsc --noEmit` exits 0 with empty stdout/stderr. `npx vitest run` prints `Tests  92 passed (92)` and `Test Files  3 passed (3)`.
  - **QA scenarios:** Run `npx tsc --noEmit; echo "EXIT:$?"` — expect `EXIT:0` on its own line. Run `npx vitest run 2>&1 | tail -5` — expect a line containing `Tests  92 passed (92)`.
  - **Commit:** none (no file changes).

---

### Wave 1 — Packaging correctness

- [ ] **1.1 Fix `package.json`: remove broken local tgz dependencies, make peers optional.**
  - **What to do:** In `package.json`, delete the `"dependencies"` block entirely (lines 45-48: `@opencode/ai` and `@opencode/client` point at a nonexistent `/tmp/tgz/*.tgz`; both packages are already transitive dependencies of `@opencode/plugin`, which is a devDependency/peerDependency — the plugin code only imports types from them, never their runtime, so no direct dependency is needed). Add a `"peerDependenciesMeta"` block right after `"peerDependencies"` (after line 32) marking both peers optional:
    ```json
    "peerDependenciesMeta": {
      "@opencode-ai/plugin": { "optional": true },
      "@opencode/plugin": { "optional": true }
    },
    ```
  - **Must NOT do:** Do not remove `"peerDependencies"` itself (still needed for the version ranges). Do not add any new runtime dependency. Do not touch `devDependencies`.
  - **Parallelization:** Independent of all Wave 2-5 todos (different file); can run in parallel with 1.2.
  - **References:** `package.json:29-32` (peerDependencies), `package.json:45-48` (dependencies to delete), Fact F22, F23.
  - **Recommended task executor category:** `junior`.
  - **Acceptance criteria:** `package.json` has no top-level `"dependencies"` key. `"peerDependenciesMeta"` key exists with both packages set `{"optional": true}`. `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"` exits 0 (valid JSON).
  - **QA scenarios:** `grep -c '"dependencies"' package.json` → `0`. `grep -A2 '"peerDependenciesMeta"' package.json` shows both `@opencode-ai/plugin` and `@opencode/plugin` with `"optional": true`. `npx tsc --noEmit` still exits 0 (removing an unused runtime dependency does not affect type-only imports).
  - **Commit:** `fix(package): remove broken tgz deps, mark plugin peers optional`

- [ ] **1.2 Fix `README.md`: correct V2 plugin config shape and the false "V1 has no event API" claim.**
  - **What to do:** Replace the V2 config block at `README.md:38-48` (currently `{"plugin": [{"id": "...", "module": "...", "export": "v2"}]}`) with the real `opencode.jsonc` shape documented at `https://opencode.ai/v2/docs/build/plugins`:
    ```json
    {
      "plugins": [
        { "package": "file:///absolute/path/to/opencode_retrypush/dist/index.js", "options": {} }
      ]
    }
    ```
    Replace the same wrong shape at `README.md:100-109` (the `maxRetryWaitMs` example), keeping `"options": {"maxRetryWaitMs": 60000}`. Replace `README.md:111-113` ("The V1 adapter ... has no event subscription API") with a statement that V1 auto-cap is supported via the `event` hook, once Wave 5 lands (this todo only fixes the false claim's wording — do not describe features not yet implemented; write it as: "The V1 adapter uses `@opencode-ai/plugin`'s `event` hook to drive the same auto-cap state machine as V2 — see Auto-Cap section above.").
  - **Must NOT do:** Do not change the V1 config example at `README.md:26-34` (that one is already correct: V1 uses the `"plugin": ["file://..."]` array-of-strings form per `@opencode-ai/plugin`). Do not invent config keys not confirmed by the fetched docs.
  - **Parallelization:** Independent of 1.1 (different file); must run before Wave 5's README update (5.3) touches the same file — sequential with 5.3, not parallel.
  - **References:** `README.md:38-48`, `README.md:100-109`, `README.md:111-113`, Fact F25, F18, F19.
  - **Recommended task executor category:** `junior`.
  - **Acceptance criteria:** `README.md` no longer contains the string `"module":` or `"export": "v2"`. It contains `"plugins":` and `"package":` in the V2 config examples. It no longer contains the phrase "no event subscription API".
  - **QA scenarios:** `grep -c '"module":' README.md` → `0`. `grep -c '"plugins":' README.md` → `2` (both config blocks). `grep -c 'no event subscription API' README.md` → `0`.
  - **Commit:** `docs(readme): fix V2 plugin config shape, correct V1 event-API claim`

---

### Wave 2 — V2 core correctness: prompt shape, agent/model, options (P0)

- [ ] **2.1 Fix `V2SessionContext` interface and `promptAsync()` to match the real `@opencode/plugin` 2.0.16 API.**
  - **What to do:** In `src/v2.ts`, replace the `V2SessionContext` interface (lines 67-74) with:
    ```ts
    interface V2SessionContext {
      context(args: { sessionID: string }): Promise<unknown>;
      interrupt(args: { sessionID: string }): Promise<unknown>;
      prompt(args: {
        sessionID: string;
        text: string;
        files?: Array<{ uri: string; name?: string; description?: string }>;
      }): Promise<unknown>;
      switchAgent(args: { sessionID: string; agent: string }): Promise<unknown>;
      switchModel(args: { sessionID: string; model: { id: string; providerID: string } }): Promise<unknown>;
    }
    ```
    Replace `promptAsync()` (lines 211-234) with:
    ```ts
    async promptAsync(
      sessionID: string,
      body: { parts: PromptPart[]; agent?: string; model?: import("./shared.js").AgentModel },
      options?: { directory?: string },
    ): Promise<void> {
      const textParts = body.parts.filter((p) => p.type === "text") as Array<import("./shared.js").TextPart>;
      const fileParts = body.parts.filter((p) => p.type === "file") as Array<import("./shared.js").FilePart>;

      const text = textParts.map((p) => p.text).join("\n");
      const files = fileParts.map((p) => ({
        uri: p.file.uri,
        name: p.file.name,
        description: p.file.description,
      }));

      if (body.agent) {
        await this.ctx.session.switchAgent({ sessionID, agent: body.agent });
      }
      if (body.model) {
        await this.ctx.session.switchModel({
          sessionID,
          model: { id: body.model.modelID, providerID: body.model.providerID },
        });
      }

      await this.ctx.session.prompt({
        sessionID,
        text,
        ...(files.length > 0 ? { files } : {}),
      });
    }
    ```
    `switchAgent`/`switchModel` must run **before** `prompt`, and only when `body.agent`/`body.model` is set (matches PR #2's conditional-spread intent — do not switch when the field is absent, to avoid overriding the session's current agent/model with `undefined`).
  - **Must NOT do:** Do not add `agent`/`model` fields to the `prompt()` call itself (they do not exist on `SessionPromptInput` — confirmed by tsc probe in Fact table). Do not remove the `files` uri/name/description mapping — it is already correct.
  - **Parallelization:** Must run before 2.2/2.3 only if they touch the same lines (they don't — 2.2 touches `setup`/constructor, 2.3 touches `initStatusCache`/`event.subscribe`). Can run in parallel with 2.2 and 2.3 by a single executor doing all three in one pass, or sequentially 2.1→2.2→2.3 if split across sub-agents (same file, avoid concurrent edits).
  - **References:** `src/v2.ts:67-74` (interface), `src/v2.ts:211-234` (promptAsync), Fact F1, F2, F9 (files shape reference).
  - **Recommended task executor category:** `executor` (single file but requires careful type reasoning against real SDK types).
  - **Acceptance criteria:** `npx tsc --noEmit` exits 0. `grep -n 'text: { text' src/v2.ts` returns no matches. `grep -n 'switchAgent\|switchModel' src/v2.ts` returns at least 2 matches inside `promptAsync`.
  - **QA scenarios:** Write a throwaway compile probe (delete after): create `src/__tc.ts` with `import { V2RetryClient } from "./v2.js";` — must compile with `npx tsc --noEmit` (0 errors), then delete `src/__tc.ts`. Update the existing test at `test/v2-plugin.test.ts:72-82` ("promptAsync calls session.prompt with correct format") to assert `sessionPrompt` was called with `{sessionID: "session-1", text: "hello"}` (no `files` key, since `fileParts` is empty and the current code appends `files` only when non-empty) — run `npx vitest run test/v2-plugin.test.ts` and expect the updated assertion to pass.
  - **Commit:** `fix(v2): send session.prompt with correct body shape, wire agent/model via switchAgent/switchModel (fix #1 for V2)`

- [ ] **2.2 Read `maxRetryWaitMs` from `ctx.options` instead of a non-existent `setup` second argument.**
  - **What to do:** In `src/v2.ts`, change the `setup` callback (lines 382-390) from:
    ```ts
    setup: async (ctx: unknown, options?: { maxRetryWaitMs?: unknown }) => {
      const ctxV2 = ctx as V2PluginContext;
      const client = new V2RetryClient(ctxV2, options);
    ```
    to:
    ```ts
    setup: async (ctx: unknown) => {
      const ctxV2 = ctx as V2PluginContext & { options: Record<string, unknown> };
      const client = new V2RetryClient(ctxV2, ctxV2.options);
    ```
    Update `V2PluginContext` interface (lines 99-103) to add `options: Record<string, unknown>`:
    ```ts
    export interface V2PluginContext {
      session: V2SessionContext;
      event: V2Event;
      command: V2Command;
      options: Record<string, unknown>;
    }
    ```
    (then the `& {options: ...}` intersection added to `ctxV2`'s cast above becomes redundant — remove it and just add `options` to `V2PluginContext` directly, then cast `ctx as V2PluginContext` as before and pass `ctxV2.options`). The `V2RetryClient` constructor (lines 180-186) already accepts `options?: {maxRetryWaitMs?: unknown}` — no change needed there, just pass the real source object.
  - **Must NOT do:** Do not change `parseMaxRetryWaitMs` in `retry-cap.ts` (already correct, Fact table confirms it's reusable as-is). Do not remove the `options?:` parameter from the `V2RetryClient` constructor signature — keep it for testability (tests construct `new V2RetryClient(ctx, {maxRetryWaitMs: N})` directly).
  - **Parallelization:** Same file as 2.1/2.3 — run sequentially after 2.1 if split across executors.
  - **References:** `src/v2.ts:99-103` (V2PluginContext), `src/v2.ts:180-186` (constructor, unchanged), `src/v2.ts:382-390` (setup), Fact F3.
  - **Recommended task executor category:** `junior`.
  - **Acceptance criteria:** `npx tsc --noEmit` exits 0. `grep -n 'options?: {' src/v2.ts` — the `setup` signature no longer has an `options?` 2nd parameter (only the constructor keeps it). `grep -n 'ctxV2.options' src/v2.ts` returns 1 match.
  - **QA scenarios:** Add a test in `test/v2-plugin.test.ts` mocking `ctx.options = {maxRetryWaitMs: 60000}`, calling the exported `v2Plugin.setup(ctx)`, and asserting (via a spy or by triggering a retry-status event and checking timer arm/no-arm behavior at the 60s boundary) that the cap used is `60000`, not the `300000` default. Run `npx vitest run test/v2-plugin.test.ts` — new test passes.
  - **Commit:** `fix(v2): read maxRetryWaitMs from ctx.options, not a nonexistent setup() 2nd arg (fix #2 for V2)`

- [ ] **2.3 Fix `ctx.event.subscribe()` call signature and add stream reconnect-with-backoff.**
  - **What to do:** In `src/v2.ts`, change `V2EventSubscription`/`V2Event` interfaces (lines 76-85) to match the real signature:
    ```ts
    interface V2Event {
      subscribe(options?: { signal?: AbortSignal }): AsyncIterable<{
        type: string;
        data?: { sessionID: string; status?: SessionStatus };
      }>;
    }
    ```
    Replace `initStatusCache()` (lines 333-362) to use an `AbortController` and reconnect with backoff instead of permanently `break`-ing on error:
    ```ts
    async initStatusCache(): Promise<void> {
      if (this.statusDispose) return;
      const controller = new AbortController();
      this.statusDispose = () => controller.abort();

      (async () => {
        let backoffMs = 1000;
        while (!controller.signal.aborted) {
          try {
            const stream = this.ctx.event.subscribe({ signal: controller.signal });
            for await (const value of stream) {
              backoffMs = 1000; // reset backoff after a successful event
              if (value.type === "session.status" && value.data?.status) {
                this.statusCache[value.data.sessionID] = value.data.status as SessionStatus;
                this.handleEvent(value.type, value.data.sessionID);
              } else if (value.data?.sessionID) {
                this.handleEvent(value.type, value.data.sessionID);
              }
            }
          } catch {
            if (controller.signal.aborted) break;
            await new Promise((r) => setTimeout(r, backoffMs));
            backoffMs = Math.min(backoffMs * 2, 30000);
          }
        }
      })();
    }
    ```
    Note `subscribe()` now yields **every** V2 event, not just `session.status` — the existing `if/else if` inside the loop already filters correctly by `value.type`/`value.data?.sessionID`, so no additional filtering logic is needed beyond what's shown.
  - **Must NOT do:** Do not remove the `backoffMs` reset-on-success (without it, a long-lived healthy connection with one early blip stays slow forever). Do not use `setInterval`/polling — this must stay event-driven per the architecture note in the module's own header comment.
  - **Parallelization:** Same file as 2.1/2.2 — sequential.
  - **References:** `src/v2.ts:76-85` (interfaces), `src/v2.ts:333-362` (initStatusCache), Fact F4, F6.
  - **Recommended task executor category:** `executor` (async stream + backoff logic, higher risk of subtle bugs).
  - **Acceptance criteria:** `npx tsc --noEmit` exits 0. `grep -n 'subscribe("session.status")' src/v2.ts` → no matches. `grep -n 'AbortController' src/v2.ts` → at least 1 match.
  - **QA scenarios:** Add a test in `test/v2-plugin.test.ts`: mock `ctx.event.subscribe` to throw once then succeed on a second call; call `initStatusCache()`; advance fake timers past the initial backoff (`vi.advanceTimersByTime(1000)`); assert `ctx.event.subscribe` was called at least twice (proves reconnect). Run `npx vitest run test/v2-plugin.test.ts`.
  - **Commit:** `fix(v2): correct event.subscribe signature, add reconnect-with-backoff on stream error`

---

### Wave 3 — V2 reliability fixes

- [ ] **3.1 Add `BounceBudget.release()` and call it in a `finally` block around the auto-retry attempt.**
  - **What to do:** In `src/retry-cap.ts`, add a new method to `BounceBudget` (after `commit()`, i.e. after line 132):
    ```ts
    /** Release the in-flight flag after an auto-retry attempt settles (success, failure, or skip). */
    release(id: string): void {
      const b = this.map.get(id);
      if (b) b.inFlight = false;
    }
    ```
    In `src/v2.ts`, wrap the retry attempt inside `fireAutoRetry()` (lines 290-304) so `release` always runs:
    ```ts
    const bounces = this.budget.commit(id);
    if (bounces > MAX_AUTOMATIC_BOUNCES) {
      this.budget.reset(id);
      return;
    }

    try {
      const u = await sharedRetryingUserParts(this, id);
      if (!u || u.parts.length === 0) return;
      await this.abort(id);
      await this.promptAsync(id, { parts: u.parts, agent: u.agent, model: u.model });
    } catch (err) {
      console.error(`[retry-now] auto-cap: failed to retry session ${id}:`, err);
    } finally {
      this.budget.release(id);
    }
    ```
  - **Must NOT do:** Do not call `release()` inside `reset()` or vice versa — they are distinct: `reset()` deletes the whole bucket (used on terminal idle/delete), `release()` only flips `inFlight` back to `false` while keeping the bounce count (used after every attempt, success or fail).
  - **Parallelization:** `retry-cap.ts` edit and `v2.ts` edit touch different files but are logically coupled — do both in the same todo/executor pass to avoid a half-applied fix landing in two separate commits with a broken intermediate state. Independent of Wave 2 (different lines in `v2.ts`, but same file — run after Wave 2's `v2.ts` edits land to avoid merge conflicts).
  - **References:** `src/retry-cap.ts:110-149` (BounceBudget), `src/v2.ts:290-304` (fireAutoRetry), Fact F10, F11.
  - **Recommended task executor category:** `junior`.
  - **Acceptance criteria:** `npx tsc --noEmit` exits 0. `grep -n 'release(id: string)' src/retry-cap.ts` → 1 match. `grep -n 'this.budget.release(id)' src/v2.ts` → 1 match inside a `finally` block.
  - **QA scenarios:** Add a test in `test/shared.test.ts` or a new `test/retry-cap.test.ts` (whichever the suite already uses for `retry-cap.ts` unit tests — confirm via `grep -l 'BounceBudget' test/*.test.ts` first): `const b = new BounceBudget(); b.commit("s1"); expect(b.surviveTransientIdle("s1")).toBe(true); b.release("s1"); expect(b.surviveTransientIdle("s1")).toBe(false);`. Run `npx vitest run` and expect this new test to pass along with the previously-passing 92.
  - **Commit:** `fix(retry-cap): release bounce budget in-flight flag after each attempt (was never reset)`

- [ ] **3.2 Fix V2 event dispatch: remove dead `session.error` case, use real terminal-failure events, delete `statusCache` entries on `session.deleted`.**
  - **What to do:** In `src/v2.ts`, replace the `handleEvent()` switch (lines 307-330):
    ```ts
    private handleEvent(eventType: string, sessionID: string): void {
      switch (eventType) {
        case "session.status": {
          const status = this.statusCache[sessionID];
          if (!status) return;
          if (status.type === "busy") this.clearRetryTimer(sessionID);
          else if (status.type === "idle") {
            this.clearRetryTimer(sessionID);
            if (!this.budget.surviveTransientIdle(sessionID)) {
              this.budget.reset(sessionID);
            }
          } else if (status.type === "retry") {
            this.scheduleRetry(sessionID, status);
          }
          break;
        }
        case "session.idle":
          this.clearRetryTimer(sessionID);
          if (!this.budget.surviveTransientIdle(sessionID)) {
            this.budget.reset(sessionID);
          }
          break;
        case "session.deleted":
          this.clearRetryTimer(sessionID);
          this.budget.reset(sessionID);
          delete this.statusCache[sessionID];
          break;
        case "session.execution.failed":
        case "session.execution.interrupted":
          this.clearRetryTimer(sessionID);
          this.budget.reset(sessionID);
          break;
      }
    }
    ```
  - **Must NOT do:** Do not keep the `case "session.error":` line — it matches nothing in the real `V2Event` union and is dead code (Fact F5). Do not delete `statusCache[sessionID]` on `session.execution.failed`/`interrupted` (the session still exists, just its run failed — only `session.deleted` means the session itself is gone).
  - **Parallelization:** Same file as 3.1 — run after 3.1 in the same pass, or sequentially.
  - **References:** `src/v2.ts:307-330`, Fact F5, F7.
  - **Recommended task executor category:** `junior`.
  - **Acceptance criteria:** `npx tsc --noEmit` exits 0. `grep -n '"session.error"' src/v2.ts` → no matches. `grep -n 'delete this.statusCache\[sessionID\]' src/v2.ts` → 1 match.
  - **QA scenarios:** Add a test: seed `client["statusCache"]` (or trigger via a mocked `session.status` event) with a `retry` entry for `sess-x`, then dispatch a `session.deleted` event for `sess-x` through the event stream mock, then assert (via `client.getStatuses()`) that `sess-x` is no longer present in the returned map. Run `npx vitest run test/v2-plugin.test.ts`.
  - **Commit:** `fix(v2): remove dead session.error case, use real execution.failed/interrupted events, clean up statusCache on deletion`

- [ ] **3.3 Manual `/retry-now` in V2 must abort before replaying (matches V1 and auto-cap behavior).**
  - **What to do:** In `src/v2.ts`, inside the command's `execute` (lines 408-418), add an `abort` call before `promptAsync`:
    ```ts
    for (const sessionID of retryingSessionIds) {
      try {
        const u = await sharedRetryingUserParts(client, sessionID);
        if (!u) continue;
        const { parts, agent, model } = u;
        await client.abort(sessionID);
        await client.promptAsync(sessionID, { parts, ...(agent ? { agent } : {}), ...(model ? { model } : {}) });
      } catch (err) {
        console.error(`[retry-now] Failed to retry session ${sessionID}:`, err);
      }
    }
    ```
  - **Must NOT do:** Do not change the loop from sequential to parallel (`Promise.all`) in this todo — that is a separate, unrequested performance change and would need its own error-isolation design (V1 already uses `Promise.allSettled` for remote sessions; V2 parity is out of scope here).
  - **Parallelization:** Same file as 3.1/3.2 — sequential (all three touch `v2.ts`, do them in one pass or in strict listed order to avoid conflicting diffs).
  - **References:** `src/v2.ts:396-421` (command execute), `src/index.ts:212-215` (V1's equivalent abort-before-replay for comparison), Fact F8.
  - **Recommended task executor category:** `junior`.
  - **Acceptance criteria:** `npx tsc --noEmit` exits 0. `grep -n 'await client.abort(sessionID);' src/v2.ts` → 1 match immediately before the `promptAsync` call inside the command handler.
  - **QA scenarios:** Add a test asserting that when `/retry-now` executes with one session in `retry` status, `interrupt`/`abort` (the mocked `ctx.session.interrupt`) is called **before** `ctx.session.prompt` (assert call order via `mock.invocationCallOrder` or two separate spies checked in sequence). Run `npx vitest run test/v2-plugin.test.ts`.
  - **Commit:** `fix(v2): abort session before replaying prompt in manual /retry-now command`

- [ ] **3.4 Fix usage-limit message regex to match "free limit" (parity with PR #3).**
  - **What to do:** In `src/retry-cap.ts`, change line 97:
    ```ts
    if (typeof status.message === "string" && /usage.?limit/i.test(status.message)) return true;
    ```
    to:
    ```ts
    if (typeof status.message === "string" && /usage.?limit|free.?limit/i.test(status.message)) return true;
    ```
  - **Must NOT do:** Do not change the `status.action` truthy-object check on line 96 — it already covers the structured `action.reason` case correctly and is not part of this fact (F12 is about the message-text fallback only).
  - **Parallelization:** Independent of all other Wave 3 todos (different lines in the same file as 3.1 — run after 3.1's `retry-cap.ts` edit lands, in the same pass to avoid conflicts).
  - **References:** `src/retry-cap.ts:94-99`, Fact F12.
  - **Recommended task executor category:** `junior`.
  - **Acceptance criteria:** `npx tsc --noEmit` exits 0. `grep -n 'free.?limit' src/retry-cap.ts` → 1 match.
  - **QA scenarios:** Add a test: `expect(isUsageLimit({type:"retry", attempt:1, next:0, message:"Free limit reached"})).toBe(true);`. Run `npx vitest run` — new test passes.
  - **Commit:** `fix(retry-cap): match "free limit" in usage-limit guard regex (parity with PR #3)`

---

### Wave 4 — V1 correctness fixes

- [ ] **4.1 Fix TOCTOU no-op: re-fetch fresh status per remote session before abort.**
  - **What to do:** In `src/index.ts`, inside the `Promise.allSettled` map callback (lines 190-204), replace the stale recheck (lines 195-197):
    ```ts
    // Re-check: only abort+replay if still in retry state.
    const sessionStatus = statuses[sessionID];
    if (sessionStatus?.type !== "retry") return;
    ```
    with a fresh fetch:
    ```ts
    // Re-fetch: only abort+replay if the session is STILL in retry state
    // right now (the initial `statuses` snapshot may be stale by the time
    // this async map callback runs).
    const freshStatusResult = await client.session.status(dirQuery);
    const freshStatuses = (freshStatusResult.data ?? {}) as Record<string, SessionStatus>;
    if (freshStatuses[sessionID]?.type !== "retry") return;
    ```
  - **Must NOT do:** Do not remove the initial `statuses` fetch at line 177 — it is still needed to build `retrySessionIDs` (the candidate list) before the per-session refetch. Do not fetch status once-per-session in serial (this is already inside a `.map()` that feeds `Promise.allSettled`, so N parallel fetches are correct and match PR #2/#3's per-session re-check behavior).
  - **Parallelization:** Independent of Wave 4.2/4.3 only if they don't overlap lines — 4.2 touches lines 209-224 (different block), 4.3 touches lines 33-38/68-89/179 (different blocks). All three touch `src/index.ts` — run sequentially in the listed order (4.1 → 4.2 → 4.3) to avoid line-number drift between edits.
  - **References:** `src/index.ts:174-206` (full command handler up to remote loop), Fact F13, F14.
  - **Recommended task executor category:** `junior`.
  - **Acceptance criteria:** `npx tsc --noEmit` exits 0. `grep -n 'const freshStatusResult = await client.session.status' src/index.ts` → 1 match inside the `.map()` callback.
  - **QA scenarios:** Add/update a test in `test/retry-now-plugin.test.ts`: mock `client.session.status` to return `{data: {other: {type: "retry", ...}}}` on the first call (used to build `retrySessionIDs`) and `{data: {other: {type: "busy"}}}` on a second call; invoke the command; assert `client.session.abort` and `client.session.promptAsync` were **not** called for `other` (proves the fresh check actually blocks a session that changed state between the two fetches). Run `npx vitest run test/retry-now-plugin.test.ts`.
  - **Commit:** `fix(v1): re-fetch fresh session status before aborting each remote retry session (was a no-op TOCTOU check)`

- [ ] **4.2 Guard current-session `output.parts` replacement on `myStatus.type === "retry"` (do not resend when not rate-limited).**
  - **What to do:** In `src/index.ts`, restructure lines 209-224 so the `output.parts.splice(...)` only runs when the current session is actually in retry state:
    ```ts
    // Handle current session — only replace the command's parts when this
    // session is actually waiting on a rate-limit retry. Otherwise leave the
    // /retry-now command's own text untouched (nothing to resend).
    if (!currentParts || currentParts.length === 0) return;

    const myStatus = statuses[input.sessionID];
    if (myStatus?.type !== "retry") return;

    await client.session.abort({ path: { id: input.sessionID }, ...dirQuery });

    // Replace the command's text part with the actual user prompt.
    const commandTextPart = output.parts.find((p) => p.type === "text");
    const commandParts = currentParts.map((p) => ({ ...p }));
    const firstTextIndex = commandParts.findIndex((p) => p.type === "text");
    if (commandTextPart?.type === "text" && firstTextIndex !== -1) {
      commandParts[firstTextIndex] = { ...commandTextPart, ...commandParts[firstTextIndex] };
    }
    output.parts.splice(0, output.parts.length, ...(commandParts as typeof output.parts));
    ```
  - **Must NOT do:** Do not move this block before the remote-session loop — ordering (remote sessions first, then current session) is unchanged and intentional. Do not change the `output.parts.splice` mechanics themselves, only the guard around them.
  - **Parallelization:** Same file as 4.1/4.3 — sequential, run after 4.1.
  - **References:** `src/index.ts:209-224`, Fact F15.
  - **Recommended task executor category:** `junior`.
  - **Acceptance criteria:** `npx tsc --noEmit` exits 0. `grep -n 'if (myStatus?.type !== "retry") return;' src/index.ts` → 1 match, appearing before the `output.parts.splice` call.
  - **QA scenarios:** Add a test in `test/retry-now-plugin.test.ts`: current session status is `{type: "idle"}`; invoke `command.execute.before`; assert `output.parts` is **unchanged** from its input value (identity or deep-equal to the original command parts, not replaced with the user's last message). Run `npx vitest run test/retry-now-plugin.test.ts`.
  - **Commit:** `fix(v1): do not resend last user message via /retry-now when current session is not rate-limited`

- [ ] **4.3 Remove duplicated JSDoc block and unused `currentAgent`/`currentModel` variables.**
  - **What to do:** In `src/index.ts`, delete the first (duplicate) JSDoc comment block at lines 68-75 (keep the second one at lines 82-89, which already has the two extra type declarations `V1AgentModel`/`UserParts` correctly positioned above the function). Change line 179 from:
    ```ts
    const { parts: currentParts, agent: currentAgent, model: currentModel } = currentRetry ?? {};
    ```
    to:
    ```ts
    // V1's `command.execute.before` `output` only exposes `{parts: Part[]}` —
    // there is no field to forward agent/model for the *current* session, so
    // only `parts` is used here. Remote sessions do forward agent/model (see
    // the promptAsync call below).
    const { parts: currentParts } = currentRetry ?? {};
    ```
  - **Must NOT do:** Do not remove `agent`/`model` from `retryingUserParts`'s or `lastUserParts`'s return type — they are still correctly used for remote sessions at line 202. Do not delete the second JSDoc block.
  - **Parallelization:** Same file as 4.1/4.2 — run last in the sequence (4.1 → 4.2 → 4.3) since it touches line 179 which is inside the block 4.2 also edits; apply 4.3's line-179 change and 4.2's block together in one pass if done by the same executor to avoid re-deriving line numbers after 4.2 shifts them.
  - **References:** `src/index.ts:68-89` (duplicate JSDoc), `src/index.ts:179`, Fact F16, F17.
  - **Recommended task executor category:** `junior`.
  - **Acceptance criteria:** `npx tsc --noEmit` exits 0. `grep -c 'Find the user message that triggered the current retry' src/index.ts` → `1` (was 2). `grep -n 'currentAgent\|currentModel' src/index.ts` → no matches.
  - **QA scenarios:** `npx vitest run test/retry-now-plugin.test.ts` — all existing tests (updated by 4.1/4.2) still pass; no test referenced `currentAgent`/`currentModel` by name (confirm with `grep -n 'currentAgent\|currentModel' test/retry-now-plugin.test.ts` → no matches, so removal is safe).
  - **Commit:** `chore(v1): remove duplicated JSDoc block and unused currentAgent/currentModel destructuring`

---

### Wave 5 — V1 auto-cap parity (port PR #3's feature, missing locally)

- [ ] **5.1 Add V1 auto-cap state machine to `src/index.ts` using the existing `retry-cap.ts` helpers, wired through the V1 `event`/`dispose` hooks.**
  - **What to do:** In `src/index.ts`, import the cap helpers already re-exported at lines 40-50 (they're already imported into this file's own module scope for re-export — add a second, direct import for internal use since re-exports don't create local bindings):
    ```ts
    import {
      parseMaxRetryWaitMs,
      armMargin,
      shouldAutoCap,
      hasDrift,
      isUsageLimit,
      MAX_AUTOMATIC_BOUNCES,
      BounceBudget,
    } from "./retry-cap.js";
    import type { SessionStatus as CapStatus } from "@opencode-ai/sdk";
    ```
    Change the plugin factory signature (line 167) to accept the 2nd `options` argument and build cap state:
    ```ts
    const v1Plugin: V1Plugin = async ({ client, directory }, options) => {
      const dirQuery = directory ? { query: { directory } } : {};
      const cap = parseMaxRetryWaitMs(options as Record<string, unknown>);
      const margin = cap != null ? armMargin(cap) : 0;
      const retryTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; attempt: number; next: number }>();
      const budget = new BounceBudget();

      function clearRetryTimer(id: string): void {
        const entry = retryTimers.get(id);
        if (entry) {
          clearTimeout(entry.timer);
          retryTimers.delete(id);
        }
      }

      function scheduleRetry(id: string, status: SessionStatus): void {
        if (cap == null || status.type !== "retry") return;
        if (!shouldAutoCap(status.next, cap, margin)) return;
        if (!budget.canAct(id)) return;
        if (isUsageLimit(status as CapStatus)) return;
        const existing = retryTimers.get(id);
        if (existing && existing.attempt === status.attempt && existing.next === status.next) return;
        clearRetryTimer(id);
        const timer = setTimeout(() => void fireRetry(id), cap);
        if (typeof timer.unref === "function") timer.unref();
        retryTimers.set(id, { timer, attempt: status.attempt, next: status.next });
      }

      async function fireRetry(id: string): Promise<void> {
        const scheduled = retryTimers.get(id);
        if (!scheduled) return;
        retryTimers.delete(id);
        try {
          const statusResult = await client.session.status(dirQuery);
          const fresh = ((statusResult.data ?? {}) as Record<string, SessionStatus>)[id];
          if (!fresh || fresh.type !== "retry") return;
          if (hasDrift(scheduled, fresh)) return;
          if ((fresh.next ?? 0) - Date.now() < margin) return;
          if (isUsageLimit(fresh as CapStatus)) return;
          const bounces = budget.commit(id);
          if (bounces > MAX_AUTOMATIC_BOUNCES) {
            budget.reset(id);
            return;
          }
          const prompt = await retryingUserParts(client, id, directory);
          if (!prompt || prompt.parts.length === 0) return;
          await client.session.abort({ path: { id }, ...dirQuery });
          await client.session.promptAsync({
            path: { id },
            body: { parts: prompt.parts, ...(prompt.agent ? { agent: prompt.agent } : {}), ...(prompt.model ? { model: prompt.model } : {}) },
            ...dirQuery,
          });
        } catch (err) {
          console.error(`[retry-now] auto-cap: failed to retry session ${id}:`, err);
        } finally {
          budget.release(id);
        }
      }
    ```
    (`budget.release` requires todo 3.1 to have landed first — Wave 5 depends on Wave 3.) Then extend the returned hooks object (currently only `"command.execute.before"`, lines 170-226) with `event` and `dispose`:
    ```ts
    event: async ({ event }) => {
      try {
        if (event.type === "session.status") {
          const { sessionID, status } = event.properties;
          if (status.type === "busy") clearRetryTimer(sessionID);
          else if (status.type === "idle") {
            clearRetryTimer(sessionID);
            if (!budget.surviveTransientIdle(sessionID)) budget.reset(sessionID);
          } else if (status.type === "retry") {
            scheduleRetry(sessionID, status);
          }
        } else if (event.type === "session.idle") {
          const { sessionID } = event.properties;
          clearRetryTimer(sessionID);
          if (!budget.surviveTransientIdle(sessionID)) budget.reset(sessionID);
        }
      } catch (err) {
        console.error("[retry-now] event handler error:", err);
      }
    },
    dispose: async () => {
      for (const id of retryTimers.keys()) clearRetryTimer(id);
      budget.clear();
    },
    ```
    Also add `clearRetryTimer(input.sessionID)` (and for each remote session ID) inside the existing `command.execute.before` handler right before its `abort` calls, so a manual `/retry-now` cancels any pending auto-cap timer instead of leaving a stale one armed.
  - **Must NOT do:** Do NOT call `client.session.status()` synchronously during the plugin factory body (i.e., before `return {...}` / outside the `event`/`command.execute.before` hooks) — PR #3 documents this deadlocks OpenCode 1.18.9's per-instance bootstrap lock (verified regression test in PR #3: "initializes without calling session status during plugin startup"). All status fetches in this todo already happen lazily inside `fireRetry`/`command.execute.before`, which is safe — do not add any new top-level `await client.session.status(...)` call.
  - **Parallelization:** Single file (`src/index.ts`), depends on Wave 3.1 (`BounceBudget.release`) and Wave 4 (line numbers in this file). Run after Wave 4 completes. Not parallelizable with 4.1-4.3 (same file, dependent edits).
  - **References:** `src/index.ts:40-50` (existing re-exports), `src/index.ts:167` (factory signature), `src/retry-cap.ts` (all helpers), `src/v2.ts:236-330` (V2's equivalent state machine — port the same logic, V1 event shape differs: `properties` not `data`, Fact F20), Fact F19, F20, F21.
  - **Recommended task executor category:** `executor` (largest, most state-machine-heavy todo in the plan; requires careful port from V2's proven pattern).
  - **Acceptance criteria:** `npx tsc --noEmit` exits 0. `grep -n '"event":' src/index.ts` → 1 match. `grep -n '"dispose":' src/index.ts` → 1 match. `grep -n 'options)' src/index.ts` → the factory signature includes a 2nd parameter.
  - **QA scenarios:** Port the equivalent subset of `test/v2-plugin.test.ts`'s auto-cap tests (arm boundary, usage-limit exclusion, drift no-op, bounce-budget-stops-after-3, transient-idle-survives, dispose-clears-timers) into `test/retry-now-plugin.test.ts` using V1's `event: async ({event}) => ...` shape (`event.properties.sessionID`/`event.properties.status`, not `event.data`) and fake timers (`vi.useFakeTimers()`). Minimum: 8 new test cases covering arm/no-arm at the cap+margin boundary, usage-limit exclusion, bounce budget exhaustion at exactly 3, and `dispose()` clearing all timers. Run `npx vitest run test/retry-now-plugin.test.ts` — all new tests pass, 0 regressions in the pre-existing ones.
  - **Commit:** `feat(v1): add auto-cap retry timer with bounce budget (V1 parity with V2, matches PR #3 intent)`

- [ ] **5.2 Update `README.md`: document V1 auto-cap support and its config format.**
  - **What to do:** In `README.md`, after the "### V1 limitation" heading and paragraph (lines 111-113, already rewritten by todo 1.2), add a "### V1 configuration" subsection showing the correct V1 tuple config format (per `@opencode-ai/plugin`'s existing array-of-`[path, options]`-tuples convention, matching the V1 example already at `README.md:26-34` but extended with options):
    ```markdown
    ### V1 configuration

    \`\`\`json
    {
      "plugin": [
        ["file:///absolute/path/to/opencode_retrypush/dist/index.js", { "maxRetryWaitMs": 60000 }]
      ]
    }
    \`\`\`
    ```
    Update the "Auto-Cap (Automatic Retry Budget)" section intro (line 91, "The V2 adapter arms its own retry timer...") to say "Both the V1 and V2 adapters arm their own retry timer...".
  - **Must NOT do:** Do not remove the "### Guardrails" section (lines 115-119) — it applies to both adapters unchanged.
  - **Parallelization:** Depends on 5.1 being functionally complete (don't document a feature before it exists) and 1.2 (which already touched this file's nearby lines) — sequential after both.
  - **References:** `README.md:89-113`, `node_modules/@opencode-ai/plugin` config convention (array-of-tuples, confirmed via PR #3's own README diff during fact-gathering).
  - **Recommended task executor category:** `junior`.
  - **Acceptance criteria:** `README.md` contains a `### V1 configuration` heading. `grep -c 'Both the V1 and V2 adapters' README.md` → `1`.
  - **QA scenarios:** Visual read-through: the V1 config JSON block must be valid JSON (`node -e "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'))"` fed the extracted block, or manually verify balanced braces/brackets).
  - **Commit:** `docs(readme): document V1 auto-cap configuration`

---

### Wave 6 — Final verification

- [ ] **6.1 Full-suite verification after all waves land.**
  - **What to do:** Run, in order: `cd /home/openchamber/workspaces/opencode_retrypush && npx tsc --noEmit` (expect exit 0), `npx vitest run` (expect all tests passing, count ≥ 92 + new tests added across todos 2.1-2.3, 3.1-3.4, 4.1-4.2, 5.1 — approximately 110-120 total), `npm pack --dry-run` (expect it to list `dist/**` and `commands/**` files only, and to succeed without attempting to resolve `/tmp/tgz/*.tgz`, confirming todo 1.1 actually fixed the broken dependency).
  - **Must NOT do:** Do not skip any of the three commands. Do not mark this todo done if `tsc --noEmit` or `vitest run` report any failure — go back to the relevant wave's todo and fix it first.
  - **Parallelization:** Sequential, last todo in the plan — depends on every prior wave.
  - **References:** `package.json:9-11` (scripts), Wave 0's baseline (0.1) for comparison.
  - **Recommended task executor category:** `junior`.
  - **Acceptance criteria:** `npx tsc --noEmit` exits 0 with empty output. `npx vitest run` prints `Test Files  N passed (N)` and `Tests  M passed (M)` with zero failed/skipped. `npm pack --dry-run` exits 0.
  - **QA scenarios:** `npx tsc --noEmit; echo "TSC_EXIT:$?"` → `TSC_EXIT:0`. `npx vitest run 2>&1 | grep -E 'failed|Tests.*passed'` → only a `passed` line, no `failed` line. `npm pack --dry-run 2>&1 | tail -20` → no `ENOENT`/`tgz` errors.
  - **Commit:** none (verification only — if fixes are needed, they belong to the earlier wave's todo, not a new commit here).

## Execution notes for sub-agents

- Run all shell commands via `mcp__oc__pty_spawn(command="bash", args=["-lc", "<command>"])`
  then `mcp__oc__pty_read(id="<returned id>")`. Use `read`/`write`/`edit` MCP tools for file
  edits, never raw shell redirection for source files.
- Every `grep -n` acceptance check in this plan should be run from
  `/home/openchamber/workspaces/opencode_retrypush` as the working directory.
- If any `Acceptance criteria` grep/tsc check fails after an edit, the edit is incomplete — do
  not proceed to the next todo in the wave until it passes.

## Critic review

- **Verdict:** [OKAY] — no blockers.
- **Rounds:** 1 (no revisions needed).
- **Scope of verification:** the critic spot-checked every Reference Fact Table row against the
  live repo and installed `node_modules` type declarations, and confirmed the Wave 0 baseline
  reproduces exactly (`tsc --noEmit` exit 0, `Test Files 3 passed (3)`, `Tests 92 passed (92)`).
  All 12 implementation todos were confirmed to carry executable QA scenarios (concrete
  `tsc`/`vitest`/`grep` commands with expected output, no vague verification language).
- **Findings confirmed exact:** `src/index.ts:167/179/195-197/209-224` and the duplicate JSDoc
  at `68-75` vs `82-89` (F13-F17); `src/v2.ts:67-74, 76-85, 99-103, 180-186, 211-234, 290-304,
  307-330, 333-362, 382-390, 396-421` (F1-F8); `src/retry-cap.ts:46-55/94-99/110-149` incl. the
  `isUsageLimit` regex and `commit()`'s missing release path (F10-F12); `package.json:29-32/45-48`
  broken `/tmp/tgz` dependencies (F22/F23); external type facts (`SessionPromptInput.text:
  string` + sibling `files`, `SessionSwitchAgentInput`/`SessionSwitchModelInput`, top-level
  `Context.options`, `subscribe(options?: {signal?})`, the `V2Event` union's real
  `session.execution.failed`/`interrupted` members and absence of `session.error`, V1
  `Hooks.event`/`dispose` and `Plugin = (input, options?) => Promise<Hooks>`, V1
  `Config.plugin: Array<string | [string, PluginOptions]>`) all verified against installed
  `@opencode/plugin` 2.0.16 / `@opencode-ai/plugin` 1.18.32; `test/v2-plugin.test.ts:72-82` is
  exactly the test codifying the wrong prompt contract, as claimed.
- **Non-blocking notes (no action required, recorded for transparency):** the draft originally
  lived only in `.omo/drafts/` (now also copied here, per the approval gate); todo 1.2's
  prescribed README wording references V1 auto-cap one wave before 5.1 actually lands
  (self-flagged inside the todo itself, intentional ordering — README wording is generic enough
  not to overclaim); 5.2's QA scenario is a manual JSON-validity read-through (the weakest single
  QA scenario in the plan, but still a concrete, executable check); the original draft's
  "Execution notes" section claimed no `bash` tool exists in this environment — corrected in this
  final copy to describe running shell commands via `pty_spawn`/`pty_read` without the incorrect
  claim, since it does not change how any todo is executed.
</content>
