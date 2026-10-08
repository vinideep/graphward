import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_CAPABILITY_CARDS,
  DEFAULT_CONFIG,
  DEFAULT_ROUTING_CONFIG,
  GW_CONFIG_PATH,
  LEGACY_CONFIG_PATH,
  loadGwConfig,
  migrateGwConfig,
  serializeConfigWrite,
  updateProviderConfig,
  updateRoutingConfig,
} from "../dist/config/index.js";

async function createTempFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "gw-burst-stress-"));
  await mkdir(path.join(root, ".graphward"), { recursive: true });
  return root;
}

function withEnv(vars, fn) {
  const original = {};
  for (const key of Object.keys(vars)) {
    original[key] = process.env[key];
    if (vars[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = vars[key];
    }
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(vars)) {
        if (original[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = original[key];
        }
      }
    });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================================
// STRESS SUITE: Rapid Concurrent Bursts and Queue Draining Under Varying Loads
// ============================================================================

test("challenger-stress: rapid concurrent bursts and queue draining under varying loads", async (t) => {
  await t.test("50-task massive concurrent burst resolves with 100% success and valid JSON", async () => {
    const root = await createTempFixture();
    try {
      await writeFile(
        path.join(root, GW_CONFIG_PATH),
        JSON.stringify({ schemaVersion: 2, routing: DEFAULT_ROUTING_CONFIG }),
      );

      const logLevels = ["none", "summary", "verbose"];
      const promises = Array.from({ length: 50 }, (_, i) => {
        const threshold = Number(((i % 10) * 0.1).toFixed(2));
        const logLevel = logLevels[i % logLevels.length];
        return updateRoutingConfig(root, {
          threshold,
          logLevel,
          classifier: `classifier-worker-${i}`,
          forceModel: `model-burst-${i % 5}`,
        });
      });

      const results = await Promise.allSettled(promises);
      const rejections = results.filter((r) => r.status === "rejected");
      assert.equal(rejections.length, 0, `Expected 0 rejections, got ${rejections.length}`);

      const fulfillments = results.filter((r) => r.status === "fulfilled");
      assert.equal(fulfillments.length, 50, "All 50 operations must be fulfilled");

      const raw = await readFile(path.join(root, GW_CONFIG_PATH), "utf8");
      let parsed;
      assert.doesNotThrow(() => {
        parsed = JSON.parse(raw);
      }, "On-disk config must be valid JSON");

      assert.equal(parsed.schemaVersion, 2);
      assert.ok(typeof parsed.routing.threshold === "number");
      assert.ok(parsed.routing.threshold >= 0 && parsed.routing.threshold <= 1);
      assert.ok(["none", "summary", "verbose"].includes(parsed.routing.logLevel));
      assert.ok(parsed.routing.classifier.startsWith("classifier-worker-"));

      const files = await readdir(path.join(root, ".graphward"));
      const tmpFiles = files.filter((f) => f.includes(".tmp"));
      assert.equal(tmpFiles.length, 0, "Zero orphaned temporary files after 50-task burst");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("multi-wave storm: 5 consecutive waves of 20 concurrent calls (100 total ops)", async () => {
    const root = await createTempFixture();
    try {
      await writeFile(
        path.join(root, GW_CONFIG_PATH),
        JSON.stringify({ schemaVersion: 2, routing: DEFAULT_ROUTING_CONFIG }),
      );

      let totalSuccess = 0;
      let totalFailed = 0;

      for (let wave = 0; wave < 5; wave++) {
        const wavePromises = Array.from({ length: 20 }, (_, i) => {
          const id = wave * 20 + i;
          return updateRoutingConfig(root, {
            threshold: Number((0.01 * (id % 99 + 1)).toFixed(2)),
            classifier: `wave-${wave}-item-${i}`,
          });
        });

        const settled = await Promise.allSettled(wavePromises);
        totalSuccess += settled.filter((r) => r.status === "fulfilled").length;
        totalFailed += settled.filter((r) => r.status === "rejected").length;
      }

      assert.equal(totalFailed, 0, "No failures across 5 waves");
      assert.equal(totalSuccess, 100, "All 100 operations across 5 waves must succeed");

      const raw = await readFile(path.join(root, GW_CONFIG_PATH), "utf8");
      const parsed = JSON.parse(raw);
      assert.equal(parsed.schemaVersion, 2);
      assert.ok(parsed.routing);

      const files = await readdir(path.join(root, ".graphward"));
      assert.equal(files.filter((f) => f.includes(".tmp")).length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("queue draining and strict FIFO order under varying task latency", async () => {
    const root = await createTempFixture();
    try {
      const configPath = path.join(root, GW_CONFIG_PATH);
      await writeFile(configPath, JSON.stringify({ schemaVersion: 2, routing: DEFAULT_ROUTING_CONFIG }));

      const executionLog = [];
      const latencies = [30, 0, 15, 5, 25, 2, 20, 10, 0, 5]; // varying durations (ms)
      const tasksCount = latencies.length;

      const promises = Array.from({ length: tasksCount }, (_, index) => {
        const delay = latencies[index];
        return serializeConfigWrite(configPath, async () => {
          executionLog.push({ event: "start", index });
          if (delay > 0) {
            await sleep(delay);
          }
          executionLog.push({ event: "end", index });
          return index;
        });
      });

      const results = await Promise.all(promises);
      assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

      // Verify strict FIFO sequential execution:
      // In FIFO serialization, task N start must occur AFTER task N-1 end.
      for (let i = 0; i < tasksCount; i++) {
        const startIndex = executionLog.findIndex((e) => e.event === "start" && e.index === i);
        const endIndex = executionLog.findIndex((e) => e.event === "end" && e.index === i);
        assert.ok(startIndex < endIndex, `Task ${i} must start before it ends`);

        if (i > 0) {
          const prevEndIndex = executionLog.findIndex((e) => e.event === "end" && e.index === i - 1);
          assert.ok(
            startIndex > prevEndIndex,
            `Task ${i} must not start until Task ${i - 1} has completely ended (FIFO guarantee)`,
          );
        }
      }

      // Verify that after queue drains, a new write executes immediately
      const postDrainStartTime = Date.now();
      const postDrainResult = await serializeConfigWrite(configPath, async () => "drained");
      const postDrainDuration = Date.now() - postDrainStartTime;
      assert.equal(postDrainResult, "drained");
      assert.ok(postDrainDuration < 50, "Post-drain task starts immediately without artificial lag");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("error isolation in queue under heavy interleaved failure load", async () => {
    const root = await createTempFixture();
    try {
      const configPath = path.join(root, GW_CONFIG_PATH);
      await writeFile(configPath, JSON.stringify({ schemaVersion: 2, routing: DEFAULT_ROUTING_CONFIG }));

      const totalTasks = 30;
      const failingIndices = new Set([3, 7, 12, 18, 24]);

      const promises = Array.from({ length: totalTasks }, (_, i) => {
        return serializeConfigWrite(configPath, async () => {
          if (failingIndices.has(i)) {
            throw new Error(`Deliberate failure at index ${i}`);
          }
          return `success-${i}`;
        });
      });

      const results = await Promise.allSettled(promises);

      for (let i = 0; i < totalTasks; i++) {
        if (failingIndices.has(i)) {
          assert.equal(results[i].status, "rejected");
          assert.equal(results[i].reason.message, `Deliberate failure at index ${i}`);
        } else {
          assert.equal(results[i].status, "fulfilled");
          assert.equal(results[i].value, `success-${i}`);
        }
      }

      // Verify queue remains fully functional after multiple errors
      const recoveryWrite = await updateRoutingConfig(root, { threshold: 0.95 });
      assert.equal(recoveryWrite.threshold, 0.95);
      const onDisk = JSON.parse(await readFile(configPath, "utf8"));
      assert.equal(onDisk.routing.threshold, 0.95);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("cross-subsystem concurrent storm: updateRoutingConfig + updateProviderConfig + migrateGwConfig", async () => {
    const root = await createTempFixture();
    try {
      await writeFile(
        path.join(root, LEGACY_CONFIG_PATH),
        JSON.stringify({ tokenBudgets: { get_graph: 777, who_calls: 333 } }),
      );
      await writeFile(
        path.join(root, GW_CONFIG_PATH),
        JSON.stringify({
          schemaVersion: 2,
          providers: { policy: "auto", offline: false, requireProviders: false, exposeRawMcp: false },
          routing: DEFAULT_ROUTING_CONFIG,
        }),
      );

      const mixedOps = [];
      // 15 routing updates
      for (let i = 0; i < 15; i++) {
        mixedOps.push(
          updateRoutingConfig(root, {
            threshold: Number((0.5 + i * 0.02).toFixed(2)),
            classifier: `mixed-classifier-${i}`,
          }),
        );
      }
      // 15 provider updates
      for (let i = 0; i < 15; i++) {
        mixedOps.push(
          updateProviderConfig(root, {
            offline: i % 2 === 0,
            exposeRawMcp: i % 3 === 0,
          }),
        );
      }
      // 10 legacy migrations
      for (let i = 0; i < 10; i++) {
        mixedOps.push(migrateGwConfig(root));
      }

      const results = await Promise.allSettled(mixedOps);
      const rejections = results.filter((r) => r.status === "rejected");
      assert.equal(rejections.length, 0, `Expected 0 failures in cross-subsystem storm, got ${rejections.length}`);

      const fulfillments = results.filter((r) => r.status === "fulfilled");
      assert.equal(fulfillments.length, 40, "All 40 mixed operations fulfilled");

      const diskConfig = JSON.parse(await readFile(path.join(root, GW_CONFIG_PATH), "utf8"));
      assert.equal(diskConfig.schemaVersion, 2);
      assert.ok(diskConfig.routing);
      assert.ok(typeof diskConfig.routing.threshold === "number");
      assert.ok(diskConfig.routing.classifier.startsWith("mixed-classifier-"));
      assert.ok(diskConfig.providers);
      assert.equal(typeof diskConfig.providers.offline, "boolean");
      assert.equal(typeof diskConfig.providers.exposeRawMcp, "boolean");
      // Legacy token budgets consolidated and preserved
      assert.equal(diskConfig.tokenBudgets.get_graph, 777);
      assert.equal(diskConfig.tokenBudgets.who_calls, 333);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("concurrent reader-writer contention: 40 writers vs 60 readers without read corruption", async () => {
    const root = await createTempFixture();
    try {
      await writeFile(
        path.join(root, GW_CONFIG_PATH),
        JSON.stringify({ schemaVersion: 2, routing: DEFAULT_ROUTING_CONFIG }),
      );

      const writers = Array.from({ length: 40 }, (_, i) =>
        updateRoutingConfig(root, {
          threshold: Number((0.1 * ((i % 8) + 1)).toFixed(2)),
          forceModel: `model-rw-${i}`,
        }),
      );

      const readers = Array.from({ length: 60 }, async (_, i) => {
        // slight jitter so readers interleave throughout the writes
        if (i % 3 === 0) await sleep(2);
        return loadGwConfig(root);
      });

      const [writerResults, readerResults] = await Promise.all([
        Promise.allSettled(writers),
        Promise.allSettled(readers),
      ]);

      const writerFailures = writerResults.filter((r) => r.status === "rejected");
      assert.equal(writerFailures.length, 0, "All writers succeeded");

      const readerFailures = readerResults.filter((r) => r.status === "rejected");
      assert.equal(
        readerFailures.length,
        0,
        `Readers encountered errors: ${readerFailures.map((f) => f.reason?.message).join("; ")}`,
      );

      for (const res of readerResults) {
        assert.equal(res.status, "fulfilled");
        const cfg = res.value;
        assert.equal(cfg.schemaVersion, 2);
        assert.ok(cfg.routing);
        assert.ok(typeof cfg.routing.threshold === "number");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("independent multi-path queue concurrency (isolated queues per file)", async () => {
    const [rootA, rootB, rootC] = await Promise.all([
      createTempFixture(),
      createTempFixture(),
      createTempFixture(),
    ]);

    try {
      await Promise.all([
        writeFile(path.join(rootA, GW_CONFIG_PATH), JSON.stringify({ schemaVersion: 2, routing: DEFAULT_ROUTING_CONFIG })),
        writeFile(path.join(rootB, GW_CONFIG_PATH), JSON.stringify({ schemaVersion: 2, routing: DEFAULT_ROUTING_CONFIG })),
        writeFile(path.join(rootC, GW_CONFIG_PATH), JSON.stringify({ schemaVersion: 2, routing: DEFAULT_ROUTING_CONFIG })),
      ]);

      const tasksA = Array.from({ length: 15 }, (_, i) => updateRoutingConfig(rootA, { threshold: 0.1, classifier: `A-${i}` }));
      const tasksB = Array.from({ length: 15 }, (_, i) => updateRoutingConfig(rootB, { threshold: 0.5, classifier: `B-${i}` }));
      const tasksC = Array.from({ length: 15 }, (_, i) => updateRoutingConfig(rootC, { threshold: 0.9, classifier: `C-${i}` }));

      const all = await Promise.allSettled([...tasksA, ...tasksB, ...tasksC]);
      const rejections = all.filter((r) => r.status === "rejected");
      assert.equal(rejections.length, 0);

      const [diskA, diskB, diskC] = await Promise.all([
        readFile(path.join(rootA, GW_CONFIG_PATH), "utf8").then(JSON.parse),
        readFile(path.join(rootB, GW_CONFIG_PATH), "utf8").then(JSON.parse),
        readFile(path.join(rootC, GW_CONFIG_PATH), "utf8").then(JSON.parse),
      ]);

      assert.equal(diskA.routing.threshold, 0.1);
      assert.ok(diskA.routing.classifier.startsWith("A-"));
      assert.equal(diskB.routing.threshold, 0.5);
      assert.ok(diskB.routing.classifier.startsWith("B-"));
      assert.equal(diskC.routing.threshold, 0.9);
      assert.ok(diskC.routing.classifier.startsWith("C-"));
    } finally {
      await Promise.all([
        rm(rootA, { recursive: true, force: true }),
        rm(rootB, { recursive: true, force: true }),
        rm(rootC, { recursive: true, force: true }),
      ]);
    }
  });

  await t.test("concurrent bursts under active adversarial environment variables preserve disk isolation", async () => {
    const root = await createTempFixture();
    try {
      await writeFile(
        path.join(root, GW_CONFIG_PATH),
        JSON.stringify({ schemaVersion: 2, routing: DEFAULT_ROUTING_CONFIG }),
      );

      await withEnv(
        {
          CODEX_SHIM_THRESHOLD: "0.15",
          CODEX_SHIM_DISABLE_ROUTER: "1",
          CODEX_SHIM_FORCE_MODEL: "adversarial-env-model",
        },
        async () => {
          const promises = Array.from({ length: 25 }, (_, i) => {
            return updateRoutingConfig(root, {
              threshold: 0.88,
              enabled: true,
              classifier: `env-isolated-${i}`,
            });
          });

          const results = await Promise.allSettled(promises);
          assert.equal(results.filter((r) => r.status === "rejected").length, 0);

          const diskConfig = JSON.parse(await readFile(path.join(root, GW_CONFIG_PATH), "utf8"));
          assert.equal(diskConfig.routing.threshold, 0.88, "Disk threshold must be 0.88, not env 0.15");
          assert.equal(diskConfig.routing.enabled, true, "Disk enabled must be true, not env disabled");
          assert.equal(diskConfig.routing.forceModel, undefined, "Disk must not record env forceModel");

          const inMemoryLoaded = await loadGwConfig(root);
          assert.equal(inMemoryLoaded.routing.threshold, 0.15, "In-memory load applies env override");
          assert.equal(inMemoryLoaded.routing.enabled, false, "In-memory load applies env override");
          assert.equal(inMemoryLoaded.routing.forceModel, "adversarial-env-model");
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
