/**
 * Adversarial Empirical Stress Test Suite for Codex Auto-Model-Router (Milestone 2)
 * Path: test/adversarial-codex-shim.test.mjs
 *
 * Authored by: Milestone 2 Challenger 1 (Empirical Challenger)
 * Scope:
 * 1. Extreme Threshold Boundaries & Floating-Point Edge Cases (0.0, 1.0, exact match, epsilon below/above, NaN, subnormal)
 * 2. Corrupted & Malformed Input Requests to CodexShim (null, primitive, empty, missing roles, multipart, huge payloads, Unicode, prototype keys)
 * 3. CodexShim HTTP Proxy Server Stress (invalid JSON, array/primitive JSON, unhandled routes/methods, lifecycle)
 * 4. Concurrent Burst Routing & TaskCache Safety (10-agent x 10-turn loops, concurrent stampedes, LRU eviction, TTL expiry, logging under burst)
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CAPABILITY_CARDS,
  DEFAULT_ROUTING_CONFIG,
  normalizeRoutingConfig,
} from "../dist/config/index.js";

import {
  CodexShim,
  ModelRouter,
  TaskClassifier,
  HeuristicClassifier,
  MockClassifier,
  TaskRoutingCache,
  TaskCache,
  RoutingLogger,
  renderRoutingStatus,
  renderRoutingStats,
  extractPromptFromRequest,
  extractTaskIdFromRequest,
  generateTaskIdFromPrompt,
  resolveTargetModels,
  parseClassificationResponse,
  evaluateComplexityHeuristic,
  resolveTaskId,
  computePromptHashKey,
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
// SUITE 1: EXTREME THRESHOLD BOUNDARIES & FLOATING-POINT EDGE CASES
// ===========================================================================

test("Adversarial: Extreme threshold boundaries and float comparison semantics", async (t) => {
  await t.test("Threshold = 0.000: forces all tasks, even empty or trivial syntax fixes, to premium model", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.0 }));

    const tasks = [
      "Fix typo",
      "",
      "   \n\t  ",
      "Format code indentation",
      "Architect a distributed consensus engine",
    ];

    for (let i = 0; i < tasks.length; i++) {
      const dec = await router.route(tasks[i], { taskId: `zero-thresh-${i}` });
      assert.equal(
        dec.model,
        "gpt-4o",
        `Task "${tasks[i]}" must escalate to gpt-4o when threshold is 0.0, got ${dec.model}`,
      );
      assert.equal(dec.tier, "premium");
      assert.ok(dec.confidence >= 0.0);
    }
  });

  await t.test("Threshold = 1.000: keeps high-complexity keyword tasks on cheap model unless score reaches 1.000", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 1.0 }));

    // Task with high complexity keywords yields score ~0.85-0.95, which is < 1.000
    const complexTask = "Architect a distributed consensus engine using Raft algorithm with multi-node leader election";
    const decComplex = await router.route(complexTask, { taskId: "one-thresh-complex" });
    assert.equal(
      decComplex.model,
      "gpt-4o-mini",
      `Score (${decComplex.confidence}) is < 1.0, must remain on cheap model`,
    );
    assert.equal(decComplex.tier, "cheap");

    // Task with explicit score token 1.000 reaches threshold 1.000 and escalates
    const decPerfect = await router.route("Mission critical task score:1.000", { taskId: "one-thresh-perfect" });
    assert.equal(
      decPerfect.model,
      "gpt-4o",
      `Score 1.000 matches threshold 1.000, must escalate to gpt-4o`,
    );
    assert.equal(decPerfect.tier, "premium");
  });

  await t.test("Exact boundary match: score == threshold (0.700) escalates to premium model (>= operator)", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.700 }));
    const dec = await router.route("Analyze system score:0.700", { taskId: "exact-700" });

    assert.equal(dec.model, "gpt-4o");
    assert.equal(dec.tier, "premium");
    assert.equal(dec.confidence, 0.7);
  });

  await t.test("Epsilon below threshold: score == 0.699 stays on cheap model (< operator)", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.700 }));
    const dec = await router.route("Analyze system score:0.699", { taskId: "eps-below-700" });

    assert.equal(dec.model, "gpt-4o-mini");
    assert.equal(dec.tier, "cheap");
    assert.equal(dec.confidence, 0.699);
  });

  await t.test("Epsilon above threshold: score == 0.701 escalates to premium model", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.700 }));
    const dec = await router.route("Analyze system score:0.701", { taskId: "eps-above-700" });

    assert.equal(dec.model, "gpt-4o");
    assert.equal(dec.tier, "premium");
    assert.equal(dec.confidence, 0.701);
  });

  await t.test("Precision boundaries at arbitrary threshold 0.3333333333333333", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.333 }));

    const decBelow = await router.route("Task score:0.332", { taskId: "third-below" });
    assert.equal(decBelow.model, "gpt-4o-mini");

    const decAbove = await router.route("Task score:0.334", { taskId: "third-above" });
    assert.equal(decAbove.model, "gpt-4o");
  });

  await t.test("Subnormal float threshold (5e-324) handles safely without NaN or division by zero", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 5e-324 }));
    const dec = await router.route("Simple task", { taskId: "subnormal-task" });

    // Since score (0.25) >= 5e-324, escalates to premium
    assert.equal(dec.model, "gpt-4o");
    assert.ok(Number.isFinite(dec.confidence));
  });

  await t.test("Negative and out-of-bounds thresholds in updateConfig are clamped safely", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.7 }));

    router.updateConfig({ threshold: -50.0 });
    assert.equal(router.getConfig().threshold, 0.0);

    router.updateConfig({ threshold: 999.9 });
    assert.equal(router.getConfig().threshold, 1.0);
  });

  await t.test("Runtime CODEX_SHIM_THRESHOLD env var handles valid floats, whitespace, and out-of-bounds", async () => {
    // Valid 0.0
    await withEnv({ CODEX_SHIM_THRESHOLD: "0.00" }, async () => {
      const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.8 }, {}));
      const dec = await router.route("Fix typo", { taskId: "env-zero" });
      assert.equal(dec.model, "gpt-4o");
    });

    // Valid 1.0
    await withEnv({ CODEX_SHIM_THRESHOLD: "1.00" }, async () => {
      const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.2 }, {}));
      const dec = await router.route("Architect distributed Raft", { taskId: "env-one" });
      assert.equal(dec.model, "gpt-4o-mini");
    });

    // Float with whitespace
    await withEnv({ CODEX_SHIM_THRESHOLD: "   0.45   \n" }, async () => {
      const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.8 }, {}));
      const dec = await router.route("Refactor compiler score:0.50", { taskId: "env-ws" });
      assert.equal(dec.model, "gpt-4o");
    });

    // Out-of-bounds > 1.0 resets to safe default 0.70
    await withEnv({ CODEX_SHIM_THRESHOLD: "2.5" }, async () => {
      const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.6 }));
      // Task with score 0.65 is below default 0.70, routes to cheap
      const decBelow = await router.route("Refactor compiler score:0.65", { taskId: "env-oob-high-below" });
      assert.equal(decBelow.model, "gpt-4o-mini");
      // Task with score 0.75 meets default 0.70, escalates to premium
      const decAbove = await router.route("Refactor compiler score:0.75", { taskId: "env-oob-high-above" });
      assert.equal(decAbove.model, "gpt-4o");
    });

    // Out-of-bounds < 0.0 resets to safe default 0.70
    await withEnv({ CODEX_SHIM_THRESHOLD: "-0.5" }, async () => {
      const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.8 }));
      // Task with score 0.65 is below default 0.70, routes to cheap
      const decBelow = await router.route("Refactor compiler score:0.65", { taskId: "env-oob-low-below" });
      assert.equal(decBelow.model, "gpt-4o-mini");
      // Task with score 0.75 meets default 0.70, escalates to premium
      const decAbove = await router.route("Refactor compiler score:0.75", { taskId: "env-oob-low-above" });
      assert.equal(decAbove.model, "gpt-4o");
    });

    // Non-numeric string preserves configured threshold
    await withEnv({ CODEX_SHIM_THRESHOLD: "not_a_number" }, async () => {
      const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.8 }));
      const dec = await router.route("Refactor compiler score:0.75", { taskId: "env-nan" });
      assert.equal(dec.model, "gpt-4o-mini"); // Uses config threshold 0.8 (0.75 < 0.8)
    });
  });
});

// ===========================================================================
// SUITE 2: CORRUPTED & MALFORMED REQUEST PAYLOADS TO CODEXSHIM
// ===========================================================================

test("Adversarial: Corrupted and malformed request payloads to CodexShim", async (t) => {
  const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.7 }));
  const shim = new CodexShim(router);

  await t.test("handleRequest rejects non-object primitives and null", async () => {
    const invalidInputs = [
      null,
      undefined,
      "hello",
      12345,
      true,
      false,
      Symbol("sym"),
      [1, 2, 3], // Array
    ];

    for (const input of invalidInputs) {
      await assert.rejects(
        () => shim.handleRequest(input),
        /Invalid request payload/,
        `Should reject input: ${String(input)}`,
      );
    }
  });

  await t.test("handleRequest accepts empty object without error and produces valid chatcmpl structure", async () => {
    const res = await shim.handleRequest({});
    assert.ok(res.id.startsWith("chatcmpl-"));
    assert.equal(res.object, "chat.completion");
    assert.equal(res.model, "gpt-4o-mini");
    assert.ok(res.choices.length > 0);
    assert.equal(res.choices[0].message.role, "assistant");
    assert.ok(res._routing);
    assert.ok(res._routing.taskId.startsWith("task-"));
  });

  await t.test("handleRequest handles empty messages array safely", async () => {
    const res = await shim.handleRequest({ messages: [] });
    assert.equal(res.model, "gpt-4o-mini");
    assert.ok(res.choices[0].message.content.length > 0);
  });

  await t.test("handleRequest handles malformed message objects (null, undefined, missing role/content)", async () => {
    const malformedCases = [
      { messages: [null, undefined] },
      { messages: [{}] },
      { messages: [{ role: "user" }] }, // missing content
      { messages: [{ role: "user", content: null }] },
      { messages: [{ role: "user", content: undefined }] },
      { messages: [{ role: "user", content: 12345 }] },
      { messages: [{ role: "user", content: {} }] },
    ];

    for (const req of malformedCases) {
      const res = await shim.handleRequest(req);
      assert.ok(res.id.startsWith("chatcmpl-"));
      assert.equal(res.model, "gpt-4o-mini");
    }
  });

  await t.test("handleRequest extracts text from OpenAI multipart content array", async () => {
    const res = await shim.handleRequest({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Architect a distributed Raft consensus engine" },
            { type: "image_url", image_url: { url: "https://example.com/diagram.png" } },
          ],
        },
      ],
      taskId: "multipart-task",
    });

    assert.equal(res.model, "gpt-4o", "Must extract text from multipart array and escalate");
  });

  await t.test("handleRequest safely routes to cheap baseline when user role message is absent", async () => {
    // If request contains only system instructions without a user task prompt, routes safely to cheap model
    const resSystemOnly = await shim.handleRequest({
      messages: [{ role: "system", content: "You are a coding assistant" }],
      taskId: "system-only-task",
    });
    assert.equal(resSystemOnly.model, "gpt-4o-mini");

    const resAssistantOnly = await shim.handleRequest({
      messages: [{ role: "assistant", content: "Previous answer" }],
      taskId: "assistant-only-task",
    });
    assert.equal(resAssistantOnly.model, "gpt-4o-mini");
  });

  await t.test("handleRequest safely extracts taskId from polymorphic fields and non-string types", async () => {
    // Explicit string taskId
    const res1 = await shim.handleRequest({ taskId: "explicit-task-id" });
    assert.equal(res1._routing.taskId, "explicit-task-id");

    // Fallback to user field
    const res2 = await shim.handleRequest({ user: "user-provided-id" });
    assert.equal(res2._routing.taskId, "user-provided-id");

    // Fallback to metadata.taskId
    const res3 = await shim.handleRequest({ metadata: { taskId: "meta-id-123" } });
    assert.equal(res3._routing.taskId, "meta-id-123");

    // Non-string taskId (number, object, boolean) safely falls back to prompt digest
    const res4 = await shim.handleRequest({ taskId: 9999 });
    assert.ok(res4._routing.taskId.startsWith("task-"));

    const res5 = await shim.handleRequest({ taskId: { obj: true } });
    assert.ok(res5._routing.taskId.startsWith("task-"));

    // Empty string taskId safely falls back to prompt digest
    const resEmpty = await shim.handleRequest({ taskId: "" });
    assert.ok(resEmpty._routing.taskId.startsWith("task-"));

    // Whitespace string taskId is accepted without error
    const resWs = await shim.handleRequest({ taskId: "   \t   " });
    assert.ok(typeof resWs._routing.taskId === "string");
  });

  await t.test("Huge prompt payload (200KB string) routes without stack overflow or memory crash", async () => {
    const largePrompt = "Architect distributed system " + "Z".repeat(200 * 1024);
    const res = await shim.handleRequest({
      messages: [{ role: "user", content: largePrompt }],
      taskId: "huge-payload-task",
    });

    assert.equal(res.model, "gpt-4o");
    assert.ok(res.choices[0].message.content.length > 0);
  });

  await t.test("Exotic input: null bytes, emojis, Unicode, RTL overrides, control characters", async () => {
    const exoticPrompt = "Refactor \u0000 \b \f \u202E RTL \u200B zero-width 🚀🧠🔥 consensus deadlock";
    const res = await shim.handleRequest({
      messages: [{ role: "user", content: exoticPrompt }],
      taskId: "exotic-payload-task",
    });

    assert.equal(res.model, "gpt-4o");
    assert.ok(res._routing.confidence >= 0.7);
  });

  await t.test("Prototype pollution keys do not corrupt prototype or execution", async () => {
    const maliciousReq = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"prototype":{"hacked":true}},"taskId":"proto-test","messages":[{"role":"user","content":"fix typo"}]}',
    );

    const res = await shim.handleRequest(maliciousReq);
    assert.equal(res.model, "gpt-4o-mini");
    assert.equal(Object.prototype.polluted, undefined);
    assert.equal(Object.prototype.hacked, undefined);
  });
});

// ===========================================================================
// SUITE 3: CODEXSHIM HTTP PROXY SERVER STRESS
// ===========================================================================

test("Adversarial: CodexShim HTTP proxy server endpoints and corrupt payloads", async (t) => {
  const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.7 }));
  const shim = new CodexShim(router);
  const handle = await shim.startHttpServer(0);

  try {
    await t.test("Rejects malformed JSON with 400 Bad Request", async () => {
      const res = await handle.dispatch({
        method: "POST",
        url: "/v1/chat/completions",
        body: '{"messages": [{"role": "user", "content": "incomplete...',
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.ok(data.error && data.error.message.includes("Invalid JSON"));
    });

    await t.test("Rejects empty body with 400 Bad Request", async () => {
      const res = await handle.dispatch({
        method: "POST",
        url: "/v1/chat/completions",
        body: "",
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.ok(data.error);
    });

    await t.test("Rejects JSON primitive string with 400 Bad Request", async () => {
      const res = await handle.dispatch({
        method: "POST",
        url: "/v1/chat/completions",
        body: '"just a string"',
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.ok(data.error);
    });

    await t.test("Rejects JSON primitive number with 400 Bad Request", async () => {
      const res = await handle.dispatch({
        method: "POST",
        url: "/v1/chat/completions",
        body: "123456",
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.ok(data.error);
    });

    await t.test("Rejects JSON array with 400 Bad Request", async () => {
      const res = await handle.dispatch({
        method: "POST",
        url: "/v1/chat/completions",
        body: "[1, 2, 3]",
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.ok(data.error);
    });

    await t.test("Rejects GET requests with 404 Not Found", async () => {
      const res = await handle.dispatch({
        method: "GET",
        url: "/v1/chat/completions",
      });

      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.error.message, "Not found");
    });

    await t.test("Rejects unhandled URL paths with 404 Not Found", async () => {
      const res = await handle.dispatch({
        method: "POST",
        url: "/v1/models",
        body: {},
      });

      assert.equal(res.status, 404);
    });

    await t.test("Handles /chat/completions without /v1 prefix successfully", async () => {
      const res = await handle.dispatch({
        method: "POST",
        url: "/chat/completions",
        body: { messages: [{ role: "user", content: "Format markdown" }] },
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.model, "gpt-4o-mini");
    });

    await t.test("Rapid sequential burst of 30 HTTP requests completes cleanly", async () => {
      for (let i = 0; i < 30; i++) {
        const res = await handle.dispatch({
          method: "POST",
          url: "/v1/chat/completions",
          body: {
            messages: [{ role: "user", content: i % 2 === 0 ? "Fix typo" : "Architect Raft" }],
            taskId: `http-burst-${i}`,
          },
        });
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.model, i % 2 === 0 ? "gpt-4o-mini" : "gpt-4o");
      }
    });
  } finally {
    await handle.close();
  }
});

// ===========================================================================
// SUITE 4: CONCURRENT BURST ROUTING & TASKCACHE SAFETY UNDER MULTI-TURN LOOPS
// ===========================================================================

test("Adversarial: Concurrent burst routing, TaskCache safety, and multi-turn loops", async (t) => {
  await t.test("Multi-turn simulated agent loops: 10 parallel agents x 10 turns produce exactly 10 classifier calls", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.7 }));

    // 10 concurrent agents running in parallel
    const agentPromises = Array.from({ length: 10 }, async (_, agentIdx) => {
      const taskId = `agent-concurrent-loop-${agentIdx}`;
      const isComplex = agentIdx % 2 === 0;
      const initialPrompt = isComplex
        ? "Architect a distributed Raft consensus engine"
        : "Fix syntax error in markdown table";

      const expectedModel = isComplex ? "gpt-4o" : "gpt-4o-mini";

      // Turn 1: Miss
      const turn1 = await router.route(initialPrompt, { taskId });
      assert.equal(turn1.fromCache, false, `Agent ${agentIdx} Turn 1 must be a cache miss`);
      assert.equal(turn1.model, expectedModel);

      // Turns 2..10: Hits
      for (let turn = 2; turn <= 10; turn++) {
        const turnI = await router.route(`Iterative tool call ${turn} for agent ${agentIdx}`, { taskId });
        assert.equal(turnI.fromCache, true, `Agent ${agentIdx} Turn ${turn} must hit cache`);
        assert.equal(turnI.model, expectedModel, `Agent ${agentIdx} Turn ${turn} must retain model decision`);
      }
    });

    await Promise.all(agentPromises);

    assert.equal(
      router.classifierCalls,
      10,
      `Expected exactly 10 classifier calls across 10 agents, got ${router.classifierCalls}`,
    );

    const stats = router.getStats();
    assert.equal(stats.totalRouted, 100);
    assert.equal(stats.cacheMisses, 10);
    assert.equal(stats.cacheHits, 90);
    assert.equal(stats.cacheHitRate, 0.9);
    assert.equal(stats.modelDistribution["gpt-4o"], 50);
    assert.equal(stats.modelDistribution["gpt-4o-mini"], 50);
  });

  await t.test("Concurrent stampede: 50 simultaneous calls for same taskId resolve consistently without errors", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.7 }));
    const taskId = "stampede-task-id";
    const prompt = "Architect a distributed consensus engine";

    const promises = Array.from({ length: 50 }, () => router.route(prompt, { taskId }));
    const results = await Promise.all(promises);

    assert.equal(results.length, 50);
    for (const res of results) {
      assert.equal(res.model, "gpt-4o");
      assert.equal(res.tier, "premium");
      assert.equal(res.taskId, taskId);
    }

    assert.equal(router.cache.size, 1);
    assert.ok(router.cache.has(taskId));

    // Turn 2 strictly hits cache
    const turn2 = await router.route("Next step", { taskId });
    assert.equal(turn2.fromCache, true);
    assert.equal(turn2.model, "gpt-4o");
  });

  await t.test("Multi-tenant interleaving: 40 distinct concurrent tasks maintain strict cache isolation", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.7 }));

    const tasks = Array.from({ length: 40 }, (_, i) => ({
      taskId: `isolated-task-${i}`,
      isComplex: i % 3 === 0,
      prompt: i % 3 === 0 ? "Architect distributed Raft" : "Fix typo in comment",
    }));

    // Launch all 40 concurrently
    const decisions = await Promise.all(
      tasks.map((t) => router.route(t.prompt, { taskId: t.taskId })),
    );

    for (let i = 0; i < 40; i++) {
      const expected = tasks[i].isComplex ? "gpt-4o" : "gpt-4o-mini";
      assert.equal(decisions[i].model, expected, `Task ${tasks[i].taskId} received unexpected model`);
      assert.equal(decisions[i].taskId, tasks[i].taskId);
    }

    assert.equal(router.cache.size, 40);

    // Re-query all 40 concurrently to ensure each gets its own cached decision
    const redecisions = await Promise.all(
      tasks.map((t) => router.route("Subsequent call", { taskId: t.taskId })),
    );

    for (let i = 0; i < 40; i++) {
      const expected = tasks[i].isComplex ? "gpt-4o" : "gpt-4o-mini";
      assert.equal(redecisions[i].fromCache, true);
      assert.equal(redecisions[i].model, expected);
    }
  });

  await t.test("TaskCache bounded LRU eviction under burst correctly caps size and evicts oldest", () => {
    const cache = new TaskRoutingCache({ maxEntries: 5 });

    for (let i = 1; i <= 20; i++) {
      cache.set(`t-${i}`, {
        model: `model-${i}`,
        confidence: 0.5,
        reasoning: "r",
        tier: "cheap",
        scores: {},
        timestamp: "ts",
      });
      assert.ok(cache.size <= 5, `Cache size exceeded maxEntries: ${cache.size}`);
    }

    assert.equal(cache.size, 5);
    const stats = cache.getStats();
    assert.equal(stats.evictions, 15);

    // Oldest tasks t-1..t-15 must be evicted
    for (let i = 1; i <= 15; i++) {
      assert.equal(cache.has(`t-${i}`), false, `t-${i} should be evicted`);
    }

    // Recent tasks t-16..t-20 must remain
    for (let i = 16; i <= 20; i++) {
      assert.equal(cache.has(`t-${i}`), true, `t-${i} should exist`);
    }
  });

  await t.test("TaskCache TTL expiration invalidates entries after expiry time", async () => {
    const cache = new TaskRoutingCache({ defaultTtlMs: 40 });

    cache.set("ttl-task", {
      model: "gpt-4o",
      confidence: 0.8,
      reasoning: "r",
      tier: "premium",
      scores: {},
      timestamp: "ts",
    });

    assert.equal(cache.has("ttl-task"), true);
    assert.ok(cache.get("ttl-task"));

    // Wait 50ms for TTL expiry
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(cache.has("ttl-task"), false);
    assert.equal(cache.get("ttl-task"), undefined);
    assert.equal(cache.size, 0);
  });

  await t.test("Dynamic updateConfig during active concurrent routing executes without errors", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.8 }));

    const promises = Array.from({ length: 30 }, async (_, i) => {
      if (i === 15) {
        router.updateConfig({ threshold: 0.3 });
      }
      return router.route("Refactor compiler score:0.55", { taskId: `dyn-task-${i}` });
    });

    const results = await Promise.all(promises);
    assert.equal(results.length, 30);
    for (const r of results) {
      assert.ok(r.model === "gpt-4o" || r.model === "gpt-4o-mini");
    }
  });

  await t.test("Structured NDJSON logger maintains record integrity under 50-call concurrent burst", async () => {
    const logEntries = [];
    const router = new ModelRouter(normalizeRoutingConfig({ logLevel: "verbose" }), {
      onLog: (e) => logEntries.push(e),
    });

    const promises = Array.from({ length: 50 }, (_, i) =>
      router.route(`Task payload ${i}`, { taskId: `log-burst-${i}` }),
    );

    await Promise.all(promises);

    assert.equal(logEntries.length, 50);

    for (let i = 0; i < 50; i++) {
      const entry = logEntries[i];
      assert.ok("taskId" in entry);
      assert.ok("classifierModel" in entry);
      assert.ok("scores" in entry);
      assert.ok("selectedModel" in entry);
      assert.ok("cacheStatus" in entry);
      assert.ok("timestamp" in entry);

      assert.equal(entry.cacheStatus, "miss");
      assert.ok(typeof entry.scores === "object");
      assert.ok(entry.taskId.startsWith("log-burst-"));
    }
  });
});
