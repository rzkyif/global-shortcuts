/**
 * Global Shortcuts
 *
 * A Node.js wrapper for global hotkey registration using a Rust sidecar process.
 * This architecture is required for macOS where the event loop must run on the main thread.
 */

export interface HotKeyEntry {
  hotkey: string;
  callback?: (id: number, state: "Pressed" | "Released") => void;
}

export interface GlobalHotKeyManagerOptions {
  debug?: boolean;
  /**
   * Explicit path to the sidecar binary.
   * When provided, this path is used directly instead of auto-detection.
   * @internal
   */
  binaryPath?: string;
}

/**
 * GlobalHotKeyManager - Manages global hotkey registration via a sidecar process
 *
 * Automatically registers with the module's cleanup handlers to ensure proper
 * shutdown when the process exits.
 *
 * @example
 * ```typescript
 * import { GlobalHotKeyManager } from 'global-shortcuts'
 *
 * const manager = new GlobalHotKeyManager()
 *
 * // Register a single hotkey
 * const id = await manager.register('ctrl+shift+a', (id, state) => {
 *   console.log(`Hotkey ${id} pressed: ${state}`)
 * })
 *
 * // Register multiple hotkeys
 * const ids = await manager.registerAll([
 *   { hotkey: 'ctrl+b', callback: (id, state) => { ... } },
 *   { hotkey: 'alt+f1', callback: (id, state) => { ... } }
 * ])
 *
 * // Unregister a hotkey
 * await manager.unregister(id)
 *
 * // Or unregister all
 * await manager.unregisterAll(ids)
 *
 * // Clean up when done (optional - also happens automatically on exit)
 * manager.destroy()
 * ```
 */
export class GlobalHotKeyManager {
  /**
   * Create a new GlobalHotKeyManager instance
   * This spawns the Rust sidecar process
   * @param options - Optional configuration
   * @param options.debug - Enable debug logging (default: uses DEBUG env var)
   */
  constructor(options?: GlobalHotKeyManagerOptions);

  /**
   * Unique identifier for this manager instance
   */
  readonly id: number;

  /**
   * Whether the sidecar process is ready to receive commands
   * Commands sent before ready will be queued and processed automatically
   * @internal
   */
  readonly ready: boolean;

  /**
   * Register a global hotkey with an optional callback
   * @param hotkey - Hotkey string like "ctrl+shift+a"
   * @param callback - Optional callback function called when the hotkey is triggered
   * @returns Promise that resolves with the registered hotkey ID when the sidecar confirms
   */
  register(
    hotkey: string,
    callback?: (id: number, state: "Pressed" | "Released") => void,
  ): Promise<number>;

  /**
   * Unregister a hotkey by ID
   * @param id - The hotkey ID returned from register()
   * @returns Promise that resolves with the ID when the unregistration is processed
   */
  unregister(id: number): Promise<number>;

  /**
   * Register multiple hotkeys at once
   * @param entries - Array of {hotkey, callback} objects
   * @returns Promise that resolves with array of all IDs if successful, or rejects with (number | Error)[] if any fail
   */
  registerAll(entries: HotKeyEntry[]): Promise<number[]>;

  /**
   * Unregister multiple hotkeys by ID
   * @param ids - Array of hotkey IDs
   * @returns Promise that resolves with array of all IDs if successful, or rejects with (number | Error)[] if any fail
   */
  unregisterAll(ids: number[]): Promise<number[]>;

  /**
   * Destroy the manager and kill the sidecar process
   * Call this when you're done using the hotkey manager
   */
  destroy(): void;
}
