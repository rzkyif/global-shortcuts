# global-shortcuts

A robust, cross-platform Node.js and Bun library for reliably registering global keyboard shortcuts.

Under the hood, `global-shortcuts` bypasses the threading limitations and event-loop collisions of native Node.js addons by utilizing a lightweight Rust sidecar. It leverages Tauri's [`global-hotkey`](https://github.com/tauri-apps/global-hotkey) and [`tao`](https://github.com/tauri-apps/tao) crates to guarantee stable, OS-compliant hotkey detection without freezing your JavaScript thread.

See [the Why This Exists section below](#why-this-exists) for more information

## Platform Support

- **macOS:** x64, arm64 (Apple Silicon)
- **Windows:** x64, arm64
- **Linux:** x64, arm64 (X11 only until `global-hotkey` merges Wayland support via [#162](https://github.com/tauri-apps/global-hotkey/pull/162) and [#172](https://github.com/tauri-apps/global-hotkey/pull/172))

## Installation

```bash
npm install global-shortcuts
```

> Pre-compiled Rust binaries for your specific operating system and architecture are automatically resolved during installation.

## Quick Start

```typescript
import { GlobalHotKeyManager } from "global-shortcuts";

// 1. Initialize the manager (spawns the Rust sidecar process)
const manager = new GlobalHotKeyManager();

// 2. Register a single hotkey
const id = await manager.register("ctrl+shift+a", (id, state) => {
  console.log(`Hotkey pressed! State: ${state}`);
});

// 3. Register multiple hotkeys simultaneously
const ids = await manager.registerAll([
  { hotkey: "cmdorctrl+b", callback: () => console.log("Action B triggered") },
  { hotkey: "alt+f1", callback: () => console.log("Action C triggered") },
]);

// 4. Clean up specific hotkeys or multiple hotkeys
await manager.unregister(id);
await manager.unregisterAll(ids);

// Note: The manager automatically cleans up all hotkeys and kills the
// sidecar process when the Node.js process exits.
```

> The example code above works, but will exit immediately after registering the hotkeys. To keep the application from closing, you will need either an infinite loop or a synchronously blocking input call.

## API Reference

### Process Architecture

```text
┌─────────────────────────┐           ┌───────────────────────────┐
│   Node.js/Bun Process   │           │    Rust Sidecar Process   │
│ ┌─────────────────────┐ │           │ ┌───────────────────────┐ │
│ │  GlobalHotKeyManager│ │── stdin ─▶│ │ Background I/O Thread │ │
│ └─────────────────────┘ │           │ └───────────────────────┘ │
│            ▲            │           │             ▼             │
│            │            │           │ ┌───────────────────────┐ │
│            └────────────│◀─ stdout ─│ │ Main Thread (OS Loop) │ │
└─────────────────────────┘           │ └───────────────────────┘ │
                                      └───────────────────────────┘
```

### Class: `GlobalHotKeyManager`

#### `new GlobalHotKeyManager(options?)`

Creates a new manager instance and spawns the Rust sidecar process.

- **`options.debug`** _(boolean)_: Enables debug logging. Alternatively, you can set the environment variable `DEBUG=true` or `DEBUG=global-shortcuts`.
- **`options.binaryPath`** _(string)_: Explicit path to the sidecar binary. If provided, bypasses auto-detection. Useful for custom builds or non-standard deployment environments.

#### Properties

- **`manager.id`**: A unique identifier for this specific manager instance.
- **`manager.ready`**: _(boolean)_ Indicates if the sidecar process is fully booted and ready. Commands sent before `ready === true` are automatically queued and executed once the sidecar connects.

#### Methods

- **`register(hotkey: string, callback?: Function): Promise<number>`**

  Registers a global hotkey.
  - `callback(id, state)`: Fired when the hotkey is triggered. `state` is either `"Pressed"` or `"Released"`.
    = Resolves with a unique integer ID.
  - Rejects with an Error if registration fails (e.g., invalid hotkey format, OS error).

- **`unregister(id: number): Promise<number>`**

  Unregisters a specific hotkey using its ID.
  - Resolves with the ID when successfully unregistered.
  - If the ID was not found (already unregistered), it still resolves successfully.

- **`registerAll(entries: {hotkey: string, callback?: Function}[]): Promise<number[]>`**

  Registers multiple hotkeys at once. Each hotkey is registered individually.
  - If **all** succeed: resolves with an array of all IDs in input order.
  - If **any** fail: rejects with an array of `(number | Error)[]` in input order, where successful entries are IDs and failed entries are Error objects.

- **`unregisterAll(ids: number[]): Promise<number[]>`**

  Unregisters multiple hotkeys by their IDs. Each hotkey is unregistered individually.
  - If **all** succeed: resolves with an array of all IDs in input order.
  - If **any** fail: rejects with an array of `(number | Error)[]` in input order, where successful entries are IDs and failed entries are Error objects.
  - IDs that are not found (already unregistered) are treated as successful.

- **`destroy(): void`**

  Manually kills the sidecar process and clears all listeners. Safe to call multiple times.

  Automatically triggered on `process.on('beforeExit')`.

### Hotkey Formatting Guidelines

Hotkeys are defined as strings with modifiers separated by `+`. The main key must come last. Order of modifiers does not matter.

**Format:** `modifier1+modifier2+...+key`

**Supported Modifiers:**

- `ctrl`, `control`
- `shift`
- `alt`, `option`
- `super`, `cmd`, `command`, `meta`, `windows`
- `cmdorctrl` _(Dynamically maps to `cmd` on macOS and `ctrl` on Windows/Linux)_

**Supported Keys:**
All standard letters (`a-z`), digits (`0-9`), function keys (`f1-f24`), special keys (`space`, `enter`, `tab`, `escape`), arrow keys, numpad keys, and media keys.

**Examples:**

```typescript
manager.register("a", callback); // Single key
manager.register("ctrl+shift+a", callback); // Multiple modifiers
manager.register("cmdorctrl+s", callback); // Cross-platform save shortcut
```

## Standalone Usage

While `global-shortcuts` is designed to be consumed as a Node/Bun package, the underlying engine is a standalone executable. Pre-compiled binaries are available in the [GitHub Releases](https://github.com/rzkyif/global-shortcuts/releases) tab.

### Stdin / Stdout JSON Protocol

If you wish to use the binary in a different ecosystem (e.g., Python, Go, or a shell script), you can interact with it directly by piping JSON payloads to `stdin` and reading events from `stdout`.

#### 1. Send a command (Input via `stdin`)

Send a single-line JSON string to the binary. You must provide a unique integer `id`.

```json
{ "action": "register", "hotkey": "ctrl+shift+a", "id": 1 }
```

#### 2. Listen for result (Output via `stdout`)

When the OS detects the hardware keypress, the binary outputs a JSON string to `stdout`.

```json
{ "action": "event", "id": 1, "state": "Pressed" }
```

### Shell Example

```bash
# Start the macOS arm64 sidecar and register a hotkey
echo '{"action":"register", "hotkey":"ctrl+shift+a", "id":1}' | ./global-shortcuts-macos-arm64
```

### Stdin Commands (Inputs)

The sidecar accepts JSON commands via stdin. Each command is a single-line JSON object with an `"action"` field:

| Action           | Fields                                               | Description                                                                                                      |
| ---------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `register`       | `hotkey` (string), `id` (integer)                    | Register a single global hotkey.                                                                                 |
| `unregister`     | `id` (integer)                                       | Unregister a previously registered hotkey by its ID. If the ID is not found, the response is still successful.   |
| `register_all`   | `hotkeys` (array of `{hotkey: string, id: integer}`) | Register multiple hotkeys at once. Each hotkey is processed individually.                                        |
| `unregister_all` | `ids` (array of integers)                            | Unregister multiple hotkeys at once. Each ID is processed individually. IDs not found are treated as successful. |

### Stdout Events (Outputs)

The sidecar outputs JSON events to stdout. Each event is a single-line JSON object:

| Action                     | Fields                                     | Description                                                                                                         |
| -------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `ready`                    | _(none)_                                   | Sent once when the sidecar has finished initializing and is ready to receive commands.                              |
| `registered`               | `id` (integer)                             | Confirms a single hotkey was registered successfully.                                                               |
| `unregistered`             | `id` (integer)                             | Confirms a single hotkey was unregistered successfully (also sent if ID was not found).                             |
| `registered_all`           | `ids` (array of integers)                  | All hotkeys from a `register_all` command were registered successfully. Contains the array of registered IDs.       |
| `registered_all_partial`   | `results` (array of objects)               | Some hotkeys failed to register. Each object contains `id` and optionally `error` with the failure message.         |
| `unregistered_all`         | `ids` (array of integers)                  | All IDs from an `unregister_all` command were unregistered successfully. Contains the array of unregistered IDs.    |
| `unregistered_all_partial` | `results` (array of objects)               | Some IDs failed to unregister. Each object contains `id` and optionally `error` with the failure message.           |
| `triggered`                | `id` (integer), `state` (string)           | Fired when a registered hotkey is pressed or released. `state` is `"Pressed"` or `"Released"`.                      |
| `error`                    | `id` (integer or null), `message` (string) | An error occurred during registration or unregistration. `id` is null for errors not associated with a specific ID. |

### Stderr Debug Logs

When `DEBUG=true` or `DEBUG=global-shortcuts` is set in the environment, debug logs are written to stderr as single-line JSON objects:

| Field     | Type                   | Description                   |
| --------- | ---------------------- | ----------------------------- |
| `level`   | `"debug"` or `"error"` | The log level.                |
| `message` | string                 | Human-readable debug message. |

## Why This Exists

Registering global hotkeys in Node.js/Bun on macOS is notoriously difficult due to deep architectural conflicts:

- **The Permission Problem:** Most existing libraries trigger heavy-handed, invasive macOS Accessibility permission prompts.
- **The Threading Catch-22:** The correct native Apple API (Carbon) avoids these prompts, but strictly mandates running on the Main Thread alongside a native OS event loop (CFRunLoop).
- **The Native Addon Failure:** Because the V8/JavaScript engine already monopolizes the Main Thread, attempting to bridge Carbon via standard N-API or bun:ffi fails. You either crash the app with illegal thread exceptions, or you successfully start the Mac loop and permanently freeze your JavaScript.

**The Solution:** `global-shortcuts` bypasses this dead-end entirely. By isolating the OS-level event loop inside a microscopic, pre-compiled Rust sidecar process, it safely secures its own native Main Thread. The result is rock-solid hotkeys with zero Accessibility prompts, practically zero memory footprint, and a completely unblocked JavaScript event loop.

## License

[MIT](./LICENSE)
