import { Bench } from "tinybench";

import { GlobalHotKeyManager, GlobalHotKeyManagerInternals } from "../index.js";

// Helper to wait for the manager to be ready
async function waitForReady(manager: GlobalHotKeyManager): Promise<void> {
  return new Promise((resolve) => {
    const internals = manager as GlobalHotKeyManager & GlobalHotKeyManagerInternals;
    if (internals.ready) {
      resolve();
    } else {
      const checkReady = () => {
        if (internals.ready) {
          resolve();
        } else {
          setTimeout(checkReady, 10);
        }
      };
      checkReady();
    }
  });
}

// Helper to create a manager and wait for it to be ready
async function createReadyManager(): Promise<GlobalHotKeyManager> {
  const manager = new GlobalHotKeyManager();
  await waitForReady(manager);
  return manager;
}

const b = new Bench({ time: 100, iterations: 10 });

// Benchmark: Manager instantiation (without warmup - cold start)
b.add("GlobalHotKeyManager instantiation (cold)", async () => {
  const manager = new GlobalHotKeyManager();
  manager.destroy();
});

// Benchmark: Manager instantiation with warmup (hot)
b.add("GlobalHotKeyManager instantiation (hot)", async () => {
  const manager = await createReadyManager();
  manager.destroy();
});

// Benchmark: Single hotkey registration with warmup
b.add("GlobalHotKeyManager register (after warmup)", async () => {
  const manager = await createReadyManager();
  await manager.register("ctrl+shift+a", () => {});
  manager.destroy();
});

// Benchmark: Multiple hotkey registrations
b.add("GlobalHotKeyManager registerAll (10 hotkeys)", async () => {
  const manager = await createReadyManager();
  const hotkeys = Array.from({ length: 10 }, (_, i) => ({
    hotkey: `ctrl+${i}`,
    callback: () => {},
  }));
  await manager.registerAll(hotkeys);
  manager.destroy();
});

// Benchmark: Unregister
b.add("GlobalHotKeyManager unregister", async () => {
  const manager = await createReadyManager();
  const id = await manager.register("ctrl+u", () => {});
  await manager.unregister(id);
  manager.destroy();
});

// Benchmark: Multiple managers simultaneously
b.add("GlobalHotKeyManager multiple managers (5)", async () => {
  const managers = await Promise.all([
    createReadyManager(),
    createReadyManager(),
    createReadyManager(),
    createReadyManager(),
    createReadyManager(),
  ]);
  for (const m of managers) {
    m.destroy();
  }
});

await b.run();

console.log("\nBenchmark Results:");
console.table(b.table());
