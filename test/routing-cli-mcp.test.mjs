/**
 * Test Suite: Codex Auto-Model-Router MCP Tools & CLI Commands (Milestone 3)
 * Path: test/routing-cli-mcp.test.mjs
 *
 * Verifies:
 * 1. MCP Tool Registration & Schema Integrity in createConsolidatedRegistry
 * 2. get_routing_decision execution (complexity scoring, model, confidence, reasoning, tier, scores)
 * 3. get_routing_stats execution (accurate metrics, cache tracking, cost savings)
 * 4. set_routing_config execution (runtime config patch, disk persistence, router memory sync)
 * 5. CLI gw routing status (formatted text and --json formats)
 * 6. CLI gw routing stats (formatted text and --json formats)
 * 7. CLI gw routing help and invalid argument handling
 * 8. Stdio JSON-RPC 2.0 MCP Protocol integration
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "gw-test-cli-mcp-"));
  const gwDir = path.join(dir, ".graphward");
  await mkdir(gwDir, { recursive: true });

  if (initialConfig) {
    await writeFile(
      path.join(gwDir, "gw.config.json"),
      JSON.stringify(initialConfig, null, 2),
      "utf8",
    );
  }

  const cleanup = async () => {
    resetGlobalRouter();
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

// ---------------------------------------------------------------------------
// 1. MCP Tool Registration & Schema Integrity
// ---------------------------------------------------------------------------

test("MCP: createConsolidatedRegistry registers all 3 routing tools with valid schemas", async () => {
  const { dir, cleanup } = await createTempWorkspace();
  try {
    const registry = await createConsolidatedRegistry(dir);
    assert.ok(registry.has("get_routing_decision"), "get_routing_decision must be registered");
    assert.ok(registry.has("get_routing_stats"), "get_routing_stats must be registered");
    assert.ok(registry.has("set_routing_config"), "set_routing_config must be registered");

    const tools = registry.list();
    const decisionTool = tools.find((t) => t.name === "get_routing_decision");
    assert.ok(decisionTool);
    assert.equal(decisionTool.inputSchema.type, "object");
    assert.ok(decisionTool.inputSchema.required?.includes("task"));
    assert.equal(decisionTool.inputSchema.properties?.task?.type, "string");

    const statsTool = tools.find((t) => t.name === "get_routing_stats");
    assert.ok(statsTool);
    assert.equal(statsTool.inputSchema.type, "object");

    const configTool = tools.find((t) => t.name === "set_routing_config");
    assert.ok(configTool);
    assert.equal(configTool.inputSchema.type, "object");
    assert.equal(configTool.inputSchema.properties?.threshold?.type, "number");
    assert.equal(configTool.inputSchema.properties?.enabled?.type, "boolean");
    assert.equal(configTool.inputSchema.properties?.logLevel?.type, "string");
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2. MCP: get_routing_decision Execution
// ---------------------------------------------------------------------------

test("MCP: get_routing_decision classifies simple task to cheap model", async () => {
  await cleanEnv(async () => {
    const { dir, cleanup } = await createTempWorkspace();
    try {
      const registry = await createConsolidatedRegistry(dir);
      const decision = await registry.execute("get_routing_decision", {
        root: dir,
        task: "Fix formatting and syntax error in utils.ts line 24",
      });

      assert.ok(decision.taskId, "taskId must be returned");
      assert.equal(decision.model, "gpt-4o-mini");
      assert.equal(decision.tier, "cheap");
      assert.ok(typeof decision.confidence === "number");
      assert.ok(decision.confidence < 0.7);
      assert.ok(typeof decision.reasoning === "string" && decision.reasoning.length > 0);
      assert.ok(typeof decision.scores === "object");
      assert.equal(decision.fromCache, false);
    } finally {
      await cleanup();
    }
  });
});

test("MCP: get_routing_decision escalates complex task to premium model", async () => {
  await cleanEnv(async () => {
    const { dir, cleanup } = await createTempWorkspace();
    try {
      const registry = await createConsolidatedRegistry(dir);
      const decision = await registry.execute("get_routing_decision", {
        root: dir,
        task: "Architect distributed Raft consensus state machine with log compaction",
      });

      assert.equal(decision.model, "gpt-4o");
      assert.equal(decision.tier, "premium");
      assert.ok(decision.confidence >= 0.7);
      assert.ok(typeof decision.reasoning === "string" && decision.reasoning.length > 0);
    } finally {
      await cleanup();
    }
  });
});

test("MCP: get_routing_decision supports forceModel override", async () => {
  await cleanEnv(async () => {
    const { dir, cleanup } = await createTempWorkspace();
    try {
      const registry = await createConsolidatedRegistry(dir);
      const decision = await registry.execute("get_routing_decision", {
        root: dir,
        task: "Fix comment typo",
        forceModel: "claude-3-opus",
      });

      assert.equal(decision.model, "claude-3-opus");
      assert.ok(decision.reasoning.includes("claude-3-opus"));
    } finally {
      await cleanup();
    }
  });
});

test("MCP: get_routing_decision validates missing or invalid arguments", async () => {
  const { dir, cleanup } = await createTempWorkspace();
  try {
    const registry = await createConsolidatedRegistry(dir);
    await assert.rejects(
      () => registry.execute("get_routing_decision", { root: dir }),
      /task is required/,
    );
    await assert.rejects(
      () => registry.execute("get_routing_decision", { root: dir, task: 12345 }),
      /task must be a string/,
    );
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3. MCP: get_routing_stats Execution
// ---------------------------------------------------------------------------

test("MCP: get_routing_stats reflects cumulative routing activity", async () => {
  await cleanEnv(async () => {
    const { dir, cleanup } = await createTempWorkspace();
    try {
      const registry = await createConsolidatedRegistry(dir);

      // Baseline stats
      const stats0 = await registry.execute("get_routing_stats", { root: dir });
      assert.equal(typeof stats0.totalRouted, "number");
      assert.equal(typeof stats0.cacheHits, "number");
      assert.equal(typeof stats0.cacheMisses, "number");
      assert.equal(typeof stats0.cacheHitRate, "number");
      assert.equal(typeof stats0.estimatedCostSavings, "number");

      // Execute decisions
      await registry.execute("get_routing_decision", { root: dir, task: "Task 1" });
      await registry.execute("get_routing_decision", { root: dir, task: "Task 2" });
      await registry.execute("get_routing_decision", { root: dir, task: "Task 1" }); // cache hit

      const stats1 = await registry.execute("get_routing_stats", { root: dir });
      assert.equal(stats1.totalRouted, stats0.totalRouted + 3);
      assert.equal(stats1.cacheHits, stats0.cacheHits + 1);
      assert.equal(stats1.cacheMisses, stats0.cacheMisses + 2);
      assert.ok(stats1.cacheHitRate > 0);
      assert.ok(stats1.estimatedCostSavings >= stats0.estimatedCostSavings);
      assert.ok(typeof stats1.modelDistribution === "object");
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. MCP: set_routing_config Execution, Disk Persistence & Router Sync
// ---------------------------------------------------------------------------

test("MCP: set_routing_config updates disk configuration and in-memory router state", async () => {
  await cleanEnv(async () => {
    const { dir, cleanup } = await createTempWorkspace({
      schemaVersion: 2,
      routing: {
        enabled: true,
        threshold: 0.7,
        classifier: "gpt-4o-mini",
        logLevel: "summary",
      },
    });

    try {
      const registry = await createConsolidatedRegistry(dir);

      const updateResult = await registry.execute("set_routing_config", {
        root: dir,
        threshold: 0.45,
        logLevel: "verbose",
        forceModel: "gpt-4o",
      });

      // 1. Verify returned configuration
      assert.equal(updateResult.threshold, 0.45);
      assert.equal(updateResult.logLevel, "verbose");
      assert.equal(updateResult.forceModel, "gpt-4o");

      // 2. Verify on-disk file was atomically updated
      const rawDisk = await readFile(path.join(dir, ".graphward", "gw.config.json"), "utf8");
      const diskParsed = JSON.parse(rawDisk);
      assert.equal(diskParsed.routing.threshold, 0.45);
      assert.equal(diskParsed.routing.logLevel, "verbose");
      assert.equal(diskParsed.routing.forceModel, "gpt-4o");

      // 3. Verify in-memory router reflects new settings
      const globalRouter = await getGlobalRouter(dir);
      assert.equal(globalRouter.getConfig().threshold, 0.45);
      assert.equal(globalRouter.getConfig().logLevel, "verbose");
      assert.equal(globalRouter.getConfig().forceModel, "gpt-4o");

      // 4. Verify subsequent get_routing_decision respects the updated configuration
      const decision = await registry.execute("get_routing_decision", {
        root: dir,
        task: "Fix a typo",
      });
      assert.equal(decision.model, "gpt-4o"); // Forced by updated config
    } finally {
      await cleanup();
    }
  });
});

test("MCP: set_routing_config clamps out-of-bounds thresholds safely", async () => {
  const { dir, cleanup } = await createTempWorkspace();
  try {
    const registry = await createConsolidatedRegistry(dir);

    const clampedLow = await registry.execute("set_routing_config", {
      root: dir,
      threshold: -0.9,
    });
    assert.equal(clampedLow.threshold, 0.0);

    const clampedHigh = await registry.execute("set_routing_config", {
      root: dir,
      threshold: 5.0,
    });
    assert.equal(clampedHigh.threshold, 1.0);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5. CLI: gw routing status (Text & JSON)
// ---------------------------------------------------------------------------

test("CLI: gw routing status formats human-readable status text", async () => {
  const { dir, cleanup } = await createTempWorkspace({
    schemaVersion: 2,
    routing: {
      enabled: true,
      threshold: 0.65,
      classifier: "gpt-4o-mini",
      logLevel: "summary",
    },
  });

  try {
    const result = runCli(["routing", "status", dir]);
    assert.equal(result.status, 0, `CLI exited with error:\n${result.stderr}`);
    assert.match(result.stdout, /Codex Model Router Status:/);
    assert.match(result.stdout, /Enabled:\s*true/);
    assert.match(result.stdout, /Threshold:\s*0\.65/);
    assert.match(result.stdout, /Classifier:\s*gpt-4o-mini/);
    assert.match(result.stdout, /Log Level:\s*summary/);
  } finally {
    await cleanup();
  }
});

test("CLI: gw routing status --json outputs parseable JSON configuration", async () => {
  const { dir, cleanup } = await createTempWorkspace({
    schemaVersion: 2,
    routing: {
      enabled: true,
      threshold: 0.85,
      classifier: "gpt-4o-mini",
      logLevel: "verbose",
    },
  });

  try {
    const result = runCli(["routing", "status", dir, "--json"]);
    assert.equal(result.status, 0, `CLI exited with error:\n${result.stderr}`);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.enabled, true);
    assert.equal(parsed.threshold, 0.85);
    assert.equal(parsed.classifier, "gpt-4o-mini");
    assert.equal(parsed.logLevel, "verbose");
    assert.ok(Array.isArray(parsed.capabilityCards));
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// 6. CLI: gw routing stats (Text & JSON)
// ---------------------------------------------------------------------------

test("CLI: gw routing stats formats aggregate statistics text", async () => {
  const { dir, cleanup } = await createTempWorkspace();
  try {
    const result = runCli(["routing", "stats", dir]);
    assert.equal(result.status, 0, `CLI exited with error:\n${result.stderr}`);
    assert.match(result.stdout, /Codex Routing Aggregate Stats:/);
    assert.match(result.stdout, /Total Routed:\s*\d+/);
    assert.match(result.stdout, /Cache Hits:\s*\d+/);
    assert.match(result.stdout, /Cache Misses:\s*\d+/);
    assert.match(result.stdout, /Cache Hit Rate:\s*\d+/);
    assert.match(result.stdout, /Cost Savings:\s*\$/);
  } finally {
    await cleanup();
  }
});

test("CLI: gw routing stats --json outputs parseable JSON statistics", async () => {
  const { dir, cleanup } = await createTempWorkspace();
  try {
    const result = runCli(["routing", "stats", dir, "--json"]);
    assert.equal(result.status, 0, `CLI exited with error:\n${result.stderr}`);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(typeof parsed.totalRouted, "number");
    assert.equal(typeof parsed.cacheHits, "number");
    assert.equal(typeof parsed.cacheMisses, "number");
    assert.equal(typeof parsed.cacheHitRate, "number");
    assert.equal(typeof parsed.modelDistribution, "object");
    assert.equal(typeof parsed.estimatedCostSavings, "number");
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// 7. CLI: gw routing Help & Subcommand Routing
// ---------------------------------------------------------------------------

test("CLI: gw routing displays routing subcommand help", async () => {
  const result = runCli(["routing", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /gw routing status/);
  assert.match(result.stdout, /gw routing stats/);
});

test("CLI: gw routing handles unknown subactions with exit code 1", async () => {
  const result = runCli(["routing", "unknown-action"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Unknown routing action/);
});

test("CLI: gw routing bare command prints usage with exit code 0", async () => {
  const result = runCli(["routing"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: gw routing/);
});

// ---------------------------------------------------------------------------
// 8. Stdio JSON-RPC 2.0 MCP Protocol Integration
// ---------------------------------------------------------------------------

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

test("MCP Stdio: server advertises tools/list and handles tools/call for routing tools", async () => {
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
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    });
    const initRes = await readJsonRpcResponse(proc, 1);
    assert.ok(!initRes.error);

    sendJsonRpc(proc, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });

    // 2. tools/list: routing tools must be advertised
    sendJsonRpc(proc, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const listRes = await readJsonRpcResponse(proc, 2);
    assert.ok(!listRes.error);
    const names = (listRes.result?.tools ?? []).map((t) => t.name);
    assert.ok(names.includes("get_routing_decision"), "get_routing_decision should be in tools/list");
    assert.ok(names.includes("get_routing_stats"), "get_routing_stats should be in tools/list");
    assert.ok(names.includes("set_routing_config"), "set_routing_config should be in tools/list");

    // 3. tools/call: get_routing_decision over stdio
    sendJsonRpc(proc, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_routing_decision", arguments: { root: dir, task: "Fix simple typo" } },
    });
    const callRes = await readJsonRpcResponse(proc, 3);
    assert.ok(!callRes.error);
    const textData = JSON.parse(callRes.result?.content?.[0]?.text ?? "{}");
    assert.equal(textData.model, "gpt-4o-mini");
    assert.equal(textData.tier, "cheap");

    // 4. tools/call: get_routing_stats over stdio
    sendJsonRpc(proc, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_routing_stats", arguments: { root: dir } },
    });
    const statsRes = await readJsonRpcResponse(proc, 4);
    assert.ok(!statsRes.error);
    const statsData = JSON.parse(statsRes.result?.content?.[0]?.text ?? "{}");
    assert.ok(statsData.totalRouted >= 1);
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
