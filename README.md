# OpenCode Retry Now Plugin

A plugin for OpenCode that adds a `/retry-now` command to immediately retry rate-limited requests without waiting for the countdown.

## How It Works

When OpenCode hits a rate limit it shows a countdown timer. This plugin lets you skip it:

1. Type `/retry-now` in the chat — the last user message is re-sent immediately.

The plugin hooks into `command.execute.before`, retrieves the last user message from session history, and calls `session.promptAsync()` to re-send it right away.

## Installation

### 1. Register the plugin in `~/.config/opencode/opencode.json`

```json
{
  "plugin": [
    "file:///home/openchamber/workspaces/opencode_retrypush/dist/index.js"
  ]
}
```

### 2. Copy the slash command file

The `/retry-now` command must exist as a file in `~/.config/opencode/command/`:

```sh
mkdir -p ~/.config/opencode/command
cp /home/openchamber/workspaces/opencode_retrypush/command/retry-now.md ~/.config/opencode/command/retry-now.md
```

### 3. Build the plugin

```sh
cd /home/openchamber/workspaces/opencode_retrypush
npm install
npm run build
```

### 4. Restart OpenCode

Config and plugins are loaded once on startup — restart is required.

## Usage

When rate-limited, type `/retry-now` and press Enter. The last message is re-sent immediately.

## Requirements

- OpenCode with `@opencode-ai/plugin` ≥ 1.15.7
- Node.js ≥ 18
