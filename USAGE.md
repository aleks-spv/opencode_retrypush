# Usage Instructions

## Using the Retry Now Feature

When rate-limited, type `/retry-now` in any chat and press Enter. The plugin retries the current session and every other session waiting on a rate-limit countdown, including child sessions.

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
