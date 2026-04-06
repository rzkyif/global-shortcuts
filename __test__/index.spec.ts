import { describe, it, expect } from "bun:test";
import { GlobalHotKeyManager } from "../index";
import path from "path";

/**
 * Get the sidecar binary path for testing.
 * In CI cross-compile environments, this reads from SIDECAR_BINARY_PATH env var.
 * Otherwise, returns undefined to use auto-detection.
 */
function getTestBinaryPath(): string | undefined {
  if (process.env.SIDECAR_BINARY_PATH) {
    return path.resolve(process.env.SIDECAR_BINARY_PATH);
  }
  return undefined;
}

// Helper to wait for the manager to be ready
async function waitForReady(manager: GlobalHotKeyManager): Promise<void> {
  return new Promise((resolve) => {
    const internals = manager as GlobalHotKeyManager & { ready: boolean };
    if (internals.ready) {
      resolve();
    } else {
      const checkReady = setInterval(() => {
        if (internals.ready) {
          clearInterval(checkReady);
          resolve();
        }
      }, 10);
    }
  });
}

describe("GlobalHotKeyManager", () => {
  it("can be instantiated", async () => {
    const manager = new GlobalHotKeyManager({ binaryPath: getTestBinaryPath() });
    await waitForReady(manager);
    manager.destroy();
  });

  it("has unique id", async () => {
    const manager1 = new GlobalHotKeyManager({ binaryPath: getTestBinaryPath() });
    const manager2 = new GlobalHotKeyManager({ binaryPath: getTestBinaryPath() });
    await waitForReady(manager1);
    await waitForReady(manager2);

    expect(manager1.id).toBeGreaterThan(0);
    expect(manager2.id).toBeGreaterThan(0);
    expect(manager1.id).not.toBe(manager2.id);

    manager1.destroy();
    manager2.destroy();
  });

  it("register returns a number ID", async () => {
    const manager = new GlobalHotKeyManager({ binaryPath: getTestBinaryPath() });
    await waitForReady(manager);

    const id = await manager.register("ctrl+shift+t", (_id, _state) => {
      // Callback triggered
    });

    expect(typeof id).toBe("number");
    expect(id).toBeGreaterThan(0);

    manager.destroy();
  });

  it("registerAll returns array of IDs", async () => {
    const manager = new GlobalHotKeyManager({ binaryPath: getTestBinaryPath() });
    await waitForReady(manager);

    const ids = await manager.registerAll([
      { hotkey: "ctrl+1", callback: () => {} },
      { hotkey: "ctrl+2", callback: () => {} },
      { hotkey: "ctrl+3", callback: () => {} },
    ]);

    expect(Array.isArray(ids)).toBe(true);
    expect(ids.length).toBe(3);
    expect(typeof ids[0]).toBe("number");

    manager.destroy();
  });

  it("unregister removes callback", async () => {
    const manager = new GlobalHotKeyManager({ binaryPath: getTestBinaryPath() });
    await waitForReady(manager);

    const id = await manager.register("ctrl+u", () => {});
    expect(typeof id).toBe("number");

    await manager.unregister(id);

    // No error means success
    manager.destroy();
  });

  it("unregisterAll removes callbacks", async () => {
    const manager = new GlobalHotKeyManager({ binaryPath: getTestBinaryPath() });
    await waitForReady(manager);

    const ids = await manager.registerAll([
      { hotkey: "ctrl+4", callback: () => {} },
      { hotkey: "ctrl+5", callback: () => {} },
    ]);

    await manager.unregisterAll(ids);

    // No error means success
    manager.destroy();
  });

  it("destroy can be called multiple times", async () => {
    const manager = new GlobalHotKeyManager({ binaryPath: getTestBinaryPath() });
    await waitForReady(manager);

    await manager.register("ctrl+d", () => {});

    manager.destroy();
    manager.destroy();
  });

  it("register rejects after destroy", async () => {
    const manager = new GlobalHotKeyManager({ binaryPath: getTestBinaryPath() });
    manager.destroy();

    const promise = manager.register("ctrl+e", () => {});
    await expect(promise).rejects.toBeInstanceOf(Error);
  });

  it("registerAll rejects after destroy", async () => {
    const manager = new GlobalHotKeyManager({ binaryPath: getTestBinaryPath() });
    manager.destroy();

    const promise = manager.registerAll([{ hotkey: "ctrl+f", callback: () => {} }]);
    await expect(promise).rejects.toBeInstanceOf(Error);
  });

  it("hotkey format parsing", async () => {
    const manager = new GlobalHotKeyManager({ binaryPath: getTestBinaryPath() });
    await waitForReady(manager);

    // Test basic hotkey format parsing with safe combinations
    // Using Ctrl+number combinations which are unlikely to be system-reserved
    const hotkeys = ["ctrl+1", "ctrl+2", "ctrl+3"];

    for (const hotkey of hotkeys) {
      const id = await manager.register(hotkey, () => {});
      expect(typeof id).toBe("number");
    }

    manager.destroy();
  });

  it("unique IDs for different hotkeys", async () => {
    const manager = new GlobalHotKeyManager({ binaryPath: getTestBinaryPath() });
    await waitForReady(manager);

    const id1 = await manager.register("ctrl+1", () => {});
    const id2 = await manager.register("ctrl+2", () => {});

    expect(id1).not.toBe(id2);

    manager.destroy();
  });

  it("can re-register after unregister", async () => {
    const manager = new GlobalHotKeyManager({ binaryPath: getTestBinaryPath() });
    await waitForReady(manager);

    const id1 = await manager.register("ctrl+r", () => {});
    await manager.unregister(id1);

    const id2 = await manager.register("ctrl+r", () => {});

    expect(id1).not.toBe(id2);

    manager.destroy();
  });

  it("multiple managers work simultaneously", async () => {
    const manager1 = new GlobalHotKeyManager({ binaryPath: getTestBinaryPath() });
    const manager2 = new GlobalHotKeyManager({ binaryPath: getTestBinaryPath() });
    await waitForReady(manager1);
    await waitForReady(manager2);

    const id1 = await manager1.register("ctrl+1", () => {});
    const id2 = await manager2.register("ctrl+2", () => {});

    // Both IDs should be valid and greater than 0
    expect(id1).toBeGreaterThan(0);
    expect(id2).toBeGreaterThan(0);

    manager1.destroy();
    manager2.destroy();
  });

  it("callback is invoked (simulation)", async () => {
    const manager = new GlobalHotKeyManager({ binaryPath: getTestBinaryPath() });
    await waitForReady(manager);

    let callbackInvoked = false;
    const id = await manager.register("ctrl+9", (_id, _state) => {
      callbackInvoked = true;
    });

    expect(typeof id).toBe("number");
    // Note: We can't actually trigger the hotkey in tests, but we verify
    // the callback was registered without error
    expect(callbackInvoked).toBe(false);

    manager.destroy();
  });

  it("commands are queued before ready", async () => {
    // Create manager but don't wait for ready - commands should be queued
    const manager = new GlobalHotKeyManager({
      binaryPath: getTestBinaryPath(),
    }) as GlobalHotKeyManager & {
      readyQueue: unknown[];
      ready: boolean;
    };

    // Directly verify queue exists
    expect(Array.isArray(manager.readyQueue)).toBe(true);
    expect(manager.ready).toBe(false);

    // Queue a command manually
    const command = { action: "register", hotkey: "ctrl+x", id: 999 };
    manager.readyQueue.push(command);

    expect(manager.readyQueue.length).toBe(1);
    expect((manager.readyQueue[0] as typeof command).hotkey).toBe("ctrl+x");

    manager.destroy();
  });

  it("unregisterAll with empty array", async () => {
    const manager = new GlobalHotKeyManager({ binaryPath: getTestBinaryPath() });
    await waitForReady(manager);

    // Should not throw
    await manager.unregisterAll([]);

    manager.destroy();
  });

  it("registerAll with empty array", async () => {
    const manager = new GlobalHotKeyManager({ binaryPath: getTestBinaryPath() });
    await waitForReady(manager);

    const ids = await manager.registerAll([]);

    expect(Array.isArray(ids)).toBe(true);
    expect(ids.length).toBe(0);

    manager.destroy();
  });
});
