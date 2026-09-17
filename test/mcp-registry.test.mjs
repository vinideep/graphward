import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createConsolidatedRegistry } from "../dist/mcp/consolidated.js";
import { McpToolRegistry } from "../dist/mcp/registry.js";

test("typed MCP registry validates required, typed, and unknown arguments", async () => {
  const registry = new McpToolRegistry().register({
    name: "typed",
    description: "fixture",
    inputSchema: { type: "object", required: ["name"], additionalProperties: false, properties: { name: { type: "string" }, count: { type: "number", minimum: 1 } } },
    handler: async (args) => args,
  });
  await assert.rejects(registry.execute("typed", {}), /name is required/);
  await assert.rejects(registry.execute("typed", { name: 1 }), /name must be a string/);
  await assert.rejects(registry.execute("typed", { name: "ok", extra: true }), /Unknown argument/);
  assert.deepEqual(await registry.execute("typed", { name: "ok", count: 2 }), { name: "ok", count: 2 });
});

test("raw provider tools are hidden by default and exposed only by explicit expert config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ei-mcp-registry-"));
  let registry = await createConsolidatedRegistry(root);
  let names = registry.list().map((tool) => tool.name);
  assert.ok(names.includes("get_engineering_context"));
  assert.ok(names.includes("validate_change"));
  assert.ok(!names.some((name) => name.startsWith("provider_graphify_") || name.startsWith("provider_cce_")));
  await mkdir(path.join(root, ".graphward"), { recursive: true });
  await writeFile(path.join(root, ".graphward", "gw.config.json"), JSON.stringify({ schemaVersion: 2, providers: { exposeRawMcp: true } }));
  registry = await createConsolidatedRegistry(root);
  names = registry.list().map((tool) => tool.name);
  assert.ok(names.includes("provider_graphify_evidence"));
  assert.ok(names.includes("provider_cce_retrieval"));
});

test("Phase 4 & Phase 5 intelligence engines are registered and executable as first-class MCP tools", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ei-mcp-phase45-"));
  const registry = await createConsolidatedRegistry(root);
  const names = registry.list().map((t) => t.name);

  assert.ok(names.includes("simulate_change_intent"), "simulate_change_intent must be registered");
  assert.ok(names.includes("evaluate_counterfactual"), "evaluate_counterfactual must be registered");
  assert.ok(names.includes("assess_risk"), "assess_risk must be registered");
  assert.ok(names.includes("slice_graph"), "slice_graph must be registered");

  // 1. Test simulate_change_intent
  const mockGraph = {
    nodes: [
      { id: "src/a.ts#funcA", path: "src/a.ts", kind: "function", label: "funcA" },
      { id: "src/b.ts#funcB", path: "src/b.ts", kind: "function", label: "funcB", route: "/api/pay" },
    ],
    edges: [
      { from: "src/b.ts#funcB", to: "src/a.ts#funcA", relation: "calls" },
    ],
  };
  const simResult = await registry.execute("simulate_change_intent", {
    intent: { action: "modify", description: "update funcA", filePath: "src/a.ts" },
    graph: mockGraph,
  });
  assert.ok(simResult.affectedFiles.includes("src/a.ts"));
  assert.ok(simResult.affectedFiles.includes("src/b.ts"));
  assert.ok(simResult.affectedRoutes.includes("/api/pay"));

  // 2. Test evaluate_counterfactual
  const cfResult = await registry.execute("evaluate_counterfactual", {
    baseGraph: mockGraph,
    delta: {
      addedEdges: [{ from: "src/a.ts#funcA", to: "src/b.ts#funcB" }],
    },
  });
  assert.equal(cfResult.isCycleFree, false, "Cycle between funcA and funcB must be detected");
  assert.ok(cfResult.newCyclesDetected.length > 0);

  // 3. Test assess_risk
  const riskResult = await registry.execute("assess_risk", {
    predictedImpact: {
      affectedFiles: ["src/a.ts", "src/b.ts"],
      affectedSymbols: [],
      affectedRoutes: ["/api/pay"],
      affectedExecutionPaths: [],
      suggestedTests: [],
    },
    inboundRuntimeRequests: 5000,
    hasUnknownBoundaries: true,
  });
  assert.equal(riskResult.tier, "CRITICAL");
  assert.ok(riskResult.dimensions.unknownBoundaryRisk > 0.8);
  assert.ok(riskResult.verificationPlan, "verificationPlan should be attached to riskResult");
  assert.equal(riskResult.verificationPlan.tierNumber, 4);

  // 4. Test slice_graph
  const depGraph = {
    schemaVersion: 1,
    graphType: "dependency",
    generatedAt: new Date().toISOString(),
    scope: "test",
    unknowns: [],
    nodes: [
      { id: "packages/auth/src/login.ts#login", kind: "function", label: "login", path: "packages/auth/src/login.ts", confidence: "verified", metadata: {}, evidence: [] },
      { id: "packages/orders/src/checkout.ts#checkout", kind: "function", label: "checkout", path: "packages/orders/src/checkout.ts", confidence: "verified", metadata: {}, evidence: [] },
    ],
    edges: [
      { from: "packages/orders/src/checkout.ts#checkout", to: "packages/auth/src/login.ts#login", relation: "calls", confidence: "verified", metadata: {}, evidence: [] },
    ],
  };

  const globalSlice = await registry.execute("slice_graph", { level: "GLOBAL", graph: depGraph });
  assert.equal(globalSlice.level, "GLOBAL");
  assert.ok(globalSlice.packages.some((p) => p.name === "auth"));

  const pkgSlice = await registry.execute("slice_graph", { level: "PACKAGE", package: "auth", graph: depGraph });
  assert.equal(pkgSlice.level, "PACKAGE");
  assert.equal(pkgSlice.package, "auth");
  assert.equal(pkgSlice.nodes.length, 1);

  const taskSlice = await registry.execute("slice_graph", {
    level: "TASK",
    seeds: ["packages/orders/src/checkout.ts#checkout"],
    maxHops: 2,
    tokenBudget: 2500,
    graph: depGraph,
  });
  assert.equal(taskSlice.level, "TASK");
  assert.equal(taskSlice.hopRadius, 2);
  assert.ok(taskSlice.nodes.length >= 1);
});
