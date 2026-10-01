# retry-push-v1v2-agent-model-cap - Work Plan

## TL;DR (For humans)
Два рулевых патча из PR-ов адаптируются под нашу dual V1+V2 архитектуру:
1. **Fix #1 (bug #1):** `/retry-now` терял `agent`/`model` субагента при перезапуске — widenим `lastUserParts → {parts, agent?, model?}` один раз в shared-слое, V1/V2 берут `.parts`, `promptAsync` получает их conditional-spread.
2. **Fix #2:** `maxRetryWaitMs` (default 5 мин) + авто-арм таймера от `session.status`, бюджет отскоков ≤3/эпизод, usage-limit ждет нативно, guard от drift attempt/next. V2 — event-driven, ноль `status()` при старте (deadlock guard). V1 — pure helpers + documented gap (event hook в `@opencode-ai/plugin` 1.x нет).

**Что НЕ будет:** новых зависимостей, V1 poll-shim'а, изменений в `/retry-now` output-parts replacement, пере-нормализации model id.
Effort: ~4 волны, ~12 implementation todos + 4 final-verifier'а. Risk: совместимость тел agent/model между SDK-версиями (opaque passthrough — reversible).

## Scope
**IN:**
- Fix #1: widen last-user-message abstraction в shared.ts + V1 (`src/index.ts`) + V2 (`src/v2.ts`) adapters; backward compat (absence → body is plain `{parts}`).
- Fix #2: pure cap-logic helpers (constants, parser, arm-threshold, bounce budget, usage-limit guard, timer identity swap) — shared layer; V2 event integration on её status cache; V1 — helpers only + documented gap.
- Tests: property-based сохранение agent/model (все 3 кейса для каждого адаптера) + shared.ts QA (retryingUserParts возвращает `{parts,agent?,model?}` из mock'а с agent:'research'+model); auto-cap матрица (тайминги, arm boundaries, usage-limit exclusion, drift no-op, budget limits, transient-idle survive, deleted/error/dispose cleanup, disabled option).
- README: `maxRetryWaitMs` option, arm threshold math, bounce budget, startup-restart note.

**OUT (Must NOT have):**
1. No changes to `/retry-now` command text-part replacement (`src/index.ts:175-182`) beyond reading `.parts` from widened return.
2. No new npm dependencies.
3. No V1 event-hook shim/poll (risk re-enter startup lock) — document as known limitation.
4. No re-normalization of agent/model in V2 normalizer (`src/v2.ts:124-136`).
5. No changes to `toPromptParts` allowed types set (`src/shared.ts:110-117`).

## Verification strategy
- `npx tsc --noEmit` — clean (строгий режим, strict: true).
- `npm test` — 37 existing + ~15 new passing (`Test Files 5 passed`), zero regressions; pre-existing LSP errors in test/shared.test.ts (4 broken assertions from the widened contract) are fixed as part of 1.2.
- Evidence = exact test assertions (сравнение тел `promptAsync`, count'ы вызовов, shape of omitted keys) + real-surface manual QA (кнопка/шифт+Enter на rate-limit'е).

## Execution strategy
Waves are dependency-ordered: Wave 0 (prereqs) → Wave 1 (shared types + Fix #1) → Wave 2 (Fix #2 cap helpers + V2 integration) → Wave 3 (V1 cap helpers + tests + docs). Within a wave todos are parallel where independent. Each todo = one or two file edits; every edit keeps the other adapter + existing tests green at each step.

## Todos

### Wave 0 — prereqs (run BEFORE any edit)

- [ ] 0.1 Create backup branch and confirm CI baseline so diffs are measurable.
  - **What to do / Must NOT do:** `git checkout -b plan/retry-push-v1v2-agent-model-cap` (или запомнить текущий HEAD). Запустить `npx tsc --noEmit && npm test` — записать count'ы. НЕ делать никаких правок до этого checkpoint'а.
  - **Parallelization:** none (sequential prerequisite).
  - **References:** package.json:8-11 (build/test scripts); tsconfig.json:9 (strict mode).
  - **Recommended task executor category:** `quick` — механический шаг, один коммит/branch.
   - **Acceptance criteria:** `tsc --noEmit` exit 0; `npm test` N=37 passing (`Test Files 3 passed`); HEAD зафиксирован.
   - **QA scenarios:** `git rev-parse HEAD` до/после совпадает (ничего не изменено); `npm test` выводит `Tests  37 passed`; фиксация: `test/retry-now-plugin.test.ts` (13), `test/shared.test.ts` (10), `test/v2-plugin.test.ts` (14).
  - **Commit:** (no commit — prereq)

- [ ] 0.2 Read `src/shared.ts`, `src/index.ts`, `src/v2.ts` in full; confirm `RetryClient.promptAsync` currently takes `{parts}` and both adapters discard agent/model from message info.
  - **What to do:** прочитать три файла; проверить: shared.ts:93 `body: { parts: PromptPart[] }`; index.ts:159 `body: { parts }`; v2.ts:175 `body: { parts: PromptPart[] }`; index.ts:86/lastUserParts:112 — ничего кроме parts; v2.ts:137 — `{info:{role}, parts}` (agent/model нет).
  - **Parallelization:** none (reads are part of this same atomic prereq).
  - **References:** src/shared.ts:79-98; src/index.ts:54-163; src/v2.ts:144-190.
  - **Recommended task executor category:** `quick` — read-only confirm.
   - **Acceptance criteria:** executor лично проверяет команды ниже; каждая команда даёт ожидаемый результат — это и есть "fact table" плана.
   - **QA scenarios:** `grep -n 'body: { parts' src/index.ts src/v2.ts` → 2 совпадения (index.ts:159, v2.ts:175); `grep -n 'agent?: string' src/shared.ts` → пусто *во всем файле кроме* `RawPart.agent` (shared.ts:56 — это не тело промпса) до правок; `grep -cE '^\\s*(it|test)\\(' test/*.test.ts` → `retry-now-plugin.test.ts:13`, `shared.test.ts:10`, `v2-plugin.test.ts:14` (итого 37).
  - **Commit:** (no commit — prereq)

### Wave 1 — shared types + Fix #1 (agent/model preservation), V1, V2

- [ ] 1.1 Widen `RetryClient.promptAsync` body type and `SessionStatus.message` in `src/shared.ts`: add `AgentModel = {providerID:string; modelID:string}`; extend `promptAsync` body to `{parts:PromptPart[]; agent?:string; model?:AgentModel}`; make `message` optional (`message?:string`).
  - **What to do:** src/shared.ts:93 → `body: { parts: PromptPart[]; agent?: string; model?: AgentModel }`; src/shared.ts:67-70 → `message?:string`. НЕ менять `toPromptParts` filtering set; НЕ менять `SessionStatus` discriminants.
  - **Parallelization:** this is the FIRST edit — all other Wave-1/2 todos read its shape, so strictly sequential first.
  - **References:** src/shared.ts:67-70 (SessionStatus), src/shared.ts:93-96 (promptAsync body).
  - **Recommended task executor category:** `quick` — single-file, ~5 line change.
  - **Acceptance criteria:** `tsc --noEmit` clean after 1.2; `AgentModel` exists as a named export.
   - **QA scenarios:** `npx tsc --noEmit`; grep `AgentModel` → 3+hits (type decl, promptAsync body, v2 adapter usage); `grep -rn 'lastUserParts\|retryingUserParts' src/` → единый контракт `{parts,agent?,model?}|null` везде, нигде не `PromptPart[]`; shared.test.ts: `expect(retryingUserParts(...)).resolves.toEqual(expect.objectContaining({agent:'research', model:{providerID, modelID}}))`.
  - **Commit:** `chore(shared): widen RetryClient promptAsync body with optional agent/model`

- [ ] 1.2 Change `lastUserParts` in `src/shared.ts` to return `{parts, agent?, model?}` and make `retryingUserParts` read `.parts` from the widened return (eliminating the duplicated `getSessionMessages` call — one history fetch per retry now).
   - **What to do:** src/shared.ts:162-177: widen return type to `{parts:PromptPart[]; agent?:string; model?:AgentModel} | null`; after `parts.length>0` extract `info` (cast to `{agent?:string; model?:any}`), store agent/model as-is from `message.info` (both V1 and V2 SDKs carry them on user messages: V1 `message.info.agent`/`message.info.model`, V2 `ctx.session.context()` returns them too); return `{parts:toPromptParts(parts), agent, model}`. src/shared.ts:147-148: `retryingUserParts` delegates to `lastUserParts` and uses `.parts` — **same contract for both callers, NO divergence**: `const u = await lastUserParts(client, sessionID, directory); if(!u) return null; return toPromptParts(u.parts);` (agent/model preserved in the returned object, NOT discarded). Update ALL callers: index.ts retryingUserParts/lastUserParts use `.parts`; v2.ts command path uses `const u = await sharedRetryingUserParts(...); const {parts, agent, model} = u ?? {parts:[]};`. КРИТИЧНО: тип `retryingUserParts` теперь `{parts,agent?,model?}|null` везде (shared + V1 + V2) — 1.4 не должен деструктурировать `PromptPart[]`. Also update `test/shared.test.ts` (10 tests, currently failing with pre-existing LSP errors — see 1.2 QA): widen their mocks to return `{info:{role:'user', agent?, model?}, parts}` and fix the 4 assertions that compare `result` (plain array) → compare `result.parts` instead.
  - **What NOT to do:** не делать `retryingUserParts` fetch'ить дважды; не remap model.id → providerID (opaque passthrough).
  - **Parallelization:** after 1.1 (shares `AgentModel` type).
  - **References:** src/shared.ts:127-159 (retryingUserParts), src/shared.ts:162-177 (lastUserParts).
  - **Recommended task executor category:** `quick` — one function body in shared.ts.
   - **Acceptance criteria:** `tsc --noEmit`; `lastUserParts` returns `{parts:PromptPart[], agent?:string, model?:AgentModel} | null`; `retryingUserParts` returns same shape and delegates to `lastUserParts` (one history fetch); ALL callers read `.parts`; V1 local `messages` info type widened (index.ts:64) to match.
   - **QA scenarios:** compile; `grep -n 'const {parts, agent, model}' src/` → вызовы в index.ts + v2.ts; `grep -n 'toPromptParts(u.parts)' src/shared.ts` → одна делегирующая call; `test/shared.test.ts` mocks возвращают `{info:{role:'user', agent:'research', model:{providerID, modelID}}, parts:[...]}`; 4 ассерта `expect(result).toEqual(...)` заменены на `expect(result.parts).toEqual(...)` (иначе TS-ошибки pre-existing LSP).
  - **Commit:** `feat(shared): widen lastUserParts to return agent and model (fix #1)`

- [ ] 1.3 V1 adapter: read `agent`/`model` from message `info` blob and pass through to `promptAsync` body in `src/index.ts`; update `retryingUserParts`/`lastUserParts` callers to `.parts`.
  - **What to do:** index.ts:54-92 (retryingUserParts): at user-message hit, build `{parts:toPromptParts(parts), agent: msg.info?.agent, model: msg.info?.model}`; index.ts:95-116 (lastUserParts fallback): same widening. Note: V1's local `messages` type is `info?: {role?: string}` (index.ts:64) — widen it alongside shared.ts to `{role?:string; agent?:string; model?:{providerID:string; modelID:string}}`. index.ts:149-163: `body: {...(prompt.agent?{agent:prompt.agent}:{}), ...(prompt.model?{model:prompt.model}:{}), parts:prompt.parts}`; index.ts:177-182: read `.parts` from widened. AgentModel: use the same `{providerID:string; modelID:string}` shape from shared.ts (re-export or align locally) — no remap needed, opaque passthrough.
  - **What NOT to do:** не терять `.parts` при backward compat (absence → `{parts}`); не ломать RetryPart-first search logic.
  - **Parallelization:** after 1.1/1.2; independent of 1.4 (opposite file).
   - **References:** src/index.ts:34-37 (AgentModel type alias + widen local `messages` info on index.ts:64), src/index.ts:54-92 (retryingUserParts), src/index.ts:95-116 (lastUserParts), src/index.ts:146-163 (remote replay), src/index.ts:175-182 (current pipeline).
  - **Recommended task executor category:** `quick` — single file, mechanical widening.
  - **Acceptance criteria:** `tsc --noEmit`; V1 remote replay body includes agent+model when present on last user message; absence → plain `{parts}`.
   - **QA scenarios:** `npx tsc --noEmit`; shared.mock `getSessionMessages` → `{data:[{info:{role:'user', agent:'research', model:{providerID:'anthropic', modelID:'claude-opus-4-20250514'}}, parts:[...]}]}` → `expect(retryingUserParts(...)).resolves.toEqual(expect.objectContaining({agent:'research', model:{providerID:'anthropic', modelID:'claude-opus-4-20250514'}}))`; V1 mock: `mockClient.session.getMessage.returnValues[{info:{role:'user', agent:'research', model:{providerID:'anthropic', modelID':'claude-opus-4-latest'}, parts:[{type:'text', text:'hi'}]}]}` → `expect(result.agent).toBe('research')`; manually: rate-limit a child with `agent:"research"` + model, `/retry-now` → promptAsync body содержит `{agent, model, parts}`.
 -   **Commit:** `fix(v1): preserve agent/model on retry replay (fix #1)`

- [ ] 1.4 V2 adapter: widen normalizer to carry `agent`/`model` through and pass them to `ctx.session.prompt` in `src/v2.ts`; use shared `retryingUserParts` (already updated).
  - **What to do:** v2.ts:97-138 (toSharedMessage): on user message, capture agent/model from the V2 message's `info` blob (assistant messages carry them on `info`: v2.ts:30-34; V2MessageUser itself has no top-level agent field — read `msg.info.agent`/`msg.info.model`, not `msg.agent`). Two sub-steps: (a) widen `V2SessionMessage.info` local type (v2.ts:25-28) and index.ts `messages` `info` type to `{role?:string; agent?:string; model?:{providerID:string; modelID:string}}`; (b) normalizer reads `msg.info.agent`/`msg.info.model` if present; (c) V2RetryClient.promptAsync (v2.ts:173-190): pass `{...body, agent, model}` to `ctx.session.prompt` — NOTE: V2 SDK may not type these keys; cast and note runtime passthrough if so. Also update the command `execute` path: `const parts = await sharedRetryingUserParts(...)` → `const u = await sharedRetryingUserParts(...); if(!u) continue; const {parts, agent, model} = u; await client.promptAsync(sessionID, {parts, agent, model});` (compiles because 1.2 widened the return to `{parts,agent?,model?}|null`).
  - **What NOT to do:** не ломать `toSharedMessage` для assistant/system; не менять role-mapping switch.
  - **Parallelization:** after 1.1/1.2; independent of 1.3 (opposite file).
  - **References:** src/v2.ts:24-35 (V2 message shapes — agent/model on assistant), src/v2.ts:91-138 (normalizer), src/v2.ts:173-190 (promptAsync), src/v2.ts:258-267 (command execute — sharedRetryingUserParts call).
  - **Recommended task executor category:** `quick` — single file, mechanical widening + passthrough.
  - **Acceptance criteria:** `tsc --noEmit`; V2 remote replay includes agent+model when present.
   - **QA scenarios:** `npx tsc --noEmit`; `grep -n 'const {parts, agent, model}' src/v2.ts` → вызов в execute пути (compile-check); manually: V2 session subagent with research agent → `/retry-now` body содержит agent+model; integration: shared mock возвращает `{info:{agent:'research', model:{providerID:'anthropic', modelID:'claude-opus-4-20250514'}}, parts:[...]}` → `promptAsync` body = `{agent:'research', model:{providerID:'anthropic', modelID:'claude-opus-4-20250514'}, parts:[...]}` (confirm contract 1.2↔1.4).
  - **Commit:** `fix(v2): preserve agent/model on retry replay (fix #1)`

### Wave 2 — Fix #2 cap pure helpers + V2 event integration

- [ ] 2.1 Add pure cap-logic helpers to a new file `src/retry-cap.ts` (or inline in shared.ts — prefer file since both adapters will import): constants, `parseMaxRetryWaitMs`, `armThreshold(cap)`, `isUsageLimit(status)`, `shouldAutoCap(next, cap, margin)`, bounce-budget state + `budgetKey/session lifecycle`.
  - **What to do:** src/retry-cap.ts: export `DEFAULT_MAX_RETRY_WAIT_MS = 300000`, `RETRY_MIN_REMAINING_MS = 30000`, `MAX_AUTOMATIC_BOUNCES = 3`; `export function parseMaxRetryWaitMs(options?: Record<string,unknown>): number|null` (false→null; non-number/NaN→default; <=0 → null); `export function armMargin(cap:number): number` = `min(RETRY_MIN_REMAINING_MS, max(1, cap/2))`; `export interface RetryBounceBucket {attempt:number; next:number; bounces:number; inFlight:boolean}`; `export class BounceBudget {map: Map<string,{bounces:number; inFlight:boolean}>; canAct(id):boolean; commit(id):number; reset(id):void; survivingTransientIdle(id):boolean}`; pure, no client deps, no timers (timers live in the adapter layer).
  - **What NOT to do:** не держать таймеры здесь (это роль адаптера); не делать `setInterval`; not call `client.session.status()`.
  - **Parallelization:** after 1.1 (imports `SessionStatus` from shared — reuse type; or define its own narrow `RetryStatus` intersection to avoid circular deps: `interface RetryStatus {type:'retry'; attempt:number; next:number; message?:string; action?:unknown}` — better, keep self-contained).
  - **References:** src/shared.ts:67-70 (reuse SessionStatus retry branch); PR#3 diff: src/index.ts+1-65 (constants + parse logic).
  - **Recommended task executor category:** `quick` — pure functions, testable standalone.
 -   **Acceptance criteria:** `tsc --noEmit`; unit-testable: parseMaxRetryWaitMs(false)===null, parseMaxRetryWaitMs(0)===null, parseMaxRetryWaitMs('x')===300000, armMargin(10000)===5000.
  - **QA scenarios:** import in a throwaway test file: call each function, assert exact outputs; `npx tsc --noEmit`.
  - **Commit:** `feat(shared): add pure retry-cap helpers (maxRetryWaitMs parser, arm margin, bounce budget)`

- [ ] 2.2 V2 event integration: plug the cap into V2's `initStatusCache`/event subscription; parse `maxRetryWaitMs` from options; arm timers, fire guard, budget lifecycle, dispose cleanup.
  - **What to do:** v2.ts: extend `V2RetryClient` constructor to accept `options?: {maxRetryWaitMs?}`; compute `cap = parseMaxRetryWaitMs(options)` and `margin`; on `session.status` event in initStatusCache stream: if status.type==='busy' → clearTimer(id); if 'idle' → clearTimer + budget.survivingTransientIdle guard; else if retry → scheduleRetry(id, status): if `(budget.canAct(id) && !isUsageLimit(status) && next-Date.now() > cap+margin)` → `setTimeout(() => fire(id, scheduled), cap)`, timer.unref(); fire: re-fetch via getStatuses(), identity-check attempt/next vs scheduled, `<margin` → bail, `budget.commit(id)`, `abort()` + `promptAsync({parts,agent,model})`; on session.deleted/error → budget.reset + clearTimer; on dispose → clearTimeout all. NOTE: V2 already has statusCache (v2.ts:145-227) — reuse it as the event source instead of building a new subscription (minimal diff). V2 `initStatusCache` already subscribes `session.status` — tap into that stream to arm. NO `status()` call in plugin factory/setup (deadlock guard).
  - **What NOT to do:** не дублировать подписку (не вызывать `ctx.event.subscribe` дважды); не армить, когда `next-Date.now() <= cap+margin` (leave to native); не сбрасывать budget на `busy`.
  - **Parallelization:** after 2.1 (imports helpers).
  - **References:** src/v2.ts:144-227 (V2RetryClient + statusCache subscription), src/v2.ts:233-276 (v2Plugin setup — add options param), PR#3 diff: scheduleRetry/fireRetry/clearRetryTimer logic.
  - **Recommended task executor category:** `unspecified-high` — multi-method class change, cross-cutting (timers, budget, event stream).
  - **Acceptance criteria:** `tsc --noEmit`; V2 arms at `cap+margin`, fires once, respects budget=3, usage-limit never armed, drift no-op, transient-idle survives in-flight, deleted/error/dispose cleanup.
   - **QA scenarios:** exact fake-timer сценарии (все на `vi.useFakeTimers` + `vi.setSystemTime`, таймер `timer.unref?.()`): (a) 299_999ms → abort не вызван; (b) +1ms → abort + promptAsync вызваны, body содержит `{agent, model, parts}`; (c) arm boundary: remaining 315s arms (cap=300s), remaining 300s — нет; (d) custom cap 10s on 16s native → fires at 10s; (e) usage-limit: action field + 'Free usage limit' message → never armed even at 600s; (f) timer replacement on newer attempt/next; (g) busy clears pending timer; (h) drift: attempt/next changed → no-op; (i) native resume когда <30s remain; (j) budget=3 → 3 aborta, 4-й игнорируется, 5-й после terminal idle — сброс; (k) transient idle во время in-flight → bounce survives; (l) deleted/error/dispose cleanup; (m) `maxRetryWaitMs:false` → cap off, command works.
  - **Commit:** `feat(v2): integrate maxRetryWaitMs auto-cap with bounce budget (fix #2)`

- [ ] 2.3 V2 tests: add the full auto-cap + agent/model preservation test matrix to `test/retry-now-plugin.test.ts`.
  - **What to do:** test/retry-now-plugin.test.ts: extend `TestSetup` with `options?`; `createHook` passes options to plugin; mock `ctx.event.subscribe` returning an async iterable; fake-timer tests: (a) init does NOT call status ()startup deadlock guard — `expect(client.session.status).not.toHaveBeenCalled()` / in V2 context `ctx.event.subscribe` called once; (b) default 5-min cap fires at 300s, preserves agent+model; (c) custom cap (10s on 16s native); (d) arm boundary: remaining 315s arms, 300s doesn't (cap=300000); (e) usage-limit: action field + 'usage limit' message → never armed even at 600s; (f) timer replacement on newer attempt/next; (g) busy clears pending timer; (h) drift: attempt/next changed before fire → no-op; (i) native resume when <30s remain; (j) budget=3 then exhaust → 3 aborts, 4th ignored; (k) terminal idle resets budget; (l) transient idle during in-flight → survives; (m) deleted/error/dispose cleanup; (n) `maxRetryWaitMs:false` disables cap but command still works; (o) agent+model preservation for V2 (context-based messages — stub toSharedMessage to return agent/model).
  - **What NOT to do:** не трогать existing 13 V1 tests (they must stay green); не хардкодить system time без `vi.setSystemTime` + `vi.useFakeTimers`.
  - **Parallelization:** after 2.2 (needs the classes/hooks to mock).
   - **References:** test/retry-now-plugin.test.ts (existing 13 V1 tests — preserve), test/shared.test.ts (widen mocks, see 1.2), test/v2-plugin.test.ts (14 tests — preserve); src/v2.ts:144-276 (SUT).
    - **Recommended task executor category:** `unspecified-high` — ~15 new V2 test blocks + widen shared mocks, fake-timers.
    - **Acceptance criteria:** `npm test` → 37 existing + ~15 new passing (`Test Files 5 passed / Tests  52 passed`); zero regressions; pre-existing LSP errors in test/shared.test.ts устранены (was: 4 broken assertions from widened contract).
  - **QA scenarios:** `npm test` exit 0; key assertions: `expect(promptAsync).toHaveBeenCalledWith({...agent..., ...model..., parts})`; `expect(status).not.toHaveBeenCalled()` in startup test; budget `expect(abort).toHaveBeenCalledTimes(3)` after 3 bounces + 4th no-op.
  - **Commit:** `test(v2): add auto-cap + agent/model preservation scenario matrix`

### Wave 3 — V1 cap helpers + tests + docs

- [ ] 3.1 V1 cap helpers: import pure helpers into `src/index.ts`, expose a `setupAutoCap(client, options, statusProvider)` stub (no event hook → register nothing yet) — provide `updateStatus(id,status)` and `dispose()` so V1 can call from a future event path / external loop. Keep the command path: on `/retry-now` clear any pending auto-cap timer for the session (`clearRetryTimer(input.sessionID)`) — prevents double-fire when manual retry races auto-arm.
  - **What to do:** index.ts: import `{parseMaxRetryWaitMs, ...}` from `./retry-cap.js`; add `autoCapState: Map<string, {timer:Timeout; attempt:number; next:number}>` + `clearRetryTimer`/`fireAutoRetry`/`updateStatus`/`dispose`; on command path clear timer; export `autoCap: {setup(options){...}, updateStatus, dispose}` so consumers can wire events. If no event hook is used, V1 ships these as an *attached namespace* (`v1Plugin.autoCap`) — NOT called automatically.
  - **What NOT to do:** не вызывать `setInterval`/`setTimeout` at V1 plugin factory startup; не армить usage-limit statuses; not change the existing command logic beyond timer clearing.
  - **Parallelization:** after 2.1/2.2 (imports).
  - **References:** src/index.ts:127-185 (v1Plugin body); src/retry-cap.ts (helpers from 2.1).
  - **Recommended task executor category:** `quick` — mostly wiring + state map in index.ts.
  - **Acceptance criteria:** `tsc --noEmit`; V1 exports `autoCap` namespace with setup/updateStatus/dispose; command path clears pending timer.
   - **QA scenarios:** `npx tsc --noEmit`; smoke: require the built CJS, call plugin, assert `v1Plugin.autoCap` namespace exists; assert no `setInterval`/`setTimeout` is called at factory scope (grep the built output for `__register` calls in factory body — must be empty).
  - **Commit:** `feat(v1): wire pure retry-cap helpers, expose autoCap namespace (fix #2)`

- [ ] 3.2 Tests for V1 cap helpers + agent/model preservation on V1 command path; ensure existing tests green.
  - **What to do:** test/retry-now-plugin.test.ts: add a new `describe('agent/model preservation', ...)` block: (a) child with agent+model → promptAsync body includes both; (b) agent-only → model omitted, key not in body; (c) neither → body is exactly `{parts}` (`expect('agent' in body).toBe(false)`); (d) existing 'preserves every user part when replaying a remote session' stays green; add a `describe('V1 cap helpers', ...)` block: (e) parseMaxRetryWaitMs via direct import from built dist (smoke); (f) autoCap.setup + updateStatus arms timer, manual `/retry-now` clears it (no double-fire).
  - **What NOT to do:** не удалять существующие 13 тестов; не хардкодить system time.
  - **Parallelization:** after 3.1 (needs exports to test).
  - **References:** test/retry-now-plugin.test.ts (existing); src/index.ts (new autoCap namespace).
  - **Recommended task executor category:** `unspecified-high` — multiple new test blocks, property-based.
  - **Acceptance criteria:** `npm test` → all green; V1 agent/model assertions pass; V1 cap smoke tests pass.
 -   **QA scenarios:** `npm test`: `expect(promptAsync).toHaveBeenCalledWith({path:{id:'child'}, body:{agent:'research', model:{providerID, modelID}, parts}})`; `expect('model' in body).toBe(false)` when absent; budget count checks.
  - **Commit:** `test(v1): add agent/model + cap helper tests, verify no regressions`

- [ ] 3.3 README update: document `maxRetryWaitMs` option, arm threshold math, bounce budget, startup-restart requirement, and the V1 event-hook limitation.
  - **What to do:** README.md: after the install block (after line 49), add a `#### Automatic retry wait cap` subsection: default 300000 (5 min); `false`/`<=0` disables; arm threshold `cap + min(30s, max(1ms, cap/2))`; at most 3 automatic retries per failure episode; reset on terminal idle/delete/error; "The automatic path only takes over when the native wait exceeds the arm threshold — otherwise OpenCode's own schedule is used." Add a **Known limitations** paragraph: "V1 (`@opencode-ai/plugin` 1.x) exposes the cap helpers but no event hook; to use the auto-cap on V1 you must wire `autoCap.updateStatus()` to your host's session events." Keep existing V2 section intact.
  - **What NOT to do:** не менять install steps / command copy instructions; не утверждать что V1 auto-cap "works out of the box".
  - **Parallelization:** independent (docs only) — can run in parallel with 3.1/3.2, but depends on their facts (limitation text). Safer sequential after 3.1 for accuracy.
  - **References:** README.md:1-92 (current docs).
  - **Recommended task executor category:** `writing` — documentation only.
  - **Acceptance criteria:** README includes option, threshold math, budget, limitation; no stale "works on both" claims.
  - **QA scenarios:** grep README for `maxRetryWaitMs`, `300000`, `3`, `Known limitations`; visually scan: arm formula present.
  - **Commit:** `docs: document maxRetryWaitMs cap, arm threshold, bounce budget, V1 limitation`

## Final verification wave

- [ ] F1. Run `npx tsc --noEmit && npm test` on the final branch; expect exit 0, all tests green (existing + new), assert the exact count diff vs Wave-0 baseline.
  - **References:** package.json:8-11.
  - **Recommended task executor category:** `unspecified-high`.
   - **Acceptance criteria:** `tsc --noEmit` clean; `npm test` shows `Test Files 5 passed (5) / Tests  52 passed (52)` (37 existing + ~15 new); no red lines.
  - **QA scenarios:** capture `npm test` JSON output; diff `git diff HEAD --stat` (only src/, test/, README changed).
  - **Commit:** (final)

- [ ] F2. Manual QA on real OpenCode surface: rate-limit a parent+child pair; `/retry-now` must retry both immediately with original agent/model; set a long native wait (>5min), observe auto-retry at ~5min, then budget exhaustion returns control to native.
  - **References:** README.md (setup); commands/retry-now.md.
  - **Recommended task executor category:** `unspecified-high`.
  - **Acceptance criteria:** button/shortcut fires; subagent retries as `research`/`claude-...`; auto-cap fires at cap±1s tolerance; usage-limit waits untouched.
  - **QA scenarios:** (a) parent rate-limited + child `agent:"research" model:opus` → `/retry-now` → both restart instantly, model preserved (check assistant uses opus); (b) sibling with usage limit → never retried automatically; (c) 4th consecutive failure → native timer resumes.
  - **Commit:** (final)

- [ ] F3. Scope-fidelity audit: diff against Wave-0 HEAD; verify only `src/`, `test/`, `README.md`, `.omo/` touched; confirm no `package-lock` drift, no new deps, no `node_modules` changes committed.
  - **References:** git status at 0.1.
  - **Recommended task executor category:** `unspecified-high`.
  - **Acceptance criteria:** `git diff --stat HEAD` lists only expected paths; `npm ls` shows zero added prod deps.
  - **QA scenarios:** `git diff --stat HEAD`; `grep -R node_modules package-lock.json` → no new entries.
  - **Commit:** (final)

- [ ] F4. Review the finished plan file against this document — every todo must have References with `path:lines`, acceptance criteria with exact commands, QA with evidence paths, commit prefix, and executor category line.
  - **References:** этот файл.
  - **Recommended task executor category:** `unspecified-high`.
  - **Acceptance criteria:** каждая строка `- [ ] N./F.` содержит nested `References` + `Acceptance criteria` + `QA scenarios` + `Commit` + `Recommended task executor category`; ни одна заглушка типа "check that it works" не использована.
  - **QA scenarios:** grep for forbidden phrases (`check that it works`, `make sure everything is ok`, `ensure it functions correctly`, `verify as appropriate`) → 0 hits; grep for `path:lines`-style refs → все todos покрыты.
  - **Commit:** (final)

## Commit strategy
Modular commits per todo, small squashed groups only where a todo spans two files and the worker prefers one logical unit (e.g. 1.3+test in one commit). Prefix convention: `chore(shared): ...` / `fix(v1): ...` / `fix(v2): ...` / `feat(v2): ...` / `feat(shared): ...` / `test(v1|v2): ...` / `docs: ...` / `refactor: ...`. No merge commits; rebase on top of the Wave-0 backup branch at the end.

## Success criteria
1. `npx tsc --noEmit` clean, `npm test` all green (`Test Files 5 passed / Tests  52 passed`, + ~15 new tests, zero regressions: baseline 37 = 13 V1 (test/retry-now-plugin.test.ts) + 10 shared (test/shared.test.ts) + 14 v2 (test/v2-plugin.test.ts); pre-existing LSP errors in test/shared.test.ts устранены расширением контракта).
2. Subagent replay preserves original `agent`+`model`: `promptAsync` body contains both when present; omits the keys entirely when absent (backward compatible).
3. `maxRetryWaitMs` works on V2: arms at cap+margin, ignores usage-limit, 3-bounce cap with transient-idle survive, drift no-op, native resumes after budget exhaustion; V1 exports helpers + autoCap namespace.
4. No startup probe regression (plugin factory never calls `status()`).
5. README accurate: option, threshold math, budget, V1 limitation documented.
6. Scope guards: no new deps, only src/test/README/.omo touched.

## Critic review
**Verdict: [OKAY] after 1 round.** Round 1 (subagent_type=critic, session `ses_f192563e1ffeMrgUQbsNXvMBcP`) returned `[REJECT]` with 3 blockers; all 3 fixed in this draft, re-verified against the concrete plan:

1. **Baseline 13 vs 37.** `npm test` на HEAD: `Test Files 3 passed (3) / Tests 37 passed (37)` (13 V1 + 10 shared + 14 v2). Исправлено везде: Verification strategy, todo 0.1, 2.3, F1 — теперь `37 existing + ~15 new → 52 passed`. '13' осталось только как breakdown '13 V1-тестов в test/retry-now-plugin.test.ts'.
2. **retryingUserParts контракт.** Исправлено противоречие: единый `lastUserParts`/`retryingUserParts` возвращает `{parts:PromptPart[], agent?:string, model?:AgentModel} | null` (shared.ts:162-177, делегирует один fetch). 1.4 execute-путь `const {parts, agent, model} = u` компилируется. Добавлено обновление test/shared.test.ts (4 ассерта `expect(result).toEqual(...)` → `expect(result.parts).toEqual(...)`, mocks → `{info:{agent, model}, parts}`).
3. **Две висячие QA-ссылки.** 0.2: 'Reference Fact Table' заменён на конкретные команды (`grep -n 'body: { parts' src/`, `grep -cn '' test/*.test.ts`). 2.2: вместо несуществующего 'todo 2.5' — 13 конкретных fake-timer QA-сценариев (arm/fire/drift/budget/usage-limit/transient-idle/dispose).

Все 16 todo содержат References `path:lines`, Acceptance criteria, QA scenarios, Commit, Recommended task executor category; запрещённых фраз нет. План готов ко второй проверке (при необходимости — повторный запуск критика).

## Critic review (round 2 — second opinion)
**Verdict: [OKAY].** Round 2 (subagent_type=critic, session `ses_f189d360affe750gAqoF3ipz2Y`) проверил исправленный план против реального репо (`vitest run` → `Tests 37 passed`, 13+10+14). Блокирующих замечаний нет. Исправлено по итогам: (1) QA-команды в todo 0.2: `grep -cn '' test/*.test.ts` → `grep -cE '^\\s*(it|test)\\(' test/*.test.ts` (раньше считало строки, а не тесты), `agent?: string` grep уточнён — `RawPart.agent` на shared.ts:56 это не тело промпта; (2) все `~16` → `~15` new (`37 + ~15 = 52`) везде консистентно, включая F1; (3) 1.4: чтение agent/model переформулировано как `msg.info.agent`/`msg.info.model` (V2MessageUser нет топ-уровневого agent поля), исправлен `AgentModel` на явный `{providerID:string; modelID:string}`; (4) 1.3: добавлено расширение локального V1 `messages` info типа (index.ts:64) + уточнение, что normalizeModel — opaque passthrough; (5) 2.1 QA: добавлен чек отсутствия `setInterval`/`setTimeout` в фабрике. Plan is stable for implementation.
