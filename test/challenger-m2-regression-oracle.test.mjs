/**
 * Empirical Challenger Test Suite (Milestone 2 - Challenger 2)
 *
 * Verifies:
 * 1. Cache Bypass Hygiene:
 *    - When router is disabled (`enabled: false`), requests bypass classification and are NOT cached (cache remains empty).
 *    - Re-enabling the router allows fresh classification without stale cache contamination.
 *    - Environment override `CODEX_SHIM_DISABLE_ROUTER=1` and `CODEX_SHIM_DISABLE_ROUTER=true` enforce zero cache pollution.
 *    - Transparent proxy layer (`CodexShim`) respects bypass hygiene across single and multi-turn loops.
 * 2. Cost Savings Calculation Oracle:
 *    - Exact mathematical oracle verification across simulated 100-request workloads.
 *    - Cheap ($0.001) vs Premium baseline ($0.030) matches exact expectation:
 *      * 60 cheap / 40 premium = $1.7400
 *      * 100 cheap = $2.9000
 *      * 100 premium = $0.0000
 *      * 50 hits + 50 misses mixed workload matches exact tier savings.
 *    - Custom cost model options (`cheapCost`, `premiumCost`) verify parameterized oracle.
 *    - Standalone `RoutingStatsTracker` oracle covering standard tier ($0.010).
 * 3. Cache Hit Rate Accuracy & Model Distribution Statistics:
 *    - Zero-request edge case (no NaNs, clean 0% rate).
 *    - Precise fractional hit rate rounding to 3 decimal places (1/3 -> 0.333, 2/3 -> 0.667, 1/6 -> 0.167, 5/8 -> 0.625).
 *    - Model distribution conservation invariant: sum of model counts strictly equals `totalRouted`.
 *    - `TaskRoutingCache` LRU eviction and capacity statistics under high load.
 *    - CLI formatter `renderRoutingStats` textual and numerical fidelity.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRoutingConfig } from "../dist/config/index.js";
import {
  CodexShim,
  ModelRouter,
  renderRoutingStats,
  renderRoutingStatus,
  RoutingStatsTracker,
  TaskRoutingCache,
} from "../dist/routing/index.js";

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

// ===========================================================================
// SUITE 1: CACHE BYPASS HYGIENE
// ===========================================================================

test("Cache Bypass Hygiene: enabled: false guarantees zero cache pollution", async (t) => {
  await t.test("50 diverse requests under enabled: false bypass classification and keep cache size strictly 0", async () => {
    const router = new ModelRouter(
      normalizeRoutingConfig({
        enabled: false,
        classifier: "gpt-4o-mini",
        logLevel: "none",
      })
    );

    const taskIds = Array.from({ length: 50 }, (_, i) => `bypass-task-${i}`);

    for (let i = 0; i < 50; i++) {
      const decision = await router.route(`Complex architecture task ${i} score:0.95`, {
        taskId: taskIds[i],
      });

      assert.equal(decision.cacheStatus, "bypass", `Task ${i} must have bypass status`);
      assert.equal(decision.fromCache, false, `Task ${i} must not be from cache`);
      assert.equal(router.cache.size, 0, `Cache size must remain 0 after task ${i}`);
    }

    assert.equal(router.classifierCalls, 0, "Classifier must never be called when router is disabled");
    assert.equal(router.cache.size, 0, "Cache must remain strictly empty (size = 0)");

    // Verify cache store explicitly contains none of the processed tasks
    for (const id of taskIds) {
      assert.equal(router.cache.has(id), false, `Cache must not have ${id}`);
      assert.equal(router.cache.get(id), undefined, `Cache.get must return undefined for ${id}`);
    }
  });

  await t.test("cache bypass prevents pollution: re-enabling router performs fresh classification and then caches", async () => {
    const router = new ModelRouter(
      normalizeRoutingConfig({
        enabled: false,
        threshold: 0.7,
        logLevel: "none",
      })
    );

    const testTaskId = "pollute-check-task-1";
    const prompt = "Architect a resilient Raft cluster score:0.85";

    // Turn 1 with router disabled
    const decisionDisabled = await router.route(prompt, { taskId: testTaskId });
    assert.equal(decisionDisabled.cacheStatus, "bypass");
    assert.equal(decisionDisabled.fromCache, false);
    assert.equal(router.cache.size, 0, "Cache must be empty while disabled");
    assert.equal(router.classifierCalls, 0);

    // Re-enable router dynamically via updateConfig
    router.updateConfig({ enabled: true });
    assert.equal(router.getConfig().enabled, true);
    assert.equal(router.cache.size, 0, "Cache must still be empty before next call");

    // Turn 2 with router enabled: must NOT hit cache, must evaluate freshly and escalate
    const decisionEnabled = await router.route(prompt, { taskId: testTaskId });
    assert.equal(decisionEnabled.cacheStatus, "miss", "First enabled call must be a cache miss");
    assert.equal(decisionEnabled.fromCache, false);
    assert.equal(decisionEnabled.model, "gpt-4o", "Must escalate to premium based on score 0.85 >= 0.7");
    assert.equal(decisionEnabled.tier, "premium");
    assert.equal(router.classifierCalls, 1, "Classifier must be called exactly once now");
    assert.equal(router.cache.size, 1, "Task must now be added to cache");

    // Turn 3: same taskId must now hit the cache
    const decisionCached = await router.route(prompt, { taskId: testTaskId });
    assert.equal(decisionCached.cacheStatus, "hit", "Subsequent call must hit cache");
    assert.equal(decisionCached.fromCache, true);
    assert.equal(decisionCached.model, "gpt-4o");
    assert.equal(router.classifierCalls, 1, "Zero additional classifier calls on turn 3");
    assert.equal(router.cache.size, 1);
  });

  await t.test("CODEX_SHIM_DISABLE_ROUTER=1 environment override enforces zero cache pollution", async () => {
    await withEnv({ CODEX_SHIM_DISABLE_ROUTER: "1" }, async () => {
      const router = new ModelRouter(
        normalizeRoutingConfig({
          enabled: true,
          threshold: 0.7,
          logLevel: "none",
        })
      );

      for (let i = 0; i < 20; i++) {
        const decision = await router.route(`Task ${i} score:0.9`, { taskId: `env-disabled-${i}` });
        assert.equal(decision.cacheStatus, "bypass");
        assert.equal(decision.fromCache, false);
        assert.equal(router.cache.size, 0);
      }

      assert.equal(router.classifierCalls, 0);
      assert.equal(router.cache.size, 0);
    });

    // Outside the env override, router with enabled: true functions normally
    const router2 = new ModelRouter(
      normalizeRoutingConfig({
        enabled: true,
        threshold: 0.7,
        logLevel: "none",
      })
    );
    const decision2 = await router2.route("Task after env override cleared score:0.9", {
      taskId: "fresh-after-env",
    });
    assert.equal(decision2.cacheStatus, "miss");
    assert.equal(router2.cache.size, 1);
  });

  await t.test("CODEX_SHIM_DISABLE_ROUTER=true behaves identically with zero cache pollution", async () => {
    await withEnv({ CODEX_SHIM_DISABLE_ROUTER: "true" }, async () => {
      const router = new ModelRouter(
        normalizeRoutingConfig({
          enabled: true,
          logLevel: "none",
        })
      );

      const decision = await router.route("Arbitrary prompt score:0.95", { taskId: "true-env-task" });
      assert.equal(decision.cacheStatus, "bypass");
      assert.equal(router.cache.size, 0);
      assert.equal(router.classifierCalls, 0);
    });
  });

  await t.test("CodexShim proxy layer under enabled: false enforces cache bypass hygiene", async () => {
    const router = new ModelRouter(
      normalizeRoutingConfig({
        enabled: false,
        logLevel: "none",
      })
    );
    const shim = new CodexShim(router);

    for (let i = 0; i < 15; i++) {
      const res = await shim.handleRequest({
        messages: [{ role: "user", content: `Shim bypass task ${i} score:0.8` }],
        taskId: `shim-bypass-${i}`,
      });

      assert.ok(res._routing, "Response must attach _routing metadata");
      assert.equal(res._routing.cacheStatus, "bypass");
      assert.equal(res._routing.fromCache, false);
      assert.equal(router.cache.size, 0, `Router cache size must remain 0 after request ${i}`);
    }

    assert.equal(router.cache.size, 0);
    assert.equal(router.classifierCalls, 0);
  });

  await t.test("Multi-turn agent loop with enabled: false never caches across 10 sequential turns", async () => {
    const router = new ModelRouter(
      normalizeRoutingConfig({
        enabled: false,
        logLevel: "none",
      })
    );

    const taskId = "persistent-agent-loop-disabled";

    for (let turn = 1; turn <= 10; turn++) {
      const decision = await router.route(`Turn ${turn} iteration for task score:0.9`, { taskId });
      assert.equal(decision.cacheStatus, "bypass", `Turn ${turn} must have bypass status`);
      assert.equal(decision.fromCache, false, `Turn ${turn} must not be from cache`);
      assert.equal(router.cache.size, 0, `Cache size must remain 0 at turn ${turn}`);
    }

    assert.equal(router.classifierCalls, 0);
    assert.equal(router.cache.size, 0);
  });
});

// ===========================================================================
// SUITE 2: COST SAVINGS CALCULATION ORACLE
// ===========================================================================

test("Cost Savings Calculation Oracle: exact mathematical expectation verification", async (t) => {
  const CHEAP_COST = 0.001;
  const PREMIUM_COST = 0.030;
  const SAVINGS_PER_CHEAP = PREMIUM_COST - CHEAP_COST; // $0.029
  const SAVINGS_PER_PREMIUM = PREMIUM_COST - PREMIUM_COST; // $0.000

  await t.test("Oracle Case 1: 100-request workload with exact 60 cheap / 40 premium split", async () => {
    const router = new ModelRouter(
      normalizeRoutingConfig({
        enabled: true,
        threshold: 0.7,
        logLevel: "none",
      })
    );

    const N_CHEAP = 60;
    const N_PREMIUM = 40;
    const TOTAL = N_CHEAP + N_PREMIUM; // 100

    // Send 60 cheap requests (score 0.2 < 0.7)
    for (let i = 0; i < N_CHEAP; i++) {
      const decision = await router.route(`Format markdown table ${i} score:0.20`, {
        taskId: `oracle-cheap-${i}`,
      });
      assert.equal(decision.tier, "cheap");
      assert.equal(decision.model, "gpt-4o-mini");
    }

    // Send 40 premium requests (score 0.9 >= 0.7)
    for (let i = 0; i < N_PREMIUM; i++) {
      const decision = await router.route(`Architect distributed Raft consensus ${i} score:0.90`, {
        taskId: `oracle-prem-${i}`,
      });
      assert.equal(decision.tier, "premium");
      assert.equal(decision.model, "gpt-4o");
    }

    const stats = router.getStats();

    // Mathematical Oracle Calculations:
    const expectedCheapSavings = N_CHEAP * SAVINGS_PER_CHEAP; // 60 * 0.029 = 1.7400
    const expectedPremSavings = N_PREMIUM * SAVINGS_PER_PREMIUM; // 40 * 0.000 = 0.0000
    const rawSavings = expectedCheapSavings + expectedPremSavings;
    const expectedTotalSavings = Math.round(rawSavings * 10000) / 10000; // 1.7400

    assert.equal(stats.totalRouted, TOTAL, "Total routed must equal exactly 100");
    assert.equal(stats.modelDistribution["gpt-4o-mini"], N_CHEAP, "Must route exactly 60 to cheap model");
    assert.equal(stats.modelDistribution["gpt-4o"], N_PREMIUM, "Must route exactly 40 to premium model");
    assert.equal(
      stats.estimatedCostSavings,
      expectedTotalSavings,
      `Estimated savings must match oracle value $${expectedTotalSavings.toFixed(4)}`
    );
  });

  await t.test("Oracle Case 2: 100-request all-cheap workload ($0.001 each)", async () => {
    const router = new ModelRouter(
      normalizeRoutingConfig({
        enabled: true,
        threshold: 0.7,
        logLevel: "none",
      })
    );

    const TOTAL = 100;
    for (let i = 0; i < TOTAL; i++) {
      const decision = await router.route(`Simple prompt ${i} score:0.15`, {
        taskId: `all-cheap-${i}`,
      });
      assert.equal(decision.tier, "cheap");
    }

    const stats = router.getStats();
    const expectedTotalSavings = TOTAL * SAVINGS_PER_CHEAP; // 100 * 0.029 = 2.9000

    assert.equal(stats.totalRouted, TOTAL);
    assert.equal(stats.modelDistribution["gpt-4o-mini"], TOTAL);
    assert.equal(stats.modelDistribution["gpt-4o"], undefined);
    assert.equal(stats.estimatedCostSavings, expectedTotalSavings);
  });

  await t.test("Oracle Case 3: 100-request all-premium workload ($0.030 each, $0.00 savings)", async () => {
    const router = new ModelRouter(
      normalizeRoutingConfig({
        enabled: true,
        threshold: 0.7,
        logLevel: "none",
      })
    );

    const TOTAL = 100;
    for (let i = 0; i < TOTAL; i++) {
      const decision = await router.route(`Massive distributed concurrency task ${i} score:0.95`, {
        taskId: `all-prem-${i}`,
      });
      assert.equal(decision.tier, "premium");
    }

    const stats = router.getStats();
    const expectedTotalSavings = TOTAL * SAVINGS_PER_PREMIUM; // 0.0000

    assert.equal(stats.totalRouted, TOTAL);
    assert.equal(stats.modelDistribution["gpt-4o"], TOTAL);
    assert.equal(stats.modelDistribution["gpt-4o-mini"], undefined);
    assert.equal(stats.estimatedCostSavings, 0);
  });

  await t.test("Oracle Case 4: 100-request mixed workload with cache hits correctly accumulates tier savings", async () => {
    const router = new ModelRouter(
      normalizeRoutingConfig({
        enabled: true,
        threshold: 0.7,
        logLevel: "none",
      })
    );

    // Structure:
    // 30 distinct cheap tasks, each called twice (30 misses, 30 hits = 60 cheap calls)
    // 20 distinct premium tasks, each called twice (20 misses, 20 hits = 40 premium calls)
    // Total: 50 misses + 50 hits = 100 requests

    // Phase 1: 30 cheap tasks miss + hit
    for (let i = 0; i < 30; i++) {
      const id = `cache-cheap-${i}`;
      const d1 = await router.route(`Cheap task ${i} score:0.25`, { taskId: id });
      assert.equal(d1.fromCache, false);
      assert.equal(d1.tier, "cheap");

      const d2 = await router.route(`Cheap task ${i} score:0.25`, { taskId: id });
      assert.equal(d2.fromCache, true);
      assert.equal(d2.tier, "cheap");
    }

    // Phase 2: 20 premium tasks miss + hit
    for (let i = 0; i < 20; i++) {
      const id = `cache-prem-${i}`;
      const d1 = await router.route(`Premium task ${i} score:0.88`, { taskId: id });
      assert.equal(d1.fromCache, false);
      assert.equal(d1.tier, "premium");

      const d2 = await router.route(`Premium task ${i} score:0.88`, { taskId: id });
      assert.equal(d2.fromCache, true);
      assert.equal(d2.tier, "premium");
    }

    const stats = router.getStats();

    assert.equal(stats.totalRouted, 100);
    assert.equal(stats.cacheMisses, 50);
    assert.equal(stats.cacheHits, 50);
    assert.equal(stats.cacheHitRate, 0.5);
    assert.equal(stats.modelDistribution["gpt-4o-mini"], 60);
    assert.equal(stats.modelDistribution["gpt-4o"], 40);

    // Expected savings: 60 cheap calls * 0.029 = 1.7400
    assert.equal(stats.estimatedCostSavings, 1.74);
  });

  await t.test("Oracle Case 5: Custom cost model options in ModelRouter options", async () => {
    const customCheapCost = 0.002;
    const customPremiumCost = 0.050;
    const customSavingsPerCheap = customPremiumCost - customCheapCost; // 0.048

    const router = new ModelRouter(
      normalizeRoutingConfig({
        enabled: true,
        threshold: 0.7,
        logLevel: "none",
      }),
      {
        costModel: {
          cheapCost: customCheapCost,
          premiumCost: customPremiumCost,
        },
      }
    );

    // 50 cheap requests, 50 premium requests
    for (let i = 0; i < 50; i++) {
      await router.route(`Cheap prompt ${i} score:0.3`, { taskId: `cust-cheap-${i}` });
    }
    for (let i = 0; i < 50; i++) {
      await router.route(`Premium prompt ${i} score:0.9`, { taskId: `cust-prem-${i}` });
    }

    const stats = router.getStats();
    const expectedSavings = 50 * customSavingsPerCheap; // 50 * 0.048 = 2.4000

    assert.equal(stats.totalRouted, 100);
    assert.equal(stats.estimatedCostSavings, expectedSavings);
  });

  await t.test("Oracle Case 6: Standalone RoutingStatsTracker oracle covering standard tier ($0.010)", async () => {
    const tracker = new RoutingStatsTracker();

    // Baseline: $0.030
    // cheap: $0.001 -> savings $0.029
    // standard: $0.010 -> savings $0.020
    // premium: $0.030 -> savings $0.000

    // Record: 40 cheap, 30 standard, 30 premium
    for (let i = 0; i < 40; i++) {
      tracker.record({ model: "gpt-4o-mini", tier: "cheap", cacheStatus: "miss" });
    }
    for (let i = 0; i < 30; i++) {
      tracker.record({ model: "gpt-4o-standard", tier: "standard", cacheStatus: "hit" });
    }
    for (let i = 0; i < 30; i++) {
      tracker.record({ model: "gpt-4o", tier: "premium", cacheStatus: "miss" });
    }

    const stats = tracker.getStats();
    const rawExpected = 40 * 0.029 + 30 * 0.020 + 30 * 0.000; // 1.160 + 0.600 = 1.7600
    const expected = Math.round(rawExpected * 10000) / 10000;

    assert.equal(stats.totalRouted, 100);
    assert.equal(stats.cacheHits, 30);
    assert.equal(stats.cacheMisses, 70);
    assert.equal(stats.cacheHitRate, 0.3);
    assert.equal(stats.modelDistribution["gpt-4o-mini"], 40);
    assert.equal(stats.modelDistribution["gpt-4o-standard"], 30);
    assert.equal(stats.modelDistribution["gpt-4o"], 30);
    assert.equal(stats.estimatedCostSavings, expected);

    // Reset verification
    tracker.reset();
    const resetStats = tracker.getStats();
    assert.equal(resetStats.totalRouted, 0);
    assert.equal(resetStats.cacheHits, 0);
    assert.equal(resetStats.cacheMisses, 0);
    assert.equal(resetStats.cacheHitRate, 0);
    assert.equal(resetStats.estimatedCostSavings, 0);
    assert.deepEqual(resetStats.modelDistribution, {});
  });
});

// ===========================================================================
// SUITE 3: CACHE HIT RATE ACCURACY & MODEL DISTRIBUTION STATISTICS
// ===========================================================================

test("Cache Hit Rate Accuracy & Model Distribution Statistics", async (t) => {
  await t.test("Zero-request cold state produces clean statistics with 0% hit rate and no NaNs", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ logLevel: "none" }));
    const stats = router.getStats();

    assert.equal(stats.totalRouted, 0);
    assert.equal(stats.cacheHits, 0);
    assert.equal(stats.cacheMisses, 0);
    assert.equal(stats.cacheHitRate, 0);
    assert.equal(Number.isNaN(stats.cacheHitRate), false);
    assert.equal(stats.estimatedCostSavings, 0);
    assert.deepEqual(stats.modelDistribution, {});
  });

  await t.test("Cache hit rate fractional accuracy and 3-decimal rounding oracle", async () => {
    // Test exact fractional values using RoutingStatsTracker
    const tracker = new RoutingStatsTracker();

    // 1. 1 hit out of 3 requests: 1/3 = 0.333333... -> 0.333
    tracker.record({ model: "m", tier: "cheap", cacheStatus: "hit" });
    tracker.record({ model: "m", tier: "cheap", cacheStatus: "miss" });
    tracker.record({ model: "m", tier: "cheap", cacheStatus: "miss" });
    assert.equal(tracker.getStats().cacheHitRate, 0.333);

    // 2. 2 hits out of 3 requests: 2/3 = 0.666666... -> 0.667
    tracker.reset();
    tracker.record({ model: "m", tier: "cheap", cacheStatus: "hit" });
    tracker.record({ model: "m", tier: "cheap", cacheStatus: "hit" });
    tracker.record({ model: "m", tier: "cheap", cacheStatus: "miss" });
    assert.equal(tracker.getStats().cacheHitRate, 0.667);

    // 3. 1 hit out of 6 requests: 1/6 = 0.166666... -> 0.167
    tracker.reset();
    tracker.record({ model: "m", tier: "cheap", cacheStatus: "hit" });
    for (let i = 0; i < 5; i++) {
      tracker.record({ model: "m", tier: "cheap", cacheStatus: "miss" });
    }
    assert.equal(tracker.getStats().cacheHitRate, 0.167);

    // 4. 5 hits out of 8 requests: 5/8 = 0.625 -> 0.625
    tracker.reset();
    for (let i = 0; i < 5; i++) {
      tracker.record({ model: "m", tier: "cheap", cacheStatus: "hit" });
    }
    for (let i = 0; i < 3; i++) {
      tracker.record({ model: "m", tier: "cheap", cacheStatus: "miss" });
    }
    assert.equal(tracker.getStats().cacheHitRate, 0.625);

    // 5. 1 miss + 99 hits: 99/100 = 0.99
    tracker.reset();
    tracker.record({ model: "m", tier: "cheap", cacheStatus: "miss" });
    for (let i = 0; i < 99; i++) {
      tracker.record({ model: "m", tier: "cheap", cacheStatus: "hit" });
    }
    assert.equal(tracker.getStats().cacheHitRate, 0.99);

    // 6. 100 misses + 0 hits: 0/100 = 0
    tracker.reset();
    for (let i = 0; i < 100; i++) {
      tracker.record({ model: "m", tier: "cheap", cacheStatus: "miss" });
    }
    assert.equal(tracker.getStats().cacheHitRate, 0);
  });

  await t.test("Model distribution conservation invariant: sum of counts strictly equals totalRouted", async () => {
    const router = new ModelRouter(
      normalizeRoutingConfig({
        enabled: true,
        threshold: 0.7,
        logLevel: "none",
      })
    );

    // Route 100 requests across a variety of models using forceModel and scores
    const models = ["gpt-4o-mini", "gpt-4o", "claude-3-5-sonnet", "gemini-1.5-pro"];

    for (let i = 0; i < 100; i++) {
      const selectedTarget = models[i % models.length];
      await router.route(`Task distribution test ${i}`, {
        taskId: `distrib-${i}`,
        forceModel: selectedTarget,
      });
    }

    const stats = router.getStats();
    assert.equal(stats.totalRouted, 100);

    const sumDistributed = Object.values(stats.modelDistribution).reduce((sum, count) => sum + count, 0);
    assert.equal(
      sumDistributed,
      stats.totalRouted,
      `Sum of model distribution counts (${sumDistributed}) must strictly equal totalRouted (${stats.totalRouted})`
    );

    // Each model should have received exactly 25 requests
    for (const m of models) {
      assert.equal(stats.modelDistribution[m], 25, `Model ${m} must have count 25`);
    }
  });

  await t.test("TaskRoutingCache LRU eviction and capacity statistics under high load", async () => {
    const cache = new TaskRoutingCache({ maxEntries: 10 });

    assert.equal(cache.size, 0);
    const initialStats = cache.getStats();
    assert.equal(initialStats.size, 0);
    assert.equal(initialStats.hits, 0);
    assert.equal(initialStats.misses, 0);
    assert.equal(initialStats.evictions, 0);

    // Insert 25 distinct tasks into a 10-entry cache
    for (let i = 1; i <= 25; i++) {
      cache.set(`task-${i}`, {
        model: "gpt-4o-mini",
        confidence: 0.9,
        reasoning: "Test",
        tier: "cheap",
        scores: {},
        timestamp: new Date().toISOString(),
      });
    }

    assert.equal(cache.size, 10, "Cache size must be capped at maxEntries = 10");
    const statsAfterInsert = cache.getStats();
    assert.equal(statsAfterInsert.size, 10);
    assert.equal(statsAfterInsert.evictions, 15, "15 items must have been evicted");

    // Tasks 1..15 must be evicted
    for (let i = 1; i <= 15; i++) {
      assert.equal(cache.has(`task-${i}`), false, `task-${i} must be evicted`);
      assert.equal(cache.get(`task-${i}`), undefined);
    }

    // Tasks 16..25 must still exist
    for (let i = 16; i <= 25; i++) {
      assert.equal(cache.has(`task-${i}`), true, `task-${i} must be retained`);
      assert.ok(cache.get(`task-${i}`), `task-${i} must return cached value`);
    }

    // Accessing task-16 refreshes LRU; inserting a new item task-26 should evict task-17 (oldest)
    cache.get("task-16"); // refresh
    cache.set("task-26", {
      model: "gpt-4o",
      confidence: 0.9,
      reasoning: "New item",
      tier: "premium",
      scores: {},
      timestamp: new Date().toISOString(),
    });

    assert.equal(cache.has("task-17"), false, "task-17 should be evicted next");
    assert.equal(cache.has("task-16"), true, "task-16 should be retained because it was refreshed");
    assert.equal(cache.has("task-26"), true, "task-26 must be in cache");
    assert.equal(cache.getStats().evictions, 16);
  });

  await t.test("CLI text formatter renderRoutingStats reflects exact hit rate percentage and cost savings", async () => {
    const stats = {
      totalRouted: 100,
      cacheHits: 40,
      cacheMisses: 60,
      cacheHitRate: 0.400,
      estimatedCostSavings: 1.7400,
      modelDistribution: {
        "gpt-4o-mini": 60,
        "gpt-4o": 40,
      },
    };

    const formatted = renderRoutingStats(stats);

    assert.ok(formatted.includes("Total Routed: 100"), "Must render Total Routed");
    assert.ok(formatted.includes("Cache Hits: 40"), "Must render Cache Hits");
    assert.ok(formatted.includes("Cache Misses: 60"), "Must render Cache Misses");
    assert.ok(formatted.includes("Cache Hit Rate: 40.0%"), "Must render Cache Hit Rate percentage");
    assert.ok(formatted.includes("Cost Savings: $1.7400"), "Must render Cost Savings with 4 decimal places");
    assert.ok(formatted.includes("gpt-4o-mini: 60"), "Must render gpt-4o-mini count");
    assert.ok(formatted.includes("gpt-4o: 40"), "Must render gpt-4o count");
  });
});
