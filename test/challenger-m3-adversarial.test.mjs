/**
 * Empirical Adversarial Test Suite for Milestone 3
 * Path: test/challenger-m3-adversarial.test.mjs
 *
 * Authored by: Milestone 3 Challenger 1
 *
 * Scope:
 * 1. MCP Tools Direct Adversarial Verification:
 *    - Schema rejection of malformed payloads, invalid types, missing required arguments, unexpected properties.
 *    - Empty strings, ultra-long strings, options parsing.
 *    - Routing stats invariants (conservation of routed tasks, non-negative numbers, non-NaN rates).
 * 2. MCP set_routing_config Adversarial Verification:
 *    - Boundary threshold values (< 0, > 1, 0.0, 1.0, NaN, Infinity).
 *    - Type enforcement on enabled, logLevel enum, classifier, forceModel.
 *    - Disk state integrity: preserving existing user keys, atomic updates.
 *    - Error resilience: unwritable disk paths fail gracefully without corrupting existing files or leaving artifacts.
 *    - Concurrent execution serialization.
 * 3. MCP Stdio JSON-RPC 2.0 Adversarial Protocol Verification:
 *    - Malformed JSON strings over stdin (no crash).
 *    - Missing arguments / type errors return JSON-RPC tool errors without killing server.
 *    - Sequential protocol resilience after errors.
 * 4. CLI gw routing status & stats Adversarial Verification:
 *    - Exit code 0 for valid commands, help flags, and bare invocations.
 *    - Exit code 1 for unknown subactions and invalid flags.
 *    - Nested directories and non-existent directories.
 *    - Corrupted / malformed JSON in gw.config.json handling (safe fallback).
 *    - Flag order combinations with --json and output schema validation.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createConsolidatedRegistry } from "../dist/mcp/consolidated.js";
import {
  getGlobalRouter,
  resetGlobalRouter,
} from "../dist/routing/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "../dist/cli/index.js");
const REPO_ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Helpers & Fixtures
// ---------------------------------------------------------------------------

async function createTempWorkspace(initialConfig = null) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gw-challenger-m3-"));
  const gwDir = path.join(dir, ".graphward");
  await mkdir(gwDir, { recursive: true });

  if (initialConfig !== null) {
    await writeFile(
      path.join(gwDir, "gw.config.json"),
      typeof initialConfig === "string" ? initialConfig : JSON.stringify(initialConfig, null, 2),
      "utf8",
    );
  }

  const cleanup = async () => {
    resetGlobalRouter();
    // restore permissions if any were changed
    try { await chmod(gwDir, 0o755); } catch {}
    try { await chmod(dir, 0o755); } catch {}
    await rm(dir, { recursive: true, force: true });
  };

  return { dir, gwDir, cleanup };
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

function cleanEnv(fn) {
  const backup = {};
  const routingKeys = [
    "CODEX_SHIM_DISABLE_ROUTER",
    "CODEX_SHIM_THRESHOLD",
    "CODEX_SHIM_FORCE_MODEL",
    "CODEX_SHIM_ROUTER_LOG",
  ];
  for (const k of routingKeys) {
    backup[k] = process.env[k];
    delete process.env[k];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of routingKeys) {
        if (backup[k] !== undefined) process.env[k] = backup[k];
        else delete process.env[k];
      }
    });
}

function sendJsonRpc(proc, msg) {
  proc.stdin.write(JSON.stringify(msg) + "\n");
}

function readJsonRpcResponse(proc, requestId, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for JSON-RPC response ${requestId}`));
    }, timeoutMs);

    const onData = (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === requestId) {
            clearTimeout(timer);
            proc.stdout.off("data", onData);
            resolve(msg);
            return;
          }
        } catch {}
      }
    };
    proc.stdout.on("data", onData);
  });
}

// ---------------------------------------------------------------------------
// 1. MCP Tools Direct Adversarial Verification
// ---------------------------------------------------------------------------

test("Adversarial MCP: get_routing_decision rejects invalid input structures and missing task", async () => {
  const { dir, cleanup } = await createTempWorkspace();
  try {
    const registry = await createConsolidatedRegistry(dir);

    // Non-object inputs
    for (const invalidInput of [null, undefined, "not an object", 42, true, []]) {
      await assert.rejects(
        () => registry.execute("get_routing_decision", invalidInput),
        /Tool arguments must be an object/,
        `Expected non-object input ${String(invalidInput)} to be rejected`,
      );
    }

    // Missing required task property
    await assert.rejects(
      () => registry.execute("get_routing_decision", { root: dir }),
      /task is required/,
    );

    // Non-string task property
    for (const badTask of [123, true, false, {}, [], null]) {
      await assert.rejects(
        () => registry.execute("get_routing_decision", { root: dir, task: badTask }),
        /task must be a string/,
      );
    }

    // Unexpected additional properties rejected
    await assert.rejects(
      () => registry.execute("get_routing_decision", { root: dir, task: "Valid task", maliciousExtra: "payload" }),
      /Unknown argument: maliciousExtra/,
    );

    // Invalid types for optional fields
    await assert.rejects(
      () => registry.execute("get_routing_decision", { root: dir, task: "Valid task", options: "not-an-object" }),
      /options must be an object/,
    );
    await assert.rejects(
      () => registry.execute("get_routing_decision", { root: dir, task: "Valid task", taskId: 999 }),
      /taskId must be a string/,
    );
    await assert.rejects(
      () => registry.execute("get_routing_decision", { root: dir, task: "Valid task", forceModel: 888 }),
      /forceModel must be a string/,
    );
  } finally {
    await cleanup();
  }
});

test("Adversarial MCP: get_routing_decision handles edge cases (empty strings, large strings, options parsing)", async () => {
  await cleanEnv(async () => {
    const { dir, cleanup } = await createTempWorkspace();
    try {
      const registry = await createConsolidatedRegistry(dir);

      // Empty task string
      const emptyDecision = await registry.execute("get_routing_decision", {
        root: dir,
        task: "",
      });
      assert.ok(emptyDecision.model, "Must return a model decision for empty task");
      assert.ok(typeof emptyDecision.confidence === "number");
      assert.ok(emptyDecision.confidence >= 0 && emptyDecision.confidence <= 1);
      assert.ok(typeof emptyDecision.reasoning === "string");
      assert.ok(typeof emptyDecision.taskId === "string");
      assert.ok(typeof emptyDecision.scores === "object");
      assert.equal(typeof emptyDecision.fromCache, "boolean");

      // 100k character large prompt string
      const largeTask = "Refactor distributed cluster state. ".repeat(2500);
      const largeDecision = await registry.execute("get_routing_decision", {
        root: dir,
        task: largeTask,
      });
      assert.ok(largeDecision.model);
      assert.equal(largeDecision.tier, "premium");

      // options object nesting (options.taskId and options.forceModel)
      const nestedDecision = await registry.execute("get_routing_decision", {
        root: dir,
        task: "Quick fix",
        options: {
          taskId: "custom-task-xyz",
          forceModel: "custom-override-model",
        },
      });
      assert.equal(nestedDecision.taskId, "custom-task-xyz");
      assert.equal(nestedDecision.model, "custom-override-model");
    } finally {
      await cleanup();
    }
  });
});

test("Adversarial MCP: get_routing_stats validates schema and maintains strict mathematical invariants", async () => {
  await cleanEnv(async () => {
    const { dir, cleanup } = await createTempWorkspace();
    try {
      const registry = await createConsolidatedRegistry(dir);

      // Non-object rejection
      await assert.rejects(
        () => registry.execute("get_routing_stats", "invalid"),
        /Tool arguments must be an object/,
      );

      // Unknown arguments rejection
      await assert.rejects(
        () => registry.execute("get_routing_stats", { root: dir, unexpectedArg: 1 }),
        /Unknown argument: unexpectedArg/,
      );

      // Initial stats baseline check
      const initialStats = await registry.execute("get_routing_stats", { root: dir });
      assert.equal(typeof initialStats.totalRouted, "number");
      assert.equal(typeof initialStats.cacheHits, "number");
      assert.equal(typeof initialStats.cacheMisses, "number");
      assert.equal(typeof initialStats.cacheHitRate, "number");
      assert.ok(!Number.isNaN(initialStats.cacheHitRate), "cacheHitRate must not be NaN");
      assert.ok(initialStats.cacheHitRate >= 0 && initialStats.cacheHitRate <= 1);
      assert.equal(typeof initialStats.estimatedCostSavings, "number");
      assert.ok(!Number.isNaN(initialStats.estimatedCostSavings));
      assert.ok(initialStats.estimatedCostSavings >= 0);

      // Run multiple decisions to check conservation laws
      await registry.execute("get_routing_decision", { root: dir, task: "Task A" });
      await registry.execute("get_routing_decision", { root: dir, task: "Task B" });
      await registry.execute("get_routing_decision", { root: dir, task: "Task A" }); // Hit
      await registry.execute("get_routing_decision", { root: dir, task: "Task C" });
      await registry.execute("get_routing_decision", { root: dir, task: "Task B" }); // Hit

      const updatedStats = await registry.execute("get_routing_stats", { root: dir });
      assert.equal(updatedStats.totalRouted, initialStats.totalRouted + 5);
      assert.equal(updatedStats.cacheHits, initialStats.cacheHits + 2);
      assert.equal(updatedStats.cacheMisses, initialStats.cacheMisses + 3);
      assert.equal(updatedStats.totalRouted, updatedStats.cacheHits + updatedStats.cacheMisses);

      // Model distribution sum equals totalRouted
      const modelSum = Object.values(updatedStats.modelDistribution).reduce((a, b) => a + b, 0);
      assert.equal(modelSum, updatedStats.totalRouted, "Sum of model distribution counts must equal totalRouted");
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. MCP: set_routing_config Boundary, Clamping, and Disk Integrity
// ---------------------------------------------------------------------------

test("Adversarial MCP: set_routing_config handles extreme threshold boundaries and NaN/Infinity", async () => {
  const { dir, cleanup } = await createTempWorkspace();
  try {
    const registry = await createConsolidatedRegistry(dir);

    // Negative threshold clamping
    const neg1 = await registry.execute("set_routing_config", { root: dir, threshold: -0.0001 });
    assert.equal(neg1.threshold, 0.0);
    const neg2 = await registry.execute("set_routing_config", { root: dir, threshold: -999999 });
    assert.equal(neg2.threshold, 0.0);

    // Above 1.0 threshold clamping
    const over1 = await registry.execute("set_routing_config", { root: dir, threshold: 1.0001 });
    assert.equal(over1.threshold, 1.0);
    const over2 = await registry.execute("set_routing_config", { root: dir, threshold: 999999 });
    assert.equal(over2.threshold, 1.0);

    // Exact boundary threshold retention
    const zero = await registry.execute("set_routing_config", { root: dir, threshold: 0.0 });
    assert.equal(zero.threshold, 0.0);
    const one = await registry.execute("set_routing_config", { root: dir, threshold: 1.0 });
    assert.equal(one.threshold, 1.0);

    // NaN / Infinity handling: should not crash, should fall back to default threshold (0.7)
    const nanRes = await registry.execute("set_routing_config", { root: dir, threshold: NaN });
    assert.equal(nanRes.threshold, 0.7, "NaN threshold must safely fall back to default");

    const infRes = await registry.execute("set_routing_config", { root: dir, threshold: Infinity });
    assert.equal(infRes.threshold, 0.7, "Infinity threshold must safely fall back to default");
  } finally {
    await cleanup();
  }
});

test("Adversarial MCP: set_routing_config rejects invalid types and disallowed enums", async () => {
  const { dir, cleanup } = await createTempWorkspace();
  try {
    const registry = await createConsolidatedRegistry(dir);

    // String instead of number for threshold
    await assert.rejects(
      () => registry.execute("set_routing_config", { root: dir, threshold: "0.5" }),
      /threshold must be a number/,
    );

    // Invalid types for enabled
    for (const badEnabled of ["true", 1, 0, null, {}]) {
      await assert.rejects(
        () => registry.execute("set_routing_config", { root: dir, enabled: badEnabled }),
        /enabled must be a boolean/,
      );
    }

    // Invalid logLevel enums
    for (const badLog of ["all", "debug", "DEBUG", "off", 123, true]) {
      await assert.rejects(
        () => registry.execute("set_routing_config", { root: dir, logLevel: badLog }),
        /(logLevel must be one of|logLevel must be a string)/,
      );
    }

    // Invalid types for classifier and forceModel
    await assert.rejects(
      () => registry.execute("set_routing_config", { root: dir, classifier: 12345 }),
      /classifier must be a string/,
    );
    await assert.rejects(
      () => registry.execute("set_routing_config", { root: dir, forceModel: ["model"] }),
      /forceModel must be a string/,
    );

    // Unexpected property rejection
    await assert.rejects(
      () => registry.execute("set_routing_config", { root: dir, hackField: true }),
      /Unknown argument: hackField/,
    );
  } finally {
    await cleanup();
  }
});

test("Adversarial MCP: set_routing_config preserves existing config keys and writes atomically", async () => {
  const customConfig = {
    schemaVersion: 2,
    customField: "preserved-custom-value",
    providers: {
      policy: "full",
      offline: true,
      requireProviders: true,
      exposeRawMcp: true,
    },
    hooks: {
      "pre-tool-use": "echo hook",
    },
    routing: {
      enabled: true,
      threshold: 0.6,
      classifier: "gpt-4o-mini",
      logLevel: "summary",
    },
  };

  const { dir, gwDir, cleanup } = await createTempWorkspace(customConfig);
  try {
    const registry = await createConsolidatedRegistry(dir);

    await registry.execute("set_routing_config", {
      root: dir,
      threshold: 0.82,
      logLevel: "verbose",
    });

    const raw = await readFile(path.join(gwDir, "gw.config.json"), "utf8");
    const parsed = JSON.parse(raw);

    // Preserved top-level and nested configuration
    assert.equal(parsed.customField, "preserved-custom-value");
    assert.equal(parsed.providers.policy, "full");
    assert.equal(parsed.providers.offline, true);
    assert.equal(parsed.providers.exposeRawMcp, true);
    assert.equal(parsed.hooks["pre-tool-use"], "echo hook");

    // Updated routing configuration
    assert.equal(parsed.routing.threshold, 0.82);
    assert.equal(parsed.routing.logLevel, "verbose");
    assert.equal(parsed.routing.classifier, "gpt-4o-mini");
  } finally {
    await cleanup();
  }
});

test("Adversarial MCP: set_routing_config handles unwritable disk gracefully without corrupting state", async () => {
  const initialConfig = {
    schemaVersion: 2,
    routing: {
      enabled: true,
      threshold: 0.7,
      classifier: "gpt-4o-mini",
      logLevel: "summary",
    },
  };

  const { dir, gwDir, cleanup } = await createTempWorkspace(initialConfig);
  try {
    const configPath = path.join(gwDir, "gw.config.json");
    const registry = await createConsolidatedRegistry(dir);

    // Make the directory unwritable so atomic temp file creation or renaming fails
    await chmod(gwDir, 0o555);

    // Attempting to update config should fail cleanly
    await assert.rejects(
      () => registry.execute("set_routing_config", { root: dir, threshold: 0.2 }),
      /(EACCES|permission denied)/i,
    );

    // Restore write permissions to inspect state
    await chmod(gwDir, 0o755);

    // Verify existing file is completely untampered and parseable
    const content = await readFile(configPath, "utf8");
    const parsed = JSON.parse(content);
    assert.equal(parsed.routing.threshold, 0.7, "Threshold on disk must remain unchanged");

    // Verify in-memory router was NOT updated to the failed threshold
    const router = await getGlobalRouter(dir);
    assert.equal(router.getConfig().threshold, 0.7, "Router memory must remain unchanged");
  } finally {
    await cleanup();
  }
});

test("Adversarial MCP: set_routing_config serializes concurrent updates without race conditions", async () => {
  const { dir, gwDir, cleanup } = await createTempWorkspace();
  try {
    const registry = await createConsolidatedRegistry(dir);

    // Launch 8 concurrent updates
    const updates = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
    await Promise.all(
      updates.map((th) => registry.execute("set_routing_config", { root: dir, threshold: th })),
    );

    // Verify disk content is valid JSON and matches in-memory router
    const raw = await readFile(path.join(gwDir, "gw.config.json"), "utf8");
    const parsed = JSON.parse(raw);
    assert.ok(typeof parsed.routing.threshold === "number");
    assert.ok(parsed.routing.threshold >= 0.1 && parsed.routing.threshold <= 0.8);

    const router = await getGlobalRouter(dir);
    assert.equal(router.getConfig().threshold, parsed.routing.threshold);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3. MCP Stdio JSON-RPC 2.0 Adversarial Tests
// ---------------------------------------------------------------------------

test("Adversarial MCP Stdio: survives malformed JSON-RPC payloads, syntax errors, and missing fields", async () => {
  const { dir, cleanup } = await createTempWorkspace();
  const proc = spawn(process.execPath, [CLI, "mcp", dir], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    // 1. Initialize
    sendJsonRpc(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "adv-test", version: "1.0" } },
    });
    const initRes = await readJsonRpcResponse(proc, 1);
    assert.ok(!initRes.error);
    sendJsonRpc(proc, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });

    // 2. Feed completely invalid JSON syntax (should not crash server)
    proc.stdin.write("{{{ THIS IS CORRUPT NOT JSON }}}\n");

    // 3. Unknown method
    sendJsonRpc(proc, { jsonrpc: "2.0", id: 2, method: "tools/non_existent_method", params: {} });
    const unknownRes = await readJsonRpcResponse(proc, 2);
    assert.ok(unknownRes.error, "Unknown method should return error");

    // 4. tools/call with missing task argument for get_routing_decision
    sendJsonRpc(proc, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_routing_decision", arguments: { root: dir } },
    });
    const missingArgRes = await readJsonRpcResponse(proc, 3);
    assert.ok(missingArgRes.result?.isError, "Missing task must return tool error");
    assert.match(missingArgRes.result?.content?.[0]?.text ?? "", /task is required/);

    // 5. tools/call with invalid argument type for get_routing_decision
    sendJsonRpc(proc, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_routing_decision", arguments: { root: dir, task: 999 } },
    });
    const badTypeRes = await readJsonRpcResponse(proc, 4);
    assert.ok(badTypeRes.result?.isError);
    assert.match(badTypeRes.result?.content?.[0]?.text ?? "", /task must be a string/);

    // 6. tools/call set_routing_config with out-of-bounds threshold (< 0) clamps safely
    sendJsonRpc(proc, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "set_routing_config", arguments: { root: dir, threshold: -0.85 } },
    });
    const clampRes = await readJsonRpcResponse(proc, 5);
    assert.ok(!clampRes.error);
    const parsedClamp = JSON.parse(clampRes.result?.content?.[0]?.text ?? "{}");
    assert.equal(parsedClamp.threshold, 0.0);

    // 7. tools/call set_routing_config with invalid enum
    sendJsonRpc(proc, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "set_routing_config", arguments: { root: dir, logLevel: "invalid-level" } },
    });
    const badEnumRes = await readJsonRpcResponse(proc, 6);
    assert.ok(badEnumRes.result?.isError);
    assert.match(badEnumRes.result?.content?.[0]?.text ?? "", /logLevel must be one of/);

    // 8. Server remains fully operational after all adversarial attacks
    sendJsonRpc(proc, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "get_routing_stats", arguments: { root: dir } },
    });
    const finalStatsRes = await readJsonRpcResponse(proc, 7);
    assert.ok(!finalStatsRes.error);
    assert.ok(!finalStatsRes.result?.isError);
  } finally {
    proc.stdin.end();
    const closePromise = new Promise((res) => proc.on("close", res));
    const timer = setTimeout(() => {
      try { proc.kill("SIGTERM"); } catch {}
    }, 5000);
    await closePromise;
    clearTimeout(timer);
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4. CLI gw routing status & stats Adversarial Verification
// ---------------------------------------------------------------------------

test("Adversarial CLI: exit codes strictly conform to specification", async () => {
  // Exit code 0 for valid commands
  assert.equal(runCli(["routing", "status"]).status, 0);
  assert.equal(runCli(["routing", "stats"]).status, 0);

  // Exit code 0 for help & bare invocation
  assert.equal(runCli(["routing"]).status, 0);
  assert.equal(runCli(["routing", "help"]).status, 0);
  assert.equal(runCli(["routing", "--help"]).status, 0);
  assert.equal(runCli(["routing", "-h"]).status, 0);

  // Exit code 1 for unknown subactions
  const unknown1 = runCli(["routing", "invalid"]);
  assert.equal(unknown1.status, 1);
  assert.match(unknown1.stdout, /Unknown routing action "invalid"/);

  const unknown2 = runCli(["routing", "restart"]);
  assert.equal(unknown2.status, 1);
  assert.match(unknown2.stdout, /Unknown routing action "restart"/);

  // Exit code 1 for unknown options / flags
  const badFlag = runCli(["routing", "status", "--unknown-flag-123"]);
  assert.equal(badFlag.status, 1);
});

test("Adversarial CLI: handles nested directory paths and non-existent paths gracefully", async () => {
  const { dir, cleanup } = await createTempWorkspace({
    schemaVersion: 2,
    routing: {
      enabled: false,
      threshold: 0.92,
      classifier: "gpt-4o-mini",
      logLevel: "verbose",
    },
  });

  try {
    // Nested project path explicitly passed
    const nestedRes = runCli(["routing", "status", dir, "--json"]);
    assert.equal(nestedRes.status, 0);
    const parsed = JSON.parse(nestedRes.stdout.trim());
    assert.equal(parsed.enabled, false);
    assert.equal(parsed.threshold, 0.92);
    assert.equal(parsed.logLevel, "verbose");

    // Non-existent directory path falls back to default normalized config safely
    const nonExistentDir = path.join(os.tmpdir(), "gw-non-existent-" + Date.now());
    const fallbackRes = runCli(["routing", "status", nonExistentDir, "--json"]);
    assert.equal(fallbackRes.status, 0);
    const fallbackParsed = JSON.parse(fallbackRes.stdout.trim());
    assert.equal(fallbackParsed.enabled, true);
    assert.equal(fallbackParsed.threshold, 0.7);

    // Stats on non-existent directory
    const statsRes = runCli(["routing", "stats", nonExistentDir, "--json"]);
    assert.equal(statsRes.status, 0);
    const statsParsed = JSON.parse(statsRes.stdout.trim());
    assert.equal(statsParsed.totalRouted, 0);
  } finally {
    await cleanup();
  }
});

test("Adversarial CLI: recovers gracefully from corrupted disk configuration file", async () => {
  // Create workspace with malformed JSON syntax in gw.config.json
  const { dir, cleanup } = await createTempWorkspace("{{{ MALFORMED SYNTAX NOT JSON ");
  try {
    // CLI should not crash with unhandled exception, but fall back to safe default config
    const res = runCli(["routing", "status", dir, "--json"]);
    assert.equal(res.status, 0, `CLI should handle corrupted config file gracefully: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.enabled, true);
    assert.equal(parsed.threshold, 0.7);
    assert.equal(parsed.classifier, "gpt-4o-mini");
  } finally {
    await cleanup();
  }
});

test("Adversarial CLI: flag placement permutations (--json before and after subcommand)", async () => {
  const { dir, cleanup } = await createTempWorkspace({
    schemaVersion: 2,
    routing: {
      enabled: true,
      threshold: 0.55,
      classifier: "gpt-4o-mini",
      logLevel: "summary",
    },
  });

  try {
    // 1. gw routing status <path> --json
    const res1 = runCli(["routing", "status", dir, "--json"]);
    assert.equal(res1.status, 0);
    const p1 = JSON.parse(res1.stdout.trim());
    assert.equal(p1.threshold, 0.55);

    // 2. gw routing --json status <path>
    const res2 = runCli(["routing", "--json", "status", dir]);
    assert.equal(res2.status, 0);
    const p2 = JSON.parse(res2.stdout.trim());
    assert.equal(p2.threshold, 0.55);

    // 3. gw routing stats <path> --json
    const res3 = runCli(["routing", "stats", dir, "--json"]);
    assert.equal(res3.status, 0);
    const p3 = JSON.parse(res3.stdout.trim());
    assert.equal(typeof p3.totalRouted, "number");

    // 4. gw routing --json stats <path>
    const res4 = runCli(["routing", "--json", "stats", dir]);
    assert.equal(res4.status, 0);
    const p4 = JSON.parse(res4.stdout.trim());
    assert.equal(typeof p4.totalRouted, "number");
  } finally {
    await cleanup();
  }
});
