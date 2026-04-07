"use strict";

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const DEBUG = process.env.DEBUG === "true" || process.env.DEBUG === "global-shortcuts";

// Platform-specific configuration for binary resolution
const PLATFORM_CONFIG = {
  darwin: {
    name: "macos",
    targets: { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" },
    ext: "",
  },
  win32: {
    name: "windows",
    targets: { arm64: "aarch64-pc-windows-msvc", x64: "x86_64-pc-windows-msvc" },
    ext: ".exe",
  },
  linux: {
    name: "linux",
    targets: { arm64: "aarch64-unknown-linux-gnu", x64: "x86_64-unknown-linux-gnu" },
    ext: "",
  },
};

/**
 * Get platform configuration with binary name and target triple
 * @returns {{ binaryName: string, target: string, ext: string }}
 */
function getPlatformConfig() {
  const { platform, arch } = process;
  const config = PLATFORM_CONFIG[platform];
  if (!config) throw new Error(`Unsupported platform: ${platform}`);

  if (!["x64", "arm64"].includes(arch)) {
    throw new Error(`Unsupported architecture: ${arch}. Only x64 and arm64 are supported.`);
  }

  const target = config.targets[arch];
  if (!target) throw new Error(`Unsupported architecture ${arch} for platform ${platform}`);

  return {
    binaryName: `global-shortcuts-${config.name}-${arch}`,
    target,
    ext: config.ext,
  };
}

/**
 * Verify that a file is a regular file and has appropriate permissions
 */
function isValidExecutable(filePath) {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return false;

    // Ensure executable permission on Unix-like systems
    if (process.platform !== "win32") {
      try {
        fs.accessSync(filePath, fs.constants.X_OK);
      } catch {
        fs.chmodSync(filePath, 0o755);
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
 * Development builds use "global-shortcuts" (from cargo build),
 * while npm published packages use "global-shortcuts-<platform>-<arch>"
 */
function findBinary() {
  const { binaryName, target, ext } = getPlatformConfig();
  const base = __dirname;
  const devBinaryName = `global-shortcuts${ext}`; // cargo build output
  const pkgBinaryName = `${binaryName}${ext}`; // npm package output

  const possiblePaths = [
    // Development builds
    path.join(base, "target", target, "release", devBinaryName),
    path.join(base, "target", "release", devBinaryName),
    // NPM published packages
    path.join(base, "node_modules", binaryName, pkgBinaryName),
    path.join(base, "..", binaryName, pkgBinaryName),
  ];

  for (const binPath of possiblePaths) {
    if (isValidExecutable(binPath)) return binPath;
  }

  throw new Error(
    `Could not find sidecar binary '${pkgBinaryName}'. ` +
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
  managers.forEach((manager) => !manager.destroyed && manager._cleanup());
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
      this._log(
        this.destroyed ? "debug" : "error",
        `Process exited: code=${code}, signal=${signal}`,
      );
      if (!this.destroyed) {
        this.destroyed = true;
        this._rejectAllPending(new Error("Sidecar process exited unexpectedly"));
      }
      managers.delete(this.id);
    });

    this.sidecar.on("error", (err) => {
      this._log("error", `Process error: ${err.message}`);
      this._rejectAllPending(new Error(`Sidecar process error: ${err.message}`));
      managers.delete(this.id);
    });
  }

  _resolvePending(key, result) {
    const pending = this.pending.get(key);
    if (pending) {
      pending.resolve(result);
      this.pending.delete(key);
    }
  }

  _rejectPending(key, error) {
    const pending = this.pending.get(key);
    if (pending) {
      pending.reject(error);
      this.pending.delete(key);
    }
  }

  _rejectAllPending(error) {
    this.pending.forEach((pending) => pending.reject(error));
    this.pending.clear();
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
        case "ready":
          if (!this.ready) {
            this.ready = true;
            this._log("debug", "Sidecar is ready, processing queued commands");
            this.readyQueue.forEach((cmd) => this._writeToStdin(cmd));
            this.readyQueue = [];
          }
          break;

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

        case "registered":
        case "unregistered":
          this._log("debug", `Resolved promise for id=${event.id}`);
          this._resolvePending(event.id, event.id);
          break;

        case "registered_all":
        case "unregistered_all": {
          const isReg = event.action === "registered_all";
          const ids = event.ids || [];
          this._log(
            "debug",
            `Resolved ${isReg ? "register_all" : "unregister_all"} promise with ids=${JSON.stringify(ids)}`,
          );
          this._resolvePending(isReg ? "register_all" : "unregister_all", ids);
          break;
        }

        case "registered_all_partial":
        case "unregistered_all_partial": {
          const isReg = event.action === "registered_all_partial";
          const mappedResults = event.results.map((e) => (e.error ? new Error(e.error) : e.id));
          this._log(
            "debug",
            `Rejected ${isReg ? "register_all" : "unregister_all"} promise with partial results`,
          );
          this._rejectPending(isReg ? "register_all" : "unregister_all", mappedResults);
          break;
        }

        case "error":
          this._log("error", `Error from sidecar: ${event.message}`);
          if (event.id != null) {
            this._rejectPending(event.id, new Error(event.message));
          } else {
            this._rejectPending("register_all", new Error(event.message));
            this._rejectPending("unregister_all", new Error(event.message));
          }
          break;

        default:
          this._log("error", `Unknown message type: ${event.action}`);
      }
    } catch (err) {
      this._log("error", `Failed to parse message: ${message}`, err);
    }
  }

  /**
   * Send a command to the sidecar, handling ready queueing and pending promise creation
   */
  _sendCommand(command, pendingKey, description) {
    if (this.destroyed) {
      return Promise.reject(new Error("GlobalHotKeyManager has been destroyed"));
    }

    this._log("debug", description);

    const promise = new Promise((resolve, reject) => {
      this.pending.set(pendingKey, { resolve, reject });
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
   * Write command to stdin
   */
  _writeToStdin(command) {
    if (this.destroyed) return;
    const message = JSON.stringify(command);
    this._log("debug", `To sidecar: ${message}`);
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
   * Register a global hotkey with an optional callback
   * @param {string} hotkey - Hotkey string like "ctrl+shift+a"
   * @param {function} [callback] - Optional callback function(id, state)
   * @returns {Promise<number>} Promise that resolves with the registered hotkey ID
   */
  register(hotkey, callback) {
    const id = this._generateId();
    if (callback) this.callbacks.set(id, callback);

    return this._sendCommand(
      { action: "register", hotkey, id },
      id,
      `Registering hotkey '${hotkey}' with id=${id}`,
    );
  }

  /**
   * Unregister a hotkey by ID
   * @param {number} id - The hotkey ID returned from register()
   * @returns {Promise<number>} Promise that resolves with the unregistered ID
   */
  unregister(id) {
    this.callbacks.delete(id);
    return this._sendCommand({ action: "unregister", id }, id, `Unregistering hotkey id=${id}`);
  }

  /**
   * Register multiple hotkeys at once
   * @param {Array<{hotkey: string, callback: function}>} entries - Array of {hotkey, callback}
   * @returns {Promise<number[]>} Promise resolving with all IDs, or rejecting with (number | Error)[]
   */
  registerAll(entries) {
    if (entries.length === 0) return Promise.resolve([]);

    const ids = entries.map((entry) => {
      const id = this._generateId();
      if (entry.callback) this.callbacks.set(id, entry.callback);
      return { hotkey: entry.hotkey, id };
    });

    return this._sendCommand(
      { action: "register_all", hotkeys: ids },
      "register_all",
      `Registering ${ids.length} hotkeys: ${ids.map((h) => h.hotkey).join(", ")}`,
    );
  }

  /**
   * Unregister multiple hotkeys by ID
   * @param {Array<number>} ids - Array of hotkey IDs
   * @returns {Promise<number[]>} Promise resolving with all IDs, or rejecting with (number | Error)[]
   */
  unregisterAll(ids) {
    ids.forEach((id) => this.callbacks.delete(id));

    return this._sendCommand(
      { action: "unregister_all", ids },
      "unregister_all",
      `Unregistering ${ids.length} hotkeys: ${ids.join(", ")}`,
    );
  }

  /**
   * Internal cleanup method (called by destroy and process exit handlers)
   * @private
   */
  _cleanup() {
    this.destroyed = true;

    // Reject all pending promises
    this._rejectAllPending(new Error("GlobalHotKeyManager destroyed"));
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
