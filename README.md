# OpenCode Retry Now Plugin

A plugin for OpenCode that caps long automatic retry waits at five minutes and adds a `/retry-now` command to retry rate-limited requests immediately.

## How It Works

When OpenCode schedules a retry farther than five minutes in the future, the plugin waits five minutes, cancels the pending retry timer, and replays the last user message with its original agent and model. Usage-limit waits that reset provider quotas are left alone.

For an immediate manual retry, type `/retry-now` in any chat. The current session and every session waiting to retry are re-sent immediately.

The plugin hooks into OpenCode's event and `command.execute.before` APIs, finds sessions in the `retry` state, and repeats their last user messages. The current session is sent through OpenCode's normal command pipeline; other sessions, including subagents, are addressed by their session IDs.

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

## Usage

When rate-limited, type `/retry-now` in any session and press Enter. The command retries every session currently waiting on a rate-limit countdown, including child sessions.

## Requirements

- OpenCode with `@opencode-ai/plugin` ≥ 1.15.7
- Node.js ≥ 18
