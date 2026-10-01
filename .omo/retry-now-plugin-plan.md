# План: фикс бага с папкой команд + улучшения opencode-retry-now-plugin

Статус: **план, не реализовано.** Рабочее дерево не тронуто (`git mv` был откачен).
Реализация начинается по `/start-work`.

---

## Результаты проверки (факты, а не предположения)

### Папка команд — что на самом деле

В бинаре opencode 1.18.9
(`/home/openchamber/.npm-global/lib/node_modules/opencode-ai/bin/opencode.exe`)
лежит литерал glob-паттерна:

```
{command,commands}/**/*.md
```

Brace-glob → opencode читает **обе** папки. `/retry-now` из `command/` реально
находится, команда работает. Это не поломка, а расхождение с конвенцией.

Канон в OpenChamber — множественное число:

- `packages/web/server/lib/opencode/shared.js:11` → `COMMAND_DIR = ~/.config/opencode/commands`
- `commands.js:30,42,52` — `command/` назван legacy-фоллбэком; читается, только
  если plural-файла нет. Новые команды UI пишет исключительно в `commands/`.

Итог: `/retry-now` живёт в слепой зоне командного UI OpenChamber.

### Более важная находка: установленная копия протухла

`diff ~/.config/opencode/command/retry-now.md <repo>/command/retry-now.md`:

| | description | body |
|---|---|---|
| установлено | `Immediately retry **the last request**, skipping the rate limit countdown` | `Retry the last failed request immediately.` |
| в репо | `Immediately retry **all requests** waiting on a rate limit countdown` | `Retry every request currently waiting on a rate limit countdown immediately.` |

Установленный файл — от первого коммита, до `139fe25 feat: retry all waiting
sessions`. Промпт команды не соответствует поведению плагина. Это существеннее
самого имени папки.

### Работает ли плагин

- `npx tsc --noEmit` — чисто.
- `npx vitest run` — 7/7 зелёные.
- Грузится без ошибок: в `~/.local/share/opencode/log/opencode.log` нет записей
  об ошибке для `file:///.../opencode_retrypush/dist/index.js`. Грep валиден —
  для соседних плагинов (`opencode-with-claude`, `manual-retry-tui.js`) ошибки
  в этом же логе есть.
- Зарегистрирован в `~/.config/opencode/opencode.json`.
- `dist/index.js` синхронен с `src/index.ts`.

### API сверено с @opencode-ai/sdk 1.18.9

- `SessionStatus = {type:"idle"} | {type:"retry", attempt, message, next} | {type:"busy"}`
- `session.status()` → `{[id]: SessionStatus}`, принимает `query.directory`
- `session.messages` / `abort` / `promptAsync` существуют; нативного retry-now
  эндпоинта **нет** → abort+replay это единственный путь, подход выбран верно
- `command.execute.before` (plugin dist/index.d.ts:228) — сигнатура совпадает точно
- `TextPart` минус `id/sessionID/messageID` === `TextPartInput`; для `FilePart`
  так же → срезание полей корректно
- `RetryPart = {..., type:"retry", attempt, error, time}` — существует, позволяет
  точно определить ретраящееся сообщение

**Оговорка:** все 7 тестов на `client as any`. Реальный контракт
запрос/ответ не проверяется ничем — зелёные тесты не доказательство.

---

## Задачи

### P0-3 — Фикс бага (первый шаг)

- [ ] `git mv command commands` в репозитории
- [ ] README шаг 3: `~/.config/opencode/commands/`, `cp ./commands/retry-now.md ...`,
      плюс пометка, что opencode глобит `{command,commands}/**/*.md`, singular —
      legacy, и что старую копию надо удалить, чтобы файлы не разъезжались
- [ ] Установить **свежий** файл в `~/.config/opencode/commands/retry-now.md`
- [ ] Удалить протухший `~/.config/opencode/command/retry-now.md`

### P0-4 — Скоупинг по directory

Все вызовы SDK (`src/index.ts:8,32,46,49,59,61`) не передают `query.directory`,
хотя `PluginInput.directory` доступен и все эндпоинты его принимают. На
мультипроектном сервере (кейс OpenChamber) `session.status()` вернёт только
сессии дефолтной директории → чужие проекты не ретраятся; `messages`/`abort`
по чужой сессии может отдать 400/404.

- [ ] Достать `directory` из `PluginInput`, прокинуть `query:{directory}` везде

### P0-5 — Фильтрация частей перед реплеем

`promptAsync` принимает только `TextPartInput | FilePartInput | AgentPartInput |
SubtaskPartInput`. `asPromptParts` (`src/index.ts:4`) пропускает всё подряд.
Одна неподходящая часть — весь запрос отлетает, причём молча (см. P1-8).

- [ ] Отфильтровать по четырём разрешённым типам

### P0-6 — Сабагенты: abort осиротит родителя

`src/index.ts:49-53`. У сабагента родительский `task` висит и ждёт ребёнка.
Абортим ребёнка → родитель получает обрыв; следующий `promptAsync` стартует
отцепленный прогон, результат которого никто не читает. Бьёт ровно по
требованию «должно работать для сабагентов» из `AGENTS.md`.

**Не подтверждено вживую.** Сначала реальный тест, и только потом правки.

- [ ] Живой тест: сессия сабагента в состоянии retry → `/retry-now` → что с родителем
- [ ] Если подтвердится — для дочерних сессий отказаться от abort+replay
      (ретраить через родителя либо пропускать)

### P1-7 — Типы

`any` везде (`parts: any[]`, `client: any`, `status: any`) + каст
`...(commandParts as typeof output.parts)`. `strict: true` включён и не делает
ничего. На точных типах SDK P0-5 поймался бы компилятором.

- [ ] Перейти на `Part`, `TextPartInput`, `FilePartInput`, `SessionStatus`
- [ ] Убрать каст в `splice`

### P1-8 — Отказы не видны

`Promise.allSettled` глотает все ошибки. Ранний выход `if (!currentParts) return`
(`src/index.ts:57`) оставляет `output.parts` сырым текстом команды — модель
получает «Retry every request currently waiting...» и сочиняет ответ.

- [ ] Тост через `client.tui` либо синтетическая text-часть с объяснением
- [ ] Логировать отклонённые промисы

### P1-9 — Выбор ретраящегося сообщения

`src/index.ts:14-20` берёт последнее user-сообщение вслепую. Если во время
отсчёта что-то встало в очередь или последней была другая команда — реплеится
не тот промпт.

- [ ] Определять сообщение по `RetryPart` в частях, а не по позиции

### P1-10 — Мусор в дереве

- [ ] Удалить `dist/retry-now.js` — CommonJS-артефакт прошлого дизайна, импортит
      несуществующий `@opencode-ai/ui`, зовёт отсутствующий в SDK `getSessionService()`
- [ ] Удалить `test-plugin.ts` — дёргает `new RetryNowPlugin()`, такого экспорта нет

### P2-11 — Мелочи

- [ ] Схлопнуть N+2 вызова `session.status()` (сейчас: один вперёд, по одному на
      удалённую сессию, плюс ещё один для текущей); TOCTOU-перепроверки всё
      равно гоняются с гонкой
- [ ] Проверить реальный минимум версии: заявлено `^1.15.7`, стоит 1.18.9, код
      опирается на `session.status()`
- [ ] `package.json`: пустой `author`, нет `repository`/`files`,
      `prepare: npm run build` отработает у потребителей

### P2-12 — Тесты и доки

- [ ] Тест, проверяющий, что результат реально удовлетворяет
      `Array<TextPartInput|FilePartInput|AgentPartInput|SubtaskPartInput>`
- [ ] Кейс с частью недопустимого типа
- [ ] README: убрать хардкод пути клона `/home/openchamber/workspaces/opencode_retrypush`

### Отложено (обсудить)

Дублирование в истории: abort + повторный промпт оставляет старое
user-сообщение и мёртвое assistant-сообщение, затем дописывает идентичное user.
Модель видит промпт дважды. Косметика; `session.revert` до промпта был бы чище,
но это смена поведения — решать отдельно.
