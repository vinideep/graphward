import assert from "node:assert/strict";
import test from "node:test";
import {
  ChangeSimulator,
  CounterfactualGraphBranch,
  PredictionAccuracyTracker,
} from "../dist/simulation/index.js";
import { RiskEngine } from "../dist/risk/index.js";
import { calculateDeadExportConfidence } from "../dist/gates/dead-exports.js";

test("ChangeSimulator: pre-edit intent simulation predicts blast radius, routes and tests", () => {
  const simulator = new ChangeSimulator();

  const symTarget = {
    repository: "repo",
    package: "pkg",
    language: "ts",
    path: "src/payments/gateway.ts",
    qualifiedName: "processPayment",
    declarationHash: "hash1",
    origin: "SOURCE",
  };

  const graph = {
    nodes: [
      { id: "src/orders/service.ts#placeOrder", path: "src/orders/service.ts", route: "/orders" },
      { id: "src/payments/gateway.ts#processPayment", path: "src/payments/gateway.ts", symbolId: symTarget },
      { id: "test/orders.test.ts", path: "test/orders.test.ts" },
    ],
    edges: [
      { from: "src/orders/service.ts#placeOrder", to: "src/payments/gateway.ts#processPayment" },
      { from: "test/orders.test.ts", to: "src/orders/service.ts#placeOrder", isTest: true },
    ],
  };

  const predicted = simulator.simulateChangeIntent(
    { symbol: symTarget, action: "modify", description: "update payment processing" },
    graph
  );

  assert.ok(predicted.affectedFiles.includes("src/payments/gateway.ts"));
  assert.ok(predicted.affectedFiles.includes("src/orders/service.ts"));
  assert.ok(predicted.affectedRoutes.includes("/orders"));
  assert.ok(predicted.suggestedTests.some((t) => t.includes("orders.test.ts")));
});

test("CounterfactualGraphBranch: evaluates overlay and detects newly introduced cycles", () => {
  const baseSnapshot = {
    id: "snap_1",
    repository: "repo",
    commit: "c1",
    kind: "REAL",
    generatedAt: new Date().toISOString(),
    schemaVersion: "2.2",
  };

  const baseGraph = {
    nodes: [
      { id: "A", path: "src/a.ts" },
      { id: "B", path: "src/b.ts" },
      { id: "C", path: "src/c.ts" },
    ],
    edges: [
      { from: "A", to: "B" },
      { from: "B", to: "C" },
    ],
  };

  // Branch 1: Adds C -> A, creating A -> B -> C -> A cycle
  const branchCyclic = new CounterfactualGraphBranch(baseSnapshot, baseGraph, {
    addedEdges: [{ from: "C", to: "A" }],
  });
  const resCyclic = branchCyclic.evaluate();
  assert.equal(resCyclic.isCycleFree, false);
  assert.equal(resCyclic.newCyclesDetected.length, 1);
  assert.ok(resCyclic.newCyclesDetected[0].nodes.includes("A"));

  // Branch 2: Clean non-cyclic edge A -> C
  const branchClean = new CounterfactualGraphBranch(baseSnapshot, baseGraph, {
    addedEdges: [{ from: "A", to: "C" }],
  });
  const resClean = branchClean.evaluate();
  assert.equal(resClean.isCycleFree, true);
  assert.equal(resClean.newCyclesDetected.length, 0);

  // Branch 3: Deleted node causes broken edges
  const branchBroken = new CounterfactualGraphBranch(baseSnapshot, baseGraph, {
    removedNodeIds: ["C"],
  });
  const resBroken = branchBroken.evaluate();
  assert.ok(resBroken.brokenEdges.some((b) => b.to === "C"));

  // Branch 4: Pre-existing cycle in base graph; patch deletes node without adding edges
  const baseGraphWithCycle = {
    nodes: [{ id: "A", path: "a.ts" }, { id: "B", path: "b.ts" }, { id: "C", path: "c.ts" }],
    edges: [
      { from: "A", to: "B" },
      { from: "B", to: "C" },
      { from: "C", to: "A" },
      { from: "B", to: "A" },
    ],
  };
  const branchDeleteInCycle = new CounterfactualGraphBranch(baseSnapshot, baseGraphWithCycle, {
    removedNodeIds: ["C"],
  });
  const resDeleteInCycle = branchDeleteInCycle.evaluate();
  // Removing C breaks the A->B->C->A cycle, leaving only existing B->A->B. No NEW cycle is introduced.
  assert.equal(resDeleteInCycle.newCyclesDetected.length, 0, "No new cycles should be introduced by node deletion");
  assert.equal(resDeleteInCycle.isCycleFree, true);
});

test("PredictionAccuracyTracker: calculates precision/recall and maintains history", () => {
  const tracker = new PredictionAccuracyTracker();

  const symA = { repository: "r", package: "p", language: "ts", path: "src/a.ts", qualifiedName: "fnA", declarationHash: "hA", origin: "SOURCE" };
  const symB = { repository: "r", package: "p", language: "ts", path: "src/b.ts", qualifiedName: "fnB", declarationHash: "hB", origin: "SOURCE" };

  const metrics = tracker.computeAccuracy(
    { files: ["src/a.ts", "src/b.ts"], symbols: [symA, symB] },
    { modifiedFiles: ["src/a.ts"], modifiedSymbols: [symA] }
  );

  assert.equal(metrics.filePrecision, 0.5);
  assert.equal(metrics.fileRecall, 1.0);
  assert.equal(metrics.symbolPrecision, 0.5);
  assert.equal(metrics.symbolRecall, 1.0);
});

test("RiskEngine: generates multi-dimensional risk profiles and tiered verification plans", () => {
  const engine = new RiskEngine();

  // Low risk case
  const profileLow = engine.assessRisk({
    predictedImpact: {
      affectedFiles: ["src/local.ts"],
      affectedSymbols: [],
      affectedRoutes: [],
      affectedExecutionPaths: [],
      suggestedTests: ["test/local.test.ts"],
    },
    inboundRuntimeRequests: 10,
    hasUnknownBoundaries: false,
    existingTestCount: 5,
  });
  assert.equal(profileLow.tier, "LOW");
  const planLow = engine.generateVerificationPlan(profileLow);
  assert.equal(planLow.tierNumber, 1);
  assert.equal(planLow.requiresHumanApproval, false);

  // Critical risk case
  const profileCrit = engine.assessRisk({
    predictedImpact: {
      affectedFiles: ["src/core.ts", "src/gateway.ts", "src/db.ts"],
      affectedSymbols: [],
      affectedRoutes: ["/api"],
      affectedExecutionPaths: [],
      suggestedTests: [],
    },
    inboundRuntimeRequests: 5000,
    hasUnknownBoundaries: true,
    introducesCycle: true,
  });
  assert.equal(profileCrit.tier, "CRITICAL");
  const planCrit = engine.generateVerificationPlan(profileCrit);
  assert.equal(planCrit.tierNumber, 4);
  assert.equal(planCrit.requiresHumanApproval, true);
});

test("calculateDeadExportConfidence: evaluates entrypoints vs internal utilities", () => {
  const confMain = calculateDeadExportConfidence({ name: "main", moduleId: "mod:src/cli", file: "src/cli/index.ts", line: 10 });
  assert.ok(confMain <= 0.4);

  const confUtil = calculateDeadExportConfidence({ name: "unusedHelper", moduleId: "mod:src/utils", file: "src/utils/calc.ts", line: 25 });
  assert.ok(confUtil >= 0.9);
});

test("CounterfactualGraphBranch: handles malformed, empty, or partial deltas without false cycles", () => {
  const baseSnap = {
    id: "snap_test",
    repository: "test",
    commit: "HEAD",
    kind: "REAL",
    generatedAt: new Date().toISOString(),
    schemaVersion: "2.2",
  };
  const baseGraph = {
    nodes: [{ id: "n1", path: "src/a.ts" }, { id: "n2", path: "src/b.ts" }],
    edges: [{ from: "n1", to: "n2" }],
  };

  // 1. Completely empty / malformed delta
  const res1 = CounterfactualGraphBranch.evaluateClosureDelta(baseSnap, baseGraph, {});
  assert.equal(res1.isCycleFree, true);
  assert.equal(res1.newCyclesDetected.length, 0);

  // 2. Delta with empty edge objects (missing from/to) — must NOT produce undefined -> undefined cycle
  const res2 = CounterfactualGraphBranch.evaluateClosureDelta(baseSnap, baseGraph, {
    addedEdges: [{}, { from: undefined, to: undefined }],
    removedNodeIds: [null],
    addedNodes: [undefined],
  });
  assert.equal(res2.isCycleFree, true, "Malformed edges must not trigger undefined false cycle");
  assert.equal(res2.newCyclesDetected.length, 0);

  // 3. Delta with non-existent node IDs
  const res3 = CounterfactualGraphBranch.evaluateClosureDelta(baseSnap, baseGraph, {
    addedEdges: [{ from: "ghost1", to: "ghost2" }],
    removedNodeIds: ["ghost3"],
    removedEdges: [{ from: "ghost4", to: "ghost5" }],
  });
  assert.equal(res3.isCycleFree, true);
  assert.equal(res3.addedEdgeCount, 1);
});

test("ChangeSimulator: safely handles empty/null intent and empty graph without throwing", () => {
  const sim = new ChangeSimulator();
  const res1 = sim.simulateChangeIntent({ action: "modify", description: "" }, { nodes: [], edges: [] });
  assert.ok(Array.isArray(res1.affectedFiles));
  assert.equal(res1.affectedFiles.length, 0);

  const res2 = ChangeSimulator.simulateChangeIntent(null, null);
  assert.ok(Array.isArray(res2.affectedFiles));
});

test("RiskEngine: assessRisk attaches verificationPlan and safely handles missing properties", () => {
  const engine = new RiskEngine();
  const profile = engine.assessRisk({
    predictedImpact: {},
  });
  assert.ok(profile.tier === "LOW" || profile.tier === "MEDIUM");
  assert.ok(profile.verificationPlan, "verificationPlan must be attached to profile");
  assert.equal(profile.verificationPlan.tierNumber, 1);
  assert.equal(profile.verificationPlan.tierName, "SMOKE");
});
