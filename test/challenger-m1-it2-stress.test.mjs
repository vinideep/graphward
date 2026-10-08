import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_CAPABILITY_CARDS,
  DEFAULT_CONFIG,
  DEFAULT_ROUTING_CONFIG,
  GW_CONFIG_PATH,
  loadGwConfig,
  migrateGwConfig,
  serializeConfigWrite,
  updateProviderConfig,
  updateRoutingConfig,
} from "../dist/config/index.js";

async function createTempFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "gw-challenger-m1it2-"));
  await mkdir(path.join(root, ".graphward"), { recursive: true });
  return root;
}

test("CHALLENGER M1-IT2: Empirical Stress Test Suite", async (t) => {
  await t.test("Stress Test 1: 20 concurrent asynchronous updateRoutingConfig calls produce 0 ENOENT and 0 rejections", async () => {
    const root = await createTempFixture();
    try {
      await writeFile(
        path.join(root, GW_CONFIG_PATH),
        JSON.stringify({ schemaVersion: 2, routing: DEFAULT_ROUTING_CONFIG }, null, 2),
      );

      const count = 20;
      const calls = Array.from({ length: count }, (_, i) =>
        updateRoutingConfig(root, { threshold: Number((0.05 * (i + 1)).toFixed(2)) })
      );

      const results = await Promise.allSettled(calls);
      const rejections = results.filter((r) => r.status === "rejected");
      const fulfillments = results.filter((r) => r.status === "fulfilled");

      assert.equal(
        rejections.length,
        0,
        `Expected 0 rejections, but observed ${rejections.length}. Errors: ${rejections.map((r) => r.reason?.message).join("; ")}`,
      );
      assert.equal(fulfillments.length, count, `Expected all ${count} calls to fulfill`);

      // Verify final file is valid JSON
      const rawDisk = await readFile(path.join(root, GW_CONFIG_PATH), "utf8");
      const parsed = JSON.parse(rawDisk);
      assert.ok(parsed.routing, "Routing config must be present in parsed JSON");
      assert.ok(typeof parsed.routing.threshold === "number");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("Stress Test 2: 20 concurrent calls on uninitialized directory (lazy init race)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gw-lazy-init-race-"));
    // Notice: .graphward directory does NOT exist yet!
    try {
      const count = 20;
      const calls = Array.from({ length: count }, (_, i) =>
        updateRoutingConfig(root, { threshold: 0.1 * ((i % 5) + 1) })
      );

      const results = await Promise.allSettled(calls);
      const rejections = results.filter((r) => r.status === "rejected");
      const fulfillments = results.filter((r) => r.status === "fulfilled");

      assert.equal(rejections.length, 0, `Lazy init race caused rejections: ${rejections.map((r) => r.reason?.message).join("; ")}`);
      assert.equal(fulfillments.length, count);

      const rawDisk = await readFile(path.join(root, GW_CONFIG_PATH), "utf8");
      const parsed = JSON.parse(rawDisk);
      assert.ok(parsed.routing);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("Stress Test 3: Zero JSON corruption across 20 trials of 20 concurrent calls (400 total operations)", async () => {
    let corruptionObserved = false;
    let corruptedPayload = "";

    for (let trial = 0; trial < 20; trial++) {
      const root = await createTempFixture();
      try {
        await writeFile(
          path.join(root, GW_CONFIG_PATH),
          JSON.stringify({ schemaVersion: 2, routing: DEFAULT_ROUTING_CONFIG }, null, 2),
        );

        const promises = Array.from({ length: 20 }, (_, i) =>
          updateRoutingConfig(root, {
            threshold: Number((0.04 * (i + 1)).toFixed(2)),
            classifier: `model-${i}`,
          })
        );

        const settled = await Promise.allSettled(promises);
        const rejections = settled.filter((s) => s.status === "rejected");
        assert.equal(rejections.length, 0, `Trial ${trial} experienced rejections: ${rejections.length}`);

        const diskContent = await readFile(path.join(root, GW_CONFIG_PATH), "utf8");
        try {
          const parsed = JSON.parse(diskContent);
          assert.equal(typeof parsed.routing, "object");
          assert.equal(typeof parsed.routing.threshold, "number");
          assert.equal(typeof parsed.routing.classifier, "string");
        } catch (err) {
          corruptionObserved = true;
          corruptedPayload = diskContent;
          break;
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }

    assert.equal(corruptionObserved, false, `Corrupted JSON observed on disk: ${corruptedPayload}`);
  });

  await t.test("Stress Test 4: Read-Modify-Write Lost Updates Oracle — all independent field mutations survive", async () => {
    const root = await createTempFixture();
    try {
      // Setup initial baseline config
      await writeFile(
        path.join(root, GW_CONFIG_PATH),
        JSON.stringify({
          schemaVersion: 2,
          customUserMetadata: { preserveMe: true, buildNumber: 42 },
          routing: {
            enabled: true,
            threshold: 0.5,
            classifier: "baseline-classifier",
            logLevel: "none",
            capabilityCards: DEFAULT_CAPABILITY_CARDS,
          },
        }, null, 2),
      );

      const customCards = [
        {
          id: "custom-oracle-card",
          model: "specialist-v1",
          description: "Adversarial oracle capability card",
          strengths: ["stress-testing"],
          costTier: "premium",
        },
      ];

      // Launch concurrent mutations targeting completely distinct fields
      const p1 = updateRoutingConfig(root, { threshold: 0.95 });
      const p2 = updateRoutingConfig(root, { classifier: "challenger-classifier" });
      const p3 = updateRoutingConfig(root, { logLevel: "verbose" });
      const p4 = updateRoutingConfig(root, { enabled: false });
      const p5 = updateRoutingConfig(root, { forceModel: "forced-model-oracle" });
      const p6 = updateRoutingConfig(root, { capabilityCards: customCards });

      const results = await Promise.allSettled([p1, p2, p3, p4, p5, p6]);
      for (const res of results) {
        assert.equal(res.status, "fulfilled", `Operation rejected: ${res.reason?.message}`);
      }

      // Read final on-disk configuration
      const finalConfig = JSON.parse(await readFile(path.join(root, GW_CONFIG_PATH), "utf8"));

      // Oracle checks: EVERY single field modification must be present
      assert.equal(
        finalConfig.routing.threshold,
        0.95,
        "Lost update detected: threshold was not preserved in final state",
      );
      assert.equal(
        finalConfig.routing.classifier,
        "challenger-classifier",
        "Lost update detected: classifier was overwritten/lost",
      );
      assert.equal(
        finalConfig.routing.logLevel,
        "verbose",
        "Lost update detected: logLevel was overwritten/lost",
      );
      assert.equal(
        finalConfig.routing.enabled,
        false,
        "Lost update detected: enabled was overwritten/lost",
      );
      assert.equal(
        finalConfig.routing.forceModel,
        "forced-model-oracle",
        "Lost update detected: forceModel was overwritten/lost",
      );
      assert.equal(
        finalConfig.routing.capabilityCards.length,
        1,
        "Lost update detected: capabilityCards were overwritten/lost",
      );
      assert.equal(finalConfig.routing.capabilityCards[0].id, "custom-oracle-card");

      // Custom top-level metadata must also survive intact
      assert.deepEqual(
        finalConfig.customUserMetadata,
        { preserveMe: true, buildNumber: 42 },
        "Custom metadata was corrupted or lost",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("Stress Test 5: High burst concurrency (50 concurrent calls in a single burst)", async () => {
    const root = await createTempFixture();
    try {
      await writeFile(
        path.join(root, GW_CONFIG_PATH),
        JSON.stringify({ schemaVersion: 2, routing: DEFAULT_ROUTING_CONFIG }, null, 2),
      );

      const count = 50;
      const promises = Array.from({ length: count }, (_, i) =>
        updateRoutingConfig(root, { threshold: Number((0.01 * (i + 1)).toFixed(2)) })
      );

      const startTime = Date.now();
      const results = await Promise.allSettled(promises);
      const elapsedMs = Date.now() - startTime;

      const failures = results.filter((r) => r.status === "rejected");
      assert.equal(failures.length, 0, `50-call burst had ${failures.length} failures`);
      assert.equal(results.length, count);

      const diskContent = await readFile(path.join(root, GW_CONFIG_PATH), "utf8");
      const parsed = JSON.parse(diskContent);
      assert.ok(parsed.routing.threshold >= 0 && parsed.routing.threshold <= 1);
      assert.ok(elapsedMs < 5000, `Execution took too long: ${elapsedMs}ms`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("Stress Test 6: Temporary file hygiene — zero leftover .tmp-* files after 30 concurrent writes", async () => {
    const root = await createTempFixture();
    try {
      await writeFile(
        path.join(root, GW_CONFIG_PATH),
        JSON.stringify({ schemaVersion: 2, routing: DEFAULT_ROUTING_CONFIG }, null, 2),
      );

      const count = 30;
      await Promise.all(
        Array.from({ length: count }, (_, i) =>
          updateRoutingConfig(root, { threshold: Number((0.02 * (i + 1)).toFixed(2)) })
        )
      );

      const gwDir = path.join(root, ".graphward");
      const files = await readdir(gwDir);
      const tmpFiles = files.filter((f) => f.includes(".tmp"));

      assert.equal(
        tmpFiles.length,
        0,
        `Expected 0 temporary files remaining in ${gwDir}, found: ${tmpFiles.join(", ")}`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("Stress Test 7: Queue resilience — isolated task error does not wedge subsequent calls", async () => {
    const root = await createTempFixture();
    const configPath = path.join(root, GW_CONFIG_PATH);
    try {
      await writeFile(
        configPath,
        JSON.stringify({ schemaVersion: 2, routing: DEFAULT_ROUTING_CONFIG }, null, 2),
      );

      // Submit an intentionally failing task into serializeConfigWrite
      const failingTask = serializeConfigWrite(configPath, async () => {
        throw new Error("Deliberate injection failure for resilience testing");
      });

      // Concurrently submit 10 valid updateRoutingConfig calls behind the failing task
      const validCalls = Array.from({ length: 10 }, (_, i) =>
        updateRoutingConfig(root, { threshold: Number((0.05 * (i + 1)).toFixed(2)) })
      );

      const failResult = await failingTask.then(
        () => ({ ok: true }),
        (err) => ({ ok: false, error: err.message }),
      );
      assert.equal(failResult.ok, false);
      assert.match(failResult.error, /Deliberate injection failure/);

      const validResults = await Promise.allSettled(validCalls);
      const rejections = validResults.filter((r) => r.status === "rejected");
      assert.equal(
        rejections.length,
        0,
        `Subsequent tasks wedged or failed after preceding error: ${rejections.map((r) => r.reason?.message).join("; ")}`,
      );

      const parsed = JSON.parse(await readFile(configPath, "utf8"));
      assert.ok(parsed.routing);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("Stress Test 8: Mixed cross-function concurrency (updateRoutingConfig + updateProviderConfig + migrateGwConfig)", async () => {
    const root = await createTempFixture();
    try {
      await writeFile(
        path.join(root, GW_CONFIG_PATH),
        JSON.stringify({
          schemaVersion: 2,
          providers: { requireProviders: false, exposeRawMcp: false },
          routing: { enabled: true, threshold: 0.5 },
        }, null, 2),
      );

      // Run 3 different config mutations concurrently on the same file
      const p1 = updateRoutingConfig(root, { threshold: 0.88, logLevel: "verbose" });
      const p2 = updateProviderConfig(root, { requireProviders: true, exposeRawMcp: true });
      const p3 = migrateGwConfig(root);
      const p4 = updateRoutingConfig(root, { classifier: "mixed-concurrency-model" });

      const results = await Promise.allSettled([p1, p2, p3, p4]);
      for (const res of results) {
        assert.equal(res.status, "fulfilled", `Cross-function operation failed: ${res.reason?.message}`);
      }

      const finalConfig = JSON.parse(await readFile(path.join(root, GW_CONFIG_PATH), "utf8"));
      assert.equal(finalConfig.routing.threshold, 0.88);
      assert.equal(finalConfig.routing.logLevel, "verbose");
      assert.equal(finalConfig.routing.classifier, "mixed-concurrency-model");
      assert.equal(finalConfig.providers.requireProviders, true);
      assert.equal(finalConfig.providers.exposeRawMcp, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
