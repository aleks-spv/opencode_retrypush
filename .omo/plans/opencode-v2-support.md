# План: поддержка OpenCode V2 в opencode-retry-now-plugin

**Slug:** `opencode-v2-support`
**Автор:** Prometheus (планировщик)
**Дата:** 2026-10-01
**Базовый коммит:** `c74bfca feat: add configurable automatic retry wait cap` (= `main` = `origin/main`)
**Рабочая ветка (создаётся первым шагом):** `feature/opencode-v2-support`

---

## 1. Резюме

Плагин сейчас V1-only: монолитный `src/index.ts` (408 строк) против `@opencode-ai/plugin@^1.18.34`. Оба ранее сделанных фикса (сохранение original agent/model при replay — Fix #1; настраиваемый cap автоматического ожидания retry — Fix #2) **уже в `main`** внутри монолита. Откат уничтожил всю предыдущую V2-работу: `src/shared.ts`, `src/v2.ts`, `src/retry-cap.ts`, `test/shared.test.ts`, `test/v2-plugin.test.ts` не существуют.

Цель: добавить **вторую точку входа** для OpenCode V2 (`@opencode/plugin@2.0.21`), не ломая V1. Ключевое архитектурное открытие разведки: в V2 есть **нативный хук `ctx.session.hook("retry", ...)`** с мутируемым полем `decision.delay`. Поэтому вся V1-машинерия (таймер → поллинг `session.status()` → `abort` → replay последнего user-prompt) в V2 **не воспроизводится** — cap реализуется одной мутацией. Это радикально меньше кода и рисков, чем предполагал старый план `v2-migration.md`.

Два старых плана (`retry-push-v1v2-agent-model-cap.md`, `v2-migration.md`) объявляются **устаревшими**: их предпосылки (существующие shared/v2 файлы, 37 тестов, догадки про V2 API) опровергнуты. Из них переносится только то, что подтверждено кодом: формулы cap/margin/budget, набор fake-timer QA-сценариев, инвариант «никаких вызовов `session.status` в фабрике плагина», запрет на новые runtime-зависимости.

### Принципы (жёсткие ограничения на всю работу)

1. **V1-поведение неизменно.** Все 40 существующих тестов проходят без правок на каждом этапе.
2. **Никаких runtime-зависимостей.** `dependencies` остаётся отсутствующим. V2-пакеты — только `devDependencies` + `peerDependencies` с `peerDependenciesMeta.optional`.
3. **Shared-слой не знает про SDK.** `src/shared.ts` не содержит ни одного `import` из `@opencode-ai/*` или `@opencode/*` — только чистые функции и типы.
4. **Никаких догадок про V2 API в коде.** Любой неподтверждённый тип закрывается задачей разведки (Wave 1) до написания `src/v2.ts`.
5. **Один todo = 1–2 файла.** Если задача требует больше — она разбита.
6. **LSP в этой среде не является доказательством.** Проверено на практике: языковой сервер отдаёт устаревший кэш до-откатного состояния и показывает диагностику для физически отсутствующих `src/v2.ts` и `test/v2-plugin.test.ts`. Авторитетные источники истины для любого acceptance-критерия — только `ls`, `git`, `npx tsc --noEmit` и `npx vitest run`. Диагностику LSP не использовать ни как подтверждение, ни как опровержение.

---

## 2. Reference Fact Table

| Source path | Lines | Fact discovered | Relevance to plan |
|---|---|---|---|
| `src/index.ts` | 1 | `import type { Plugin } from "@opencode-ai/plugin"` | V1-контракт точки входа, не меняется |
| `src/index.ts` | 2-10 | type-импорты `Part, TextPartInput, FilePartInput, AgentPartInput, SubtaskPartInput, SessionStatus, RetryPart` из `@opencode-ai/sdk` | V1 типы частей; V2 использует другие — нельзя переиспользовать в `v2.ts` |
| `src/index.ts` | 13 | `type PromptPart = TextPartInput \| FilePartInput \| AgentPartInput \| SubtaskPartInput` | V1-only тип, остаётся в `index.ts` |
| `src/index.ts` | 15 | `ALLOWED_PART_TYPES = new Set(["text","file","agent","subtask"])` | **Не трогать** — зафиксированное V1-поведение фильтрации |
| `src/index.ts` | 18-22 | `toPromptParts(parts)` — фильтр + strip `id/sessionID/messageID` | **Не трогать**, V1-only |
| `src/index.ts` | 24-26 | `DEFAULT_MAX_RETRY_WAIT_MS = 300_000`, `RETRY_MIN_REMAINING_MS = 30_000`, `MAX_AUTOMATIC_BOUNCES = 3` | Переезжают в `src/shared.ts` как единственный источник правды для V1+V2 |
| `src/index.ts` | 28-32 | `type LastUserPrompt = { parts; agent?; model?: {providerID; modelID} }` | V1-форма; V2 получает agent/model напрямую из `SessionRetry` |
| `src/index.ts` | 42-98 | `lastUserPrompt(client, sessionID, directory?)` — идёт назад по истории к последнему `RetryPart`, затем к user-сообщению, извлекает `info.agent` (81-83) и `info.model` (85-92) | V1-only; в V2 не нужен для cap, нужен только для команды `retry-now` |
| `src/index.ts` | 101-141 | `lastUserPromptParts` — fallback-путь, дублирует логику agent/model (121-135) | Дублирование кода 42-98 ↔ 101-141; дедупликация **вне скоупа** этого плана (риск регрессии V1) |
| `src/index.ts` | 144-150 | `logRejected(results, context)` → `console.error('[retry-now] ...')` | Префикс лога `[retry-now]` переиспользуется в V2 |
| `src/index.ts` | 152-158 | `type RetryStatus = {type:"retry"; attempt; message?; next; action?}` | V1-форма статуса; в V2 заменяется `SessionRetry` |
| `src/index.ts` | 160-164 | `type RetryTimer = {timer; attempt; next}` | V1-only, в V2 таймеров нет |
| `src/index.ts` | 166-171 | `maxRetryWaitMs(options?)`: `false`→`null`; не-число/не-finite→DEFAULT; `>0`? value : `null` | **Чистая функция** → переезжает в `shared.ts` как `parseMaxRetryWaitMs` |
| `src/index.ts` | 173-188 | `retryStatus(status)` — валидация type/attempt/next | V1-only (валидация V1-формы) |
| `src/index.ts` | 190-193 | `isUsageLimitRetry(status)`: `status.action` truthy → true; либо regex `/usage limit\|free limit/i` по message | Regex-часть → `shared.ts` как `isUsageLimitMessage(message)`; V2 использует её по тексту из `input.error` |
| `src/index.ts` | 195-204 | `replayPrompt(client, sessionID, prompt)` → `client.session.promptAsync({path:{id},body:{agent?,model?,parts}})` | V1-only; V2-аналог — `ctx.session.prompt` |
| `src/index.ts` | 206 | `const plugin: Plugin = async ({ client, directory }, options) =>` | V1: опции — **второй аргумент фабрики**. В V2 опции — `ctx.options` |
| `src/index.ts` | 209-218 | `retryWaitCap = maxRetryWaitMs(options)`; `retrySubstituteMargin = cap===null?0:Math.min(RETRY_MIN_REMAINING_MS, Math.max(1, cap/2))`; state-мапы `retryTimers`, `automaticBounces`, `bouncesInFlight` | Формула margin → `shared.ts` как `armMargin(cap)`; мапы остаются V1-only |
| `src/index.ts` | 234-262 | `fireRetry` — identity-check, budget-check `>=MAX_AUTOMATIC_BOUNCES`, `session.status()`, drift-guard, margin-guard, abort, replay | V1-машинерия. В V2 **не воспроизводится** |
| `src/index.ts` | 264-281 | `scheduleRetry` — порог `status.next-Date.now() <= cap+margin` → отдаём нативу; иначе `setTimeout(..., cap)` + `timer.unref?.()` | Формула порога документирована в README; в V2 заменяется прямым сравнением `delay > cap` |
| `src/index.ts` | 283-288 | Комментарий-инвариант: **не вызывать `session.status` в фабрике плагина** — ре-входит в bootstrap-lock и дедлочит старт OpenCode | Инвариант обязателен и для V2: в `setup()` нельзя делать блокирующие вызовы к сессионному API |
| `src/index.ts` | 289-405 | Возвращаемый объект хуков: `event` (290-331), `dispose` (333-340), `"command.execute.before"` (342-404) | V1-форма хуков. В V2: `setup` возвращает `Cleanup`, команда регистрируется через `ctx.command.transform` |
| `src/index.ts` | 395-403 | Замена `output.parts` с переиспользованием ID командной text-части | **Не трогать** — хрупкое V1-поведение, покрыто тестами |
| `src/index.ts` | 408 | `export default plugin;` | V1 default-export сохраняется как есть |
| `test/retry-now-plugin.test.ts` | 56-80 | `createHook({messages,statuses,statusResponses,options})` мокает `client.session.{messages,status,abort,promptAsync}`, вызывает `await RetryNowPlugin({client} as any, options)` | Шаблон для V2-харнесса: мокать `Context`, а не `client` |
| `test/retry-now-plugin.test.ts` | 77, 452 | Два `describe`: `"retry-now plugin"` (15 тестов), `"automatic retry wait cap"` (13 тестов) | 40 тестов по vitest — baseline, который не должен меняться |
| `test/retry-now-plugin.test.ts` | 453 | Тест «НЕ вызывает session status при старте» | Прямая проверка инварианта из `src/index.ts:283-288`; V2-аналог обязателен |
| `test/retry-now-plugin.test.ts` | 90-92 | `afterEach(() => vi.useRealTimers())` | Шаблон изоляции fake-timers |
| `package.json` | 8-12 | scripts: `build: tsc`, `test: vitest run`, `prepublishOnly: npm run build` | Расширяются (или нет) в Wave 4 |
| `package.json` | 13-15 | `main: dist/index.js`, `types: dist/index.d.ts`, `files: ["dist","commands"]` | Нужен `exports`-map для подпути `./v2` |
| `package.json` | 21-27 | devDeps: `@opencode-ai/plugin ^1.18.34`, `@opencode-ai/sdk ^1.18.34`, `@types/node ^20`, `typescript ^5`, `vitest ^1`. **Нет `dependencies`/`peerDependencies`** | V2-пакеты добавляются только в devDeps + optional peerDeps |
| `tsconfig.json` | 1-17 | target es2022, module/moduleResolution NodeNext, outDir `./dist`, rootDir `./src`, strict, include `["src/**/*"]`, exclude `[node_modules, dist, test]` | NodeNext нужен для exports-subpath `@opencode/plugin`; `include` уже покрывает новые файлы в `src/` |
| `/tmp/v2probe/package/dist/promise/plugin.d.ts` | 1-60 | `interface Context {app; location; options: PluginOptions; agent; aisdk; command; event; experimental; integration; mcp; model; generate; permission; plugin; provider; reference; rpc; session; shell; skill; storage; tool; vcs; websearch; worktree}`; `type Cleanup = () => Promise<void>\|void`; `interface Plugin {id: string; setup: (ctx) => Promise<Cleanup\|void>\|Cleanup\|void}`; `function define(plugin): Plugin` | Точный контракт точки входа V2 |
| `/tmp/v2probe/package/dist/options.d.ts` | 1 | `PluginOptions = Readonly<Record<string, any>>` | Опции V2 нетипизированы → валидация обязательна на нашей стороне (`parseMaxRetryWaitMs`) |
| `/tmp/v2probe/package/dist/promise/registration.d.ts` | 1-13 | `Registration {dispose: () => Promise<void>}`; `Hooks<Spec> = <Name>(name, cb: (input: Spec[Name]) => Promise<void>\|void) => Promise<Registration>`; `Transform<Input> = (cb: (input: Input) => void) => Promise<Registration>` | Хуки регистрируются асинхронно и возвращают `.dispose()` → собираются в `Cleanup` |
| `/tmp/v2probe/package/dist/promise/session.d.ts` | 1-146 | `SessionRetryDecision = {retry:false} \| {retry:true; delay:number}`; `SessionRetry {sessionID; agent; model; error: SessionError.Error; attempt; decision /* мутируемое */}`; `SessionHooks` включает `retry`; `SessionDomain = Pick<SessionApi, "create"\|"get"\|"switchAgent"\|"switchModel"\|"prompt"\|"generate"\|"command"\|"synthetic"\|"interrupt"\|"update"\|"move"\|"wait"\|"context"> & {hook: ModelHooks<SessionHooks>}` | **Ядро V2-реализации**: cap = мутация `decision.delay`. `attempt` даёт бюджет, `error` — детект usage-limit |
| `/tmp/v2probe/package/dist/promise/command.d.ts` | 1-23 | `CommandInvocation {sessionID; prompt: PromptInput.Prompt; delivery}`; `CommandDefinition {name; description?; execute: (input) => Promise<void>}`; `CommandEditor {add(def): void}`; `CommandDomain {transform: Transform<CommandEditor>; reload}` | Команда `retry-now` в V2 регистрируется **кодом**, а не markdown-файлом |
| `/tmp/v2probe/package/dist/promise/event.d.ts` | 1-3 | `EventDomain extends Pick<EventApi, "subscribe">` | Подписка = `AsyncIterable`, не callback |
| `/tmp/v2probe/client/package/dist/promise/client.d.ts` | 31-100 | `session.active: (requestOptions?) => Promise<{[x:string]: SessionActive}>`; `session.context: (input: SessionContextInput) => Promise<SessionMessageInfo[]>`; `session.interrupt: (input: SessionInterruptInput) => Promise<SessionInterruptResponse>`; `session.prompt: (input: SessionPromptInput) => Promise<SessionInboxUser>` | V2-аналоги V1 `status`/`messages`/`abort`/`promptAsync` |
| `/tmp/v2probe/client/package/dist/promise/index.d.ts` | 1-6 | Только 6 строк ре-экспортов; `SessionPromptInput`/`SessionContextInput`/`SessionInterruptInput`/`SessionActive`/`V2Event` в нём не объявлены | **Остаточная неизвестность** → закрывается задачей T1.2, не догадкой |
| npm registry | — | `@opencode/plugin@2.0.21` peerDependencies: `solid-js >=1.9.0`, `@opentui/core >=0.5.14`, `@opentui/solid >=0.5.14`, `@opencode/theme 2.0.21` | Риск ERESOLVE при `npm install` → решается в T1.1 |
| npm registry | — | `@opencode/plugin@2.0.21` exports: `.` → `dist/promise/index.js`, `./effect`, `./tui`, `./host`, `./*` | Два флейвора API; план использует **promise** (дефолтный подпуть `.`) |
| npm registry | — | Пакета `opencode` нет (404); `@opencode-ai/plugin` latest = `1.18.34`; `@opencode/sdk@2.0.21` существует | V1 и V2 — разные npm-скоупы, могут стоять рядом |
| git | — | `main` = `origin/main` = `c74bfca`; ветки `main`, `pr3-temp`, `_pr2-temp`; `origin/fix/retry-agent-model-preservation`; ветки `feature/*` нет | Точка ответвления и имя новой ветки |
| git | — | `git status --short`: ` M README.md`, `?? .omo/` | Грязное дерево на старте → T0.1 обязана это учесть |
| baseline | — | `npx tsc --noEmit` → exit 0; `npx vitest run` → `Test Files 1 passed (1)` / `Tests 40 passed (40)` | Эталон для всех acceptance criteria |

---

## 3. Целевая архитектура

```
src/
  shared.ts     ← НОВЫЙ. Чистая логика, 0 импортов из SDK.
                  parseMaxRetryWaitMs, armMargin, isUsageLimitMessage,
                  DEFAULT_MAX_RETRY_WAIT_MS, RETRY_MIN_REMAINING_MS, MAX_AUTOMATIC_BOUNCES
  index.ts      ← V1 (существующий). Импортирует из ./shared.js. Поведение не меняется.
  v2.ts         ← НОВЫЙ. Plugin.define({id:"retry-now", setup(ctx){...}}).
                  session.hook("retry") для cap + command.transform для retry-now.
test/
  retry-now-plugin.test.ts  ← существующий, 40 тестов, НЕ меняется
  shared.test.ts            ← НОВЫЙ, юнит-тесты чистых функций
  v2-plugin.test.ts         ← НОВЫЙ, тесты V2 через мок Context
```

package.json `exports`:
```json
"exports": {
  ".":    { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
  "./v2": { "types": "./dist/v2.d.ts",    "import": "./dist/v2.js"    }
}
```
`main`/`types` остаются (fallback для старых резолверов).

### Почему V2 проще V1

| Задача | V1 (текущий код) | V2 |
|---|---|---|
| Узнать про retry | событие `session.status` + `retryStatus()` валидация | хук `retry` с типизированным `SessionRetry` |
| Ограничить ожидание | `setTimeout(cap)` → `status()` → drift-guard → `abort()` → `promptAsync()` | `input.decision.delay = cap` |
| Сохранить agent/model | обход истории сообщений (`src/index.ts:42-98`) | `input.agent`, `input.model` уже в хуке |
| Бюджет попыток | `automaticBounces` Map + `bouncesInFlight` Set | `input.attempt` |
| Детект usage-limit | regex по `status.message` + `status.action` | `input.error` (структура — T1.2) |
| Отмена | `dispose` хук | `Cleanup` из `setup` + `registration.dispose()` |

---

## 4. Волны и порядок зависимостей

```
Wave 0 (ветка + baseline)
   └─> Wave 1 (закрытие неизвестностей V2 API)   ← ГЕЙТ: без него Wave 3 не начинается
         ├─> Wave 2 (shared-слой)   ──┐
         └─────────────────────────────┴─> Wave 3 (V2-плагин) ─> Wave 4 (упаковка + докс + PR)
```

Wave 2 формально не зависит от Wave 1 (чистые функции без SDK), поэтому T2.1–T2.3 и T1.2 могут идти параллельно. Wave 3 требует и Wave 1, и Wave 2.

---

## 5. Todos

### Wave 0 — ветка и baseline

---

#### T0.1 — Создать ветку `feature/opencode-v2-support` от `main`

**What to do:**
1. Выполнить `cd /home/openchamber/workspaces/opencode_retrypush && git --no-pager status --short` — зафиксировать вывод.
2. Убедиться, что текущая ветка `main` и она равна `origin/main`: `git --no-pager rev-parse --abbrev-ref HEAD` → `main`; `git --no-pager rev-parse HEAD origin/main` → две одинаковые SHA (`c74bfca...`).
3. Создать и переключиться: `git checkout -b feature/opencode-v2-support`.
4. Подтвердить: `git --no-pager rev-parse --abbrev-ref HEAD` → `feature/opencode-v2-support`.
5. Опубликовать ветку: `git push -u origin feature/opencode-v2-support`. Если push не проходит без интерактивного ввода — остановиться и сообщить, ветка остаётся локальной, работа продолжается.

**Must NOT do:**
- НЕ делать `git stash`, `git checkout -- .`, `git reset` — локальное изменение ` M README.md` переносится на новую ветку как есть (`git checkout -b` сохраняет рабочее дерево).
- НЕ коммитить `.omo/` (не отслеживается намеренно; `?? .omo/` в status — нормально).
- НЕ ответвляться от `pr3-temp`, `_pr2-temp` или `origin/fix/retry-agent-model-preservation`.
- НЕ создавать ветку с именем `feat/...`, `v2`, `dev` — имя зафиксировано: `feature/opencode-v2-support` (git-flow: `feature/<scope>` для новой функциональности).

**Parallelization:** Строго последовательно, шаги 1→5. Блокирует все остальные todos.

**References:**
- git-состояние: `main` = `origin/main` = `c74bfca feat: add configurable automatic retry wait cap`
- грязное дерево: ` M README.md`, `?? .omo/`
- существующие ветки: `main`, `pr3-temp` (=c74bfca), `_pr2-temp` (=bdbee10), `origin/fix/retry-agent-model-preservation` (=bdbee10)

**Recommended task executor category:** `junior`

**Acceptance criteria:**
- `git --no-pager rev-parse --abbrev-ref HEAD` печатает ровно `feature/opencode-v2-support`.
- `git --no-pager rev-parse feature/opencode-v2-support` равен `git --no-pager rev-parse main` (ветка создана без лишних коммитов).
- `git --no-pager status --short` по-прежнему содержит ` M README.md` (локальное изменение не потеряно).
- `git --no-pager branch --list 'feature/*'` печатает `* feature/opencode-v2-support`.

**QA scenarios:**
1. `git --no-pager log --oneline -1` → `c74bfca feat: add configurable automatic retry wait cap`.
2. `git --no-pager diff --stat main..feature/opencode-v2-support` → пустой вывод (0 коммитов разницы).
3. Если шаг 5 (`push`) завершился ошибкой — в отчёте явно написано «ветка только локальная, upstream не настроен», и это не считается провалом todo.

**Commit:** Коммита нет (создание ветки). Первый коммит появится в T1.1.

---

#### T0.2 — Зафиксировать baseline health-check в ветке

**What to do:**
1. `npx tsc --noEmit` — записать exit-код и полный вывод.
2. `npx vitest run` — записать итоговые строки `Test Files` и `Tests`.
3. Записать результаты в `.omo/notes/baseline-feature-branch.md` (создать каталог `.omo/notes/` при необходимости): команда, exit-код, дословная итоговая строка, дата.

**Must NOT do:**
- НЕ править код, тесты, конфиги на этом шаге — это чистое измерение.
- НЕ запускать `npm install` до T1.1 (это изменит `node_modules` и смажет baseline).
- НЕ добавлять `.omo/notes/` в git.

**Parallelization:** Шаги 1 и 2 независимы, могут идти параллельно. Шаг 3 — после обоих.

**References:**
- ожидаемый эталон: `npx tsc --noEmit` → exit 0, пустой вывод
- ожидаемый эталон: `npx vitest run` → `Test Files  1 passed (1)`, `Tests  40 passed (40)`, duration ~577ms
- ожидаемый шум: тест «continues retrying other sessions when one session fails» (`test/retry-now-plugin.test.ts:171`) печатает в stderr `[retry-now] remote session retry: Error: session unavailable` — это by design, не ошибка

**Recommended task executor category:** `junior`

**Acceptance criteria:**
- `npx tsc --noEmit` → exit-код 0 и пустой stdout/stderr.
- `npx vitest run` → строка `Tests  40 passed (40)` и строка `Test Files  1 passed (1)`.
- Файл `.omo/notes/baseline-feature-branch.md` существует и содержит обе дословные итоговые строки.

**QA scenarios:**
1. Если `tsc` вернул ненулевой код — остановиться, не начинать Wave 1, сообщить полный вывод: baseline сломан, и это надо разобрать до миграции.
2. Если число тестов ≠ 40 — остановиться и сообщить фактическое число; весь план опирается на 40 как на эталон.
3. Единственный допустимый stderr-вывод — строка `[retry-now] remote session retry:` из теста на строке 171. Любой другой stderr фиксируется в заметке.

**Commit:** Коммита нет (`.omo/` не отслеживается).

---

### Wave 1 — закрытие неизвестностей V2 API

---

#### T1.1 — Установить V2-пакеты в devDependencies, разрешив конфликт peer-зависимостей

**What to do:**
1. Попытка №1: `npm install --save-dev --save-exact @opencode/plugin@2.0.21 @opencode/client@2.0.21`.
2. Если установка падает с `ERESOLVE` (ожидаемо из-за peerDeps `solid-js`, `@opentui/core`, `@opentui/solid`, `@opencode/theme`) — попытка №2: тот же install с `--legacy-peer-deps`.
3. Зафиксировать в `package.json`: V2-пакеты в `devDependencies` с точными версиями `2.0.21`.
4. Добавить в `package.json` блок, делающий V2 опциональным для потребителей:
```json
"peerDependencies": {
  "@opencode-ai/plugin": ">=1.15.7",
  "@opencode/plugin": ">=2.0.21"
},
"peerDependenciesMeta": {
  "@opencode-ai/plugin": { "optional": true },
  "@opencode/plugin": { "optional": true }
}
```
5. Если потребовался `--legacy-peer-deps` — создать в корне `.npmrc` со строкой `legacy-peer-deps=true` и закоммитить его, чтобы `npm install` воспроизводился у других.
6. Проверить: `ls -d node_modules/@opencode/plugin node_modules/@opencode/client`.

**Must NOT do:**
- НЕ добавлять блок `dependencies` — у плагина не должно быть runtime-зависимостей.
- НЕ использовать `--force` (он игнорирует и реальные конфликты версий, не только peer-предупреждения).
- НЕ устанавливать `solid-js`, `@opentui/core`, `@opentui/solid`, `@opencode/theme` — это TUI-peer'ы хоста, плагину они не нужны.
- НЕ обновлять `@opencode-ai/plugin`/`@opencode-ai/sdk` (V1 остаётся на `^1.18.34`).
- НЕ переходить на `@opencode/plugin/effect` — план использует promise-флейвор (подпуть `.`).

**Parallelization:** Шаги 1→2 последовательны (2 только при провале 1). Шаги 3–4 можно делать одной правкой `package.json`. Шаг 6 — последним.

**References:**
- `package.json:21-27` — текущий блок devDependencies (5 пакетов), нет `dependencies`/`peerDependencies`
- npm registry: `@opencode/plugin@2.0.21` peerDependencies `solid-js >=1.9.0`, `@opentui/core >=0.5.14`, `@opentui/solid >=0.5.14`, `@opencode/theme 2.0.21`
- npm registry: `@opencode/plugin@2.0.21` dependencies `zod 4.1.8`, `effect 4.0.0-rc.112`, `@opencode/ai 2.0.21`, `@opencode/util 2.0.21`, `@ai-sdk/provider 3.0.8`, `@opencode/client 2.0.21`, `@opencode/schema 2.0.21`, `@opencode/protocol 2.0.21`, `@standard-schema/spec 1.1.0`
- README.md секция Requirements: `@opencode-ai/plugin ≥ 1.15.7` — источник нижней границы для V1 peer-диапазона

**Recommended task executor category:** `junior`

**Acceptance criteria:**
- `ls -d node_modules/@opencode/plugin` → путь существует.
- `node -e "console.log(require('./node_modules/@opencode/plugin/package.json').version)"` → `2.0.21`.
- `node -e "const p=require('./package.json'); console.log(JSON.stringify({dep:p.dependencies, dev:Object.keys(p.devDependencies), peerMeta:p.peerDependenciesMeta}))"` → `dep` равен `undefined`, `dev` содержит `@opencode/plugin` и `@opencode/client`, `peerMeta` помечает оба peer'а `optional: true`.
- `npx tsc --noEmit` → exit 0 (установка новых типов не сломала существующую компиляцию).
- `npx vitest run` → `Tests  40 passed (40)`.

**QA scenarios:**
1. Чистая воспроизводимость: `rm -rf node_modules && npm install` завершается с exit 0. Если нужен `.npmrc` с `legacy-peer-deps=true` — он в репозитории, и повторный install проходит без ручных флагов.
2. Если `npm install` не проходит ни с флагом, ни без — зафиксировать полный текст ERESOLVE и перейти на fallback: НЕ устанавливать пакет, а вендорить type-only декларации в `src/types/opencode-v2.d.ts` (скопировать нужные интерфейсы из `/tmp/v2probe/package/dist/promise/{plugin,session,command,event,registration}.d.ts`), добавив `declare module "@opencode/plugin"`. В этом случае T3.1 пишется против вендоренных типов, а в README отмечается, что V2-зависимость — только peer.
3. `npm ls @opencode/plugin` не печатает `UNMET PEER DEPENDENCY` для нашего собственного пакета.

**Commit:** `chore(deps): add opencode v2 plugin and client as dev dependencies`

---

#### T1.2 — Закрыть остаточные неизвестности V2 API и записать факты

**What to do:**
1. Прочитать из установленного пакета (или из `/tmp/v2probe` при fallback) точные определения:
   - `SessionError.Error` — из `@opencode/schema` (грепать `node_modules/@opencode/schema/dist` по `SessionError`): нужны поля, позволяющие отличить usage-limit/free-limit от обычного rate-limit (аналог `src/index.ts:190-193`).
   - `Model.Ref` и `Agent.ID` — форма (строка? объект `{providerID, modelID}`?).
   - `PromptInput.Prompt` — форма prompt'а для `CommandInvocation.prompt` и `ctx.session.prompt`.
   - `SessionPromptInput`, `SessionContextInput`, `SessionInterruptInput` — обязательные поля.
   - `SessionActive` и `V2Event` — форма (нужны только если команда `retry-now` будет опрашивать активность).
   - `SessionInbox.Delivery` — форма, т.к. фигурирует в `CommandInvocation`.
2. Записать результаты в `.omo/notes/v2-api-facts.md`: для каждого типа — `путь:строки` + дословный фрагмент `.d.ts`.
3. Для каждого типа, который найти не удалось, записать строку `НЕ НАЙДЕНО` + что именно грепали. Такие типы в `src/v2.ts` обрабатываются защитно: narrowing через `typeof`/`in`, без приведения к выдуманной форме.
4. По итогам заметки зафиксировать **одно** решение: реализует ли V2-команда `retry-now` полный remote-replay (как V1 `"command.execute.before"`, `src/index.ts:342-404`) или только текущую сессию. Критерий: если `SessionActive`/`session.active()` даёт надёжный способ перечислить сессии в состоянии retry — полный вариант; иначе — только текущая сессия, с явной записью ограничения в README.

**Must NOT do:**
- НЕ писать `src/v2.ts` на этом шаге.
- НЕ использовать `any` для типов, которые найдены — только для тех, что помечены `НЕ НАЙДЕНО`, и с комментарием-ссылкой на заметку.
- НЕ выводить форму типа из названия. Либо дословная цитата из `.d.ts`, либо `НЕ НАЙДЕНО`.
- НЕ лезть в `dist/effect/*` для определения runtime-контракта — промис-флейвор авторитетен для нашего кода (effect-файлы допустимы только как источник имён типов).

**Parallelization:** Пункты 1a–1g независимы и грепаются параллельно. Пункты 2–4 — после.

**References:**
- `/tmp/v2probe/package/dist/promise/session.d.ts:1-146` — `SessionRetry {sessionID; agent: Agent.ID; model: Model.Ref; error: SessionError.Error; attempt: number; decision: SessionRetryDecision}`
- `/tmp/v2probe/package/dist/promise/command.d.ts:1-23` — `CommandInvocation {sessionID; prompt: PromptInput.Prompt; delivery: SessionInbox.Delivery}`
- `/tmp/v2probe/client/package/dist/promise/client.d.ts:31-100` — `session.active/context/interrupt/prompt`
- `/tmp/v2probe/client/package/dist/promise/index.d.ts:1-6` — 6 строк ре-экспортов, `*Input`-типы не объявлены здесь
- `/tmp/v2probe/client/package/dist/effect/client.d.ts:2330` — упоминание `import("./api.js").SessionPromptInput` (зацепка для поиска)
- `src/index.ts:190-193` — V1-критерий usage-limit, который V2 должен воспроизвести по `input.error`

**Recommended task executor category:** `executor`

**Acceptance criteria:**
- Файл `.omo/notes/v2-api-facts.md` существует.
- В нём есть раздел для каждого из 7 типов из пункта 1, и каждый раздел содержит либо `путь:строки` + цитату, либо явное `НЕ НАЙДЕНО` + перечень выполненных grep-запросов.
- В файле есть раздел `## Решение по скоупу команды retry-now в V2` с одним из двух вариантов и обоснованием через конкретный тип.
- `grep -c 'НЕ НАЙДЕНО' .omo/notes/v2-api-facts.md` выполняется без ошибки (число — любое, важно, что помечено явно).

**QA scenarios:**
1. Для `SessionError.Error`: заметка отвечает на вопрос «какое выражение на TypeScript отличает usage-limit от rate-limit» — либо конкретным полем (например дискриминант `name`/`type`), либо выводом «различить нельзя, применяем regex по текстовому полю X как в V1».
2. Для `Model.Ref`: заметка показывает, можно ли передать `input.model` напрямую в `ctx.session.prompt` или нужна трансформация.
3. Проверка на отсутствие догадок: каждый не-`НЕ НАЙДЕНО` раздел содержит путь, начинающийся с `node_modules/` или `/tmp/v2probe/`.

**Commit:** Коммита нет (`.omo/` не отслеживается). Если создавался `src/types/opencode-v2.d.ts` по fallback из T1.1 — он коммитится здесь: `chore(types): vendor opencode v2 type declarations`.

---

### Wave 2 — shared-слой

---

#### T2.1 — Создать `src/shared.ts` с чистыми хелперами

**What to do:**
1. Создать `src/shared.ts` **без единого импорта** (ни type-, ни value-импортов из `@opencode-ai/*` / `@opencode/*`).
2. Экспортировать константы, дословно совпадающие с `src/index.ts:24-26`:
   - `export const DEFAULT_MAX_RETRY_WAIT_MS = 300_000;`
   - `export const RETRY_MIN_REMAINING_MS = 30_000;`
   - `export const MAX_AUTOMATIC_BOUNCES = 3;`
3. Экспортировать `parseMaxRetryWaitMs(options?: unknown): number | null`. **На вход идёт объект опций целиком** (не одно значение) — так же, как `maxRetryWaitMs(options?)` в `src/index.ts:166-171`, и так же, как его зовут все потребители: `parseMaxRetryWaitMs(options)` в V1 (T2.2) и `parseMaxRetryWaitMs(ctx.options)` в V2 (T3.1). Логика побитово повторяет `src/index.ts:166-171`:
   - читаем поле `maxRetryWaitMs` из объекта (если `options` не объект/`undefined`/`null` — считаем поле отсутствующим);
   - поле строго `=== false` → `null` (функция выключена);
   - поле не `number` или не `Number.isFinite(...)` (в т.ч. отсутствует, строка, `NaN`, `Infinity`) → `DEFAULT_MAX_RETRY_WAIT_MS`;
   - поле `> 0` → само значение;
   - иначе (`0`, отрицательное) → `null`.
   Внутри — ни одного обращения к полю без проверки типа `options` (под `strict: true` это обязательно, т.к. параметр `unknown`).
4. Экспортировать `armMargin(cap: number | null): number` — формула из `src/index.ts:211`: `cap === null ? 0 : Math.min(RETRY_MIN_REMAINING_MS, Math.max(1, cap / 2))`.
5. Экспортировать `isUsageLimitMessage(message: unknown): boolean` — regex-часть из `src/index.ts:190-193`: `typeof message === "string" && /usage limit|free limit/i.test(message)`.
6. Экспортировать `export type AgentModel = { providerID: string; modelID: string };` (форма из `src/index.ts:28-32`).
7. Экспортировать `shouldCapDelay(delayMs: number, cap: number | null): boolean` — `cap !== null && delayMs > cap` (V2-предикат; V1 его не использует).

**Must NOT do:**
- НЕ менять числовые значения, границы сравнений (`>` vs `>=`), порядок проверок — любая правка меняет V1-поведение.
- НЕ импортировать ничего. Файл обязан компилироваться в вакууме.
- НЕ добавлять логирование/`console.*` в shared.
- НЕ переносить сюда `toPromptParts`, `retryStatus`, `lastUserPrompt`, `replayPrompt` — они завязаны на V1-типы SDK и остаются в `index.ts`.
- НЕ править `src/index.ts` в этом todo (это T2.2).

**Parallelization:** Пункты 2–7 независимы внутри одного файла, пишутся одной правкой. Todo целиком параллелен T1.1/T1.2.

**References:**
- `src/index.ts:24-26` — три константы
- `src/index.ts:166-171` — `maxRetryWaitMs(options?)`, точная логика
- `src/index.ts:209-211` — вызов `maxRetryWaitMs(options)` и формула `retrySubstituteMargin`
- `src/index.ts:190-193` — `isUsageLimitRetry`, regex `/usage limit|free limit/i`
- `src/index.ts:28-32` — форма `{providerID, modelID}`
- `tsconfig.json:include` = `["src/**/*"]` — новый файл подхватывается автоматически

**Recommended task executor category:** `junior`

**Acceptance criteria:**
- Файл `src/shared.ts` существует.
- `grep -cE "^\s*import" src/shared.ts` → `0`.
- `npx tsc --noEmit` → exit 0.
- `npx vitest run` → `Tests  40 passed (40)` (новый файл ещё никем не используется, регрессии быть не может).
- Все **8** экспортов присутствуют. Проверка — по одному grep на имя, каждый обязан вернуть `1`:
  `for n in DEFAULT_MAX_RETRY_WAIT_MS RETRY_MIN_REMAINING_MS MAX_AUTOMATIC_BOUNCES parseMaxRetryWaitMs armMargin isUsageLimitMessage AgentModel shouldCapDelay; do printf '%s=%s\n' "$n" "$(grep -cE "^export (const|function|type) $n\b" src/shared.ts)"; done`
  → ожидаемый вывод: восемь строк, каждая вида `<имя>=1`. Любой `=0` — провал. (Regex-класс `[A-Za-z]+` здесь не годится: он не матчит `_` и обрывает `DEFAULT_MAX_RETRY_WAIT_MS` на `DEFAULT`.)

**QA scenarios:**
1. `node -e` против скомпилированного `dist/shared.js` (после `npx tsc`): `parseMaxRetryWaitMs({maxRetryWaitMs: false})` → `null`; `parseMaxRetryWaitMs({})` → `300000`; `parseMaxRetryWaitMs({maxRetryWaitMs: "abc"})` → `300000`; `parseMaxRetryWaitMs({maxRetryWaitMs: 0})` → `null`; `parseMaxRetryWaitMs({maxRetryWaitMs: -5})` → `null`; `parseMaxRetryWaitMs({maxRetryWaitMs: 10_000})` → `10000`; `parseMaxRetryWaitMs(undefined)` → `300000`.
2. `armMargin(null)` → `0`; `armMargin(300000)` → `30000`; `armMargin(10000)` → `5000`; `armMargin(1)` → `1` (ветка `Math.max(1, 0.5)`).
3. `isUsageLimitMessage("Usage limit reached")` → `true`; `isUsageLimitMessage("free LIMIT")` → `true`; `isUsageLimitMessage("rate limited")` → `false`; `isUsageLimitMessage(undefined)` → `false`.
4. `shouldCapDelay(600000, 300000)` → `true`; `shouldCapDelay(300000, 300000)` → `false` (граница не капается); `shouldCapDelay(600000, null)` → `false`.

**Commit:** `refactor: extract pure retry helpers into src/shared.ts`

---

#### T2.2 — Перевести `src/index.ts` на `src/shared.ts` без изменения поведения

**What to do:**
1. Добавить в `src/index.ts` импорт: `import { DEFAULT_MAX_RETRY_WAIT_MS, RETRY_MIN_REMAINING_MS, MAX_AUTOMATIC_BOUNCES, parseMaxRetryWaitMs, armMargin, isUsageLimitMessage } from "./shared.js";` (расширение `.js` обязательно — `moduleResolution: NodeNext`).
2. Удалить локальные объявления трёх констант (`src/index.ts:24-26`) и локальную функцию `maxRetryWaitMs` (`src/index.ts:166-171`).
3. Заменить вызов `maxRetryWaitMs(options)` (`src/index.ts:209`) на `parseMaxRetryWaitMs(options)`.
4. Заменить инлайн-формулу `retrySubstituteMargin` (`src/index.ts:211`) на `armMargin(retryWaitCap)`.
5. В `isUsageLimitRetry` (`src/index.ts:190-193`) заменить инлайн-regex на вызов `isUsageLimitMessage(status.message)`, сохранив приоритет проверки `status.action` первым.

**Must NOT do:**
- НЕ менять ни одну строку в `toPromptParts` (18-22), `lastUserPrompt` (42-98), `lastUserPromptParts` (101-141), `retryStatus` (173-188), `replayPrompt` (195-204), `fireRetry` (234-262), `scheduleRetry` (264-281), хуках (289-405).
- НЕ дедуплицировать `lastUserPrompt`/`lastUserPromptParts` — вне скоупа.
- НЕ удалять комментарий-инвариант `src/index.ts:283-288`.
- НЕ менять `export default plugin;` (408).
- НЕ править ни один тест. Если тест упал — откатить правку, а не подгонять тест.
- НЕ использовать импорт без `.js` (сломает NodeNext-резолв в скомпилированном `dist`).

**Parallelization:** Шаги 1–5 — одна правка одного файла, последовательно. Требует завершённый T2.1.

**References:**
- `src/index.ts:24-26` — удаляемые константы
- `src/index.ts:166-171` — удаляемая `maxRetryWaitMs`
- `src/index.ts:190-193` — `isUsageLimitRetry`, точка подстановки `isUsageLimitMessage`
- `src/index.ts:209-211` — точки подстановки `parseMaxRetryWaitMs` и `armMargin`
- `src/index.ts:234-262`, `264-281` — потребители `MAX_AUTOMATIC_BOUNCES` и `retrySubstituteMargin`, остаются как есть
- `tsconfig.json`: `module: NodeNext`, `moduleResolution: NodeNext` — требует `.js` в относительных импортах
- `test/retry-now-plugin.test.ts:713` — тест кастомного cap; `:732` — тест «16s натив → 10s cap»; оба прямо проверяют формулы

**Recommended task executor category:** `junior`

**Acceptance criteria:**
- `npx tsc --noEmit` → exit 0.
- `npx vitest run` → `Tests  40 passed (40)`, `Test Files  1 passed (1)`.
- `grep -cE "DEFAULT_MAX_RETRY_WAIT_MS = |RETRY_MIN_REMAINING_MS = |MAX_AUTOMATIC_BOUNCES = " src/index.ts` → `0` (константы больше не объявляются локально).
- `grep -c 'from "./shared.js"' src/index.ts` → `1`.
- `grep -c 'usage limit|free limit' src/index.ts` → `0` (regex переехал).
- `git --no-pager diff --stat src/index.ts` показывает только удаления дублей и строки подстановки; число изменённых строк ≤ 20.

**QA scenarios:**
1. Прогон полного набора после правки: ожидается ровно `40 passed`, ни одного `skipped`/`failed`.
2. Точечно те тесты, что задевают формулы: `npx vitest run -t "custom cap"` и `npx vitest run -t "cap"` → все найденные проходят.
3. `npx tsc && node -e "import('./dist/index.js').then(m => console.log(typeof m.default))"` → `function` (скомпилированный бандл резолвит `./shared.js` в рантайме).
4. Поведенческая эквивалентность на границе: тест `test/retry-now-plugin.test.ts:732` («16s натив → 10s cap») проходит — он прямо зависит от `armMargin(10000) === 5000`.

**Commit:** `refactor: wire V1 plugin to shared retry helpers`

---

#### T2.3 — Добавить `test/shared.test.ts`

**What to do:**
1. Создать `test/shared.test.ts`, импорт: `import { ... } from "../src/shared";` (как в существующем тесте: `test/retry-now-plugin.test.ts:1` импортирует `../src/index` без расширения — vitest это резолвит).
2. Покрыть `parseMaxRetryWaitMs`: `false` → `null`; `{}` → `300000`; `undefined` → `300000`; строка → `300000`; `NaN` → `300000`; `Infinity` → `300000`; `0` → `null`; отрицательное → `null`; положительное → само значение.
3. Покрыть `armMargin`: `null` → `0`; `300000` → `30000`; `60000` → `30000` (срабатывает `Math.min`); `10000` → `5000`; `2` → `1`; `1` → `1` (срабатывает `Math.max(1, ...)`).
4. Покрыть `isUsageLimitMessage`: обе ветки regex, регистронезависимость, `undefined`, `null`, не-строка, пустая строка, «rate limit» → `false`.
5. Покрыть `shouldCapDelay`: `delay > cap` → `true`; `delay === cap` → `false`; `delay < cap` → `false`; `cap === null` → `false`.
6. Покрыть константы: три `expect(...).toBe(...)` на точные значения `300000`, `30000`, `3` — чтобы случайное изменение значения ломало тест.

**Must NOT do:**
- НЕ использовать fake timers — функции синхронные и без времени.
- НЕ мокать ничего.
- НЕ править `test/retry-now-plugin.test.ts`.
- НЕ тестировать через приватные/внутренние пути `src/index.ts` — только публичный API `shared.ts`.

**Parallelization:** Пункты 2–6 независимы, пишутся как отдельные `describe`-блоки в одном файле. Требует T2.1 (не T2.2).

**References:**
- `test/retry-now-plugin.test.ts:1` — стиль импорта из `../src/...`
- `test/retry-now-plugin.test.ts:90-92` — шаблон `afterEach`
- `src/shared.ts` (создаётся в T2.1) — тестируемый модуль
- `src/index.ts:166-171`, `:209-211`, `:190-193` — источники эталонного поведения
- `package.json:9` — `test: vitest run`

**Recommended task executor category:** `junior`

**Acceptance criteria:**
- Файл `test/shared.test.ts` существует.
- `npx vitest run` → `Test Files  2 passed (2)` и `Tests` строго больше 40 (40 прежних + новые), ни одного падения.
- `npx vitest run test/retry-now-plugin.test.ts` → `Tests  40 passed (40)` (изоляция: новый файл не влияет на старый).
- Все 4 функции и 3 константы из `shared.ts` упомянуты в тесте: `grep -c 'parseMaxRetryWaitMs\|armMargin\|isUsageLimitMessage\|shouldCapDelay' test/shared.test.ts` ≥ 4.

**QA scenarios:**
1. Мутационная проверка: временно изменить в `src/shared.ts` `DEFAULT_MAX_RETRY_WAIT_MS` на `300_001` → `npx vitest run test/shared.test.ts` падает. Вернуть значение, тест снова зелёный.
2. Мутационная проверка границы: временно заменить `shouldCapDelay` на `delayMs >= cap` → тест `delay === cap` падает. Вернуть.
3. Мутационная проверка `armMargin`: временно убрать `Math.max(1, ...)` → падает кейс `cap = 1`. Вернуть.

**Commit:** `test: cover pure retry helpers in src/shared.ts`

---

### Wave 3 — V2-плагин

---

#### T3.1 — Создать `src/v2.ts`: точка входа + cap через `session.hook("retry")`

**What to do:**
1. Создать `src/v2.ts`. Импорты: `import { Plugin } from "@opencode/plugin";` и `import { parseMaxRetryWaitMs, shouldCapDelay, isUsageLimitMessage, MAX_AUTOMATIC_BOUNCES } from "./shared.js";`.
2. Экспортировать default: `Plugin.define({ id: "retry-now", setup: async (ctx) => { ... } })`.
3. Внутри `setup`: `const cap = parseMaxRetryWaitMs(ctx.options);`. Если `cap === null` — **не регистрировать retry-хук** (автоматический cap выключен), но `setup` обязан продолжить работу и зарегистрировать команду `retry-now` (T3.2). Это паритет с V1: там `maxRetryWaitMs: false` гасит только автоматику (`scheduleRetry` выходит на `cap === null`, `src/index.ts:265`), а хук команды `"command.execute.before"` регистрируется безусловно (`src/index.ts:342-404` лежит вне ветки cap). Ручной `retry-now` — главная функция плагина и не должна исчезать от выключения cap'а.
4. Зарегистрировать `const reg = await ctx.session.hook("retry", (input) => { ... })`. Внутри колбэка, по порядку:
   - если `input.decision.retry !== true` — выйти, ничего не мутируя;
   - если retry вызван usage-limit (критерий из `.omo/notes/v2-api-facts.md`, T1.2) — выйти, не капать;
   - если `input.attempt >= MAX_AUTOMATIC_BOUNCES` — выйти, не капать (исчерпан бюджет);
   - если `shouldCapDelay(input.decision.delay, cap)` — присвоить `input.decision.delay = cap`.
5. Собрать `Cleanup`: массив всех `Registration`, функция возврата вызывает `await r.dispose()` для каждого, с индивидуальным `try/catch` и `console.error("[retry-now] ...")` — чтобы один упавший dispose не блокировал остальные.
6. Весь колбэк обернуть в `try/catch` с `console.error` и префиксом `[retry-now]` — исключение из нашего хука не должно валить сессию хоста (паттерн из `src/index.ts:289-331`).

**Must NOT do:**
- НЕ вызывать `ctx.session.active()`, `ctx.session.context()`, `ctx.session.prompt()`, `ctx.session.get()` или любой другой сессионный API **синхронно внутри `setup`** — это прямой аналог V1-дедлока из `src/index.ts:283-288` (ре-вход в bootstrap-lock).
- НЕ воспроизводить V1-машинерию: ни `setTimeout`, ни `Map` таймеров, ни `abort`+replay. Cap в V2 — только мутация `decision.delay`.
- НЕ мутировать `input.sessionID`, `input.agent`, `input.model`, `input.error`, `input.attempt` — они `readonly`.
- НЕ подменять весь объект `input.decision` новым (`input.decision = {...}`) без необходимости: мутируется поле `delay` у существующего объекта, чтобы не потерять другие поля варианта `{retry: true}`.
- НЕ использовать `@opencode/plugin/effect`.
- НЕ импортировать ничего из `@opencode-ai/*` в `v2.ts` (V1-типы несовместимы).
- НЕ регистрировать команду в этом todo (это T3.2).
- НЕ делать ранний `return` из `setup` при `cap === null`. Выключение cap'а гасит **только** retry-хук; остальная часть `setup` (регистрация команды в T3.2) должна выполняться. Ранний выход = регрессия относительно V1.
- НЕ использовать `any` для типов, задокументированных в `.omo/notes/v2-api-facts.md`.

**Parallelization:** Шаги 1–3 последовательны. Шаги 4 и 5 можно писать параллельно (разные участки файла), затем шаг 6 оборачивает. Требует T1.1, T1.2, T2.1.

**References:**
- `/tmp/v2probe/package/dist/promise/plugin.d.ts:1-60` — `Plugin.define`, `Context`, `Cleanup`, `ctx.options`, `ctx.session`
- `/tmp/v2probe/package/dist/promise/session.d.ts:1-146` — `SessionRetry {sessionID; agent; model; error; attempt; decision}`, `SessionRetryDecision = {retry:false} | {retry:true; delay:number}`, `SessionDomain.hook`
- `/tmp/v2probe/package/dist/promise/registration.d.ts:1-13` — `Registration {dispose}`, `ModelHooks<Spec>` возвращает `Promise<Registration>`
- `/tmp/v2probe/package/dist/options.d.ts:1` — `PluginOptions = Readonly<Record<string, any>>`, валидация на нашей стороне обязательна
- `src/index.ts:283-288` — инвариант «нет сессионных вызовов в фабрике»
- `src/index.ts:289-331` — паттерн глушения исключений в хуке
- `src/index.ts:144-150` — префикс лога `[retry-now]`
- `.omo/notes/v2-api-facts.md` (T1.2) — критерий usage-limit и форма `SessionError.Error`

**Recommended task executor category:** `executor`

**Acceptance criteria:**
- Файл `src/v2.ts` существует.
- `npx tsc --noEmit` → exit 0 (в т.ч. под `strict: true`).
- `npx vitest run` → все прежние тесты проходят, `Tests` ≥ прежнего числа, 0 падений.
- `grep -cE "setTimeout|setInterval" src/v2.ts` → `0`.
- `grep -cE 'from "@opencode-ai/' src/v2.ts` → `0`.
- `grep -c 'Plugin.define' src/v2.ts` → `1`.
- `npx tsc && ls dist/v2.js dist/v2.d.ts` → оба файла существуют.

**QA scenarios:** (детальные тесты — в T3.3; здесь — быстрые проверки)
1. `node -e "import('./dist/v2.js').then(m => console.log(m.default.id, typeof m.default.setup))"` → `retry-now function`.
2. Статическая проверка инварианта: `grep -nE "ctx\.session\.(active|context|prompt|get|interrupt)" src/v2.ts` — каждое найденное вхождение должно находиться внутри тела колбэка хука или `execute` команды, а не в прямом теле `setup`. Проверяется чтением найденных строк.
3. Под `strict` компилятор обязан потребовать narrowing перед доступом к `input.decision.delay` (поле есть только в варианте `{retry: true}`) — если `tsc` молчит без narrowing, значит narrowing написан неверно или подавлен; `grep -c "@ts-ignore\|@ts-expect-error\|as any" src/v2.ts` → `0`.

**Commit:** `feat(v2): add opencode v2 entry point with native retry delay cap`

---

#### T3.2 — Зарегистрировать команду `retry-now` в `src/v2.ts` через `ctx.command.transform`

**What to do:**
1. В `setup` (после регистрации retry-хука) добавить: `const cmdReg = await ctx.command.transform((editor) => { editor.add({ name: "retry-now", description: "...", execute: async (invocation) => { ... } }); });`
2. `description` — короткая строка, согласованная с текстом в `commands/retry-now.md`.
3. Реализовать `execute` в объёме, выбранном в T1.2 (пункт 4):
   - **вариант «только текущая сессия»**: взять `invocation.sessionID`, прервать текущую генерацию через `ctx.session.interrupt(...)`, затем повторно отправить последний user-prompt через `ctx.session.prompt(...)`, сохранив agent/model;
   - **вариант «полный»**: дополнительно перечислить сессии в retry через `ctx.session`-API и повторить для каждой, логируя отказы через `console.error("[retry-now] ...")` по образцу `logRejected` (`src/index.ts:144-150`).
4. Добавить `cmdReg` в массив `Registration` для `Cleanup` из T3.1.
5. Обернуть тело `execute` в `try/catch` с `console.error("[retry-now] ...")`.

**Must NOT do:**
- НЕ вызывать `ctx.command.transform` синхронно-блокирующе до того, как `setup` вернёт управление, если это требует сессионных запросов — сам `transform` допустим в `setup`, но внутри его колбэка нельзя делать сетевые вызовы (колбэк синхронный: `(input: CommandEditor) => void`).
- НЕ делать колбэк `transform` асинхронным: его тип — `(input: CommandEditor) => void`, возврат Promise будет проигнорирован.
- НЕ ставить регистрацию команды под условие `cap !== null`. Команда регистрируется всегда, включая `maxRetryWaitMs: false` (см. T3.1 шаг 3 и тест T3.3 шаг 6a).
- НЕ удалять и НЕ менять файл `commands/retry-now.md` — он нужен V1.
- НЕ менять V1-хук `"command.execute.before"` в `src/index.ts:342-404`.
- НЕ выдумывать поля `SessionInterruptInput`/`SessionPromptInput` — использовать только зафиксированные в `.omo/notes/v2-api-facts.md`. Если поле помечено `НЕ НАЙДЕНО`, реализовать минимальный путь (только текущая сессия) и записать ограничение в README (T4.2).
- НЕ воспроизводить V1-трюк с переиспользованием ID командной text-части (`src/index.ts:395-403`) — в V2 другой контракт команды.

**Parallelization:** Шаг 1–2 последовательно, шаг 3 — основная работа, шаги 4–5 после. Требует T3.1 и T1.2.

**References:**
- `/tmp/v2probe/package/dist/promise/command.d.ts:1-23` — `CommandDefinition {name; description?; execute}`, `CommandEditor.add`, `CommandDomain.transform: Transform<CommandEditor>`
- `/tmp/v2probe/package/dist/promise/registration.d.ts:11` — `Transform<Input> = (callback: (input: Input) => void) => Promise<Registration>` — колбэк **синхронный**
- `/tmp/v2probe/client/package/dist/promise/client.d.ts:31-100` — `session.interrupt`, `session.prompt`, `session.context`, `session.active`
- `src/index.ts:342-404` — V1-эталон поведения команды (что именно воспроизводим)
- `src/index.ts:144-150` — `logRejected`, формат лога
- `commands/retry-now.md` — источник текста `description`
- `.omo/notes/v2-api-facts.md` (T1.2) — формы input-типов и решение по скоупу

**Recommended task executor category:** `executor`

**Acceptance criteria:**
- `grep -c 'ctx.command.transform' src/v2.ts` → `1`.
- `grep -c '"retry-now"' src/v2.ts` → ≥ `1` (имя команды).
- `npx tsc --noEmit` → exit 0.
- `npx vitest run` → 0 падений.
- `grep -c "as any" src/v2.ts` → `0`.
- Массив `Registration` в `Cleanup` содержит и retry-хук, и команду: `grep -c 'dispose' src/v2.ts` ≥ `1`, и это подтверждается тестом из T3.3.

**QA scenarios:**
1. Мок-Context в тесте (T3.3): после `setup` счётчик вызовов `ctx.command.transform` равен `1`, и переданный колбэк при вызове с мок-`editor` делает ровно один `editor.add` с `name === "retry-now"`.
2. Вызов `execute` на мок-Context приводит к ожидаемой последовательности: `interrupt` вызван до `prompt`, и `prompt` получил agent/model исходной сессии.
3. Падение `interrupt` (мок бросает) не выбрасывает наружу: `await execute(...)` резолвится, а в `console.error` попадает строка с префиксом `[retry-now]`.

**Commit:** `feat(v2): register retry-now command through command.transform`

---

#### T3.3 — Добавить `test/v2-plugin.test.ts`

**What to do:**
1. Создать `test/v2-plugin.test.ts`. Импорт: `import v2Plugin from "../src/v2";`.
2. Написать харнесс `createV2Context({options, ...})` по образцу `createHook` (`test/retry-now-plugin.test.ts:56-80`), но мокающий **`Context`**, а не `client`: `vi.fn()` для `session.hook`, `command.transform`, `session.interrupt`, `session.prompt`; `options` как объект; возврат `{ctx, hooks, cleanup}` где `hooks` — собранная мапа `name → callback`, захваченная из `session.hook`. `session.hook` возвращает `{dispose: vi.fn()}`.
3. Тест инварианта запуска: после `await v2Plugin.setup(ctx)` **ни один** из `ctx.session.active/context/prompt/get/interrupt` не вызван (`expect(...).not.toHaveBeenCalled()`) — V2-аналог теста `test/retry-now-plugin.test.ts:453`.
4. Тест регистрации: `ctx.session.hook` вызван с первым аргументом `"retry"`.
5. Тесты cap-логики, вызывая захваченный колбэк с собранным `SessionRetry`-подобным объектом:
   - `decision = {retry: true, delay: 600000}`, cap 300000 → после вызова `delay === 300000`;
   - `decision = {retry: true, delay: 60000}`, cap 300000 → `delay === 60000` (не тронут);
   - `decision = {retry: true, delay: 300000}`, cap 300000 → `delay === 300000` (граница, не тронут);
   - `decision = {retry: false}` → объект не мутирован, свойства `delay` не появилось;
   - `attempt = 3` (= `MAX_AUTOMATIC_BOUNCES`), `delay = 600000` → `delay` остался `600000` (бюджет исчерпан);
   - `attempt = 2`, `delay = 600000` → `delay === 300000`;
   - usage-limit-ошибка (по критерию из T1.2), `delay = 600000` → `delay` не тронут.
6. Тест опций: `options = {maxRetryWaitMs: false}` → `ctx.session.hook` **не** вызван, но `ctx.command.transform` вызван ровно один раз (паритет с V1: выключение cap'а не убирает команду `retry-now`); `options = {maxRetryWaitMs: 10000}` → `delay = 60000` капается до `10000`.
6a. Тест паритета-выключения отдельным `it`: при `options = {maxRetryWaitMs: false}` колбэк, зарегистрированный в `command.transform`, всё равно добавляет команду `name === "retry-now"`, и `await cleanup()` резолвится без ошибок. Это прямая страховка от раннего `return` из `setup`.
7. Тест `Cleanup`: `const cleanup = await v2Plugin.setup(ctx); await cleanup();` → `dispose` каждого возвращённого `Registration` вызван ровно один раз.
8. Тест устойчивости: один `dispose` бросает → `await cleanup()` резолвится, остальные `dispose` всё равно вызваны.
9. Тест команды: `ctx.command.transform` вызван один раз; переданный колбэк с мок-`editor` добавляет команду `name === "retry-now"`; вызов её `execute` на мок-Context даёт порядок `interrupt` → `prompt`.
10. Тест глушения: колбэк хука с намеренно сломанным `input` (например `decision` = `null`) не выбрасывает исключение наружу.

**Must NOT do:**
- НЕ менять `test/retry-now-plugin.test.ts` и `test/shared.test.ts`.
- НЕ использовать fake timers — в V2-пути таймеров нет. Если в тесте появился `vi.useFakeTimers()`, значит в `src/v2.ts` просочилась V1-машинерия → вернуться к T3.1.
- НЕ импортировать реальный `@opencode/plugin` runtime в тест ради создания Context — Context мокается целиком.
- НЕ тестировать через реальную сеть/процесс OpenCode.
- НЕ ослаблять assertions до `toHaveBeenCalled()` там, где проверяется именно значение `delay`.

**Parallelization:** Шаг 1–2 (харнесс) — сначала. Затем шаги 3–10 независимы и пишутся параллельно как отдельные `it`. Требует T3.1 и T3.2.

**References:**
- `test/retry-now-plugin.test.ts:56-80` — `createHook`, шаблон мок-харнесса на `vi.fn()`
- `test/retry-now-plugin.test.ts:453` — тест «не вызывает session status при старте», образец для шага 3
- `test/retry-now-plugin.test.ts:86-88` — `retryStatus(next, attempt, extra)`, образец фабрики фикстур
- `test/retry-now-plugin.test.ts:90-92` — `afterEach`
- `test/retry-now-plugin.test.ts:713` — «кастомный cap», образец для шага 6
- `/tmp/v2probe/package/dist/promise/session.d.ts:1-146` — форма `SessionRetry`, которую воспроизводит фикстура
- `/tmp/v2probe/package/dist/promise/registration.d.ts:1-13` — `Registration.dispose`, образец мока
- `src/shared.ts` — `MAX_AUTOMATIC_BOUNCES = 3`, источник границы бюджета

**Recommended task executor category:** `executor`

**Acceptance criteria:**
- Файл `test/v2-plugin.test.ts` существует.
- `npx vitest run` → `Test Files  3 passed (3)`, 0 падений.
- `npx vitest run test/retry-now-plugin.test.ts` → `Tests  40 passed (40)` (V1 не затронут).
- `grep -c 'useFakeTimers' test/v2-plugin.test.ts` → `0`.
- Все 10 пунктов имеют соответствующий `it(...)`: `grep -cE "^\s*(it|test)\(" test/v2-plugin.test.ts` ≥ `12`.

**QA scenarios:**
1. Мутационная проверка cap: временно заменить в `src/v2.ts` присваивание на `input.decision.delay = cap * 2` → тест «600000 → 300000» падает. Вернуть.
2. Мутационная проверка границы: временно заменить `shouldCapDelay` на `>=` в `src/shared.ts` → падает и `test/shared.test.ts`, и кейс границы в `test/v2-plugin.test.ts`. Вернуть.
3. Мутационная проверка бюджета: временно убрать проверку `attempt >= MAX_AUTOMATIC_BOUNCES` → падает кейс `attempt = 3`. Вернуть.
4. Мутационная проверка инварианта запуска: временно добавить `await ctx.session.active()` в тело `setup` → падает тест шага 3. Убрать.
5. Мутационная проверка Cleanup: временно вернуть из `setup` `undefined` → падает тест шага 7. Вернуть.
6. Мутационная проверка паритета-выключения: временно поставить в `src/v2.ts` ранний `return` при `cap === null` (до регистрации команды) → падает тест шага 6a. Вернуть.

**Commit:** `test(v2): cover v2 retry cap, command registration and cleanup`

---

### Wave 4 — упаковка, документация, PR

---

#### T4.1 — Добавить `exports`-map и обновить сборку в `package.json`

**What to do:**
1. Добавить в `package.json` блок `exports` с двумя подпутями (`.` → `dist/index.js`, `./v2` → `dist/v2.js`), сохранив `main` и `types` как fallback.
2. Сохранить `files: ["dist","commands"]` — `dist` уже покрывает `v2.js`/`shared.js`.
3. Проверить, что `npm run build` (= `tsc`) выдаёт `dist/index.js`, `dist/shared.js`, `dist/v2.js` и соответствующие `.d.ts`.
4. Проверить содержимое публикуемого архива: `npm pack --dry-run`.

**Must NOT do:**
- НЕ удалять `main`/`types` (сломает старые резолверы и V1-регистрацию по прямому пути к файлу).
- НЕ менять `outDir`/`rootDir` в `tsconfig.json`.
- НЕ добавлять `exports` без ключа `types` в каждом подпути (сломает типы у потребителей под NodeNext).
- НЕ включать `src` или `test` в `files`.
- НЕ поднимать `version` (релиз — отдельное решение пользователя).

**Parallelization:** Шаги 1–2 — одна правка. Шаги 3–4 — проверки после. Требует T3.1.

**References:**
- `package.json:13-15` — `main: dist/index.js`, `types: dist/index.d.ts`, `files: ["dist","commands"]`
- `package.json:8-12` — scripts `build: tsc`, `prepublishOnly: npm run build`
- `tsconfig.json`: `outDir ./dist`, `rootDir ./src`, `declaration: true`, `include ["src/**/*"]`
- README.md секция Installation — регистрация V1 по абсолютному пути `file:///.../dist/index.js`, поэтому `main` обязан остаться

**Recommended task executor category:** `junior`

**Acceptance criteria:**
- `npm run build` → exit 0.
- `ls dist/index.js dist/index.d.ts dist/shared.js dist/shared.d.ts dist/v2.js dist/v2.d.ts` → все 6 файлов существуют.
- `node -e "const p=require('./package.json'); console.log(JSON.stringify(p.exports))"` печатает оба подпути, и у каждого есть ключи `types` и `import`.
- `node --input-type=module -e "import('./dist/v2.js').then(m=>console.log(m.default.id))"` → печатает ровно `retry-now`.
- `npm pack --dry-run` в списке файлов содержит `dist/v2.js`, `dist/shared.js`, `commands/retry-now.md` и **не** содержит `src/` или `test/`.

**QA scenarios:**
1. Резолв подпути из внешнего кода: во временном каталоге `node --input-type=module -e "import('<abs>/dist/v2.js').then(m=>console.log(typeof m.default.setup))"` → `function`.
2. `npx tsc --noEmit` → exit 0 после правки `package.json`.
3. `npx vitest run` → 0 падений (правка упаковки не влияет на тесты, но проверяется).

**Commit:** `build: expose v2 entry point through package exports map`

---

#### T4.2 — Обновить `README.md`: раздел про OpenCode V2

**What to do:**
1. В секцию Requirements добавить две строки: V1 — `@opencode-ai/plugin ≥ 1.15.7`; V2 — `@opencode/plugin ≥ 2.0.21`. Указать, что нужен ровно один из них.
2. Добавить новую секцию «Installation (OpenCode V2)» с:
   - форматом конфига V2 — массив `plugins` с объектами `{package, options}` (вместо V1-формы `"plugin": [[path, options]]`);
   - путём к V2-входу (`.../dist/v2.js` либо подпуть пакета `opencode-retry-now-plugin/v2`);
   - тем же ключом опций `maxRetryWaitMs` (default `300000`, `false` отключает);
   - явной заметкой: в V2 команда `retry-now` регистрируется плагином программно, копировать `commands/retry-now.md` не нужно (это шаг только для V1).
3. В секцию How It Works добавить подраздел о различии реализаций: V1 — таймер + прерывание + повторная отправка последнего сообщения; V2 — нативный retry-хук, который ограничивает задержку (`decision.delay`), без прерывания и повторной отправки.
4. Сохранить все существующие V1-разделы без правок по смыслу: How It Works (V1-часть), Installation (V1, 4 шага), Usage, Keyboard shortcut.
5. Если в T3.2 был выбран вариант «только текущая сессия» — добавить в V2-секцию строку-ограничение: команда в V2 действует на текущую сессию (в отличие от V1, который задевает и другие rate-limited сессии).
6. Если формат конфига V2 (`plugins` vs `plugin`) не подтверждён документацией/типами — пометить его как «подлежит подтверждению» и дать ссылку на зафиксированный источник вместо утверждения.

**Must NOT do:**
- НЕ удалять и НЕ переписывать V1-инструкцию по установке (4 шага: clone+build, регистрация в `~/.config/opencode/opencode.json`, копирование `commands/retry-now.md` в `~/.config/opencode/commands/`, restart).
- НЕ удалять формулу порога `cap + min(30s, max(1ms, cap/2))` и упоминание «максимум 3 автоматических ретрая на эпизод» — они описывают V1.
- НЕ удалять ссылку на opencode#5903 в секции Keyboard shortcut.
- НЕ утверждать формат конфига V2 как факт без источника (см. пункт 6).
- НЕ коммитить незавязанные локальные правки README, если ` M README.md` из T0.1 содержит что-то посторонние: сначала посмотреть `git --no-pager diff README.md` и описать, что там, в отчёте.

**Parallelization:** Пункты 1–3 независимы (разные секции). Пункты 4–6 — проверка/условные добавления. Требует T3.1, T3.2, T4.1.

**References:**
- `README.md` (3631 b) — секции: How It Works, Installation (4 шага), Usage, Requirements, Keyboard shortcut
- `README.md` Installation шаг 2 — V1-форма `"plugin": [["file:///home/openchamber/workspaces/opencode_retrypush/dist/index.js", {"maxRetryWaitMs":300000}]]`
- `README.md` Installation шаг 2 — описание `maxRetryWaitMs` (default 300000, `false` отключает), формула `cap + min(30s, max(1ms, cap/2))`, «максимум 3 автоматических ретрая»
- `README.md` Installation шаг 3 — копирование `commands/retry-now.md`, заметка про legacy-каталог `command/`
- `README.md` Requirements — `@opencode-ai/plugin ≥ 1.15.7`, Node ≥ 18
- `/tmp/v2probe/package/dist/promise/command.d.ts:1-23` — основание для утверждения «команда в V2 регистрируется кодом»
- `/tmp/v2probe/package/dist/promise/session.d.ts:1-146` — основание для описания V2-механики cap
- `package.json` `exports` (T4.1) — источник подпути `./v2`
- `git --no-pager status --short` из T0.1 — факт ` M README.md`

**Recommended task executor category:** `junior`

**Acceptance criteria:**
- `grep -c 'opencode/plugin' README.md` ≥ `1` (V2-пакет упомянут).
- `grep -c 'dist/v2.js\|/v2' README.md` ≥ `1` (V2-вход документирован).
- `grep -c '@opencode-ai/plugin' README.md` ≥ `1` (V1-требование сохранено).
- `grep -c 'commands/retry-now.md' README.md` ≥ `1` (V1-шаг 3 сохранён).
- `grep -c 'maxRetryWaitMs' README.md` ≥ `2` (опция описана и для V1, и для V2).
- `git --no-pager diff --stat README.md` показывает только добавления и правки внутри Requirements/How It Works; удалённых строк в V1-Installation нет (`git --no-pager diff README.md | grep -c '^-[^-]'` — все удаления объяснены в отчёте).

**QA scenarios:**
1. Читательский прогон: по README V2-пользователь получает (а) какой пакет нужен, (б) куда указать путь, (в) какой ключ опций, (г) что `commands/retry-now.md` копировать не нужно. Все четыре пункта присутствуют дословно.
2. Читательский прогон V1: инструкция из 4 шагов цела и по-прежнему ведёт к `dist/index.js`.
3. Проверка отсутствия ложных утверждений: каждое утверждение про V2 API в README либо соответствует зафиксированному `.d.ts`, либо помечено как «подлежит подтверждению».

**Commit:** `docs: document opencode v2 installation and retry cap behaviour`

---

#### T4.3 — Финальная верификация и подготовка PR

**What to do:**
1. `npx tsc --noEmit` — exit 0.
2. `npm run build` — exit 0, `dist` содержит 6 ожидаемых артефактов.
3. `npx vitest run` — 3 тест-файла, 0 падений, и `test/retry-now-plugin.test.ts` даёт ровно `40 passed`.
4. Чистая установка: `rm -rf node_modules && npm install && npx vitest run` — exit 0.
5. `git --no-pager status --short` — нет незакоммиченных изменений в отслеживаемых файлах (кроме осознанно оставленных; `?? .omo/` допустимо).
6. `git --no-pager log --oneline main..feature/opencode-v2-support` — список коммитов соответствует коммитам из todos.
7. Подготовить текст PR: что сделано (shared-слой, V2-вход, тесты, docs), что НЕ сделано (дедупликация `lastUserPrompt`/`lastUserPromptParts`; любые пункты, помеченные `НЕ НАЙДЕНО` в `.omo/notes/v2-api-facts.md`; ограничение скоупа команды V2, если выбран минимальный вариант), как проверено (команды + дословные итоговые строки).
8. Push ветки и создание PR — **только после явного подтверждения пользователя**.

**Must NOT do:**
- НЕ мержить в `main`.
- НЕ делать `git push --force`.
- НЕ создавать PR без подтверждения пользователя (внешнее действие).
- НЕ объявлять работу завершённой, если шаг 4 (чистая установка) не прошёл.
- НЕ скрывать и НЕ сглаживать упавшие проверки: любая неудача попадает в отчёт дословным выводом.

**Parallelization:** Шаги 1–3 последовательны, шаг 4 — после них, шаги 5–6 параллельны, шаг 7 — после. Шаг 8 — отдельно, по подтверждению.

**References:**
- `.omo/notes/baseline-feature-branch.md` (T0.2) — эталон, с которым сравнивается финал
- `.omo/notes/v2-api-facts.md` (T1.2) — источник списка остаточных неизвестностей для текста PR
- `package.json:8-12` — `build`, `test`, `prepublishOnly`
- `src/index.ts:101-141` — известное дублирование, осознанно оставленное вне скоупа
- git: базовая ветка для PR — `main` (`c74bfca`)

**Recommended task executor category:** `executor`

**Acceptance criteria:**
- `npx tsc --noEmit` → exit 0, пустой вывод.
- `npm run build` → exit 0; `ls dist/{index,shared,v2}.{js,d.ts}` → 6 файлов.
- `npx vitest run` → `Test Files  3 passed (3)`, 0 failed.
- `npx vitest run test/retry-now-plugin.test.ts` → `Tests  40 passed (40)` — V1 бит-в-бит как в baseline.
- `rm -rf node_modules && npm install` → exit 0; последующий `npx vitest run` → 0 падений.
- Текст PR содержит три раздела: «Сделано», «Не сделано / остаточные риски», «Как проверено» с дословными итоговыми строками.

**QA scenarios:**
1. Сверка с baseline: число V1-тестов в финале равно числу из `.omo/notes/baseline-feature-branch.md` (40). Расхождение — блокер.
2. Единственный допустимый stderr при прогоне — `[retry-now] remote session retry:` из `test/retry-now-plugin.test.ts:171` плюс намеренные `console.error` из негативных V2-тестов (каждый такой вывод соотнесён с конкретным тестом в отчёте).
3. Антипробник «грязное состояние»: `npm run build` после `rm -rf dist` даёт полный набор артефактов (сборка не зависит от остатков предыдущей).
4. Антипробник «ложный успех»: отдельно проверить exit-коды, а не только текст вывода — `npx vitest run; echo "exit=$?"` → `exit=0`. Зелёный текст при ненулевом коде трактуется как провал.

**Commit:** Отдельного коммита нет. При необходимости — `chore: finalize v2 support branch`.

---

## 6. Риски и реакции

| Риск | Вероятность | Реакция |
|---|---|---|
| `npm install @opencode/plugin` падает с ERESOLVE из-за TUI-peer'ов (`solid-js`, `@opentui/*`, `@opencode/theme`) | Высокая | T1.1 QA-2: `--legacy-peer-deps` + `.npmrc`; при полном провале — вендоренные type-only декларации, V2-зависимость остаётся только peer |
| Форма `SessionError.Error` не позволяет отличить usage-limit | Средняя | T1.2 фиксирует это явно; fallback — `isUsageLimitMessage` по текстовому полю ошибки (та же логика, что в V1) |
| `SessionPromptInput`/`SessionInterruptInput` не найдены в типах | Средняя | T3.2 реализует минимальный вариант (текущая сессия) и фиксирует ограничение в README (T4.2 пункт 5) |
| Правка `src/index.ts` в T2.2 ломает один из 40 тестов | Низкая | Acceptance T2.2 требует ровно `40 passed`; при падении — откат правки, а не правка теста |
| Формат конфига V2 (`plugins` vs `plugin`) в README указан неверно | Средняя | T4.2 пункт 6: помечать как «подлежит подтверждению», не утверждать без источника |
| Блокирующий вызов сессионного API в `setup` дедлочит старт OpenCode (V2-аналог `src/index.ts:283-288`) | Средняя | Тест T3.3 шаг 3 + статическая проверка T3.1 QA-2 |
| V2 `attempt` считается иначе, чем V1 `automaticBounces` (нумерация с 0 или с 1) | Средняя | T3.3 покрывает и `attempt = 2`, и `attempt = 3`; при расхождении семантики — уточнить по `.d.ts`/поведению и поправить границу, зафиксировав в PR |
| Экспорт-map ломает V1-установку по абсолютному пути | Низкая | T4.1 сохраняет `main`/`types`; T4.1 QA-1 проверяет резолв напрямую по пути файла |
| `maxRetryWaitMs: false` в V2 случайно отключает и команду `retry-now` (ранний `return` из `setup`) | Средняя | Запрет в T3.1/T3.2 «Must NOT do» + тест T3.3 шаг 6a + мутационная проверка T3.3 QA-6 |

---

## 7. Критерии готовности всей работы

1. Ветка `feature/opencode-v2-support` создана от `c74bfca` и содержит все коммиты работы.
2. `npx tsc --noEmit` → exit 0.
3. `npx vitest run` → 3 файла, 0 падений; `test/retry-now-plugin.test.ts` → ровно `40 passed`.
4. `npm run build` → `dist/{index,shared,v2}.{js,d.ts}` (6 артефактов).
5. `rm -rf node_modules && npm install` → exit 0 без ручных флагов (либо `.npmrc` в репозитории).
6. `package.json`: нет блока `dependencies`; V2-пакеты в `devDependencies`; peer'ы помечены `optional`.
7. `src/shared.ts` не содержит ни одного `import`.
8. `src/v2.ts` не содержит `setTimeout`/`setInterval`, импортов из `@opencode-ai/*`, `as any`, `@ts-ignore`.
9. README документирует установку и для V1, и для V2; V1-инструкция из 4 шагов цела.
10. `.omo/notes/v2-api-facts.md` существует, и каждая остаточная неизвестность в нём помечена явно.
11. При `maxRetryWaitMs: false` V2-плагин не регистрирует retry-хук, но команда `retry-now` по-прежнему регистрируется (паритет с V1), и это покрыто тестом.
12. Текст PR готов; PR создаётся только по подтверждению пользователя.

---

## 8. Статус старых планов

- `.omo/plans/retry-push-v1v2-agent-model-cap.md` — **УСТАРЕЛ**. Предполагал существующие `src/shared.ts`/`src/v2.ts` и 37 тестов. Из него перенесены формулы cap/margin/budget и fake-timer QA-сценарии (в T2.3/T3.3).
- `.omo/plans/v2-migration.md` — **УСТАРЕЛ**. Его догадки про V2 API опровергнуты разведкой (таблица опровержений — в разделе 2 настоящего плана и в истории разведки). Из него перенесена волновая структура.

Оба файла предлагается оставить на диске как исторический контекст; настоящий план их заменяет. Удаление — на усмотрение пользователя, в скоуп работы не входит.

---

## Critic review

**Verdict:** `[OKAY]` — с оговоркой о способе ревью (см. ниже).
**Раундов:** 1.
**Ревьюер:** планировщик (саморевью). **Внешний critic-сабагент был недоступен.**

### Честная оговорка о процедуре

Контракт требует ревью через `task(subagent_type="critic")`. В этой сессии инструмент `task` **не работает**: две попытки подряд завершились аварийно без вывода.

| Попытка | Вызов | Результат |
|---|---|---|
| 1 | `task(subagent_type="general", description="Review plan draft", ...)` | `Task aborted.` (session `ses_f096227a3ffe0oAzvWP12KVsvL`) |
| 2 | `task(subagent_type="explore", description="Review plan draft", ...)` | `Tool execution aborted` |

Типа `critic` в списке доступных `subagent_type` этой среды нет вообще (доступны: `benchbot`, `build`, `explore`, `general`, `Junior`, `librarian`, `lightweight-coder`, `phone-agent`, `plan`, `general-purpose`), поэтому первая попытка использовала `general` как ближайший аналог.

Вместо молчаливого пропуска шага проведено **адверсариальное саморевью** черновика (`.omo/drafts/opencode-v2-support.md`, 818 строк, прочитан целиком) по тем же 8 критериям, которые предназначались критику: наличие всех подсекций в каждом todo; размер todo 1–2 файла; Reference Fact Table; создание ветки первым шагом; отсутствие размытых формулировок; явный порядок волн; decision-completeness; отсутствие догадок, выданных за факты.

**Это слабее независимого ревью.** Саморевью не ловит ошибки, встроенные в собственную модель задачи. Рекомендация: при следующем запуске сессии, где `task` работоспособен, прогнать план через внешнего критика до старта Wave 1.

### Найденные блокеры и как устранены

| # | Раздел | Блокер | Устранение |
|---|---|---|---|
| 1 | T2.1 шаг 3 | Объявленная сигнатура `parseMaxRetryWaitMs(value: unknown)` противоречила описанному поведению и **всем** местам вызова: QA-сценарий T2.1 зовёт `parseMaxRetryWaitMs({maxRetryWaitMs: false})`, T2.2 — `parseMaxRetryWaitMs(options)`, T3.1 — `parseMaxRetryWaitMs(ctx.options)`. На вход идёт объект опций, а не одно значение. Исполнитель написал бы функцию с неверной сигнатурой и сломал бы оба потребителя. | Шаг 3 переписан: `parseMaxRetryWaitMs(options?: unknown): number \| null`, явно указано «на вход объект опций целиком», логика расписана пятью пунктами с привязкой к `src/index.ts:166-171`, добавлено требование narrowing под `strict`. |
| 2 | T2.1 acceptance, T4.1 acceptance | Невыполнимые/тавтологичные команды проверки. (а) `grep -oE "export (const\|function\|type) [A-Za-z]+"` физически не матчит `DEFAULT_MAX_RETRY_WAIT_MS` — класс `[A-Za-z]` не содержит `_`, матч обрывается на `DEFAULT`; при этом сказано «все 7 имён», а перечислено 8. (б) В T4.1 проверка `node -e "console.log(require.resolve ? 'ok' : 'ok')"` печатает `ok` при любом исходе — ложный зелёный сигнал. | (а) Заменено на `for`-цикл с `grep -cE "^export (const\|function\|type) $n\b"` по каждому из **8** имён, ожидаемый вывод — восемь строк `<имя>=1`, любой `=0` — провал; добавлено пояснение, почему `[A-Za-z]+` не годится. (б) Тавтологическая половина команды удалена, осталась содержательная проверка `import('./dist/v2.js') → m.default.id === "retry-now"`. |
| 3 | T3.1 шаг 3 ↔ T3.2/T3.3 | **Регрессия относительно V1.** Шаг 3 предписывал при `cap === null` «зарегистрировать ноль хуков и вернуть no-op `Cleanup`». В V1 `maxRetryWaitMs: false` гасит только автоматику (`scheduleRetry` выходит на `cap === null`, `src/index.ts:265`), а хук команды `"command.execute.before"` регистрируется безусловно (`src/index.ts:342-404` вне ветки cap). По плану V2 при `maxRetryWaitMs: false` потерял бы саму команду `retry-now` — то есть главную функцию плагина, ради которой он существует. | T3.1 шаг 3 переписан: retry-хук не регистрируется, но `setup` продолжает работу и регистрирует команду; добавлен явный запрет на ранний `return` в «Must NOT do» T3.1 и запрет условной регистрации в «Must NOT do» T3.2; в T3.3 добавлен тест-страховка шаг 6a (при `maxRetryWaitMs: false` `session.hook` не вызван, но `command.transform` вызван и добавляет `retry-now`) и мутационная проверка QA-6; в таблицу рисков добавлена строка; в критерии готовности добавлен пункт 11. |

### Прочие правки по итогам ревью (не блокеры)

- В раздел «Принципы» добавлен пункт 6: LSP в этой среде отдаёт устаревший кэш и показывает диагностику для физически отсутствующих файлов — авторитетны только `ls`, `git`, `npx tsc --noEmit`, `npx vitest run`. Это прямое предупреждение исполнителю, основанное на наблюдённом в этой сессии поведении.
- Нумерация критериев готовности сдвинута (было 11 пунктов, стало 12).

### Проверенные критерии (без замечаний)

- Все 13 todos (T0.1, T0.2, T1.1, T1.2, T2.1, T2.2, T2.3, T3.1, T3.2, T3.3, T4.1, T4.2, T4.3) содержат полный набор подсекций: What to do / Must NOT do / Parallelization / References / Recommended task executor category / Acceptance criteria / QA scenarios / Commit.
- Размер todo: каждый затрагивает 1–2 файла; T3.1 и T3.2 намеренно разделены по одному файлу (`src/v2.ts`) на два смысловых этапа с отдельными коммитами.
- Reference Fact Table присутствует, 47 строк, колонки Source path / Lines / Fact discovered / Relevance.
- T0.1 (создание ветки `feature/opencode-v2-support`) — первый todo плана, блокирует все остальные.
- Запрещённых формулировок («проверь что работает», «убедись что всё ок», «verify as appropriate») в тексте нет; все acceptance-критерии — команды с ожидаемым выводом или exit-кодом.
- Волновой граф корректен: Wave 0 → Wave 1 (гейт) → Wave 3; Wave 2 параллелен Wave 1, т.к. `src/shared.ts` не зависит от V2-типов.
- Непроверенные свойства V2 API не выданы за факты: 7 остаточных неизвестностей (`SessionError.Error`, `Model.Ref`/`Agent.ID`, `PromptInput.Prompt`, `SessionPromptInput`, `SessionContextInput`, `SessionInterruptInput`, `SessionActive`/`V2Event`, `SessionInbox.Delivery`) вынесены в отдельный todo разведки T1.2 с требованием дословной цитаты из `.d.ts` либо явной пометки `НЕ НАЙДЕНО`.
