# OpenCode Retry Now Plugin

A plugin for OpenCode that adds a `/retry-now` command to immediately retry rate-limited requests without waiting for the countdown.

## How It Works

When OpenCode hits a rate limit it shows a countdown timer. This plugin lets you skip it:

1. Type `/retry-now` in any chat — the current session and every session waiting to retry are re-sent immediately.

The plugin hooks into `command.execute.before`, finds every OpenCode session in the `retry` state, and repeats its last user message. The current session is sent through OpenCode's normal command pipeline; other sessions, including subagents, are addressed by their session IDs.

## Installation

### 1. Clone and build the plugin

```sh
git clone https://github.com/aleks-spv/opencode_retrypush.git /home/openchamber/workspaces/opencode_retrypush
cd /home/openchamber/workspaces/opencode_retrypush
npm install
npm run build
```

### 2. Register the plugin in `~/.config/opencode/opencode.json`

```json
{
  "plugin": [
    "file:///home/openchamber/workspaces/opencode_retrypush/dist/index.js"
  ]
}
```

### 3. Copy the slash command file

The `/retry-now` command must exist as a file in `~/.config/opencode/command/`:

```sh
mkdir -p ~/.config/opencode/command
cp /home/openchamber/workspaces/opencode_retrypush/command/retry-now.md ~/.config/opencode/command/retry-now.md
```

### 4. Restart OpenCode

Config and plugins are loaded once on startup — restart is required.

## Usage

When rate-limited, type `/retry-now` in any session and press Enter. The command retries every session currently waiting on a rate-limit countdown, including child sessions.

## Requirements

- OpenCode with `@opencode-ai/plugin` ≥ 1.15.7
- Node.js ≥ 18
