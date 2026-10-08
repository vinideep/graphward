/**
 * Unit Test Suite for ModelRouter and CodexShim (Milestone 2)
 *
 * Verifies:
 * 1. Shim Request Interception & Transparent Forwarding
 * 2. Threshold-Based Routing & Complexity Scoring Boundary Conditions
 * 3. 10-Call Per-Task Caching Guarantee (0 additional classifier calls)
 * 4. R5 Environment Variable Overrides & Precedence
 * 5. Structured NDJSON Log Format & Required 6 Fields
 * 6. HTTP Proxy Server Interception, Error Handling, and Lifecycle
 * 7. Aggregate Metrics, Cost Savings, and CLI Formatters
 */

import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRoutingConfig } from "../dist/config/index.js";
import {
  CodexShim,
  ModelRouter,
  renderRoutingStats,
  renderRoutingStatus,
  TaskRoutingCache,
  TaskClassifier,
  HeuristicClassifier,
  MockClassifier,
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
// SUITE 1: SHIM REQUEST INTERCEPTION & TRANSPARENT FORWARDING
// ===========================================================================

test("CodexShim: transparent request interception and response structure", async (t) => {
  await t.test("returns valid OpenAI-compatible chat completion payload", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.7 }));
    const shim = new CodexShim(router);

    const response = await shim.handleRequest({
      messages: [{ role: "user", content: "Format this markdown table" }],
      taskId: "shim-test-1",
    });

    assert.ok(response.id.startsWith("chatcmpl-"), "id must start with chatcmpl-");
    assert.equal(response.object, "chat.completion");
    assert.equal(typeof response.created, "number");
    assert.equal(response.model, "gpt-4o-mini");
    assert.ok(Array.isArray(response.choices) && response.choices.length === 1);
    assert.equal(response.choices[0].message.role, "assistant");
    assert.ok(response.usage.total_tokens > 0);
    assert.ok(response._routing, "response should attach _routing metadata");
    assert.equal(response._routing.taskId, "shim-test-1");
  });

  await t.test("extracts prompt from the last user message in multi-turn history", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.7 }));
    const shim = new CodexShim(router);

    const response = await shim.handleRequest({
      messages: [
        { role: "system", content: "You are a coding assistant" },
        { role: "user", content: "Simple hello" },
        { role: "assistant", content: "Hi there!" },
        {
          role: "user",
          content: "Architect a distributed Raft consensus engine with log compaction",
        },
      ],
      taskId: "multi-turn-task",
    });

    assert.equal(response.model, "gpt-4o", "must route based on latest user message");
  });

  await t.test("gracefully handles empty messages array without throwing", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({}));
    const shim = new CodexShim(router);

    const response = await shim.handleRequest({ messages: [], taskId: "empty-task" });
    assert.equal(response.model, "gpt-4o-mini");
    assert.ok(response.choices.length > 0);
  });

  await t.test("rejects malformed non-object request payload", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({}));
    const shim = new CodexShim(router);

    await assert.rejects(
      () => shim.handleRequest(null),
      /Invalid request payload/,
    );
    await assert.rejects(
      () => shim.handleRequest("not an object"),
      /Invalid request payload/,
    );
  });

  await t.test("supports custom pluggable upstream executor", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({}));
    let intercepted = false;

    const shim = new CodexShim(router, {
      upstreamExecutor: async (req, decision) => {
        intercepted = true;
        return {
          id: "custom-id",
          object: "chat.completion",
          created: 1000,
          model: decision.model,
          choices: [{ index: 0, message: { role: "assistant", content: "Custom" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          _routing: decision,
        };
      },
    });

    const res = await shim.handleRequest({ messages: [{ role: "user", content: "test" }] });
    assert.equal(intercepted, true);
    assert.equal(res.id, "custom-id");
  });
});

// ===========================================================================
// SUITE 2: THRESHOLD-BASED ROUTING & BOUNDARY CONDITIONS
// ===========================================================================

test("ModelRouter: complexity classification and threshold escalation", async (t) => {
  await t.test("routes simple syntax/fix task below threshold to cheap model", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.7 }));
    const dec = await router.route("Fix typo in comment", { taskId: "task-simple" });

    assert.equal(dec.model, "gpt-4o-mini");
    assert.equal(dec.tier, "cheap");
    assert.ok(dec.confidence < 0.7);
    assert.equal(dec.fromCache, false);
  });

  await t.test("escalates complex distributed architecture task above threshold to premium model", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.7 }));
    const dec = await router.route(
      "Architect a distributed consensus engine using Raft algorithm with multi-node leader election and log compaction",
      { taskId: "task-complex" },
    );

    assert.equal(dec.model, "gpt-4o");
    assert.equal(dec.tier, "premium");
    assert.ok(dec.confidence >= 0.7);
    assert.equal(dec.fromCache, false);
  });

  await t.test("boundary match: score == 0.700 escalates to premium model (>= condition)", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.700 }));
    const dec = await router.route("Task score:0.700", { taskId: "exact-boundary" });

    assert.equal(dec.model, "gpt-4o");
    assert.equal(dec.tier, "premium");
  });

  await t.test("boundary epsilon below: score == 0.699 stays on cheap model (< condition)", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.700 }));
    const dec = await router.route("Task score:0.699", { taskId: "epsilon-below" });

    assert.equal(dec.model, "gpt-4o-mini");
    assert.equal(dec.tier, "cheap");
  });

  await t.test("extreme threshold 0.0 escalates all tasks to premium model", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.0 }));
    const dec = await router.route("Simple syntax fix", { taskId: "zero-thresh" });

    assert.equal(dec.model, "gpt-4o");
    assert.equal(dec.tier, "premium");
  });

  await t.test("extreme threshold 1.0 keeps all standard tasks on cheap model", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 1.0 }));
    const dec = await router.route("Architect a distributed Raft consensus engine", { taskId: "one-thresh" });

    assert.equal(dec.model, "gpt-4o-mini");
    assert.equal(dec.tier, "cheap");
  });
});

// ===========================================================================
// SUITE 3: PER-TASK CACHING GUARANTEE (10-CALL LOOP)
// ===========================================================================

test("ModelRouter: per-task caching mechanism", async (t) => {
  await t.test("10 subsequent calls in same task context reuse cached decision with 0 additional classifier calls", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.7 }));
    const taskId = "agent-task-loop-test";

    // Turn 1: Initial classification (miss)
    const turn1 = await router.route("Architect distributed Raft consensus engine", { taskId });
    assert.equal(turn1.fromCache, false);
    assert.equal(turn1.model, "gpt-4o");
    assert.equal(router.classifierCalls, 1, "First call must invoke classifier exactly once");

    // Turns 2..10: Subsequent iterative tool calls within same task
    for (let i = 2; i <= 10; i++) {
      const turnI = await router.route(`Iterative tool call step ${i}`, { taskId });
      assert.equal(turnI.fromCache, true, `Turn ${i} must hit cache`);
      assert.equal(turnI.model, "gpt-4o", `Turn ${i} must retain cached model decision`);
    }

    assert.equal(
      router.classifierCalls,
      1,
      "Turns 2 through 10 must make 0 additional classifier calls",
    );

    const stats = router.getStats();
    assert.equal(stats.totalRouted, 10);
    assert.equal(stats.cacheHits, 9);
    assert.equal(stats.cacheMisses, 1);
    assert.equal(stats.cacheHitRate, 0.9);
  });

  await t.test("distinct tasks maintain cache isolation without cross-pollination", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.7 }));

    const decA1 = await router.route("Fix typo in comment", { taskId: "task-cheap-isolated" });
    const decB1 = await router.route("Architect distributed Raft engine", { taskId: "task-prem-isolated" });

    assert.equal(decA1.model, "gpt-4o-mini");
    assert.equal(decB1.model, "gpt-4o");

    const decA2 = await router.route("Next tool call for cheap", { taskId: "task-cheap-isolated" });
    const decB2 = await router.route("Next tool call for prem", { taskId: "task-prem-isolated" });

    assert.equal(decA2.model, "gpt-4o-mini");
    assert.equal(decA2.fromCache, true);
    assert.equal(decB2.model, "gpt-4o");
    assert.equal(decB2.fromCache, true);
  });

  await t.test("clearCache flushes cache and forces re-classification", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.7 }));

    await router.route("Fix typo", { taskId: "flush-task" });
    assert.equal(router.classifierCalls, 1);

    router.clearCache();
    assert.equal(router.cache.size, 0);

    const afterFlush = await router.route("Fix typo again", { taskId: "flush-task" });
    assert.equal(afterFlush.fromCache, false);
    assert.equal(router.classifierCalls, 2);
  });

  await t.test("LRU cache evicts oldest entry when reaching maxEntries", () => {
    const cache = new TaskRoutingCache({ maxEntries: 3 });
    cache.set("t1", { model: "m1", confidence: 1, reasoning: "r", tier: "cheap", scores: {}, timestamp: "ts" });
    cache.set("t2", { model: "m2", confidence: 1, reasoning: "r", tier: "cheap", scores: {}, timestamp: "ts" });
    cache.set("t3", { model: "m3", confidence: 1, reasoning: "r", tier: "cheap", scores: {}, timestamp: "ts" });
    assert.equal(cache.size, 3);

    // Access t1 to mark it recently used
    assert.ok(cache.get("t1"));

    // Insert t4: should evict t2 (oldest non-refreshed)
    cache.set("t4", { model: "m4", confidence: 1, reasoning: "r", tier: "cheap", scores: {}, timestamp: "ts" });
    assert.equal(cache.size, 3);
    assert.equal(cache.has("t2"), false, "t2 should have been evicted");
    assert.equal(cache.has("t1"), true, "t1 should remain");
    assert.equal(cache.has("t3"), true, "t3 should remain");
    assert.equal(cache.has("t4"), true, "t4 should remain");
  });
});

// ===========================================================================
// SUITE 4: R5 ENVIRONMENT VARIABLE OVERRIDES
// ===========================================================================

test("ModelRouter: runtime environment variable overrides (R5)", async (t) => {
  await t.test("CODEX_SHIM_DISABLE_ROUTER=1 bypasses classification to base model with 0 classifier calls", async () => {
    await withEnv({ CODEX_SHIM_DISABLE_ROUTER: "1" }, async () => {
      const router = new ModelRouter(normalizeRoutingConfig({ enabled: true }));
      const dec = await router.route("Architect distributed Raft consensus", { taskId: "dis-task" });

      assert.equal(dec.model, "gpt-4o-mini");
      assert.equal(router.classifierCalls, 0, "bypassed router makes 0 classifier calls");
    });
  });

  await t.test("CODEX_SHIM_DISABLE_ROUTER=true behaves identically to '1'", async () => {
    await withEnv({ CODEX_SHIM_DISABLE_ROUTER: "true" }, async () => {
      const router = new ModelRouter(normalizeRoutingConfig({ enabled: true }));
      const dec = await router.route("Architect distributed Raft consensus", { taskId: "dis-true-task" });

      assert.equal(dec.model, "gpt-4o-mini");
      assert.equal(router.classifierCalls, 0);
    });
  });

  await t.test("disabled router does not pollute cache; re-enabling starts with fresh evaluation", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ enabled: false }));

    // Request while disabled
    await router.route("Architect distributed Raft consensus", { taskId: "no-pollute" });
    assert.equal(router.cache.size, 0, "disabled router must not store entries in cache");

    // Re-enable
    router.updateConfig({ enabled: true });
    const reEnabled = await router.route("Architect distributed Raft consensus", { taskId: "no-pollute" });

    assert.equal(reEnabled.fromCache, false);
    assert.equal(reEnabled.model, "gpt-4o");
  });

  await t.test("CODEX_SHIM_FORCE_MODEL forces all requests to specified model regardless of score", async () => {
    await withEnv({ CODEX_SHIM_FORCE_MODEL: "claude-3-5-sonnet" }, async () => {
      const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.9 }));

      const decSimple = await router.route("Fix typo", { taskId: "force-simple" });
      assert.equal(decSimple.model, "claude-3-5-sonnet");

      const decComplex = await router.route("Architect distributed system", { taskId: "force-complex" });
      assert.equal(decComplex.model, "claude-3-5-sonnet");
    });
  });

  await t.test("CODEX_SHIM_THRESHOLD overrides threshold configured in config", async () => {
    await withEnv({ CODEX_SHIM_THRESHOLD: "0.40" }, async () => {
      const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.85 }));
      // Task with score 0.55 (would be cheap under 0.85, but premium under 0.40)
      const dec = await router.route("Refactor compiler score:0.55", { taskId: "thresh-override" });

      assert.equal(dec.model, "gpt-4o");
    });
  });

  await t.test("CODEX_SHIM_ROUTER_LOG=1 forces log emission even when config specifies logLevel 'none'", async () => {
    await withEnv({ CODEX_SHIM_ROUTER_LOG: "1" }, async () => {
      const logs = [];
      const router = new ModelRouter(normalizeRoutingConfig({ logLevel: "none" }), {
        onLog: (e) => logs.push(e),
      });

      await router.route("Test task", { taskId: "force-log-task" });
      assert.equal(logs.length, 1, "log must be emitted when env var overrides 'none'");
    });
  });

  await t.test("Environment variables take strict precedence over conflicting config values", async () => {
    await withEnv(
      {
        CODEX_SHIM_DISABLE_ROUTER: "1",
        CODEX_SHIM_THRESHOLD: "0.2",
        CODEX_SHIM_ROUTER_LOG: "1",
        CODEX_SHIM_FORCE_MODEL: "override-model",
      },
      async () => {
        const fileConfig = {
          enabled: true,
          threshold: 0.8,
          logLevel: "none",
          forceModel: "config-model",
        };
        const resolved = normalizeRoutingConfig(fileConfig, process.env);

        assert.equal(resolved.enabled, false);
        assert.equal(resolved.threshold, 0.2);
        assert.equal(resolved.logLevel, "summary");
        assert.equal(resolved.forceModel, "override-model");
      },
    );
  });
});

// ===========================================================================
// SUITE 5: STRUCTURED NDJSON ROUTING LOGS
// ===========================================================================

test("ModelRouter: structured NDJSON logging and required fields", async (t) => {
  await t.test("emits log entry containing exact 6 required fields on routing decision", async () => {
    const logs = [];
    const router = new ModelRouter(normalizeRoutingConfig({ logLevel: "summary" }), {
      onLog: (e) => logs.push(e),
    });

    await router.route("Design distributed cache", { taskId: "log-fields-test" });

    assert.equal(logs.length, 1);
    const entry = logs[0];

    assert.ok("taskId" in entry, "must contain taskId");
    assert.ok("classifierModel" in entry, "must contain classifierModel");
    assert.ok("scores" in entry, "must contain scores");
    assert.ok("selectedModel" in entry, "must contain selectedModel");
    assert.ok("cacheStatus" in entry, "must contain cacheStatus");
    assert.ok("timestamp" in entry, "must contain timestamp");

    assert.equal(entry.taskId, "log-fields-test");
    assert.equal(entry.cacheStatus, "miss");
    assert.equal(typeof entry.scores, "object");
  });

  await t.test("records cacheStatus 'miss' on initial call and 'hit' on subsequent calls", async () => {
    const logs = [];
    const router = new ModelRouter(normalizeRoutingConfig({ logLevel: "summary" }), {
      onLog: (e) => logs.push(e),
    });

    await router.route("Initial call", { taskId: "hit-miss-track" });
    await router.route("Repeated call", { taskId: "hit-miss-track" });

    assert.equal(logs.length, 2);
    assert.equal(logs[0].cacheStatus, "miss");
    assert.equal(logs[1].cacheStatus, "hit");
  });

  await t.test("suppresses all routing log emission when logLevel is 'none'", async () => {
    const logs = [];
    const router = new ModelRouter(normalizeRoutingConfig({ logLevel: "none" }), {
      onLog: (e) => logs.push(e),
    });

    await router.route("Silent task", { taskId: "silent-task" });
    assert.equal(logs.length, 0);
  });
});

// ===========================================================================
// SUITE 6: HTTP PROXY SERVER LIFECYCLE & INTERCEPTION
// ===========================================================================

test("CodexShim: HTTP proxy server endpoints and error handling", async (t) => {
  await t.test("starts server on dynamic port, handles /v1/chat/completions, closes cleanly", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.7 }));
    const shim = new CodexShim(router);

    const handle = await shim.startHttpServer(0);
    assert.ok(handle.port > 0, "server must bind to a dynamic port > 0");

    try {
      const res = await handle.dispatch({
        method: "POST",
        url: "/v1/chat/completions",
        body: {
          messages: [{ role: "user", content: "Check code syntax" }],
          taskId: "http-test-task",
        },
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.object, "chat.completion");
      assert.equal(data.model, "gpt-4o-mini");
      assert.equal(data._routing.taskId, "http-test-task");
    } finally {
      await handle.close();
    }
  });

  await t.test("handles /chat/completions without /v1 prefix", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({}));
    const shim = new CodexShim(router);
    const handle = await shim.startHttpServer(0);

    try {
      const res = await handle.dispatch({
        method: "POST",
        url: "/chat/completions",
        body: { messages: [{ role: "user", content: "hello" }] },
      });
      assert.equal(res.status, 200);
    } finally {
      await handle.close();
    }
  });

  await t.test("returns 400 Bad Request on malformed JSON payload without crashing server", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({}));
    const shim = new CodexShim(router);
    const handle = await shim.startHttpServer(0);

    try {
      const res = await handle.dispatch({
        method: "POST",
        url: "/v1/chat/completions",
        body: "{ malformed json...",
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.ok(data.error && data.error.message);
    } finally {
      await handle.close();
    }
  });

  await t.test("returns 404 Not Found on unhandled routes", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({}));
    const shim = new CodexShim(router);
    const handle = await shim.startHttpServer(0);

    try {
      const res = await handle.dispatch({
        method: "GET",
        url: "/unknown/route",
      });
      assert.equal(res.status, 404);
    } finally {
      await handle.close();
    }
  });
});

// ===========================================================================
// SUITE 7: AGGREGATE METRICS & FORMATTERS
// ===========================================================================

test("ModelRouter & CLI formatters: statistics and ROI tracking", async (t) => {
  await t.test("tracks accurate aggregate metrics and calculates cost savings", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.7 }));

    // 2 cheap tasks ($0.001 each -> saves $0.029 each)
    await router.route("Fix typo", { taskId: "task-cheap-1" });
    await router.route("Fix typo", { taskId: "task-cheap-2" });

    // 1 premium task ($0.03 each -> saves $0.00)
    await router.route("Architect distributed Raft consensus engine", { taskId: "task-prem-1" });

    // 1 cached cheap hit
    await router.route("Subsequent call", { taskId: "task-cheap-1" });

    const stats = router.getStats();
    assert.equal(stats.totalRouted, 4);
    assert.equal(stats.cacheHits, 1);
    assert.equal(stats.cacheMisses, 3);
    assert.equal(stats.cacheHitRate, 0.25);
    assert.equal(stats.modelDistribution["gpt-4o-mini"], 3);
    assert.equal(stats.modelDistribution["gpt-4o"], 1);

    // 3 cheap calls * ($0.03 - $0.001) = 3 * 0.029 = 0.087
    assert.ok(Math.abs(stats.estimatedCostSavings - 0.087) < 0.001);
  });

  await t.test("renderRoutingStatus formats configuration summary text", () => {
    const cfg = normalizeRoutingConfig({ threshold: 0.65, classifier: "gpt-4o-mini" });
    const text = renderRoutingStatus(cfg);

    assert.ok(text.includes("Enabled: true"));
    assert.ok(text.includes("Threshold: 0.65"));
    assert.ok(text.includes("Classifier: gpt-4o-mini"));
  });

  await t.test("renderRoutingStats formats aggregate statistics text", () => {
    const stats = {
      totalRouted: 10,
      cacheHits: 8,
      cacheMisses: 2,
      cacheHitRate: 0.8,
      modelDistribution: { "gpt-4o-mini": 8, "gpt-4o": 2 },
      estimatedCostSavings: 0.232,
    };
    const text = renderRoutingStats(stats);

    assert.ok(text.includes("Total Routed: 10"));
    assert.ok(text.includes("Cache Hits: 8"));
    assert.ok(text.includes("Cache Hit Rate: 80.0%"));
    assert.ok(text.includes("Cost Savings: $0.2320"));
  });
});
