# OpenCode Retry Now Plugin

A plugin for OpenCode that caps long automatic retry waits at five minutes and adds a `/retry-now` command to retry rate-limited requests immediately.

## How It Works

### OpenCode V1

When OpenCode schedules a retry farther than five minutes in the future, the plugin waits five minutes, cancels the pending retry timer, and replays the last user message with its original agent and model. Usage-limit waits that reset provider quotas are left alone.

For an immediate manual retry, type `/retry-now` in any chat. The current session and every session waiting to retry are re-sent immediately.

The plugin hooks into OpenCode's event and `command.execute.before` APIs, finds sessions in the `retry` state, and repeats their last user messages. The current session is sent through OpenCode's normal command pipeline; other sessions, including subagents, are addressed by their session IDs.

### OpenCode V2

The V2 implementation uses OpenCode's native retry hook (`session.hook("retry", ...)`) to modify retry delays directly. When a retry delay exceeds the cap, the plugin reduces it to the cap value before OpenCode processes the retry. This approach is simpler and has less overhead than V1's timer-based cancellation and replay strategy.

Usage-limit and free-limit waits are ignored and handled by OpenCode's native logic. At most three automatic delay reductions are applied per retry attempt to prevent excessive capping.

For manual retry, type `/retry-now`. In V2, this retries the current session immediately by interrupting any pending generation and re-sending the last user message with its original agent and model. Unlike V1, V2 does not batch-retry all waiting sessions — only the current one.

## Installation

### 1. Clone and build the plugin

```sh
git clone https://github.com/aleks-spv/opencode_retrypush.git
cd opencode_retrypush
npm install
npm run build
```

### 2. Register the plugin in `~/.config/opencode/opencode.json`

```json
{
  "plugin": [
    [
      "file:///home/openchamber/workspaces/opencode_retrypush/dist/index.js",
      { "maxRetryWaitMs": 300000 }
    ]
  ]
}
```

`maxRetryWaitMs` is optional and defaults to `300000` (five minutes). Set a positive millisecond value to change the cap, or `false` to disable automatic retry capping while keeping `/retry-now` available.

The automatic path only takes over when the native wait is long enough to leave room to act: `cap + min(30 seconds, max(1 millisecond, cap / 2))`. For example, a 10-second cap leaves waits of up to 15 seconds to OpenCode and caps a longer wait at 10 seconds. At most three automatic retries are attempted per failure episode before control returns to OpenCode's native schedule.

### 3. Copy the slash command file

The `/retry-now` command must exist as a file in `~/.config/opencode/commands/`:

```sh
mkdir -p ~/.config/opencode/commands
cp ./commands/retry-now.md ~/.config/opencode/commands/retry-now.md
```

> **Note:** OpenCode reads both `command/` (legacy) and `commands/` via a brace-glob.
> New commands should go into `commands/`. If you have a stale copy in the old
> `command/` directory, delete it to avoid confusion:
> `rm ~/.config/opencode/command/retry-now.md`

### 4. Restart OpenCode

Config and plugins are loaded once on startup — restart is required.

## Installation (OpenCode V2)

OpenCode V2 uses a new plugin format. Instead of separate command files, the `/retry-now` command is registered programmatically by the plugin.

### 1. Clone and build the plugin

Same as V1:

```sh
git clone https://github.com/aleks-spv/opencode_retrypush.git
cd opencode_retrypush
npm install
npm run build
```

### 2. Register the plugin in `~/.config/opencode/opencode.json`

For OpenCode V2, use the `plugins` array instead of `plugin`:

```json
{
  "plugins": [
    {
      "package": "file:///home/openchamber/workspaces/opencode_retrypush/dist/v2.js",
      "options": { "maxRetryWaitMs": 300000 }
    }
  ]
}
```

Or use the published package path:

```json
{
  "plugins": [
    {
      "package": "opencode-retry-now-plugin/v2",
      "options": { "maxRetryWaitMs": 300000 }
    }
  ]
}
```

`maxRetryWaitMs` is optional and defaults to `300000` (five minutes). Set a positive millisecond value to change the cap, or `false` to disable automatic retry capping while keeping `/retry-now` available.

### 3. Restart OpenCode

Config and plugins are loaded once on startup — restart is required. Unlike V1, **you do not need to copy `commands/retry-now.md`** — the V2 plugin registers the command programmatically.

**Note:** The V2 implementation caps delays by modifying the native retry decision delay, which affects the current session. Unlike V1, which can retry all waiting sessions, V2 retries only the current session when you use `/retry-now`.

## Usage

When rate-limited, type `/retry-now` in any session and press Enter. The command retries every session currently waiting on a rate-limit countdown, including child sessions.

## Requirements

**OpenCode V1:**
- `@opencode-ai/plugin` ≥ 1.15.7

**OpenCode V2:**
- `@opencode/plugin` ≥ 2.0.21

**Both versions:**
- Node.js ≥ 18

## Keyboard shortcut (optional)

You can bind `/retry-now` to a keyboard shortcut so you don't have to type it. OpenCode supports keybinding custom slash commands via the `keybinds` config once [opencode#5903](https://github.com/anomalyco/opencode/pull/5903) lands. Add this to your `opencode.json`:

```json
{
  "keybinds": {
    "/retry-now": "ctrl+alt+r"
  }
}
```

Pressing the shortcut types `/retry-now` into the prompt and submits it, retrying every rate-limited session immediately. `ctrl+alt+r` is a suggested default — pick any combo that does not collide with your terminal's bindings.

> **Note:** this requires an OpenCode version that includes [PR #5903](https://github.com/anomalyco/opencode/pull/5903). Until then, use `/retry-now` manually or bind it via your terminal emulator (e.g. a custom escape sequence that opens an input with `/retry-now` typed).
