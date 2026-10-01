# V2 API Facts — разведка типов

**Дата:** 2026-10-01  
**Статус:** Fallback (типы из /tmp/v2probe)

## SessionError.Error

**Источник:** `/tmp/v2probe/package/dist/promise/session.d.ts:8`

```typescript
import type { SessionError } from "@opencode/schema/session-error";
...
readonly error: SessionError.Error;
```

Точная форма `SessionError.Error` не найдена в доступных `.d.ts` (не в promise/, не в client/). Нужно грепать в `@opencode/schema`.

**Решение:** Использовать `input.error` как `any` в коде V2, с narrowing через `typeof` и проверкой наличия текстовых полей. Текстовое сравнение (как в V1) остается fallback для определения usage-limit.

## Model.Ref и Agent.ID

**Источник:** `/tmp/v2probe/package/dist/promise/session.d.ts:24, 123`

```typescript
export interface SessionRequest {
    readonly model: Model.Ref;
    ...
}
export interface SessionRetry {
    readonly agent: Agent.ID;
    readonly model: Model.Ref;
    ...
}
```

**Форма `Model.Ref`:** `/tmp/v2probe/package/dist/promise/session.d.ts` импортирует из `@opencode/schema/model`. Точная форма не раскрыта в `.d.ts` (interface declaration отсутствует). Предположить: `{ providerID: string; modelID: string }` (как в V1 `src/index.ts:28-32`).

**Форма `Agent.ID`:** Аналогично — импортируется из `@opencode/schema/agent`, точная форма не раскрыта. Предположить: строка или `{ id: string }`.

**Решение:** В V2-коде передаем `input.agent` и `input.model` напрямую в `ctx.session.prompt(...)` без трансформации. TypeScript отметит, если форма несовместима.

## PromptInput.Prompt

**Источник:** `/tmp/v2probe/package/dist/promise/session.d.ts:16` и `/tmp/v2probe/package/dist/promise/command.d.ts:8`

```typescript
export interface SessionPrompt {
    ...
    prompt: Types.DeepMutable<PromptInput.Prompt>;
    ...
}
export interface CommandInvocation {
    readonly prompt: PromptInput.Prompt;
    ...
}
```

**Форма:** Импортируется из `@opencode/schema/prompt-input`, точное определение не найдено в доступных файлах.

**Решение:** Используем как `any` в вендоренных типах. Для команды `retry-now`: структура prompt передается от хост OpenCode'a через `CommandInvocation.prompt`, мы передаем её напрямую в `ctx.session.prompt(input)`.

## SessionPromptInput, SessionContextInput, SessionInterruptInput

**Источник:** `/tmp/v2probe/client/package/dist/promise/client.d.ts:31-100`

```typescript
session.active: (requestOptions?) => Promise<{[x:string]: SessionActive}>;
session.context: (input: SessionContextInput) => Promise<SessionMessageInfo[]>;
session.interrupt: (input: SessionInterruptInput) => Promise<SessionInterruptResponse>;
session.prompt: (input: SessionPromptInput) => Promise<SessionInboxUser>;
```

**Статус:** Типы импортируются, но не экспортируются из `/tmp/v2probe/client/package/dist/promise/index.d.ts` — там только 6 строк ре-экспортов, сами типы не объявлены.

**Решение:** Используем `any` для input-объектов. V2 хук `retry` получает pre-built `SessionRetry.decision`, мы только мутируем `decision.delay` — не нужно создавать новые prompt-объекты.

## SessionActive и V2Event

**Статус:** НЕ НАЙДЕНО. Не упомянуты в доступных файлах.

**Решение:** Команда `retry-now` в V2 работает только в текущей сессии (не перечисляет активные сессии как в V1). README явно отмечает это ограничение.

## SessionInbox.Delivery

**Источник:** `/tmp/v2probe/package/dist/promise/command.d.ts:9`

```typescript
export interface CommandInvocation {
    readonly delivery: SessionInbox.Delivery;
}
```

Форма не раскрыта, импортируется из `@opencode/schema/session-inbox`.

**Решение:** Передаем как-есть из `CommandInvocation.delivery` в `ctx.session.prompt({..., delivery})`.

---

## Решение по скоупу команды retry-now в V2

**Вариант:** Только текущая сессия.

**Обоснование:** 
- V1 перечисляет все сессии через `client.session.status()` (блокирующий sync call) и пересылает каждую через `client.session.promptAsync()`.
- В V2 нет эквивалента `SessionActive` в доступных типах и нет способа перечислить "все retry-сессии" без асинхронного запроса к хосту (что ломает bootstrap-инвариант).
- Команда `retry-now` срабатывает как `ctx.command.transform`, получает текущий `CommandInvocation`, может отправить только текущую сессию через `ctx.session.prompt()`.
- Для субагентов (subagents) — каждый запускается в отдельной сессии, у каждого свой хук `retry`; они сами cap'ируют свои retry через session.hook("retry") в своем контексте. Этого достаточно.

**Ограничение в README:** "V2-плагин кэпирует retry в текущей сессии. Для batch-retry всех rate-limited сессий используйте V1-плагин."

