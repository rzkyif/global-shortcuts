# Global Shortcuts

A Node.js and Bun library for reliably registering global keyboard shortcuts.

It works by spawning a small sidecar Rust process that utilizes [global-hotkey](https://github.com/tauri-apps/global-hotkey) to globally register hotkeys. For MacOS and Windows, [tao](https://github.com/tauri-apps/tao) is used to start the event loop that [global-hotkey](https://github.com/tauri-apps/global-hotkey) requires.

## Platform Support

- **macOS** (x64, arm64)
- **Windows** (x64, arm64)
- **Linux** (x64, arm64) - X11 only until [global-hotkey](https://github.com/tauri-apps/global-hotkey) supports Wayland (see [#162](https://github.com/tauri-apps/global-hotkey/pull/162) and [#172](https://github.com/tauri-apps/global-hotkey/pull/172))

## Installation

```bash
npm install global-shortcuts
```

## Usage

```typescript
import { GlobalHotKeyManager } from "global-shortcuts";

// Create a manager instance
const manager = new GlobalHotKeyManager();

// Register a hotkey
const id = await manager.register("ctrl+shift+a", (id, state) => {
  console.log(`Hotkey pressed: ${state}`);
});

// Register multiple hotkeys
const ids = await manager.registerAll([
  { hotkey: "ctrl+b", callback: (id, state) => console.log("ctrl+b") },
  { hotkey: "alt+f1", callback: (id, state) => console.log("alt+f1") },
]);

// Unregister when done
await manager.unregister(id);

// Or unregister all
await manager.unregisterAll(ids);

// Clean up (optional - happens automatically on process exit)
manager.destroy();
```

## Cleanup

The module automatically cleans up all manager instances when the process exits with a `process.on('beforeExit', ...)` hook. You can also manually call `destroy()` to clean up.

## API

### `new GlobalHotKeyManager(options?)`

Creates a new manager instance and spawns the Rust sidecar process.

- `options.debug` - Enable debug logging (default: uses `DEBUG` env var)
- `options.binaryPath` - Explicit path to the sidecar binary. When provided, this path is used directly instead of auto-detection. Useful for custom builds or non-standard installations.

### `manager.id`

Unique identifier for this manager instance.

### `manager.ready`

Whether the sidecar process is ready to receive commands. Commands sent before ready are queued automatically.

### `register(hotkey, callback?): Promise<number>`

Register a global hotkey. Returns a unique ID for the registration.

- `hotkey` - String like "ctrl+shift+a", "alt+f1", etc.
- `callback` - Called with `(id, state)` when the hotkey is triggered
  - `state` is either `"Pressed"` or `"Released"`

### `unregister(id): Promise<void>`

Unregister a hotkey by its ID.

### `registerAll(entries): Promise<number[]>`

Register multiple hotkeys at once.

- `entries` - Array of `{ hotkey: string, callback?: function }`

### `unregisterAll(ids): Promise<void>`

Unregister multiple hotkeys by their IDs.

### `destroy(): void`

Destroy the manager and kill the sidecar process. Safe to call multiple times.

## Supported Hotkeys

All standard modifiers and keys are supported:

**Modifiers:** `ctrl`, `control`, `shift`, `alt`, `option`, `super`, `cmd`, `command`, `meta`, `windows`, `cmdorctrl`

**Keys:** All letters (a-z), digits (0-9), function keys (f1-f24), special keys (space, enter, tab, escape, etc.), arrow keys, numpad keys, and media keys (volume, play/pause, etc.)

### Examples

```typescript
// Simple key
manager.register("a", callback);

// With modifiers
manager.register("ctrl+a", callback);
manager.register("ctrl+shift+a", callback);
manager.register("alt+f1", callback);

// Platform-aware
manager.register("cmdorctrl+s", callback); // Cmd on Mac, Ctrl on Windows/Linux
```

## Hotkey Format

Hotkeys are specified as strings with modifiers separated by `+` and the main key last:

```
modifier1+modifier2+...+key
```

Order doesn't matter, but modifiers must come before the main key.

## Architecture

```
┌─────────────────────────┐
│   Node.js Process       │
│   ┌─────────────────┐   │
│   │ JS Wrapper      │   │
│   │ (index.js)      │   │
│   └────────┬────────┘   │
│            │            │
│   stdin/stdout JSON     │
│            │            │
└────────────┼────────────┘
             │
┌────────────┼──────────────┐
│   Rust Sidecar Process    │
│            ▼              │
│   ┌─────────────────┐     │
│   │ stdin reader    │     │
│   │ (background)    │     │
│   └────────┬────────┘     │
│            │              │
│   ┌────────▼────────┐     │
│   │ Event Loop      │     │
│   │ (Main Thread)   │     │
│   │                 │     │
│   │ GlobalHotkey    │     │
│   │ Manager         │     │
│   └─────────────────┘     │
└───────────────────────────┘
```

## Debug Mode

Enable debug logging by setting the `DEBUG` environment variable:

```bash
DEBUG=true node your-script.js
DEBUG=global-shortcuts node your-script.js
```

Or enable it in the constructor:

```typescript
const manager = new GlobalHotKeyManager({ debug: true });
```

## Standalone Binaries

Pre-compiled Rust sidecar binaries are available in the [GitHub Releases](https://github.com/rzkyif/global-shortcuts/releases) for each platform and architecture. These binaries are intended for manual sidecar usage only.

> **Recommended Usage:** For most users, the recommended approach is to install the NPM package (`npm install global-shortcuts`) and let `index.js` automatically manage the sidecar process. See the [Usage](#usage) section above for instructions.

### Available Binaries

| Platform | Architecture          | Binary Name                          |
| -------- | --------------------- | ------------------------------------ |
| macOS    | Apple Silicon (arm64) | `global-shortcuts-macos-arm64`       |
| macOS    | Intel (x86_64)        | `global-shortcuts-macos-x64`         |
| Linux    | x86_64                | `global-shortcuts-linux-x64`         |
| Linux    | ARM64                 | `global-shortcuts-linux-arm64`       |
| Windows  | x64                   | `global-shortcuts-windows-x64.exe`   |
| Windows  | ARM64                 | `global-shortcuts-windows-arm64.exe` |

### Manual Usage

Download the appropriate binary for your platform and run it directly. The sidecar accepts JSON commands via stdin and outputs events via stdout:

```bash
# Example: Start the sidecar and send a register command
echo '{"action":"register","hotkey":"ctrl+shift+a","id":1}' | ./global-shortcuts-macos-arm64
```

## License

MIT
