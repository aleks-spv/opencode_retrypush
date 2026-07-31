# Usage Instructions

## Installing the Plugin

1. Place this plugin in your OpenCode plugins directory
2. Ensure all peer dependencies are installed:
   - @opencode-ai/plugin
   - @opencode-ai/sdk  
   - @opencode-ai/ui

## Using the Retry Now Feature

### Command Interface
1. Open the command palette (Ctrl+Shift+P or Cmd+Shift+P)
2. Type "/retry-now" and select the command
3. The last user input will be resent immediately

### UI Button
1. When rate limited, a "Retry Now" button will appear in the interface
2. Click the button to retry immediately

### Keyboard Shortcut
1. With an empty prompt, press Enter
2. This will trigger an immediate retry of the last input

## Implementation Details

The plugin works by:
- Maintaining session state tracking
- Retrieving previous user inputs from session history
- Bypassing rate limit checks when retrying
- Providing multiple entry points for convenience

## Development

To build the plugin:
```
npm run build
```

To test:
```
npm test
```