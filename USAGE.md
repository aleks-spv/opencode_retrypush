# Usage Instructions

## Using the Retry Now Feature

When rate-limited, type `/retry-now` in the chat and press Enter. The plugin replaces the command content with the last user message and OpenCode submits that request through its normal pipeline.

Only the `/retry-now` slash command is provided. This plugin does not add a UI button, a command-palette entry, or an Enter-on-empty-input shortcut.

## Development

To build the plugin:
```
npm run build
```

To test:
```
npm test
```
