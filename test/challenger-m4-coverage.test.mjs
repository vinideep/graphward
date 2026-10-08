/**
 * Tier 5 White-Box Adversarial Coverage Hardening Test Suite
 * Path: test/challenger-m4-coverage.test.mjs
 *
 * Authored by: Milestone 4 Challenger 1 (Empirical Challenger)
 * Scope:
 * Suite 1: TaskClassifier & Heuristic Evaluator Boundary & Fallback Conditions
 * Suite 2: TaskRoutingCache & Hash Resolution Deep Edge Cases
 * Suite 3: RoutingLogger Stream, File Queue & Callback Resilience
 * Suite 4: ModelRouter White-Box Branch Coverage
 * Suite 5: CodexShim & HTTP Proxy Deep Protocol & Network Edge Cases
 * Suite 6: MCP Consolidated Tools & CLI White-Box Coverage
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  DEFAULT_CAPABILITY_CARDS,
  DEFAULT_ROUTING_CONFIG,
  normalizeRoutingConfig,
  updateRoutingConfig,
} from "../dist/config/index.js";

import {
  CodexShim,
  ModelRouter,
  TaskClassifier,
  HeuristicClassifier,
  MockClassifier,
  TaskRoutingCache,
  RoutingLogger,
  RoutingStatsTracker,
  renderRoutingStatus,
  renderRoutingStats,
  extractPromptFromRequest,
  extractTaskIdFromRequest,
  generateTaskIdFromPrompt,
  resolveTargetModels,
  buildClassificationPrompt,
  parseClassificationResponse,
  evaluateComplexityHeuristic,
  resolveTaskId,
  computePromptHashKey,
  getGlobalRouter,
  resetGlobalRouter,
} from "../dist/routing/index.js";

import { createConsolidatedRegistry } from "../dist/mcp/consolidated.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "../dist/cli/index.js");
const REPO_ROOT = path.resolve(__dirname, "..");

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

function runCli(args, cwd = REPO_ROOT, envOverrides = {}) {
  const cleanEnv = { ...process.env };
  delete cleanEnv.CODEX_SHIM_DISABLE_ROUTER;
  delete cleanEnv.CODEX_SHIM_THRESHOLD;
  delete cleanEnv.CODEX_SHIM_FORCE_MODEL;
  delete cleanEnv.CODEX_SHIM_ROUTER_LOG;

  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...cleanEnv, ...envOverrides },
  });

  if (result.error) throw result.error;
  return result;
}

// ===========================================================================
// SUITE 1: TaskClassifier & Heuristic Evaluator Boundary & Fallback Conditions
// ===========================================================================

test("M4 Suite 1: TaskClassifier & Heuristic Evaluator Boundary & Fallback Conditions", async (t) => {
  await t.test("1.1: buildClassificationPrompt formats system instructions and capability cards summary", () => {
    const prompt = buildClassificationPrompt("Implement raft consensus", DEFAULT_CAPABILITY_CARDS);
    assert.ok(prompt.system.includes("GraphWard Task Complexity Classifier"));
    assert.ok(prompt.system.includes("gpt-4o-mini"));
    assert.ok(prompt.system.includes("gpt-4o"));
    assert.ok(prompt.system.includes("Respond ONLY with a JSON object"));
    assert.ok(prompt.user.includes("Task to evaluate:\nImplement raft consensus"));
  });

  await t.test("1.2: parseClassificationResponse handles markdown code fences and JSON whitespace", () => {
    const rawWithFences = "Here is the decision:\n```json\n{\n  \"score\": 0.88,\n  \"confidence\": 0.90,\n  \"reasoning\": \"Complex architecture\",\n  \"suggestedTier\": \"premium\",\n  \"suggestedModel\": \"gpt-4o\"\n}\n```\nHope that helps!";
    const res = parseClassificationResponse(rawWithFences, "gpt-4o-mini", DEFAULT_CAPABILITY_CARDS);

    assert.equal(res.score, 0.88);
    assert.equal(res.confidence, 0.90);
    assert.equal(res.reasoning, "Complex architecture");
    assert.equal(res.suggestedTier, "premium");
    assert.equal(res.suggestedModel, "gpt-4o");
    assert.equal(res.classifierModel, "gpt-4o-mini");
    assert.equal(res.rawOutput, rawWithFences);
  });

  await t.test("1.3: parseClassificationResponse clamps out-of-bounds score and infers confidence", () => {
    const rawNegative = JSON.stringify({ score: -0.75, reasoning: "Negative score test" });
    const resNegative = parseClassificationResponse(rawNegative, "gpt-4o-mini", DEFAULT_CAPABILITY_CARDS);
    assert.equal(resNegative.score, 0.0, "Score < 0 must clamp to 0.0");
    assert.equal(resNegative.suggestedTier, "cheap");
    assert.equal(resNegative.suggestedModel, "gpt-4o-mini");

    const rawOverflow = JSON.stringify({ score: 1.85, reasoning: "Overflow score test" });
    const resOverflow = parseClassificationResponse(rawOverflow, "gpt-4o-mini", DEFAULT_CAPABILITY_CARDS);
    assert.equal(resOverflow.score, 1.0, "Score > 1 must clamp to 1.0");
    assert.equal(resOverflow.suggestedTier, "premium");
    assert.equal(resOverflow.suggestedModel, "gpt-4o");
  });

  await t.test("1.4: parseClassificationResponse handles suggestedTier 'standard' and custom suggestedModel", () => {
    const raw = JSON.stringify({
      score: 0.50,
      suggestedTier: "standard",
      suggestedModel: "claude-3-5-sonnet",
      reasoning: "Intermediate complexity",
    });
    const res = parseClassificationResponse(raw, "gpt-4o-mini", DEFAULT_CAPABILITY_CARDS);

    assert.equal(res.suggestedTier, "standard");
    assert.equal(res.suggestedModel, "claude-3-5-sonnet");
    assert.equal(res.selectedModel, "claude-3-5-sonnet");
  });

  await t.test("1.5: parseClassificationResponse falls back to heuristic evaluator when JSON is missing or malformed", () => {
    const nonJson = "This response contains no json at all. Just plain text saying Architect a distributed system.";
    const res = parseClassificationResponse(nonJson, "gpt-4o-mini", DEFAULT_CAPABILITY_CARDS);

    assert.ok(res.reasoning.includes("engineering keywords"));
    assert.equal(res.suggestedTier, "premium");
    assert.equal(res.suggestedModel, "gpt-4o");
  });

  await t.test("1.6: evaluateComplexityHeuristic exact length 400 boundary condition without keywords", () => {
    // Exactly 400 characters without keywords: should evaluate to 0.25 (standard low-complexity)
    const padding400 = "x".repeat(400);
    const res400 = evaluateComplexityHeuristic(padding400, DEFAULT_CAPABILITY_CARDS);
    assert.equal(res400.score, 0.25, "Prompt length <= 400 without keywords should score 0.25");
    assert.equal(res400.tier, "cheap");
    assert.ok(res400.reasoning.includes("Standard low-complexity"));

    // Exactly 401 characters without keywords: triggers length > 400 heuristic (score 0.55)
    const padding401 = "x".repeat(401);
    const res401 = evaluateComplexityHeuristic(padding401, DEFAULT_CAPABILITY_CARDS);
    assert.equal(res401.score, 0.55, "Prompt length > 400 should score 0.55");
    assert.equal(res401.tier, "cheap", "Score 0.55 is below default 0.7 threshold and stays cheap");
    assert.ok(res401.reasoning.includes("Large prompt payload (401 chars) indicates elevated complexity"));
  });

  await t.test("1.7: evaluateComplexityHeuristic explicit score and complexity tokens", () => {
    const t1 = evaluateComplexityHeuristic("Run task complexity=0.88 now");
    assert.equal(t1.score, 0.88);
    assert.equal(t1.tier, "premium");

    const t2 = evaluateComplexityHeuristic("Run task Score: 0.15 please");
    assert.equal(t2.score, 0.15);
    assert.equal(t2.tier, "cheap");

    const t3 = evaluateComplexityHeuristic("task score:1");
    assert.equal(t3.score, 1.0);
    assert.equal(t3.tier, "premium");

    const t4 = evaluateComplexityHeuristic("task complexity:0");
    assert.equal(t4.score, 0.0);
    assert.equal(t4.tier, "cheap");
  });

  await t.test("1.8: evaluateComplexityHeuristic multiple keywords cap at 0.95", () => {
    const multiKeywordPrompt = "architect architecture refactor consensus distributed concurrency deadlock algorithm crypto";
    const res = evaluateComplexityHeuristic(multiKeywordPrompt);
    assert.equal(res.score, 0.95, "Multiple keywords should be capped at 0.95");
    assert.equal(res.tier, "premium");
    assert.equal(res.suggestedModel, "gpt-4o");
  });

  await t.test("1.9: resolveTargetModels handles unusual capability card configurations", () => {
    // Array of single card
    const singleCard = [
      { id: "c1", model: "model-only", description: "Only model", strengths: [], costTier: "standard" },
    ];
    const resSingle = resolveTargetModels(singleCard);
    assert.equal(resSingle.cheapCard.model, "model-only");
    assert.equal(resSingle.premiumCard.model, "model-only");

    // Array of only standard cards
    const standardCards = [
      { id: "s1", model: "standard-1", description: "S1", strengths: [], costTier: "standard" },
      { id: "s2", model: "standard-2", description: "S2", strengths: [], costTier: "standard" },
    ];
    const resStandard = resolveTargetModels(standardCards);
    assert.equal(resStandard.cheapCard.model, "standard-1");
    assert.equal(resStandard.premiumCard.model, "standard-2");
  });

  await t.test("1.10: extractPromptFromRequest handles null content and multipart content safely", () => {
    // Request with no user message
    assert.equal(extractPromptFromRequest({ messages: [] }), "");

    // Request with user message containing null content
    const nullContentReq = {
      messages: [
        { role: "system", content: "System prompt fallback" },
        { role: "user", content: null },
      ],
    };
    const promptNull = extractPromptFromRequest(nullContentReq);
    assert.equal(promptNull, "System prompt fallback", "Falls back to concatenating available string messages");

    // User message with multipart array where parts lack text
    const imageOnlyReq = {
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "https://example.com/img.png" } },
          ],
        },
      ],
    };
    assert.equal(extractPromptFromRequest(imageOnlyReq), "");
  });

  await t.test("1.11: extractTaskIdFromRequest fallback chain and whitespace trimming", () => {
    // Whitespace in taskId falls through to user
    const res1 = extractTaskIdFromRequest({ taskId: "   ", user: "valid-user" });
    assert.equal(res1, "valid-user");

    // Whitespace in user falls through to metadata.taskId
    const res2 = extractTaskIdFromRequest({ user: "   ", metadata: { taskId: "meta-task" } });
    assert.equal(res2, "meta-task");

    // Whitespace in metadata.taskId falls through to prompt hash
    const res3 = extractTaskIdFromRequest({ metadata: { taskId: "   " } }, "sample prompt");
    assert.equal(res3, generateTaskIdFromPrompt("sample prompt"));
  });

  await t.test("1.12: TaskClassifier custom backend management and error propagation", async () => {
    const classifier = new TaskClassifier();
    assert.equal(classifier.getBackend().name, "heuristic");

    const customBackend = new MockClassifier({
      handler: async () => {
        throw new Error("Custom backend offline");
      },
    });
    classifier.setBackend(customBackend);
    assert.equal(classifier.getBackend().name, "mock");

    await assert.rejects(
      () => classifier.evaluate("Test prompt"),
      /Custom backend offline/,
    );
  });
});

// ===========================================================================
// SUITE 2: TaskRoutingCache & Hash Resolution Deep Edge Cases
// ===========================================================================

test("M4 Suite 2: TaskRoutingCache & Hash Resolution Deep Edge Cases", async (t) => {
  await t.test("2.1: TaskRoutingCache silently ignores invalid non-string or empty task IDs on set", () => {
    const cache = new TaskRoutingCache();
    cache.set("", { model: "m", confidence: 1, reasoning: "r", tier: "cheap", scores: {}, timestamp: "ts" });
    cache.set(null, { model: "m", confidence: 1, reasoning: "r", tier: "cheap", scores: {}, timestamp: "ts" });
    cache.set(12345, { model: "m", confidence: 1, reasoning: "r", tier: "cheap", scores: {}, timestamp: "ts" });

    assert.equal(cache.size, 0);
  });

  await t.test("2.2: TaskRoutingCache exact TTL expiration boundary", async () => {
    const cache = new TaskRoutingCache();
    // Set entry with 30ms TTL
    cache.set("short-ttl", { model: "m", confidence: 1, reasoning: "r", tier: "cheap", scores: {}, timestamp: "ts" }, 30);

    assert.equal(cache.has("short-ttl"), true);
    assert.ok(cache.get("short-ttl"));

    // Wait 40ms to exceed TTL
    await new Promise((res) => setTimeout(res, 40));

    assert.equal(cache.has("short-ttl"), false);
    assert.equal(cache.get("short-ttl"), undefined);
    assert.equal(cache.size, 0);
  });

  await t.test("2.3: TaskRoutingCache.get increments missesCount on expired entries", async () => {
    const cache = new TaskRoutingCache();
    cache.set("expiring", { model: "m", confidence: 1, reasoning: "r", tier: "cheap", scores: {}, timestamp: "ts" }, 20);

    await new Promise((res) => setTimeout(res, 30));

    const val = cache.get("expiring");
    assert.equal(val, undefined);
    const stats = cache.getStats();
    assert.equal(stats.misses, 1);
    assert.equal(stats.hits, 0);
  });

  await t.test("2.4: TaskRoutingCache.delete returns true for existing key and false otherwise", () => {
    const cache = new TaskRoutingCache();
    cache.set("k1", { model: "m", confidence: 1, reasoning: "r", tier: "cheap", scores: {}, timestamp: "ts" });

    assert.equal(cache.delete("k1"), true);
    assert.equal(cache.delete("k1"), false);
    assert.equal(cache.delete("non-existent"), false);
  });

  await t.test("2.5: TaskRoutingCache.clear resets size and all operational counters", () => {
    const cache = new TaskRoutingCache({ maxEntries: 2 });
    cache.set("a", { model: "m", confidence: 1, reasoning: "r", tier: "cheap", scores: {}, timestamp: "ts" });
    cache.set("b", { model: "m", confidence: 1, reasoning: "r", tier: "cheap", scores: {}, timestamp: "ts" });
    cache.get("a"); // 1 hit
    cache.get("missing"); // 1 miss
    cache.set("c", { model: "m", confidence: 1, reasoning: "r", tier: "cheap", scores: {}, timestamp: "ts" }); // 1 eviction

    const beforeClear = cache.getStats();
    assert.equal(beforeClear.hits, 1);
    assert.equal(beforeClear.misses, 1);
    assert.equal(beforeClear.evictions, 1);

    cache.clear();

    const afterClear = cache.getStats();
    assert.equal(afterClear.size, 0);
    assert.equal(afterClear.hits, 0);
    assert.equal(afterClear.misses, 0);
    assert.equal(afterClear.evictions, 0);
    assert.equal(afterClear.hitRate, 0);
  });

  await t.test("2.6: TaskRoutingCache LRU access refreshes recency preventing premature eviction", () => {
    const cache = new TaskRoutingCache({ maxEntries: 3 });
    cache.set("k1", { model: "m1", confidence: 1, reasoning: "r", tier: "cheap", scores: {}, timestamp: "ts" });
    cache.set("k2", { model: "m2", confidence: 1, reasoning: "r", tier: "cheap", scores: {}, timestamp: "ts" });
    cache.set("k3", { model: "m3", confidence: 1, reasoning: "r", tier: "cheap", scores: {}, timestamp: "ts" });

    // Access k1 so it becomes the most recently used (order becomes k2, k3, k1)
    cache.get("k1");

    // Insert k4: should evict k2 (oldest), NOT k1
    cache.set("k4", { model: "m4", confidence: 1, reasoning: "r", tier: "cheap", scores: {}, timestamp: "ts" });

    assert.equal(cache.has("k2"), false, "k2 should be evicted");
    assert.equal(cache.has("k1"), true, "k1 was recently accessed and must be preserved");
    assert.equal(cache.has("k3"), true);
    assert.equal(cache.has("k4"), true);
  });

  await t.test("2.7: resolveTaskId polymorphic and edge inputs", () => {
    // Explicit taskId takes top priority
    assert.equal(resolveTaskId({ taskId: "t1", prompt: "foo" }), "t1");

    // metadata.taskId takes second priority
    assert.equal(resolveTaskId({ metadata: { taskId: "meta-1" }, user: "user-1" }), "meta-1");

    // user field takes third priority
    assert.equal(resolveTaskId({ user: "user-1", prompt: "foo" }), "user-1");

    // Fallback to prompt string
    assert.equal(resolveTaskId({ prompt: "my prompt" }), computePromptHashKey("my prompt"));

    // Fallback to empty prompt hash
    assert.equal(resolveTaskId({}), computePromptHashKey(""));
  });

  await t.test("2.8: computePromptHashKey generates deterministic 17-char key", () => {
    const keyEmpty = computePromptHashKey("");
    assert.equal(keyEmpty.length, 17);
    assert.ok(keyEmpty.startsWith("task-"));

    const key1 = computePromptHashKey("hello world");
    const key2 = computePromptHashKey("hello world");
    assert.equal(key1, key2);

    const keyWhitespace = computePromptHashKey("   hello world \n\t ");
    assert.equal(key1, keyWhitespace, "Normalized prompt strings should yield identical hash keys");
  });
});

// ===========================================================================
// SUITE 3: RoutingLogger Stream, File Queue & Callback Resilience
// ===========================================================================

test("M4 Suite 3: RoutingLogger Stream, File Queue & Callback Resilience", async (t) => {
  await t.test("3.1: RoutingLogger suppresses log emission completely when logLevel is 'none'", async () => {
    const logs = [];
    let streamChunks = "";
    const stream = new Writable({
      write(chunk, encoding, callback) {
        streamChunks += chunk.toString();
        callback();
      },
    });

    const logger = new RoutingLogger({
      logLevel: "none",
      stream,
      onLog: (e) => logs.push(e),
    });

    assert.equal(logger.isEnabled(), false);
    assert.equal(logger.getLogLevel(), "none");

    await logger.log({
      taskId: "test-task",
      classifierModel: "gpt-4o-mini",
      scores: {},
      selectedModel: "gpt-4o",
      cacheStatus: "miss",
      timestamp: "ts",
    });

    assert.equal(logs.length, 0);
    assert.equal(streamChunks, "");
  });

  await t.test("3.2: RoutingLogger in verbose mode preserves all diagnostics fields", async () => {
    const logs = [];
    const logger = new RoutingLogger({
      logLevel: "verbose",
      onLog: (e) => logs.push(e),
    });

    await logger.log({
      taskId: "task-verbose",
      classifierModel: "gpt-4o-mini",
      scores: { "gpt-4o-mini": 0.1, "gpt-4o": 0.9 },
      selectedModel: "gpt-4o",
      cacheStatus: "miss",
      timestamp: "2026-10-07T00:00:00.000Z",
      reasoning: "Architectural complexity",
      tier: "premium",
      confidence: 0.9,
    });

    assert.equal(logs.length, 1);
    const entry = logs[0];
    assert.equal(entry.reasoning, "Architectural complexity");
    assert.equal(entry.tier, "premium");
    assert.equal(entry.confidence, 0.9);
  });

  await t.test("3.3: RoutingLogger in summary mode strips non-essential fields to exact 6 required fields", async () => {
    const logs = [];
    const logger = new RoutingLogger({
      logLevel: "summary",
      onLog: (e) => logs.push(e),
    });

    await logger.log({
      taskId: "task-summary",
      classifierModel: "gpt-4o-mini",
      scores: { "gpt-4o-mini": 0.8, "gpt-4o": 0.2 },
      selectedModel: "gpt-4o-mini",
      cacheStatus: "hit",
      timestamp: "2026-10-07T00:00:00.000Z",
      reasoning: "Should be omitted in summary",
      tier: "cheap",
      confidence: 0.2,
    });

    assert.equal(logs.length, 1);
    const entry = logs[0];
    assert.equal(entry.taskId, "task-summary");
    assert.equal(entry.classifierModel, "gpt-4o-mini");
    assert.ok(entry.scores);
    assert.equal(entry.selectedModel, "gpt-4o-mini");
    assert.equal(entry.cacheStatus, "hit");
    assert.equal(entry.timestamp, "2026-10-07T00:00:00.000Z");
    assert.equal(entry.reasoning, undefined);
    assert.equal(entry.tier, undefined);
  });

  await t.test("3.4: RoutingLogger writes NDJSON lines to a Writable stream", async () => {
    let captured = "";
    const stream = new Writable({
      write(chunk, encoding, callback) {
        captured += chunk.toString();
        callback();
      },
    });

    const logger = new RoutingLogger({ logLevel: "summary", stream });
    await logger.log({
      taskId: "stream-t1",
      classifierModel: "gpt-4o-mini",
      scores: { m1: 1 },
      selectedModel: "m1",
      cacheStatus: "miss",
      timestamp: "ts",
    });

    assert.ok(captured.endsWith("\n"));
    const parsed = JSON.parse(captured.trim());
    assert.equal(parsed.taskId, "stream-t1");
  });

  await t.test("3.5: RoutingLogger writes to file and flushes queue cleanly", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "gw-log-test-"));
    const logFile = path.join(tmp, "nested", "routing.log");

    try {
      const logger = new RoutingLogger({ logLevel: "summary", filePath: logFile });
      await logger.log({
        taskId: "file-t1",
        classifierModel: "gpt-4o-mini",
        scores: {},
        selectedModel: "gpt-4o-mini",
        cacheStatus: "miss",
        timestamp: "ts1",
      });
      await logger.log({
        taskId: "file-t2",
        classifierModel: "gpt-4o-mini",
        scores: {},
        selectedModel: "gpt-4o",
        cacheStatus: "hit",
        timestamp: "ts2",
      });

      await logger.flush();

      const content = await readFile(logFile, "utf8");
      const lines = content.trim().split("\n");
      assert.equal(lines.length, 2);
      assert.equal(JSON.parse(lines[0]).taskId, "file-t1");
      assert.equal(JSON.parse(lines[1]).taskId, "file-t2");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  await t.test("3.6: RoutingLogger swallows onLog exceptions without interrupting caller", async () => {
    const logger = new RoutingLogger({
      logLevel: "summary",
      onLog: () => {
        throw new Error("Callback exploded!");
      },
    });

    // Should not reject
    await logger.log({
      taskId: "err-task",
      classifierModel: "gpt-4o-mini",
      scores: {},
      selectedModel: "gpt-4o",
      cacheStatus: "miss",
      timestamp: "ts",
    });
  });

  await t.test("3.7: RoutingStatsTracker records bypass, hits, misses, and cost savings across tiers", () => {
    const tracker = new RoutingStatsTracker();

    tracker.record({ model: "gpt-4o-mini", tier: "cheap", cacheStatus: "miss" }); // saves 0.029
    tracker.record({ model: "gpt-4o-mini", tier: "cheap", cacheStatus: "hit" });  // saves 0.029
    tracker.record({ model: "gpt-4o", tier: "premium", cacheStatus: "miss" });    // saves 0.000
    tracker.record({ model: "custom-standard", tier: "standard", cacheStatus: "bypass" }); // saves 0.020 (0.03 - 0.01)

    const stats = tracker.getStats();
    assert.equal(stats.totalRouted, 4);
    assert.equal(stats.cacheHits, 1);
    assert.equal(stats.cacheMisses, 2);
    assert.equal(stats.bypasses, 1);
    assert.equal(stats.cacheHitRate, 0.25);
    assert.equal(stats.modelDistribution["gpt-4o-mini"], 2);
    assert.equal(stats.modelDistribution["gpt-4o"], 1);
    assert.equal(stats.modelDistribution["custom-standard"], 1);

    // Cost savings: 0.029 + 0.029 + 0.000 + 0.020 = 0.078
    assert.ok(Math.abs(stats.estimatedCostSavings - 0.078) < 0.001);

    tracker.reset();
    const resetStats = tracker.getStats();
    assert.equal(resetStats.totalRouted, 0);
    assert.equal(resetStats.cacheHits, 0);
    assert.equal(resetStats.estimatedCostSavings, 0);
  });

  await t.test("3.8: renderRoutingStats handles empty model distribution gracefully without error", () => {
    const text = renderRoutingStats({
      totalRouted: 0,
      cacheHits: 0,
      cacheMisses: 0,
      cacheHitRate: 0,
      modelDistribution: {},
      estimatedCostSavings: 0,
    });
    assert.ok(text.includes("Total Routed: 0"));
    assert.ok(text.includes("Cache Hits: 0"));
    assert.ok(text.includes("Cache Hit Rate: 0.0%"));
    assert.ok(text.includes("Cost Savings: $0.0000"));
    assert.ok(!text.includes("Model Distribution:"));
  });
});

// ===========================================================================
// SUITE 4: ModelRouter White-Box Branch Coverage
// ===========================================================================

test("M4 Suite 4: ModelRouter White-Box Branch Coverage", async (t) => {
  await t.test("4.1: ModelRouter constructor costModel override calculates customized savings", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.7 }), {
      costModel: { cheapCost: 0.005, premiumCost: 0.050 }, // Savings per cheap call = 0.050 - 0.005 = 0.045
    });

    await router.route("Fix typo", { taskId: "cost-custom-1" });
    await router.route("Fix typo", { taskId: "cost-custom-2" });

    const stats = router.getStats();
    assert.equal(stats.totalRouted, 2);
    // 2 * 0.045 = 0.090
    assert.ok(Math.abs(stats.estimatedCostSavings - 0.090) < 0.001);
  });

  await t.test("4.2: TaskClassifier.decide supports per-call options.threshold override directly", async () => {
    const classifier = new TaskClassifier({ ...DEFAULT_ROUTING_CONFIG, threshold: 0.85 });
    const dec = await classifier.decide("Task score:0.70", { threshold: 0.60 });
    assert.equal(dec.model, "gpt-4o", "Must escalate because score 0.70 >= call threshold 0.60");
    assert.equal(dec.tier, "premium");
  });

  await t.test("4.2b: ModelRouter dynamic threshold escalation via updateConfig", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.85 }));
    const decBefore = await router.route("Task score:0.70", { taskId: "dyn-thresh-1" });
    assert.equal(decBefore.model, "gpt-4o-mini", "Score 0.70 is below 0.85, stays cheap");

    router.updateConfig({ threshold: 0.60 });
    const decAfter = await router.route("Task score:0.70", { taskId: "dyn-thresh-2" });
    assert.equal(decAfter.model, "gpt-4o", "Score 0.70 meets updated threshold 0.60, escalates to premium");
  });

  await t.test("4.3: route accepts ChatCompletionRequest with user, metadata, and forceModel", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.7 }));

    const req = {
      messages: [{ role: "user", content: "Fix spelling in readme" }],
      user: "user-session-99",
      forceModel: "claude-3-opus",
    };

    const dec = await router.route(req);
    assert.equal(dec.taskId, "user-session-99");
    assert.equal(dec.model, "claude-3-opus");
    assert.equal(dec.tier, "premium");
    assert.equal(dec.confidence, 1.0);
  });

  await t.test("4.4: route with empty string or whitespace prompt falls back safely without throwing", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.7 }));

    const decEmpty = await router.route("");
    assert.equal(decEmpty.model, "gpt-4o-mini");
    assert.equal(decEmpty.tier, "cheap");
    assert.ok(decEmpty.taskId.startsWith("task-"));

    const decWhitespace = await router.route("   \n\t  ");
    assert.equal(decWhitespace.model, "gpt-4o-mini");
    assert.equal(decWhitespace.tier, "cheap");
  });

  await t.test("4.5: CODEX_SHIM_FORCE_MODEL with unclassified model name defaults to standard tier", async () => {
    await withEnv({ CODEX_SHIM_FORCE_MODEL: "mistral-large-2407" }, async () => {
      const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.7 }));
      const dec = await router.route("Any task", { taskId: "standard-tier-task" });

      assert.equal(dec.model, "mistral-large-2407");
      assert.equal(dec.tier, "standard");
    });
  });

  await t.test("4.6: clearCache forces re-scoring and updates stats counters", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.7 }));

    await router.route("Simple task", { taskId: "task-to-clear" });
    assert.equal(router.classifierCalls, 1);

    await router.route("Simple task", { taskId: "task-to-clear" });
    assert.equal(router.classifierCalls, 1);

    router.clearCache();
    assert.equal(router.cache.size, 0);

    const reRoute = await router.route("Simple task", { taskId: "task-to-clear" });
    assert.equal(reRoute.fromCache, false);
    assert.equal(router.classifierCalls, 2);
  });

  await t.test("4.7: Router bypass with CODEX_SHIM_DISABLE_ROUTER=1 produces bypass status and 0 cache growth", async () => {
    await withEnv({ CODEX_SHIM_DISABLE_ROUTER: "1" }, async () => {
      const router = new ModelRouter(normalizeRoutingConfig({ enabled: true }));

      for (let i = 0; i < 5; i++) {
        const dec = await router.route(`Task step ${i}`, { taskId: "bypassed-loop" });
        assert.equal(dec.cacheStatus, "bypass");
        assert.equal(dec.fromCache, false);
        assert.equal(dec.model, "gpt-4o-mini");
      }

      assert.equal(router.classifierCalls, 0);
      assert.equal(router.cache.size, 0, "Bypassed calls must never be cached");
    });
  });

  await t.test("4.8: Dynamic updateConfig updates threshold and logLevel immediately", async () => {
    const logs = [];
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.85, logLevel: "none" }), {
      onLog: (e) => logs.push(e),
    });

    // Call under initial config: log disabled, threshold 0.85
    const dec1 = await router.route("Task score:0.75", { taskId: "dyn-t1" });
    assert.equal(dec1.model, "gpt-4o-mini");
    assert.equal(logs.length, 0);

    // Mutate config to lower threshold and enable logging
    router.updateConfig({ threshold: 0.50, logLevel: "summary" });

    const dec2 = await router.route("Task score:0.75", { taskId: "dyn-t2" });
    assert.equal(dec2.model, "gpt-4o");
    assert.equal(logs.length, 1);
  });
});

// ===========================================================================
// SUITE 5: CodexShim & HTTP Proxy Deep Protocol & Network Edge Cases
// ===========================================================================

test("M4 Suite 5: CodexShim & HTTP Proxy Deep Protocol & Network Edge Cases", async (t) => {
  await t.test("5.1: CodexShim.handleRequest generates realistic timestamp and attaches _routing", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.7 }));
    const shim = new CodexShim(router);

    const before = Math.floor(Date.now() / 1000);
    const res = await shim.handleRequest({
      messages: [{ role: "user", content: "Format readme" }],
      taskId: "ts-check-task",
    });
    const after = Math.floor(Date.now() / 1000);

    assert.ok(res.created >= before && res.created <= after);
    assert.equal(res._routing.taskId, "ts-check-task");
    assert.equal(res._routing.model, "gpt-4o-mini");
  });

  await t.test("5.2: CodexShim supports options.executor alias", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.7 }));
    let calledExecutor = false;

    const shim = new CodexShim(router, {
      executor: async (req, decision) => {
        calledExecutor = true;
        return {
          id: "executor-alias-id",
          object: "chat.completion",
          created: 12345,
          model: decision.model,
          choices: [{ index: 0, message: { role: "assistant", content: "Done" }, finish_reason: "stop" }],
        };
      },
    });

    const res = await shim.handleRequest({ messages: [{ role: "user", content: "Hello" }] });
    assert.equal(calledExecutor, true);
    assert.equal(res.id, "executor-alias-id");
  });

  await t.test("5.3: CodexShim.handleRequest bubbles upstream executor exceptions", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.7 }));
    const shim = new CodexShim(router, {
      upstreamExecutor: async () => {
        throw new Error("503 Service Unavailable from Upstream Provider");
      },
    });

    await assert.rejects(
      () => shim.handleRequest({ messages: [{ role: "user", content: "test" }] }),
      /503 Service Unavailable from Upstream Provider/,
    );
  });

  await t.test("5.4: HTTP proxy returns 404 for URLs with unknown paths or unexpected query strings", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.7 }));
    const shim = new CodexShim(router);
    const handle = await shim.startHttpServer(0);

    try {
      const resQuery = await handle.dispatch({
        method: "POST",
        url: "/v1/chat/completions?stream=false",
        body: { messages: [{ role: "user", content: "test" }] },
      });
      assert.equal(resQuery.status, 404, "Strict URL match returns 404 when query string is attached");

      const resWrongPath = await handle.dispatch({
        method: "POST",
        url: "/api/v1/chat",
        body: {},
      });
      assert.equal(resWrongPath.status, 404);
    } finally {
      await handle.close();
    }
  });

  await t.test("5.5: HTTP proxy returns 404 for non-POST HTTP methods", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.7 }));
    const shim = new CodexShim(router);
    const handle = await shim.startHttpServer(0);

    try {
      for (const m of ["GET", "PUT", "DELETE", "PATCH", "HEAD"]) {
        const res = await handle.dispatch({
          method: m,
          url: "/v1/chat/completions",
        });
        assert.equal(res.status, 404, `${m} request must return 404`);
      }
    } finally {
      await handle.close();
    }
  });

  await t.test("5.6: HTTP proxy returns 400 Bad Request for invalid JSON payload types", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.7 }));
    const shim = new CodexShim(router);
    const handle = await shim.startHttpServer(0);

    try {
      const invalidPayloads = ["123", "true", "false", '"string"', "[1, 2, 3]", "null"];
      for (const payload of invalidPayloads) {
        const res = await handle.dispatch({
          method: "POST",
          url: "/v1/chat/completions",
          body: payload,
        });
        assert.equal(res.status, 400, `Payload ${payload} must return 400 Bad Request`);
      }
    } finally {
      await handle.close();
    }
  });

  await t.test("5.7: HTTP proxy returns 400 with error message when upstream handler throws", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.7 }));
    const shim = new CodexShim(router, {
      upstreamExecutor: async () => {
        throw new Error("Upstream Model Rate Limited");
      },
    });
    const handle = await shim.startHttpServer(0);

    try {
      const res = await handle.dispatch({
        method: "POST",
        url: "/v1/chat/completions",
        body: { messages: [{ role: "user", content: "Test message" }] },
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.error.message, "Upstream Model Rate Limited");
    } finally {
      await handle.close();
    }
  });

  await t.test("5.8: Real HTTP network socket cycle with 25 concurrent requests", async () => {
    const router = new ModelRouter(normalizeRoutingConfig({ threshold: 0.7 }));
    const shim = new CodexShim(router);
    const handle = await shim.startHttpServer(0);

    try {
      const requests = Array.from({ length: 25 }, async (_, i) => {
        const isComplex = i % 2 === 0;
        const res = await handle.dispatch({
          method: "POST",
          url: "/v1/chat/completions",
          body: {
            messages: [{ role: "user", content: isComplex ? "Architect Raft" : "Fix typo" }],
            taskId: `socket-burst-${i}`,
          },
        });
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.model, isComplex ? "gpt-4o" : "gpt-4o-mini");
        assert.equal(data._routing.taskId, `socket-burst-${i}`);
      });

      await Promise.all(requests);
    } finally {
      await handle.close();
    }
  });
});

// ===========================================================================
// SUITE 6: MCP Consolidated Tools & CLI White-Box Coverage
// ===========================================================================

test("M4 Suite 6: MCP Consolidated Tools & CLI White-Box Coverage", async (t) => {
  await t.test("6.1: MCP get_routing_decision respects options.taskId precedence over args.taskId", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "gw-mcp-opt-"));
    const gwDir = path.join(tmp, ".graphward");
    await mkdir(gwDir, { recursive: true });

    try {
      resetGlobalRouter();
      const registry = await createConsolidatedRegistry(tmp);

      const decision = await registry.execute("get_routing_decision", {
        root: tmp,
        task: "Fix typo",
        taskId: "top-level-task",
        options: {
          taskId: "inner-options-task",
        },
      });

      assert.equal(decision.taskId, "inner-options-task", "options.taskId must take precedence");
    } finally {
      resetGlobalRouter();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  await t.test("6.2: MCP set_routing_config updates classifier and resets forceModel with empty string", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "gw-mcp-cfg-"));
    const gwDir = path.join(tmp, ".graphward");
    await mkdir(gwDir, { recursive: true });

    try {
      resetGlobalRouter();
      const registry = await createConsolidatedRegistry(tmp);

      // Set forceModel and custom classifier
      const updated1 = await registry.execute("set_routing_config", {
        root: tmp,
        forceModel: "gpt-4o",
        classifier: "claude-3-haiku",
      });
      assert.equal(updated1.forceModel, "gpt-4o");
      assert.equal(updated1.classifier, "claude-3-haiku");

      // Reset forceModel with empty string
      const updated2 = await registry.execute("set_routing_config", {
        root: tmp,
        forceModel: "",
      });
      assert.equal(updated2.forceModel, undefined, "Empty string forceModel must normalize to undefined");
      assert.equal(updated2.classifier, "claude-3-haiku", "Unpatched classifier must be preserved");
    } finally {
      resetGlobalRouter();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  await t.test("6.3: getGlobalRouter singleton caching and resetGlobalRouter lifecycle", async () => {
    resetGlobalRouter();
    const router1 = await getGlobalRouter();
    const router2 = await getGlobalRouter();
    assert.equal(router1, router2, "Repeated getGlobalRouter calls must return same instance");

    resetGlobalRouter();
    const router3 = await getGlobalRouter();
    assert.notEqual(router1, router3, "resetGlobalRouter must allow fresh instance creation");
  });

  await t.test("6.4: renderRoutingStatus formatting with and without forceModel", () => {
    const textNoForce = renderRoutingStatus({
      enabled: true,
      threshold: 0.7,
      classifier: "gpt-4o-mini",
      logLevel: "summary",
      capabilityCards: DEFAULT_CAPABILITY_CARDS,
    });
    assert.ok(textNoForce.includes("Force Model: none"));

    const textWithForce = renderRoutingStatus({
      enabled: true,
      threshold: 0.7,
      classifier: "gpt-4o-mini",
      logLevel: "summary",
      forceModel: "claude-3-5-sonnet",
      capabilityCards: DEFAULT_CAPABILITY_CARDS,
    });
    assert.ok(textWithForce.includes("Force Model: claude-3-5-sonnet"));
  });

  await t.test("6.5: CLI gw routing status --json and gw routing stats --json produce parseable schemas", () => {
    const statusRes = runCli(["routing", "status", "--json"]);
    assert.equal(statusRes.status, 0);
    const statusObj = JSON.parse(statusRes.stdout.trim());
    assert.ok("enabled" in statusObj);
    assert.ok("threshold" in statusObj);
    assert.ok("classifier" in statusObj);
    assert.ok("logLevel" in statusObj);

    const statsRes = runCli(["routing", "stats", "--json"]);
    assert.equal(statsRes.status, 0);
    const statsObj = JSON.parse(statsRes.stdout.trim());
    assert.ok("totalRouted" in statsObj);
    assert.ok("cacheHits" in statsObj);
    assert.ok("cacheMisses" in statsObj);
    assert.ok("cacheHitRate" in statsObj);
    assert.ok("estimatedCostSavings" in statsObj);
    assert.ok("modelDistribution" in statsObj);
  });
});
