---
title: RetryPush — fix all findings from the code review (loader, V2 API, reliability, docs)
slug: retrypush-review-round3
status: proposed
created: 2026-09-29
revised: 2026-09-29 (round 4 — loader mechanics, V2 events, prompt payloads re-verified against source)
scope: src/**, test/**, package.json, README.md, USAGE.md
---

# Goal

The plugin does not load on either OpenCode major, and several behaviours are wrong.
Fixes serve three goals in priority order:

1. Make the package **load** on V1 and V2 (blockers).
2. Make the V2 adapter **correct** against the real V2 API (high).
3. Make behaviour **bounded and documented** (medium/low).

Non-goal: the AGENTS.md feature (a "Retry Now" *button* / Enter-on-empty-prompt) is out of
scope; it is recorded as an open item, not built here.

---

## §0. Verified API reference

Everything below was read out of published tarballs and upstream source on 2026-09-29.
Upstream files were fetched from **`sst/opencode` branch `dev`** (`anomalyco/opencode` `main`
returns 404 for these paths).

### 0.1 How a **V1** host loads a plugin

`packages/opencode/src/util/record.ts`:
```ts
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
```
Note: `typeof fn === "function"`, so **a function is not a record**.

`packages/opencode/src/plugin/shared.ts`:
```ts
export function readV1Plugin(mod, spec, kind, mode = "strict") {
  const value = mod.default
  if (!isRecord(value)) { if (mode === "detect") return; throw new TypeError(...) }
  if (mode === "detect" && !("id" in value) && !("server" in value) && !("tui" in value)) return
  const server = "server" in value ? value.server : undefined
  const tui = "tui" in value ? value.tui : undefined
  if (server !== undefined && typeof server !== "function") throw TypeError("invalid server export")
  if (tui !== undefined && typeof tui !== "function") throw TypeError("invalid tui export")
  if (server !== undefined && tui !== undefined) throw TypeError("must export either server() or tui(), not both")
  if (kind === "server" && server === undefined) throw TypeError("must default export an object with server()")
  if (kind === "tui" && tui === undefined) throw TypeError(...)
  return value
}
export async function resolvePluginId(source, spec, target, id, pkg) {
  if (source === "file") { if (id) return id; throw new TypeError(`Path plugin ${spec} must export id`) }
  if (id) return id
  ...
}
export async function checkPluginCompatibility(target, opencodeVersion, pkg) {
  if (!semver.valid(opencodeVersion) || semver.major(opencodeVersion) === 0) return
  const hit = pkg ?? (await readPluginPackage(target).catch(() => undefined)); if (!hit) return
  const engines = hit.json.engines; if (!isRecord(engines)) return
  const range = engines.opencode; if (typeof range !== "string") return
  if (!semver.satisfies(opencodeVersion, range)) throw new Error(`Plugin requires opencode ${range} but running ${opencodeVersion}`)
}
```
`checkPluginCompatibility` reads **only** `engines.opencode`, via `semver.satisfies`.
`engines.node` is never read. **It is also skipped entirely for `source === "file"`**
(see `plugin/loader.ts`: "file plugins are treated as local development code and skip this
compatibility gate"), so a local `file://` install is never version-gated.

`packages/opencode/src/plugin/index.ts`:
```ts
function isServerPlugin(value) { return typeof value === "function" }
function getServerPlugin(value) {
  if (isServerPlugin(value)) return value
  if (!value || typeof value !== "object" || !("server" in value)) return
  if (!isServerPlugin(value.server)) return
  return value.server
}
function getLegacyPlugins(mod) {
  const seen = new Set(); const result = []
  for (const entry of Object.values(mod)) {
    if (seen.has(entry)) continue
    seen.add(entry)
    const plugin = getServerPlugin(entry)
    if (!plugin) throw new TypeError("Plugin export is not a function")
    result.push(plugin)
  }
  return result
}
async function applyPlugin(load, input, hooks) {
  const plugin = readV1Plugin(load.mod, load.spec, "server", "detect")
  if (plugin) {
    await resolvePluginId(load.source, load.spec, load.target, readPluginId(plugin.id, load.spec), load.pkg)
    hooks.push(await (plugin as PluginModule).server(input, load.options))
    return
  }
  for (const server of getLegacyPlugins(load.mod)) hooks.push(await server(input, load.options))
}
```

**The decisive fact:** the only `readV1Plugin` call in the server package is hardcoded
`kind: "server"`. If `mod.default` is an object carrying `id` + `server`, the detect path
succeeds and **`getLegacyPlugins` never runs — named exports are never inspected.**

### 0.2 How a **V2** host loads a plugin

`packages/core/src/config/plugin/external.ts`:
```ts
const PluginModule = Schema.Struct({
  default: Schema.Union([
    Schema.Struct({ id: Schema.String, effect: <fn> }),
    Schema.Struct({ id: Schema.String, setup: <fn> }),
  ]),
})
for (const ref of configured) {
  const entrypoint = path.isAbsolute(ref.package) ? pathToFileURL(ref.package).href : (yield* npm.add(ref.package)).entrypoint
  if (!entrypoint) return
  const mod = yield* Effect.promise(() => import(entrypoint))
  const value = (yield* Schema.decodeUnknownEffect(PluginModule)(mod)).default
  const plugin = "effect" in value ? value : PluginPromise.fromPromise(value)
  yield* ctx.plugin.add({ id: plugin.id, effect: (host) => plugin.effect({ ...host, options: ref.options ?? {} }) })
}
```
- V2 reads **`mod.default` only**. Named exports are irrelevant.
- `id: Schema.String` is **required**.
- Either an `effect` fn or a `setup` fn is required.
- `Schema.Struct` strips excess keys (only `Schema.exact` rejects), so `{ id, server, setup }`
  matches branch 2 — branch 1 fails (no `effect`), branch 2 succeeds, `server` is stripped.

### 0.3 The dual export, proven

A single default export of shape **`{ id, server, setup }`** satisfies both hosts:

| Host | Path taken | Why |
|---|---|---|
| V1 | `readV1Plugin(mod, spec, "server", "detect")` → object | `isRecord` ✓; has `id` and `server`; `server` is a fn; `tui` absent so no "either/or" throw → returns value → `plugin.server(input, options)`; `resolvePluginId("file", …, id)` satisfied by `id` |
| V2 | union branch 2 | `id` is a string, `setup` is a function; `server` stripped as excess |

`id` is mandatory on both sides (`resolvePluginId` throws `Path plugin … must export id` for
file plugins; V2 requires `Schema.String`).

**Open question, flagged not guessed:** `readV1Plugin` also has a `kind === "tui"` branch that
would throw on `{id, server, setup}`. The TUI consumes plugins over RPC (its fixture imports
`createOpencodeClient` and `HostPluginApi`, not the module directly), and the server package
only ever resolves `kind: "server"`, so this should not be hit. Task 1.4 includes a test that
asserts the server-kind path; the tui-kind question is listed in Appendix B as a
verify-in-the-wild item rather than asserted as safe.

### 0.4 `Plugin.define` is the identity function

`@opencode/plugin@2.0.16` `dist/effect/plugin.js` and `dist/promise/plugin.js` both literally:
```js
export function define(plugin) { return plugin; }
```
⇒ **No dynamic `import("@opencode/plugin")` is needed** to build the V2 definition. A literal
`{ id, setup }` object plus a type-only import is sufficient.

### 0.5 V2 events — `@opencode/client@2.0.16` `dist/promise/generated/types.d.ts`

> **Correction vs. round 3.** `event.subscribe()` returns `AsyncIterable<V2Event>` from
> `@opencode/client`, whose union is a **superset** of the `SessionEventDurable` union in
> `@opencode/schema/dist/session-event.d.ts`. Round 3 consulted the schema union and wrongly
> concluded that `session.status` and `session.idle` do not exist. **They do.**

```ts
export type SessionStatusUpdated = { id; created; metadata?; type: "session.status"; location?;
  data: { sessionID: string; status: SessionStatus } }
export type SessionIdle = { id; created; metadata?; type: "session.idle"; location?;
  data: { sessionID: string } }
export type SessionStatus =
  | { type: "idle" }
  | { type: "retry"; attempt: number; message: string;
      action?: { reason: string; provider: string; title: string; message: string; label: string; link?: string };
      next: number }
  | { type: "busy" }
export type SessionStructuredError = { type: string; message: string; status?: number }
```

`SessionStatus.retry` carries **`action`** and **`next`**. `session.retry.scheduled` does not:
```ts
data: { sessionID: string; assistantMessageID: string; attempt: number; at: number;
        error: SessionStructuredError }
```
⇒ Rebuilding the retry state from `session.retry.scheduled` would **lose `action`**, which is
exactly what `isUsageLimit` (`src/retry-cap.ts:94-99`) keys on to refuse auto-retrying a
usage limit. The existing `session.status`-driven cache is the correct design. **Round 3's
2.2 is dropped.**

Also present: `session.execution.{started,succeeded,failed,interrupted}`, `session.deleted`.

### 0.6 V2 prompt input vs. message attachments — **not** pass-through

> **Correction vs. round 3.** Round 3 claimed the two shapes are identical. They are not, and
> round 3's snippet would not compile.

Input side:
```ts
export type SessionPromptInput = {
  readonly sessionID: SessionID;
  readonly text: string;                                     // ← a string, not an object
  readonly files?:  ReadonlyArray<{ uri: string; name?: string; description?: string; mention?: PromptMention }>;
  readonly agents?: ReadonlyArray<{ name: string; mention?: PromptMention }>;
  readonly skills?: ReadonlyArray<{ id: string; mention?: PromptMention }>;
}
```
Message side:
```ts
export type SessionMessageUser = { id; metadata?; time:{created}; text: string;
  files?: Array<PromptFileAttachment>; agents?: Array<PromptAgentAttachment>;
  skills?: Array<PromptSkillAttachment>; type: "user" }
export type PromptFileAttachment = { data: PromptBase64; mime: string; source: PromptFileSource;
  name?: string; description?: string; mention?: PromptMention }
export type PromptFileSource = { type: "inline" } | { type: "uri"; uri: string }
export type PromptSkillAttachment = { id: string; name: string; text?: string; mention?: PromptMention }
```
⇒ Input files want `{ uri }`; message files have `{ data, mime, source }` and **no `uri`**.
The existing call `prompt({ sessionID, text, files: [{ uri, … }] })` is **already
shape-correct**. The real bug is in `toSharedFileAttachment`, which reads `file.uri` off a
message attachment where that field does not exist.

### 0.7 V1 events — `@opencode-ai/sdk@1.18.32` `dist/gen/types.gen.d.ts`

```ts
export type EventSessionDeleted = { type: "session.deleted"; properties: { info: Session } }
export type EventSessionError  = { type: "session.error";
  properties: { sessionID?: string; error?: ProviderAuthError | UnknownError | … } }
```
⇒ `session.deleted` carries the id at **`properties.info.id`**, not `event.sessionID`.
`session.error` has an **optional** `sessionID?`.

### 0.8 V1 config key and types — `@opencode-ai/plugin@1.18.32` `dist/index.d.ts`
```ts
export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>;
export type PluginModule = { id?: string; server: Plugin; tui?: never };
export type PluginOptions = Record<string, unknown>;
export type Config = Omit<SDKConfig, "plugin"> & { plugin?: Array<string | [string, PluginOptions]> };
```
V1 key is `plugin` (singular); values are `string | [string, PluginOptions]`. V2 key is
`plugins` (plural); values are `string | { package: string; options?: Record<string, unknown> }`.

### 0.9 V2 session API — no `status` method
`SessionDomain = Pick<SessionApi, "create"|"get"|"switchAgent"|"switchModel"|"prompt"|"generate"|
"command"|"synthetic"|"interrupt"|"update"|"move"|"wait"|"context"> & { hook }`. There is no
`session.status()` method — **but the current code never calls one; it reads the cache.** So
this is not a defect. `session.active()` returns a two-state `{ [sessionID]: { type: "running" } }`
map and is not a substitute.

---

## Phase 0 — Restore the dev environment (blocks every verification step)

`node_modules/@opencode/` and `node_modules/@opencode-ai/` are **empty directories**.
`tsc --noEmit` fails with TS2307 and `vitest` is unusable, so no typecheck or test result from
this repo is currently evidence of anything. (LSP diagnostics reporting
`Cannot find name 'Record'` / `'Promise'` are artifacts of this, not code errors.)

| # | Task | Acceptance |
|---|------|-----------|
| 0.1 | `rm -rf node_modules && npm ci` | exit 0. Do **not** delete `package-lock.json` — it is gitignored and may be the only reproducible lock; if `npm ci` fails because it is out of sync, fall back to `npm install` and say so. |
| 0.2 | Assert the peer packages landed | `ls -la node_modules/@opencode-ai/plugin/dist/index.d.ts node_modules/@opencode/plugin/dist/promise/plugin.d.ts` — both non-empty. Note `@opencode-ai/plugin` is pinned in `devDependencies` by **tarball URL**, so a registry-only mirror will not serve it. |
| 0.3 | `npx tsc --noEmit` | exit 0 |
| 0.4 | `npx vitest run --reporter=dot` (timeout 180s) | exit 0 **and it terminates** — the previous run hung and had to be killed |
| 0.5 | Record resolved versions in this file | see the Environment block below |

**Environment (fill in during execution):**
```
@opencode-ai/plugin: <resolved>
@opencode/plugin:    <resolved>
@opencode-ai/sdk:    <resolved>
node:                <version>
```

If 0.2 cannot pass, **stop** and report — nothing later is verifiable.

---

## Phase 1 — Make the package load

> **This phase replaces round 3's Phase 1 wholesale.** The round-3 design (dynamic
> `import("@opencode/plugin")` at runtime, attaching a `Plugin` property asynchronously onto a
> function-shaped default export) was wrong on three counts: `define` is the identity function
> so no runtime import is needed; `isRecord(fn)` is false so a function-shaped default export
> skips the detect path entirely; and an asynchronously attached property is not part of either
> API.

### 1.1 Blocker 3 — make the `@opencode/plugin` import type-only

`src/v2.ts:12` is a **value** import (`import * as V2PluginNamespace from "@opencode/plugin"`),
and `src/index.ts:22` statically imports `./v2.js`. A V1-only install with no
`@opencode/plugin` on disk therefore throws `ERR_MODULE_NOT_FOUND` when opencode imports
`dist/index.js` — before our plugin is ever called. This is the real blocker 3; the fix is
minimal, not a dynamic-import wrapper.

```ts
// src/v2.ts — replace L12 and L27
import type { CommandDefinition, CommandInvocation } from "@opencode/plugin"   // erased at build

export const v2Setup = async (ctx: unknown): Promise<() => Promise<void>> => { /* …existing body… */ }
```

`Plugin.define` is `plugin => plugin` (§0.4), so the exported V2 definition is a plain
`{ id, setup }` literal. Nothing from `@opencode/plugin` is needed at runtime.

**Acceptance:** `mv node_modules/@opencode/plugin /tmp/ && node -e "import('./dist/index.js')"`
exits 0 and prints the default export's shape; then restore the directory.

### 1.2 Blockers 1 & 2 — default-export an object, drop the named exports

Round 3 proposed `Object.assign(v1Plugin, { id, server })`. **That does not work:** a function
is not `isRecord`, so `readV1Plugin` returns `undefined` in detect mode, the loader falls into
`getLegacyPlugins`, and the attached properties are dead. The correct form is the official
`PluginModule` shape (§0.1) as a plain object:

```ts
// src/index.ts — bottom of file
const plugin = {
  id: "opencode-retry-now-plugin",
  server: v1Plugin,          // V1: readV1Plugin(…, "server", "detect") → plugin.server(input, options)
  setup: v2Setup,            // V2: PluginModule union branch 2 → PluginPromise.fromPromise
}
export default plugin
```

And delete, from the same file:
- `export { v2Plugin as v2 }` (L37) — the object named export that is not a function.
- The nine re-exports at L47-57 (`DEFAULT_MAX_RETRY_WAIT_MS`, `RETRY_MIN_REMAINING_MS`,
  `MAX_AUTOMATIC_BOUNCES`, `parseMaxRetryWaitMs`, `armMargin`, `shouldAutoCap`, `hasDrift`,
  `isUsageLimit`, `BounceBudget`).
- The stale header comment at L1-10 that documents `export { v2 }`.

**Honest scoping of this fix.** With the object form, `getLegacyPlugins` is never reached, so
the named exports are *not* what breaks loading — the **function-shaped default export** is
(§0.1). Removing the named exports is still correct: it keeps the module namespace clean, and
it removes a latent trap should any future loader version fall back to the legacy path. But it
is **hygiene, not the fix**; round 3 mislabelled it.

Keep the helpers importable for consumers and tests via a subpath export:
```json
"exports": {
  ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
  "./retry-cap": { "types": "./dist/retry-cap.d.ts", "import": "./dist/retry-cap.js" },
  "./shared": { "types": "./dist/shared.d.ts", "import": "./dist/shared.js" },
  "./package.json": "./package.json"
}
```
Audit the two test files that import helpers from the entrypoint rather than from
`src/retry-cap.js` and repoint them.

**Acceptance:** `Object.keys(await import('./dist/index.js')).join(',') === 'default'`, and
`mod.default` is a non-null object with string `id` and function `server`.

### 1.3 A regression test that models **both** loader stages

Round 3's test only reproduced `getLegacyPlugins`, so it would not have caught the actual
failure (a function default export). Model the real sequence:

```ts
// test/loader.test.ts
import { describe, expect, it } from "vitest"

// Mirrors packages/opencode/src/util/record.ts
const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v)

// Mirrors readV1Plugin() from packages/opencode/src/plugin/shared.ts
function readV1Plugin(mod: Record<string, unknown>, kind: "server" | "tui", mode: "detect" | "strict") {
  const value = mod.default
  if (!isRecord(value)) { if (mode === "detect") return undefined; throw new TypeError("not a record") }
  if (mode === "detect" && !("id" in value) && !("server" in value) && !("tui" in value)) return undefined
  const server = "server" in value ? value.server : undefined
  const tui = "tui" in value ? value.tui : undefined
  if (server !== undefined && typeof server !== "function") throw new TypeError("invalid server export")
  if (tui !== undefined && typeof tui !== "function") throw new TypeError("invalid tui export")
  if (server !== undefined && tui !== undefined) throw new TypeError("must export either server() or tui(), not both")
  if (kind === "server" && server === undefined) throw new TypeError("must default export an object with server()")
  if (kind === "tui" && tui === undefined) throw new TypeError("must default export an object with tui()")
  return value
}

// Mirrors getLegacyPlugins() from packages/opencode/src/plugin/index.ts
function getLegacyPlugins(mod: Record<string, unknown>) {
  const getServerPlugin = (value: unknown) =>
    typeof value === "function" ? value
    : value && typeof value === "object" && "server" in value && typeof (value as any).server === "function"
      ? (value as any).server : undefined
  const out: unknown[] = []
  for (const entry of Object.values(mod)) {
    const plugin = getServerPlugin(entry)
    if (!plugin) throw new TypeError("Plugin export is not a function")
    out.push(plugin)
  }
  return out
}

describe("V1 loader conformance", () => {
  it("takes the detect path, so named exports are never inspected", async () => {
    const mod = await import("../src/index.js")
    expect(readV1Plugin(mod, "server", "detect")).toBe(mod.default)
  })

  it("default export carries a string id and a function server", async () => {
    const mod = await import("../src/index.js")
    expect(typeof (mod.default as any).id).toBe("string")
    expect(typeof (mod.default as any).server).toBe("function")
  })

  it("a bare function default export would NOT be detected (regression guard)", () => {
    // Documents the exact failure mode we are fixing.
    expect(readV1Plugin({ default: () => {}, extra: 1 }, "server", "detect")).toBeUndefined()
    expect(() => getLegacyPlugins({ default: () => {}, extra: 1 })).toThrow(/not a function/)
  })

  it("the module namespace exposes nothing but the default export", async () => {
    const mod = await import("../src/index.js")
    expect(Object.keys(mod)).toEqual(["default"])
  })
})

describe("V2 loader conformance", () => {
  it("default export matches the { id, setup } branch of PluginModule", async () => {
    const mod = await import("../src/index.js")
    const d = mod.default as any
    expect(typeof d.id).toBe("string")
    expect(typeof d.setup).toBe("function")
  })
})
```

**Acceptance:** this file **fails on the pre-fix tree and passes after Phase 1.** Record both
results in this plan — a test that never failed is not evidence.

### 1.4 Fix the README install instructions (Blocker 4)

`README.md:26-63` is wrong. Replace with:

```jsonc
// OpenCode 1.x (V1) — key is "plugin"; options need the tuple form
{ "plugin": ["file:///abs/path/to/dist/index.js"] }
{ "plugin": [["file:///abs/path/to/dist/index.js", { "maxRetryWaitMs": 60000 }]] }
```
```jsonc
// OpenCode 2.x (V2) — key is "plugins"; object form needs "package" + "options"
{ "plugins": [{ "package": "file:///abs/path/to/dist/index.js", "options": {} }] }
```
Also:
- Delete the `### V1 configuration` section that uses `"plugins"` — it contradicts the section
  above it.
- Replace the "default export = V1 / named export `v2` = V2" table with the single
  `{ id, server, setup }` default export, stating that the same `dist/index.js` serves both.
- Note that a `file://` install requires the `id` export (§0.1) and that local file plugins
  skip the `engines.opencode` gate (§0.1) — so `engines` only protects npm installs.

**Acceptance:** every JSON snippet parses, uses the correct key for its major, and the two
snippets per major differ only in the options object.

---

## Phase 2 — V2 correctness

> Round 3's 2.2 (rebuild retry state from `session.retry.scheduled`) is **removed**: it would
> drop `SessionStatus.retry.action` (§0.5), which is the field `isUsageLimit` uses to refuse
> auto-retrying a usage limit. The existing `session.status`-driven cache is correct.

### 2.1 `execute` must accept the `CommandInvocation` (High 1 — confirmed)

`src/v2.ts` registers `execute: async () => { … }` and then guesses which sessions are
retrying. The real signature is
`execute: (input: { sessionID, prompt, delivery }) => Promise<void>`.

```ts
await ctx.command.transform((editor) => {
  editor.add({
    name: "retry-now",
    description: "Immediately retry a request waiting on a rate limit countdown",
    execute: async (input: CommandInvocation) => { await client.retryNow(input.sessionID) },
  } satisfies CommandDefinition)
})
```
Delete the local `V2CommandTransformer` / `V2Command` interfaces in favour of the SDK types so
a future SDK change breaks the build rather than silently mis-binding.

**Acceptance:** `tsc --noEmit` passes; a test asserts the plugin forwards `input.sessionID`.

### 2.2 Prune the status cache; add `session.execution.*` cleanup (Medium)

Keep `session.status` and `session.idle` as the primary state source. Two real defects remain
in the existing code:

- `getStatuses()` does `structuredClone(this.statusCache)` on **every** call, and entries for
  idle sessions are never removed, so the cache grows without bound.
- Only `session.status` / `session.idle` / `session.deleted` are handled; a session that dies
  through `session.execution.failed` / `.interrupted` keeps a stale retry entry and an armed
  auto-cap timer.

Fix: delete the entry on every terminal event, and drop the clone.
```ts
getStatuses(): Record<string, SessionStatus> {
  return { ...this.statusCache }          // shallow copy; values are never mutated
}
```
Event table:

| Event | Action |
|-------|--------|
| `session.status` | `status === "retry"` → store + `scheduleAutoRetry`; otherwise clear timer, delete entry, `budget.release` |
| `session.idle` | clear timer, delete entry, apply the budget rule (see 3.5 for polarity) |
| `session.execution.{started,succeeded,failed,interrupted}` | clear timer, delete entry, `budget.release` |
| `session.deleted` | clear timer, delete entry, `budget.reset` |

**Acceptance:** a test drives `session.retry.scheduled`-less flow: `session.status` retry →
entry present; then `session.execution.started` → entry gone and timer cleared. A second test
asserts `getStatuses()` is not the same object as the internal cache and that entries are
removed (cache size does not grow across 100 idle/status events).

### 2.3 Stop reading `msg.info` — V2 messages are flat (High — confirmed)

`src/v2.ts:157-162` reads `msg.info?.agent` / `msg.info?.model`. `SessionMessageUser` and
`SessionMessageAssistant` have **no `info` field**; the assistant carries `agent: string` and
`model: ModelRef` at the top level, and the user message carries **no agent/model at all** —
in V2 that is session-level state.

Fix `toSharedMessage`:
- Derive `role` from `msg.type`, not from an `info.role`.
- Read `agent` / `model` from `msg.agent` / `msg.model` when present (assistant only).
- Do **not** try to synthesise agent/model for the user message — see 2.4.
- Preserve `agents` and `skills` as `AgentPart` / `SubtaskPart` instead of dropping them, so a
  replayed subagent request keeps its sub-agent.
- For the retry anchor: `session.status` carries no message id, so the existing fallback in
  `shared.ts:retryingUserParts` (walk back to the last user message) is the only option here.
  Record this as a known limitation — it can pick the wrong user message when a session has
  several. `session.retry.scheduled` carries `assistantMessageID`, but using it would require
  re-introducing the `action`-losing rewrite rejected in the header of this phase. **Leave the
  fallback, note the limitation.**

**Acceptance:** a test constructs a flat `SessionMessageAssistant` with top-level
`agent`/`model` and asserts `toSharedMessage` surfaces them; a test constructs a
`SessionMessageUser` with `agents: [{ name: "reviewer" }]` and asserts an `agent` part comes
through.

### 2.4 Stop permanently switching the session's agent/model (High 5)

`src/v2.ts:208-238` calls `ctx.session.switchAgent(...)` and `ctx.session.switchModel(...)`
before `ctx.session.prompt(...)`. Both mutate **durable session state**: after one
`/retry-now` the user's session is permanently pointed at whatever agent/model the replayed
message used.

`SessionPromptInput` has no per-prompt agent/model override (§0.6), so the prompt uses the
session's current selection. The correct behaviour is:
- **Do not call `switchAgent` / `switchModel` at all.**
- If the replayed assistant record names a different agent/model than the session's current
  selection, log a warning and replay under the current selection. Silently changing the
  user's session is worse than replaying with their own model.

**Acceptance:** grep for `switchAgent` / `switchModel` in `src/v2.ts` returns nothing; a test
asserts the V2 retry path issues exactly `interrupt` + `prompt` and no other session call.

### 2.5 Fix the attachment mapping (High 6) — real bug, wrong location

Round 3 claimed message attachments and prompt-input attachments are identical and proposed
`prompt({ sessionID, text: { text, files } })`. Both halves are wrong (§0.6). The existing call
`prompt({ sessionID, text, files: [{ uri, … }] })` is already shape-correct; the defect is that
`toSharedFileAttachment` reads `file.uri` off a message attachment, where there is no `uri`.

Correct mapping, message → input:

```ts
// src/v2.ts
function toPromptFiles(files: PromptFileAttachment[] | undefined): Array<{
  uri: string; name?: string; description?: string; mention?: PromptMention
}> {
  const out: Array<{ uri: string; name?: string; description?: string; mention?: PromptMention }> = []
  for (const f of files ?? []) {
    if (f.source.type === "uri") {
      out.push({ uri: f.source.uri, name: f.name, description: f.description, mention: f.mention })
      continue
    }
    // source.type === "inline" carries base64 `data` + `mime`; SessionPromptInput has no
    // inline representation, so it cannot be replayed as-is.
    warn("retry-now: dropping inline attachment on replay; it cannot be represented in SessionPromptInput")
  }
  return out
}

function toPromptSkills(skills: PromptSkillAttachment[] | undefined) {
  // input wants { id, mention } only; message carries { id, name, text?, mention? }
  return (skills ?? []).map((s) => ({ id: s.id, mention: s.mention }))
}
```

**Decision needed (flagged, not silently chosen):** inline attachments are not replayable
without inventing a `data:` URI. Two options —
(a) drop them with a warning (above), or
(b) synthesise `data:${mime};base64,${data}`. Option (b) is lossless but can push a large blob
back through the prompt path. **Recommend (a)**; record the choice in the plan when made.

**Acceptance:** `tsc --noEmit` passes with no `as any` in the V2 prompt path; tests cover
`source.type === "uri"` pass-through, inline drop-with-warning, and skill narrowing.

### 2.6 Split the replay guard: manual vs. auto (High 2)

> **Correction vs. round 3.** Round 3 put one `replay()` behind both paths, with a
> `r.at - Date.now() < margin` early return. That would break manual `/retry-now`, which by
> design must work **regardless** of the remaining countdown (AGENTS.md). The margin guard
> belongs on the **auto-timer only**.
>
> Round 3's `hasDrift(r.scheduledAt, { attempt: r.attempt, next: r.at })` was also nonsense: it
> compared a number to an object, and compared a record against a copy of itself, so drift
> could never be detected.

Two distinct entry points:

```ts
// Manual /retry-now — the user asked; honour it unconditionally.
async retryNow(sessionID: string) {
  if (!this.statusCache[sessionID] || this.statusCache[sessionID].type !== "retry") return
  await this.replay(sessionID)
}

// Auto-cap timer — only fires when the guard genuinely says "the server is still holding us".
private async fireAutoRetry(sessionID: string) {
  const fresh = this.statusCache[sessionID]
  if (!fresh || fresh.type !== "retry") return
  if (hasDrift(this.scheduled.get(sessionID), fresh)) return      // compare SCHEDULED vs FRESH
  if ((fresh.next ?? 0) - Date.now() < this.margin) return
  if (isUsageLimit(fresh)) return
  await this.replay(sessionID)
}
```
`hasDrift(scheduled, actual)` needs a **stored copy of what the timer was armed with** to be
meaningful; store `{ attempt, next }` in a `scheduled` map when arming. The existing V1
implementation (`src/index.ts:194-223`) already does this correctly — mirror it.

**Acceptance:** tests for (a) manual path with `next - now < margin` → `interrupt` + `prompt`
still issued; (b) auto path with the same condition → not issued; (c) auto path with a changed
`attempt` → not issued; (d) auto path on a usage-limit status → not issued.

### 2.7 The reconnect loop (Low)

`initStatusCache()` uses a bare `catch {}`. Make it log once per reconnect at `warn` with the
error, keep the 1000→30000 ms backoff, and expose a `connected` flag so `fireAutoRetry` can
refuse to run while disconnected (a stale cache is exactly the TOCTOU hazard 2.6 fixes).

**Acceptance:** a test simulates a throwing `subscribe` and asserts the loop retries with
increasing backoff and logs.

---

## Phase 3 — Reliability and bounds

**Re-ranked vs. round 3.** 3.1 and 3.2 are downgraded (see the corrections), 3.3 is reframed as
a product decision, and 3.4/3.5 snippets are corrected.

### 3.1 `parseMaxRetryWaitMs` bounds — **Low**, not Medium

> **Correction vs. round 3.** Round 3 claimed `2**31` "silently becomes 1 ms" via Node's
> `setTimeout` clamp. That scenario cannot occur: `shouldAutoCap` requires the remaining time
> to exceed `cap + margin`, so a cap of `2**31` would need ~24.8 days of server-specified
> retry before the timer is even armed. The clamp concern is theoretical.

The bounds are still worth having — a user typo of `1` would make the auto-cap fire
immediately in a loop. Keep it, at Low priority:

```ts
export const MIN_AUTO_CAP_MS = 5_000
export const MAX_AUTO_CAP_MS = 86_400_000   // 1 day

export function parseMaxRetryWaitMs(options?: Record<string, unknown> | null): number | null {
  const raw = (options as any)?.maxRetryWaitMs
  if (raw === undefined || raw === null) return DEFAULT_MAX_RETRY_WAIT_MS
  if (raw === false) return null
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_MAX_RETRY_WAIT_MS
  if (raw <= 0) return null
  return Math.min(Math.max(raw, MIN_AUTO_CAP_MS), MAX_AUTO_CAP_MS)
}
```
Also switch `typeof raw !== "number" || isNaN(raw)` → `!Number.isFinite(raw)`, which covers
`NaN` and `±Infinity` in one check.

**Acceptance:** table-driven test covering `undefined → default`, `false → null`, `0 → null`,
`-5 → null`, `1 → 5000`, `2**31 → 86400000`, `NaN → default`, `Infinity → default`,
`"60000" → default`.

### 3.2 The `bounces > MAX_AUTOMATIC_BOUNCES` branch — **Low / cosmetic**

`src/index.ts:206-209` and `src/v2.ts:294-298` both do:
```ts
const bounces = budget.commit(id)
if (bounces > MAX_AUTOMATIC_BOUNCES) { budget.reset(id); return }
```
`canAct()` gates arming on `bounces < MAX`, so by the time `commit` runs the count cannot
exceed the cap. **Deleting this fixes nothing** — it is unreachable, not harmful. And the
`reset()` inside it would be wrong if it ever *were* reached (it zeroes the counter mid-storm,
granting a fresh budget, the opposite of the intent).

Recommendation: **leave it, or delete it as a pure cleanup, but do not count it as a fix.** If
deleted, keep `const bounces = budget.commit(id)` where the count is used for logging.

**Acceptance:** either the branch is gone (and a test drives 3 auto-retries asserting the 4th
is refused with the counter still reading 3), or it stays and the plan records that no defect
was fixed.

### 3.3 Auto-cap default and jitter — **product decision, needs sign-off**

> **Correction vs. round 3.** Two things were wrong here. First, "RFC 9110 §10.2.3 permits a
> client to reduce a wait only with jitter" is **not supported by anything I could verify** —
> remove the citation. Second, "full jitter from 0 to cap−margin" is not a bugfix; it silently
> redefines `maxRetryWaitMs` from *"wait at most N"* to *"randomly up to N"*, which is a
> different contract and would break every existing configuration.

What is defensible without a product call:
- The auto-cap **is** on by default at 5 minutes and does override a server's `Retry-After`.
  Whether that should change is a decision, not a bug. It is already documented and shipped in
  `retry-push-v1v2-agent-model-cap.md`; changing it now contradicts an approved plan.
- The `"the server will be hammered"` argument is weak: the bounce budget caps this at 3 per
  session.

**Three options, to be decided by the user, not by the agent:**
- **(a) No change.** Keep on-by-default at 5 min. Cheapest; no doc churn.
- **(b) Opt-in only.** `maxRetryWaitMs` defaults to `false`; users who want it set it. Changes
  the documented default in README and the cap plan.
- **(c) Keep the default, add jitter inside the existing window** — i.e. arm the timer at a
  random point in `[remaining − cap, remaining]`, so the *upper bound* stays `cap` and the
  semantics of `maxRetryWaitMs` are preserved. This is the only option that adds jitter
  without redefining the knob.

**Recommendation: (c).** It gets the anti-synchronisation benefit at zero contract cost.

**Acceptance:** depends on the choice — record the decision and the chosen option in this
plan before implementing.

### 3.4 Kill the N+1 in `command.execute.before` (Medium)

`src/index.ts:243-263` fires, per other retrying session: `getSessionMessages` **and** a fresh
`session.status()`. With 10 retrying sessions that is 20 RPCs for one keystroke.

> **Correction vs. round 3.** Round 3's snippet used `statuses.filter(...)`, but V1
> `session.status()` returns a **Record**, not an array.

```ts
const statuses = await client.session.status(dirQuery)                  // 1 call — a Record
const retrying = Object.values(statuses).filter(s => s.type === "retry" && s.id !== input.sessionID)
const parts = await Promise.all(
  retrying.map(s => retryingUserParts(client, s.id, directory).then(p => [s.id, p] as const)))
```
One status call, message lookups in parallel. Re-check each session's own status only inside
the act step (which is a per-session freshness check, not a bulk prefetch).

**Acceptance:** a counting fake client records call counts; assert
`status` calls === 1 for the bulk read, and `getSessionMessages` calls === number of sessions
acted on.

### 3.5 V1 `session.deleted` / `session.error` handling (Medium)

> **Correction vs. round 3.** Round 3's snippet was wrong three ways: it read `event.sessionID`
> for a `session.deleted` event whose id lives at `properties.info.id`; it called
> `clearRetryTimer(event.sessionID)` on a `session.error` whose `sessionID` is **optional**;
> and it **inverted** the budget polarity.

Correct handling, matching the real shapes (§0.7):

```ts
case "session.deleted": {
  const id = event.properties?.info?.id
  if (id) { clearRetryTimer(id); budget.reset(id) }
  break
}
case "session.error": {
  const id = event.properties?.sessionID
  if (id) { clearRetryTimer(id); budget.reset(id) }
  break
}
```
`session.deleted` and `session.error` are **terminal** — reset the budget outright, do not
merely `release` the in-flight flag.

For `session.idle`, the existing polarity is correct and must be preserved:
```ts
case "session.idle": {
  clearRetryTimer(id)
  if (!budget.surviveTransientIdle(id)) budget.reset(id)   // in-flight ⇒ keep; otherwise reset
  break
}
```
Round 3 proposed `if (survive) release`, which would **never** reset on a terminal idle — after
three bounces a session would drop out of auto-retry forever, contradicting the README.

**Acceptance:** tests for all three event names asserting the id is read from the right path,
that an event without a session id is a no-op (not `clearRetryTimer(undefined)`), and that the
budget polarity matches the three cases: in-flight idle → kept; non-in-flight idle → reset;
deleted → reset.

### 3.6 Stop mutating a Map while iterating it (Low)

`src/index.ts:305-308`:
```ts
for (const id of retryTimers.keys()) clearRetryTimer(id)   // deletes during iteration
```
```ts
for (const id of [...retryTimers.keys()]) clearRetryTimer(id)
retryTimers.clear()
budget.clear()
```
Same pattern in `src/v2.ts:377-387`.

**Acceptance:** seed 3 timers, call `dispose`, assert the internal map is empty.

### 3.7 Structured errors instead of bare `console.error` (Low)

`src/index.ts:286-302` and `src/v2.ts:365` swallow with `console.error` and no context. Every
catch must log the session id, the operation, and the error object. Prefer the host's logger
if reachable from `PluginInput`; otherwise `console.error("[retry-now]", { sessionID, op }, err)`
so the plugin's lines are greppable and separable from opencode's own.

---

## Phase 4 — Dedup, docs, packaging

### 4.1 De-duplicate `src/index.ts` against `src/shared.ts` (Low)

Four functions exist twice: `toPromptParts` (index.ts:66-73 ≈ shared.ts:116-123),
`retryingUserParts` (index.ts:89-128 ≈ shared.ts:133-167), `lastUserParts` (index.ts:132-155 ≈
shared.ts:170-187), `logRejected` (index.ts:158-164 ≈ shared.ts:190-199).

V1 should be an **adapter**, not a second implementation: build a `RetryClient` over the V1 SDK
client and call the shared functions. That is what the architecture was always meant to be
(`src/shared.ts:85-104` defines `RetryClient`; V2 already implements it).

**Acceptance:** `src/index.ts` contains no copy of these four bodies; a test asserts the V1
and V2 paths produce identical `PromptPart[]` for the same synthetic history.

### 4.2 `engines` in package.json (Medium)

> **Correction vs. round 3.** Round 3 justified this as "without it opencode cannot tell which
> major a package targets". That is **wrong**. `checkPluginCompatibility` (§0.1) reads *only*
> `engines.opencode`, runs only `semver.satisfies`, and — per `plugin/loader.ts` — is **skipped
> entirely for `source === "file"`** local installs. It never inspects `engines.node`, and it
> never compares majors.

The field is still worth adding, for npm installs only, with two honest caveats:
- `semver.satisfies` does not match prerelease versions unless the range itself contains one,
  so `">=1.15.0"` **rejects `2.0.0-rc.1`**. If prerelease hosts matter, the range must be
  written as `">=1.15.0 || >=2.0.0-0"`.
- The floor `1.15.0` comes from our own `peerDependencies` range and is **unverified** against
  the actual V1 API surface we use. Check what the oldest V1 that has `session.status` +
  `session.promptAsync` is, and set the floor to that.

```json
"engines": { "node": ">=20", "opencode": ">=1.15.0" }
```
State in the README that `engines.opencode` only gates npm installs, and that `engines.node`
is currently decorative.

**Acceptance:** `node -e "console.log(require('./package.json').engines)"` prints the object;
the README documents the prerelease caveat.

### 4.3 Fix the README policy table (Medium)

`README.md` states:
- "15s margin" — the code computes `Math.min(30_000, Math.max(1, cap/2))` = **30 s** at the
  default cap. State the real formula, or change `RETRY_MIN_REMAINING_MS` to 15 000. Pick one;
  do not leave them disagreeing.
- `maxRetryWaitMs` default — update to whatever 3.3 decides.
- "After 3 automatic retries **the V2 adapter** yields" — **both** V1 and V2 have `BounceBudget`.
  Reword to "the plugin yields after 3 automatic retries per session".
- The dual-export table — replaced by 1.4.

**Acceptance:** every number in the README policy table is asserted by a test in
`test/retry-cap.test.ts`, so the docs cannot drift silently.

### 4.4 Test hygiene (Low)

- `test/retry-cap.test.ts` — *"surviveTransientIdle() returns false when inFlight=false"*
  asserts an identity. Replace with the case that matters: *when a session goes idle while an
  auto-retry is in flight, the in-flight flag survives the idle and the next failure still
  counts against the budget.* This is the polarity 3.5 depends on.
- Replace `as any` on `output` and `client` in `test/retry-now-plugin.test.ts` with narrow typed
  doubles (a `makeClient(overrides)` factory). Those casts are what let the entrypoint's
  export-shape regression go unnoticed.
- `test/v2-plugin.test.ts` imports `../src/v2.js` directly, so it fails at import time whenever
  `@opencode/plugin` is absent. After 1.1 `src/v2.ts` must be importable standalone with the
  peer missing; add a test asserting exactly that.

### 4.5 USAGE.md / AGENTS.md honesty pass (Low)

`AGENTS.md` promises a button or Enter-on-empty-prompt; only `/retry-now` exists, and
`USAGE.md` admits it. This plan takes option (b): reword AGENTS.md to describe what ships, and
record the button as an open item. Making AGENTS.md, README.md and USAGE.md describe the same
feature set.

---

## Appendix A — Review-findings traceability

| Finding | Review severity | Verified verdict | Phase | Item |
|---|---|---|---|---|
| Loader throws on non-function exports | Blocker | **Confirmed, but mis-attributed.** The *function-shaped default export* is what forces the legacy path; named exports are collateral damage. | 1 | 1.2 |
| `export { v2 }` is not a plugin | Blocker | Confirmed; a contributing symptom | 1 | 1.2 |
| Top-level value import of `@opencode/plugin` | Blocker | **Confirmed.** Crash before the plugin is called | 1 | 1.1 |
| README V1 config key/options | Blocker | Confirmed | 1 | 1.4 |
| V2 `execute` takes no invocation | High | Confirmed | 2 | 2.1 |
| V2 re-sends to non-retrying sessions | High | Confirmed | 2 | 2.6 |
| V2 event names unverified | High | **Correct in the code, wrong in the review.** `session.status`/`session.idle` exist in `@opencode/client` `V2Event`; the adapter works. | 2 | 2.2 |
| V2 agent/model dropped | High | Confirmed — messages are flat | 2 | 2.3 |
| `switchAgent`/`switchModel` mutate session | High | Confirmed | 2 | 2.4 |
| V2 file part shape wrong | High | Confirmed, but the bug is in the **read** direction, not the write | 2 | 2.5 |
| `structuredClone` per call, unbounded cache | Medium | Confirmed | 2 | 2.2 |
| `parseMaxRetryWaitMs` unbounded | Medium | **Downgraded to Low** — the `2**31` scenario is unreachable; the `1` typo is the real (narrow) risk | 3 | 3.1 |
| Dead `bounces > MAX` branch | Medium | **Downgraded to Low/cosmetic** — unreachable, not harmful; deleting it fixes nothing | 3 | 3.2 |
| Auto-cap on by default, no jitter | Medium | **Product decision, not a bugfix.** Unverified RFC citation; the semantics change is the real concern | 3 | 3.3 |
| N+1 RPCs | Medium | Confirmed | 3 | 3.4 |
| No `session.deleted`/`session.error` in V1 | Medium | Confirmed | 3 | 3.5 |
| Mutating a Map while iterating | Low | Confirmed | 3 | 3.6 |
| Bare `console.error` | Low | Confirmed | 3 | 3.7 |
| README drift | Medium | Confirmed | 4 | 4.3 |
| No `engines` | Medium | Confirmed, but the justification was wrong and the range is unverified | 4 | 4.2 |
| Duplicated helpers | Low | Confirmed | 4 | 4.1 |
| Misnamed test | Low | Confirmed, and it guards the polarity 3.5 relies on | 4 | 4.4 |
| `as any` in tests | Low | Confirmed — this is why the blockers shipped | 4 | 4.4 |
| v2 test imports the peer directly | Low | Confirmed | 4 | 4.4 |
| AGENTS.md promises an undelivered button | Low | Confirmed | 4 | 4.5 |
| *(round 3, retracted)* V2 has no `session.status` API | — | **FALSE.** Both the method's absence and the event's absence were mis-read; the event exists | — | dropped |
| *(round 3, retracted)* V2 prompt input is pass-through | — | **FALSE.** Input is `{sessionID, text: string, files?: [{uri}]}` | — | dropped |
| *(round 3, retracted)* `Object.assign(fn, {id, server})` | — | **FALSE.** A function is not `isRecord`; the properties are dead | — | replaced by 1.2 |
| *(round 4, new)* `readV1Plugin` tui-kind branch | — | Open question, not asserted | 1 | Appendix B |
| *(round 4, new)* V2 `mod.default` only; `id` required; excess keys stripped | — | Enables the single-object dual export | 1 | 1.2 |
| *(round 4, new)* `checkPluginCompatibility` skipped for `file://` plugins | — | Changes what 4.2 can promise | 4 | 4.2 |
| *(standing)* `node_modules` peer dirs empty | — | Blocks all verification | 0 | 0.1–0.4 |

## Appendix B — Open questions and out of scope

**Open questions (need a decision, not an agent guess):**
1. **3.3** — auto-cap default: (a) unchanged, (b) opt-in, (c) keep default + jitter within the
   existing window. Recommendation: (c).
2. **2.5** — inline (`source.type === "inline"`) attachments are not representable in
   `SessionPromptInput`. Recommendation: drop with a warning, rather than synthesise a
   `data:` URI.
3. **Appendix A, tui-kind** — `readV1Plugin` has a `kind === "tui"` branch that would throw on
   `{ id, server, setup }`. The server package only ever resolves `kind: "server"`, and the
   TUI consumes plugins over RPC, so this should not be hit — but it is not proven. Verify
   against a real V1 host before publishing.

**Out of scope:**
- **AGENTS.md's headline feature** — a "Retry Now" button, or Enter on an empty prompt, that
  skips the countdown. Still undelivered; recorded in 4.5 as an open item.
- **Fixed-interval retry** (upstream discussion #8769). A different feature.
- **npm publishing.** Phase 1 makes the package *loadable*; it does not verify
  `npm publish` metadata or `exports` resolution under a real install.

## Appendix C — Definition of done

- [ ] `npm ci` from a clean `node_modules`; both peer packages present (0.1–0.2).
- [ ] `npx tsc --noEmit` exits 0.
- [ ] `npx vitest run` exits 0 and terminates.
- [ ] `test/loader.test.ts` **fails on the pre-fix tree and passes after** (1.3).
- [ ] `Object.keys(await import('./dist/index.js'))` is exactly `['default']` (1.2).
- [ ] `mod.default` is a **non-null object** with string `id`, function `server`, function
      `setup` (1.2).
- [ ] Loads with `@opencode/plugin` moved out of `node_modules` (1.1).
- [ ] Manual `/retry-now` fires with `next - now < margin`; the auto timer does **not** (2.6).
- [ ] `hasDrift` compares a stored snapshot against the fresh status, not a record with itself.
- [ ] V2 attachment mapping: `source.uri` pass-through, inline drop-with-warning, skills
      narrowed to `{id, mention}` (2.5).
- [ ] No `switchAgent` / `switchModel` in `src/v2.ts` (2.4).
- [ ] V1 `session.deleted` reads `properties.info.id`; `session.error` guards on an absent
      `sessionID`; idle keeps the `if (!surviveTransientIdle) reset` polarity (3.5).
- [ ] `session.status.retry.action` still reaches `isUsageLimit` on the auto path (2.6).
- [ ] Every README policy number is asserted by a test (4.3).
- [ ] Every JSON snippet in the README parses and uses the correct key for its major (1.4).
- [ ] The 3.3 decision is recorded here with the option chosen, before implementation.
