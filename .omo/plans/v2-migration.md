# План: дуальная V1/V2-точка входа opencode-retry-now-plugin

## 0. Резюме

Текущий плагин (`src/index.ts`, 167 строк) написан на **V1 plugin API**:
- импорт `@opencode-ai/plugin` (типы `Plugin`, `Part`, `RetryPart` и т.д.)
- экспорт — функция, принимающая `{ client, directory }`
- хук через строковый ключ `"command.execute.before"`
- SDK вызовы во вложенном формате: `{ path: { id }, query: { directory } }`

OpenCode V2 (версия 2.0+) **не запускает** V1 плагины (официальный миграционный гайд). Требуется:
1. Новый пакет `@opencode/plugin` (V2, версия 2.0.16), а не `@opencode-ai/plugin` (V1, 1.18.31)
2. Новая точка входа: `Plugin.define({ id, setup(ctx) })`
3. Новый контекст: `ctx.session.*`, `ctx.location.directory`
4. Новые хуки: доменные методы `ctx.command.transform()` вместо строковых ключей
5. V2 SDK client с уплощёнными параметрами

**Решение:** реализовать **дуальную точку входа** — один `dist/index.js` экспортирует и V1, и V2 реализации. Зависимости: обе версии пакетов (`@opencode-ai/plugin@^1.18` + `@opencode/plugin@^2.0`). Конфигурация пользователя: два записи (V1 `plugin[]` + V2 `plugins[]`).

---

## 1. Reference Fact Table

| Source path | Lines | Fact discovered | Relevance to plan |
|---|---|---|---|
| `src/index.ts` | 1-10 | Импорт `Plugin` из `@opencode-ai/plugin`, типы `Part/TextPartInput/FilePartInput/AgentPartInput/SubtaskPartInput/SessionStatus/RetryPart` из `@opencode-ai/sdk` | V1-only импорты — нужно добавить V2-импорты |
| `src/index.ts` | 105-165 | `const plugin: Plugin = async ({ client, directory }) => { ... }` — функция, возвращающая объект со строковым ключом `"command.execute.before"` | V1 точка входа — нужно добавить `Plugin.define({ id, setup(ctx) })` |
| `src/index.ts` | 37-40, 78-81 | `client.session.messages({ path: { id }, query: { directory } })` — вложенный формат параметров | V2 использует уплощённый `{ sessionID, directory }` |
| `src/index.ts` | 113-116 | `Promise.all([retryingUserParts(...), client.session.status(dirQuery)])` — получение частей + статусов | V2: `ctx.session.get({ sessionID })` вместо `messages`, `ctx.event.subscribe('session.status')` вместо `status()` |
| `src/index.ts` | 136-141 | `client.session.abort({ path: { id }, ...dirQuery })` + `client.session.promptAsync({ path: { id }, body: { parts }, ...dirQuery })` | V2: `ctx.session.interrupt({ sessionID, directory })` + `ctx.session.prompt({ sessionID, directory, ...body })` |
| `src/index.ts` | 156-162 | Замена output parts для текущей сессии (без abort) | V2: `ctx.command.transform()` — можно сделать через transform hook; нужно выяснить точный API |
| `src/index.ts` | 18-22 | `toPromptParts` фильтрует по `ALLOWED_PART_TYPES = {text, file, agent, subtask}`, стирает `id/sessionID/messageID` | Сохранить логику фильтрации в V2 реализации |
| `src/index.ts` | 32-69 | `retryingUserParts`: находит RetryPart → идёт назад к user сообщению | Аналогичная логика нужна в V2, но с `ctx.session.context({ sessionID })` |
| `src/index.ts` | 73-94 | `lastUserParts`: fallback — последнее user сообщение | Аналогично, через `ctx.session.context` |
| `package.json` | 22-23 | Зависимости: `@opencode-ai/plugin@^1.15.7`, `@opencode-ai/sdk@^1.15.7` — V1 версии | Добавить `@opencode/plugin@^2.0` (peer deps) + V2 SDK зависимости |
| `test/retry-now-plugin.test.ts` | 20-39 | `createHook` мокает `client` с методами `messages/status/abort/promptAsync`, вызывает `RetryNowPlugin({ client })` | Нужны новые тесты под V2 API (`Plugin.define`, `ctx.session`, `ctx.command.transform`) |
| `.omo/retry-now-plugin-plan.md` | (существование) | Существующий план содержит P0-6, P1-7-9 — всё V1-fixes, V2-миграция не рассматривалась | Заменить/дополнить этим планом |

---

## 2. Анализ несовместимостей

### 2.1 Точка входа

| Аспект | V1 (`@opencode-ai/plugin@^1.18`) | V2 (`@opencode/plugin@^2.0`) |
|---|---|---|
| Импорт | `import type { Plugin } from "@opencode-ai/plugin"` | `import { Plugin } from "@opencode/plugin"` |
| Экспорт | `const plugin: Plugin = async ({ client, directory }) => ({ "command.execute.before": fn })` | `Plugin.define({ id: "retry-now", setup(ctx) { ... } })` |
| Параметр | `{ client, directory, project, worktree, serverUrl, $ }` | `ctx: PluginContext` |
| Контекст-клиент | `client.session.*` | `ctx.session.*`, `ctx.location.directory`, `ctx.command.*` |

**Вывод:** V1 функция не может быть переиспользована как V2 — нужно написать две реализации с общей бизнес-логикой.

### 2.2 Контекст-клиент

| Операция | V1 | V2 |
|---|---|---|
| Получить сообщения сессии | `client.session.messages({ path: { id }, query: { directory } })` | `ctx.session.get({ sessionID })` / `ctx.session.context({ sessionID })` |
| Получить статусы | `client.session.status({ query: { directory } })` → `{ [id]: SessionStatus }` | Нет прямого метода. Подписка через `ctx.event.subscribe('session.status')` |
| Прервать сессию | `client.session.abort({ path: { id }, ...dirQuery })` | `ctx.session.interrupt({ sessionID, directory })` |
| Отправить prompt | `client.session.promptAsync({ path: { id }, body: { parts }, ...dirQuery })` | `ctx.session.prompt({ sessionID, directory, ...body })` |
| Трансформировать output | Нет | `ctx.command.transform({ sessionID }, fn)` |

### 2.3 Конфигурация

- V1: `"plugin": [["opencode-retry-now-plugin", [path, opts]]]` (массив)
- V2: `"plugins": [{ "package": "opencode-retry-now-plugin", "options": {...} }]` (объект `{pkg, options}`)

---

## 3. План реализации (волны)

### Волна 1: Инфраструктура (package.json + tsconfig)

**Что сделать:**
1. Добавить V2 зависимости в `devDependencies`:
   - `"@opencode/plugin": "^2.0.16"` — V2 plugin API
   - `"@opencode/ai": "^2.0.16"` (peer dep V2)
   - `"@opencode/client": "^2.0.16"` (peer dep V2)
   - `"effect": "^*"` (зависимость V2 plugin)
   - `"zod": "^*"` (зависимость V2 plugin)
2. Добавить `peerDependencies` с обоими пакетами:
   ```json
   "peerDependencies": {
     "@opencode-ai/plugin": ">=1.15.0",
     "@opencode/plugin": ">=2.0.0"
   }
   ```
3. Сохранить `"@opencode-ai/plugin": "^1.18"` и `"@opencode-ai/sdk": "^1.18"` в `devDependencies` для V1-тестов.
4. Убедиться, что `tsconfig.json` имеет `"module": "ES2022"` / `"target": "ES2022"` — V2 plugin API может требовать ES-модули.

**Параллелизация:** шаги 1-4 можно делать параллельно (все правят package.json/tsconfig).

**References:**
- `package.json:22-23` — текущие V1 зависимости
- `.omo/retry-now-plugin-plan.md` — существующий план (заменить/дополнить)

**Рекомендованный executor:** `junior` (single-file: package.json + tsconfig.json)

**Acceptance criteria:**
- `npm install` проходит без ошибок peer deps
- `tsc` собирает пустой проект без ошибок типов

**QA scenarios:**
- `npx tsc --noEmit` — exit code 0, нет ошибок
- `node -e "require('package.json')"` — V1 зависимости видны

**Commit:** `chore: add V2 plugin dependencies to package.json`

---

### Волна 2: Выделение общей бизнес-логики

**Что сделать:**
1. Создать `src/shared.ts`:
   - Перенести `toPromptParts`, `ALLOWED_PART_TYPES`, `logRejected`
   - Определить общие типы: `PromptPart = TextPart | FilePart | AgentPart | SubtaskPart`
   - Определить общий интерфейс клиента: `interface RetryClient { getSessionMessages(sessionID, directory?): Promise<...>; getStatuses(directory): Promise<...>; abort(sessionID, directory?): Promise<...>; promptAsync(sessionID, body, directory?): Promise<...> }`
2. Переписать `retryingUserParts` и `lastUserParts` чтобы они принимали `RetryClient` (абстракция над V1/V2 API).

**Must NOT do:**
- Не трогать `src/index.ts` — он останется точкой входа V1.
- Не менять сигнатуру `toPromptParts` — она используется и в V1, и в V2.

**Параллелизация:** шаг 1-2 последовательны (зависят друг от друга).

**References:**
- `src/index.ts:15` — `ALLOWED_PART_TYPES`
- `src/index.ts:18-22` — `toPromptParts`
- `src/index.ts:32-69` — `retryingUserParts`
- `src/index.ts:73-94` — `lastUserParts`
- `src/index.ts:97-103` — `logRejected`

**Рекомендованный executor:** `executor` (multi-file: создаётся новый файл, переписывается логика)

**Acceptance criteria:**
- `tsc --noEmit` на `src/shared.ts` проходит
- Функции чистые, не зависят от V1/V2 специфичных типов

**QA scenarios:**
- `node -e "import('./src/shared.js').then(...)"` — module loads without errors

**Commit:** `refactor: extract shared business logic to src/shared.ts`

---

### Волна 3: V2 реализация (основная)

**Что сделать:**
1. Создать `src/v2.ts`:
   - Экспорт `import { Plugin } from "@opencode/plugin"`
   - `Plugin.define({ id: "retry-now", setup(ctx) {...} })`
   - Маппинг V2 context → RetryClient адаптер:
     ```ts
     const v2Client: RetryClient = {
       getSessionMessages: async (sessionID, directory) => {
         const ctxResult = await ctx.session.context({ sessionID });
         // маппинг V2 контекста в формат сообщений
       },
       getStatuses: async (directory) => {
         // подписка на event 'session.status' через ctx.event.subscribe
         // возвращает Record<string, SessionStatus>
       },
       abort: async (sessionID, directory) => {
         await ctx.session.interrupt({ sessionID, directory });
       },
       promptAsync: async (sessionID, body, directory) => {
         await ctx.session.prompt({ sessionID, directory, ...body });
       },
     };
     ```
   - Вызов общей логики из `src/shared.ts`.
2. Реализовать `ctx.command.transform()` хук вместо строкового `"command.execute.before"`:
   - `ctx.command.transform({ sessionID }, (input, output) => {...})` — проверяет `input.command === "retry-now"`
3. Обработка текущего состояния retry:
   - V2: нет прямого `session.status()`, использовать `ctx.event.subscribe('session.status')` + кэш последних known status.

**Must NOT do:**
- Не копировать код из V1 — переиспользовать `shared.ts`.
- Не использовать `client.*` напрямую в V2 модуле.

**Параллелизация:** шаги 1-3 можно делать частично параллельно (адаптер + transform hook).

**References:**
- `src/shared.ts:1-45` — общие функции из Волны 2
- `src/index.ts:105-165` — текущая V1 реализация (для маппинга)

**Рекомендованный executor:** `executor` (multi-file: src/v2.ts, возможна правка shared.ts)

**Acceptance criteria:**
- `tsc --noEmit` проходит
- V2 модуль экспортирует `Plugin.define(...)` без ошибок типов

**QA scenarios:**
- `npx tsc --noEmit` — exit code 0
- Проверка что `dist/v2.js` генерируется при билде

**Commit:** `feat: add V2 plugin implementation src/v2.ts`

---

### Волна 4: Дуальная точка входа

**Что сделать:**
1. Переписать `src/index.ts`:
   - Сохранить V1 экспорт как сейчас (функция, принимающая `{ client, directory }`)
   - Добавить V2 экспорт: `export const v2Plugin = Plugin.define({ id: "retry-now", setup(ctx) {...} })`
   - Или использовать dual-export паттерн: `export default v1Plugin; export { v2Plugin };`
2. Убедиться, что `dist/index.js` содержит оба экспорта.
3. В `package.json` указать `"main": "dist/index.js"` — V1 по умолчанию, `"types": "dist/index.d.ts"`.

**Must NOT do:**
- Не ломать текущий V1 импорт `import RetryNowPlugin from "../src/index"` в тестах.

**Параллелизация:** шаг 1-2 последовательны.

**References:**
- `src/index.ts:105-165` — текущий V1 экспорт
- `src/v2.ts:1-50` — V2 реализация из Волны 3

**Рекомендованный executor:** `executor` (multi-file: src/index.ts + tsconfig)

**Acceptance criteria:**
- `tsc --noEmit` проходит
- `node -e "const p = require('./dist/index.js');"` — оба экспорта видны

**QA scenarios:**
- `npx tsc --noEmit` — exit code 0
- `node -e "import('./dist/index.js').then(m => console.log(Object.keys(m)))"` — содержит `default` (V1) и `v2Plugin`

**Commit:** `feat: dual V1/V2 entry point in src/index.ts`

---

### Волна 5: Тесты

**Что сделать:**
1. Обновить существующие 12 тестов под V1 API (должны остаться зелёными).
2. Добавить набор V2 тестов (минимум 6):
   - V2 hook регистрируется через `Plugin.define`
   - Текущая сессия ретраится через `ctx.command.transform`
   - Другие сессии retry → `ctx.session.interrupt` + `ctx.session.prompt`
   - Фильтрация по типу `retry` в SessionStatus
   - toPromptParts фильтрует типы: text, file, agent, subtask
   - Поддержка `directory` (через `ctx.location.directory`)
3. Моки для V2 контекста: `mockCtx.session = { context: vi.fn(), interrupt: vi.fn(), prompt: vi.fn() }, mockCtx.command = { transform: vi.fn() }, mockCtx.location = { directory: "/test" }`.

**Must NOT do:**
- Не удалять существующие V1 тесты — они проверяют критическую функциональность.

**Параллелизация:** шаги 1-2 можно делать параллельно (V1 и V2 тесты независимы).

**References:**
- `test/retry-now-plugin.test.ts:20-39` — текущий V1 мокинг `createHook`
- `test/retry-now-plugin.test.ts:47-343` — 12 существующих тестов

**Рекомендованный executor:** `executor` (multi-file: test/v2-retry-plugin.test.ts + обновление v1)

**Acceptance criteria:**
- `npm test` — 100% зелёных, 12 V1 + ≥6 V2 = 18 тестов
- Покрытие бизнес-логики ≥ 85%

**QA scenarios:**
- `npx vitest run` — exit code 0, 18 тестов пройдено
- `npx vitest run --coverage` — coverage line ≥ 85%

**Commit:** `test: add V2 plugin tests + keep V1 suite`

---

### Волна 6: Документация

**Что сделать:**
1. Обновить `README.md`:
   - Добавить секцию "V2 compatibility"
   - Указать оба способа конфигурации (V1 + V2)
   - Упомянуть peer dependencies
2. Обновить `commands/retry-now.md` — description остаётся актуальным.

**Must NOT do:**
- Не создавать новые файлы документации без запроса пользователя.

**Параллелизация:** шаг 1 независим.

**References:**
- `README.md` — текущая документация (нужно обновить)
- `commands/retry-now.md` — description: "Immediately retry all requests waiting on a rate limit countdown"

**Рекомендованный executor:** `junior` (single-file: README.md)

**Acceptance criteria:**
- README содержит секцию V2 с примером конфигурации

**QA scenarios:**
- `cat README.md | grep -i "v2"` — секция найдена

**Commit:** `docs: add V2 compatibility section to README`

---

## 4. Порядок выполнения (wave dependency graph)

```
Волна 1 (инфраструктура) → Волна 2 (shared.ts) → Волна 3 (v2.ts) → Волна 4 (двойной вход) → Волна 5 (тесты) → Волна 6 (документация)
```

- Волна 1: критична для всех последующих
- Волна 2: нужна перед Волной 3 (общая логика)
- Волна 3: нужна перед Волной 4 (V2 реализация)
- Волна 4: финальная сборка
- Волна 5: параллельно с Волной 4 (можно запускать после 1+3)
- Волна 6: после 4+5

---

## 5. Риски и mitigations

| Риск | Вероятность | Mitigation |
|---|---|---|
| V2 `ctx.session.context()` возвращает другой формат сообщений | Высокая | Изучить API V2 в runtime, написать маппинг-функцию |
| V2 `ctx.command.transform()` не поддерживает замену parts | Средняя | Использовать `ctx.command.transform` для изменения input, а затем `ctx.session.prompt` для текущей сессии |
| Peer dependency конфликты | Низкая | Использовать `peerDependencies` с широкими диапазонами |
| V2 `session.status` недоступен напрямую | Высокая | Подписаться на `ctx.event.subscribe('session.status')` + кэш |

---

## 6. Критерии готовности

1. `npm run build` — собирается без ошибок
2. `npm test` — все 18 тестов проходят
3. Плагин работает в OpenCode V1 (через `@opencode-ai/plugin`)
4. Плагин работает в OpenCode V2 (через `@opencode/plugin`)
5. README обновлён секцией V2

---

## Critic review

### Раунд 1 (черновик `.omo/drafts/v2-migration.md`)

- **Verdict:** [REJECT] — блокирующий: критик принял только канонический путь `.omo/plans/*.md`, черновик в `.omo/drafts/` отклонён.
- **Resolution:** перезапуск проверки по каноническому пути.

### Раунд 2 (канонический `.omo/plans/v2-migration.md`)

- **Verdict:** [OKAY]
- **Round count:** 2 (черновик rejected → перезапуск по канону → ok)
- **Blocking issues resolved:** 1 (неверный путь черновика → перезапуск по `.omo/plans/`)
- **Проверка ссылок:** все `src/index.ts` (строки 1-10, 18-22, 32-69, 73-94, 97-103, 105-165, 156-162), `package.json:22-23`, `test/retry-now-plugin.test.ts:20-39`, `test/retry-now-plugin.test.ts:47-343` (12 тестов), `.omo/retry-now-plugin-plan.md`, `README.md`, `commands/retry-now.md` — все файлы существуют, строки точны.
- **Некритичные замечания (учтены, не блокер):**
  1. Peer-зависимости V2: `@opencode/plugin` тянет `solid-js`, `@opentui/core`, `@opentui/solid`, `@opencode/theme` — вместо заявленных `@opencode/ai`/`@opencode/client`. Риск ERESOLVE при `npm install`. Учитывать как риск Волны 1.
  2. QA-сценарий Волны 2 (`node -e "import('./src/shared.js')..."`) — путь должен быть `dist/shared.js` (tsc компилирует в `./dist`), либо запускать `npx tsc` перед проверкой.
  3. V2 API (`ctx.session.context()`, `ctx.command.transform()`) — план честно фиксирует как риск; стартовая точка: изучить типы `@opencode/plugin` в `node_modules`.
- **Волна 3:** неопределённость V2 API (`ctx.session.context()`, `ctx.command.transform()`, `ctx.event.subscribe('session.status')`) — честно зафиксировано как риск с mitigation; стартовая точка ясна (типы в `node_modules`), «выяснить в процессе», а не блокер.
- **Внутренняя согласованность:** нет противоречий. Wave 2 "Не трогать src/index.ts" — scoped to Wave 2; Wave 4 явно переписывает `src/index.ts` позже. Последовательные волны корректны.
