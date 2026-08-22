# OpenCode Retry Now Plugin

A plugin for OpenCode that adds a `/retry-now` command to immediately retry rate-limited requests without waiting for the countdown.

## How It Works

When OpenCode hits a rate limit it shows a countdown timer. This plugin lets you skip it:

1. Type `/retry-now` in any chat — the current session and every session waiting to retry are re-sent immediately.

The plugin hooks into `command.execute.before`, finds every OpenCode session in the `retry` state, and repeats its last user message. The current session is sent through OpenCode's normal command pipeline; other sessions, including subagents, are addressed by their session IDs.

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
    "file:///absolute/path/to/opencode_retrypush/dist/index.js"
  ]
}
```

Replace the path above with the actual absolute path to your clone.

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
