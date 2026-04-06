"use strict";

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const DEBUG = process.env.DEBUG === "true" || process.env.DEBUG === "global-shortcuts";

/**
 * Get the Rust target triple based on platform and architecture
 */
function getRustTargetTriple() {
  const platform = process.platform;
  const arch = process.arch;

  switch (platform) {
    case "darwin":
      return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
    case "win32":
      return arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
    case "linux":
      return arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
    default:
      return null;
  }
}

/**
 * Get the binary name based on platform and architecture
 * Matches the naming convention used in publish.yml and build.yml workflows
 */
function getBinaryName() {
  const platform = process.platform;
  const arch = process.arch;

  // Normalize architecture names - only x64 and arm64 are supported
  const normalizedArch = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : null;

  // Normalize platform names
  let normalizedPlatform;
  switch (platform) {
    case "darwin":
      normalizedPlatform = "macos";
      break;
    case "win32":
      normalizedPlatform = "windows";
      break;
    case "linux":
      normalizedPlatform = "linux";
      break;
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }

  if (!normalizedArch) {
    throw new Error(`Unsupported architecture: ${arch}. Only x64 and arm64 are supported.`);
  }

  return `global-shortcuts-${normalizedPlatform}-${normalizedArch}`;
}

/**
 * Verify that a file is a regular file (not a symlink, directory, etc.)
 * and has appropriate permissions for the platform
 * @param {string} filePath - The path to verify
 * @returns {boolean} Whether the file is a valid executable
 */
function isValidExecutable(filePath) {
  try {
    const stats = fs.statSync(filePath);

    // Must be a regular file
    if (!stats.isFile()) {
      return false;
    }

    // On Unix-like systems, verify it's executable
    if (process.platform !== "win32") {
      try {
        fs.accessSync(filePath, fs.constants.X_OK);
      } catch {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Find the sidecar binary path with strict security checks
 *
 * Binary is always relative to where index.js lives (__dirname):
 * 1. Development builds: __dirname/target/release/global-shortcuts
 * 2. Published npm packages (optionalDependencies as siblings):
 *    - __dirname/node_modules/<binary-name>/<binary-name> (normal install)
 *    - __dirname/../<binary-name>/<binary-name> (when package is inside another project's node_modules)
 */
function findBinary() {
  const binaryName = getBinaryName();

  // __dirname is the package root (where index.js is located)
  const packageDir = __dirname;

  // Possible binary locations (all relative to package root)
  const possiblePaths = [];
  const rustTarget = getRustTargetTriple();

  if (process.platform === "win32") {
    // Windows: only search for .exe variants
    possiblePaths.push(
      // CI builds with --target flag (e.g., target/x86_64-pc-windows-msvc/release/)
      path.join(packageDir, "target", rustTarget, "release", "global-shortcuts.exe"),
      // Local builds without --target flag
      path.join(packageDir, "target", "release", "global-shortcuts.exe"),
      // npm published packages
      path.join(packageDir, "node_modules", binaryName, `${binaryName}.exe`),
      path.join(packageDir, "..", binaryName, `${binaryName}.exe`),
    );
  } else {
    // Unix-like: no extension
    possiblePaths.push(
      // CI builds with --target flag (e.g., target/x86_64-apple-darwin/release/)
      path.join(packageDir, "target", rustTarget, "release", "global-shortcuts"),
      // Local builds without --target flag
      path.join(packageDir, "target", "release", "global-shortcuts"),
      // npm published packages
      path.join(packageDir, "node_modules", binaryName, binaryName),
      path.join(packageDir, "..", binaryName, binaryName),
    );
  }

  // Search for the binary
  for (const binPath of possiblePaths) {
    if (isValidExecutable(binPath)) {
      return binPath;
    }
  }

  // No binary found in allowed locations
  throw new Error(
    `Could not find sidecar binary '${binaryName}'. ` +
      `Please ensure the package is properly installed. ` +
      `Searched locations: ${possiblePaths.join(", ")}`,
  );
}

// Track all manager instances by ID for cleanup
const managers = new Map();
let managerIdCounter = 0;

/**
 * Clean up all managers on process exit
 */
function cleanupAllManagers() {
  for (const [_id, manager] of managers) {
    if (!manager.destroyed) {
      manager._cleanup();
    }
  }
  managers.clear();
}

// Register cleanup handlers for process exit
process.on("beforeExit", () => {
  cleanupAllManagers();
});

/**
 * GlobalHotKeyManager - Manages global hotkey registration via a sidecar process
 */
class GlobalHotKeyManager {
  /**
   * @param {Object} options - Configuration options
   * @param {boolean} [options.debug] - Enable debug logging
   */
  constructor(options = {}) {
    this.id = ++managerIdCounter;
    this.callbacks = new Map();
    this.pending = new Map();
    this.idCounter = 0;
    this.ready = false;
    this.readyQueue = [];
    this.destroyed = false;
    this.debug = options.debug !== undefined ? options.debug : DEBUG;

    // Register this manager instance
    managers.set(this.id, this);

    // Find and spawn the sidecar binary
    const binaryPath = options.binaryPath || findBinary();

    this._log("debug", `Spawning sidecar from: ${binaryPath}`);

    try {
      this.sidecar = spawn(binaryPath, [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: this.debug ? { ...process.env, DEBUG: "true" } : process.env,
        detached: false,
      });
      this._log("debug", "Sidecar process spawned successfully");
    } catch (err) {
      managers.delete(this.id);
      throw new Error(`Failed to spawn sidecar process: ${err.message}`);
    }

    // Set up stdout listener
    this.sidecar.stdout.on("data", (data) => {
      const lines = data
        .toString()
        .split("\n")
        .filter((line) => line.trim());
      for (const line of lines) {
        this._handleMessage(line);
      }
    });

    // Set up stderr listener for JSON debug logs from Rust sidecar
    this.sidecar.stderr.on("data", (data) => {
      const lines = data
        .toString()
        .split("\n")
        .filter((line) => line.trim());
      for (const line of lines) {
        this._handleStderr(line);
      }
    });

    // Handle process exit
    this.sidecar.on("exit", (code, signal) => {
      if (!this.destroyed) {
        this._log("error", `Process exited unexpectedly: code=${code}, signal=${signal}`);
        this.destroyed = true;
        // Reject all pending promises
        for (const [_id, pending] of this.pending) {
          pending.reject(new Error("Sidecar process exited unexpectedly"));
        }
        this.pending.clear();
        managers.delete(this.id);
      } else {
        this._log("debug", `Process exited: code=${code}, signal=${signal}`);
        managers.delete(this.id);
      }
    });

    this.sidecar.on("error", (err) => {
      this._log("error", `Process error: ${err.message}`);
      // Reject all pending promises
      for (const [, pending] of this.pending) {
        pending.reject(new Error(`Sidecar process error: ${err.message}`));
      }
      this.pending.clear();
      managers.delete(this.id);
    });
  }

  /**
   * Handle stderr output from the Rust sidecar (JSON debug logs)
   */
  _handleStderr(line) {
    try {
      const debug = JSON.parse(line);
      if (debug.level === "error") {
        this._log("error", `[sidecar] ${debug.message}`);
      } else {
        this._log(debug.level || "debug", `[sidecar] ${debug.message}`);
      }
    } catch {
      // Fallback for non-JSON stderr (e.g., Rust panics, unexpected output)
      this._log("error", `[sidecar stderr] ${line.trim()}`);
    }
  }

  /**
   * Debug logging helper
   */
  _log(level, message, ...args) {
    const prefix = `[global-shortcuts] [${level.toUpperCase()}]`;
    if (level === "error") {
      console.error(prefix, message, ...args);
    } else if (level === "debug") {
      if (this.debug) {
        console.log(prefix, message, ...args);
      }
    } else {
      console.log(prefix, message, ...args);
    }
  }

  /**
   * Handle incoming messages from the sidecar
   */
  _handleMessage(message) {
    this._log("debug", `From sidecar: ${message}`);
    try {
      const event = JSON.parse(message);

      switch (event.action) {
        case "ready": {
          if (!this.ready) {
            this.ready = true;
            this._log("debug", "Sidecar is ready, processing queued commands");
            // Process any queued registrations
            for (const cmd of this.readyQueue) {
              this._writeToStdin(cmd);
            }
            this.readyQueue = [];
          }
          break;
        }
        case "triggered": {
          const callback = this.callbacks.get(event.id);
          if (callback) {
            this._log("debug", `Triggered callback for id=${event.id}, state=${event.state}`);
            callback(event.id, event.state);
          } else {
            this._log("debug", `No callback registered for id=${event.id}`);
          }
          break;
        }
        case "registered": {
          const pending = this.pending.get(event.id);
          if (pending) {
            this._log("debug", `Resolved registration promise for id=${event.id}`);
            pending.resolve(event.id);
            this.pending.delete(event.id);
          }
          break;
        }
        case "registered_all": {
          const pending = this.pending.get("register_all");
          if (pending) {
            this._log(
              "debug",
              `Resolved register_all promise with ids=${JSON.stringify(pending.ids)}`,
            );
            pending.resolve(pending.ids);
            this.pending.delete("register_all");
          }
          break;
        }
        case "unregistered": {
          const pending = this.pending.get(event.id);
          if (pending) {
            this._log("debug", `Resolved unregister promise for id=${event.id}`);
            pending.resolve();
            this.pending.delete(event.id);
          }
          break;
        }
        case "unregistered_all": {
          const pending = this.pending.get("unregister_all");
          if (pending) {
            this._log("debug", `Resolved unregister_all promise`);
            pending.resolve();
            this.pending.delete("unregister_all");
          }
          break;
        }
        case "error": {
          this._log("error", `Error from sidecar: ${event.state}`);
          // Check if there's a pending promise for this id and reject it
          if (event.id && event.id !== 0 && this.pending.has(event.id)) {
            const pending = this.pending.get(event.id);
            pending.reject(new Error(event.state));
            this.pending.delete(event.id);
          } else if (event.id === 0) {
            // Check for batch operations - reject with the error message
            if (this.pending.has("register_all")) {
              const pending = this.pending.get("register_all");
              pending.reject(new Error(event.state));
              this.pending.delete("register_all");
            }
            if (this.pending.has("unregister_all")) {
              const pending = this.pending.get("unregister_all");
              pending.reject(new Error(event.state));
              this.pending.delete("unregister_all");
            }
          }
          break;
        }
        default:
          this._log("error", `Unknown message type: ${event.action}`);
      }
    } catch (err) {
      this._log("error", `Failed to parse message: ${message}`, err);
    }
  }

  /**
   * Write command to stdin
   */
  _writeToStdin(command) {
    if (this.destroyed) {
      this._log("debug", `Cannot write to stdin: manager destroyed`);
      return;
    }
    const message = JSON.stringify(command);
    this._log("debug", `To sidecar: ${message}`);
    // Write the command and flush to ensure it's sent to the sidecar
    this.sidecar.stdin.write(message + "\n", (err) => {
      if (err) {
        this._log("error", `Failed to write to sidecar stdin: ${err.message}`);
      }
    });
  }

  /**
   * Generate a unique ID for hotkey registration
   */
  _generateId() {
    return ++this.idCounter;
  }

  /**
   * Register a global hotkey with a callback
   * @param {string} hotkey - Hotkey string like "ctrl+shift+a"
   * @param {function} [callback] - Optional callback function(id, state) for triggered events
   * @returns {Promise<number>} Promise that resolves with the registered hotkey ID
   */
  register(hotkey, callback) {
    if (this.destroyed) {
      return Promise.reject(new Error("GlobalHotKeyManager has been destroyed"));
    }

    const id = this._generateId();
    this._log("debug", `Registering hotkey '${hotkey}' with id=${id}`);

    if (callback) {
      this.callbacks.set(id, callback);
    }

    const command = {
      action: "register",
      hotkey,
      id,
    };

    // Create a promise that resolves when the sidecar confirms registration
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, command });
    });

    if (this.ready) {
      this._writeToStdin(command);
    } else {
      this._log("debug", `Sidecar not ready yet, queuing command`);
      this.readyQueue.push(command);
    }

    return promise;
  }

  /**
   * Unregister a hotkey by ID
   * @param {number} id - The hotkey ID returned from register()
   * @returns {Promise<void>} Promise that resolves when the sidecar confirms unregistration
   */
  unregister(id) {
    if (this.destroyed) {
      return Promise.reject(new Error("GlobalHotKeyManager has been destroyed"));
    }

    this._log("debug", `Unregistering hotkey id=${id}`);
    this.callbacks.delete(id);

    const command = {
      action: "unregister",
      id,
    };

    // Create a promise that resolves when the sidecar confirms unregistration
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, command });
    });

    if (this.ready) {
      this._writeToStdin(command);
    } else {
      this._log("debug", `Sidecar not ready yet, queuing command`);
      this.readyQueue.push(command);
    }

    return promise;
  }

  /**
   * Register multiple hotkeys at once
   * @param {Array<{hotkey: string, callback: function}>} entries - Array of {hotkey, callback}
   * @returns {Promise<number[]>} Promise that resolves with array of registered hotkey IDs
   */
  registerAll(entries) {
    if (entries.length == 0) return Promise.resolve([]);

    if (this.destroyed) {
      return Promise.reject(new Error("GlobalHotKeyManager has been destroyed"));
    }

    const ids = [];
    const hotkeys = [];

    for (const entry of entries) {
      const id = this._generateId();
      ids.push(id);
      if (entry.callback) {
        this.callbacks.set(id, entry.callback);
      }
      hotkeys.push({ hotkey: entry.hotkey, id });
    }

    const command = {
      action: "register_all",
      hotkeys,
    };

    this._log(
      "debug",
      `Registering ${ids.length} hotkeys: ${hotkeys.map((h) => h.hotkey).join(", ")}`,
    );

    // Create a promise that resolves when the sidecar confirms registration
    const promise = new Promise((resolve, reject) => {
      this.pending.set("register_all", { resolve, reject, ids });
    });

    if (this.ready) {
      this._writeToStdin(command);
    } else {
      this._log("debug", `Sidecar not ready yet, queuing command`);
      this.readyQueue.push(command);
    }

    return promise;
  }

  /**
   * Unregister multiple hotkeys by ID
   * @param {Array<number>} ids - Array of hotkey IDs
   * @returns {Promise<void>} Promise that resolves when the sidecar confirms unregistration
   */
  unregisterAll(ids) {
    if (this.destroyed) {
      return Promise.reject(new Error("GlobalHotKeyManager has been destroyed"));
    }

    this._log("debug", `Unregistering ${ids.length} hotkeys: ${ids.join(", ")}`);

    for (const id of ids) {
      this.callbacks.delete(id);
    }

    const command = {
      action: "unregister_all",
      ids,
    };

    // Create a promise that resolves when the sidecar confirms unregistration
    const promise = new Promise((resolve, reject) => {
      this.pending.set("unregister_all", { resolve, reject, ids });
    });

    if (this.ready) {
      this._writeToStdin(command);
    } else {
      this._log("debug", `Sidecar not ready yet, queuing command`);
      this.readyQueue.push(command);
    }

    return promise;
  }

  /**
   * Internal cleanup method (called by destroy and process exit handlers)
   * @private
   */
  _cleanup() {
    this.destroyed = true;

    // Reject all pending promises
    for (const [, pending] of this.pending) {
      pending.reject(new Error("GlobalHotKeyManager destroyed"));
    }
    this.pending.clear();
    this.callbacks.clear();
    this.readyQueue = [];

    // Kill the sidecar process
    if (this.sidecar && !this.sidecar.killed) {
      this._log("debug", "Shutting down sidecar process");
      try {
        // Try graceful shutdown first by ending stdin
        this.sidecar.stdin.end();
      } catch {
        // Ignore errors
      }

      // Force kill if it hasn't exited within 100ms
      setTimeout(() => {
        if (this.sidecar && !this.sidecar.killed) {
          try {
            this.sidecar.kill("SIGTERM");
          } catch {
            // Ignore kill errors
          }
        }
      }, 100);
    }
  }

  /**
   * Destroy the manager and kill the sidecar process
   */
  destroy() {
    if (this.destroyed) {
      return;
    }

    this._log("debug", `Destroying GlobalHotKeyManager (id=${this.id})`);
    this._cleanup();
    managers.delete(this.id);
  }
}

module.exports = {
  GlobalHotKeyManager,
};
