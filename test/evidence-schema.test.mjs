import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateCalibratedConfidence,
  generateWhyExplanation,
  createUnknownBoundaryNode,
  createUnknownBoundaryEdge,
  UNKNOWN_DYNAMIC_TARGET,
  UNKNOWN_DYNAMIC_CALL,
  UNKNOWN_RUNTIME_PATH,
  UNKNOWN_REFLECTION,
  UNKNOWN_EXTERNAL_SYSTEM,
  validateGraph,
} from "../dist/graph/schema.js";

test("evidence-schema: calculateCalibratedConfidence ladder", () => {
  // Empty evidence
  assert.equal(calculateCalibratedConfidence([]), 0.1);

  // 1. Heuristic alone
  const heuristicEv = [{
    id: "e1",
    kind: "AST",
    strength: "HEURISTIC",
    scope: "FILE",
    source: { type: "SOURCE", file: "test.ts", startLine: 1 },
    confidenceState: "CALIBRATED",
  }];
  const heuristicConf = calculateCalibratedConfidence(heuristicEv);
  assert.ok(heuristicConf >= 0.40 && heuristicConf <= 0.50, `Expected ~0.45, got ${heuristicConf}`);

  // 2. Structural (AST) alone
  const astEv = [{
    id: "e2",
    kind: "AST",
    strength: "STRUCTURAL",
    scope: "FILE",
    source: { type: "SOURCE", file: "test.ts", startLine: 1 },
    confidenceState: "CALIBRATED",
  }];
  const astConf = calculateCalibratedConfidence(astEv);
  assert.ok(astConf >= 0.75 && astConf <= 0.85, `Expected ~0.80, got ${astConf}`);

  // 3. Compiler truth alone
  const compilerEv = [{
    id: "e3",
    kind: "COMPILER",
    strength: "SEMANTIC",
    scope: "PROJECT",
    source: { type: "SOURCE", file: "test.ts", startLine: 1 },
    confidenceState: "CALIBRATED",
  }];
  const compilerConf = calculateCalibratedConfidence(compilerEv);
  assert.ok(compilerConf >= 0.95 && compilerConf <= 0.98, `Expected ~0.97, got ${compilerConf}`);

  // 4. Runtime observed alone
  const runtimeEv = [{
    id: "e4",
    kind: "RUNTIME",
    strength: "OBSERVED",
    scope: "RUNTIME",
    source: { type: "RUNTIME", service: "payment-service" },
    observations: 100,
    confidenceState: "CALIBRATED",
  }];
  const runtimeConf = calculateCalibratedConfidence(runtimeEv);
  assert.ok(runtimeConf >= 0.95 && runtimeConf <= 0.995, `Expected > 0.95, got ${runtimeConf}`);

  // 5. Corroborated: AST + COMPILER + RUNTIME
  const corroborated = [
    { id: "e1", kind: "AST", strength: "STRUCTURAL", scope: "FILE", source: { type: "SOURCE", file: "test.ts", startLine: 1 }, confidenceState: "CALIBRATED" },
    { id: "e2", kind: "COMPILER", strength: "SEMANTIC", scope: "PROJECT", source: { type: "SOURCE", file: "test.ts", startLine: 1 }, confidenceState: "CALIBRATED" },
    { id: "e3", kind: "RUNTIME", strength: "OBSERVED", scope: "RUNTIME", source: { type: "RUNTIME", service: "payment-service" }, observations: 1832, confidenceState: "CALIBRATED" },
  ];
  const corrConf = calculateCalibratedConfidence(corroborated);
  assert.ok(corrConf >= 0.99, `Expected >= 0.99, got ${corrConf}`);

  // 6. Dynamic dispatch penalty (Evidence ladder E0-E5)
  const dynConf = calculateCalibratedConfidence(astEv, { isDynamic: true });
  assert.equal(dynConf, 0.42, `Dynamic unconfirmed call should be calibrated to 0.42, got ${dynConf}`);

  // 7. UNKNOWN confidenceState ignores confidence
  const unknownEv = [{
    id: "e5",
    kind: "COMPILER",
    strength: "SEMANTIC",
    scope: "PROJECT",
    source: { type: "SOURCE", file: "test.ts", startLine: 1 },
    confidenceState: "UNKNOWN",
  }];
  assert.equal(unknownEv[0].confidence, undefined);
  assert.equal(calculateCalibratedConfidence(unknownEv), 0.1);
});

test("evidence-schema: polymorphic EvidenceSource variants", () => {
  const sourceEv = {
    id: "ev:source",
    kind: "AST",
    strength: "STRUCTURAL",
    scope: "FILE",
    source: { type: "SOURCE", file: "src/auth.ts", startLine: 10, endLine: 20 },
    confidenceState: "CALIBRATED",
    confidence: 0.80,
  };
  assert.equal(sourceEv.source.type, "SOURCE");

  const runtimeEv = {
    id: "ev:runtime",
    kind: "RUNTIME",
    strength: "OBSERVED",
    scope: "RUNTIME",
    source: { type: "RUNTIME", traceId: "t123", spanId: "s456", service: "payment" },
    confidenceState: "CALIBRATED",
    confidence: 0.99,
  };
  assert.equal(runtimeEv.source.type, "RUNTIME");

  const gitEv = {
    id: "ev:git",
    kind: "GIT",
    strength: "CORROBORATED",
    scope: "HISTORY",
    source: { type: "GIT", commit: "abc1234", author: "dev@example.com", cochangeFiles: ["a.ts", "b.ts"] },
    confidenceState: "CALIBRATED",
    confidence: 0.85,
  };
  assert.equal(gitEv.source.type, "GIT");

  const testEv = {
    id: "ev:test",
    kind: "TEST",
    strength: "CORROBORATED",
    scope: "TEST",
    source: { type: "TEST", suite: "checkout.spec.ts", case: "test pay", executionTimeMs: 42 },
    confidenceState: "CALIBRATED",
    confidence: 0.90,
  };
  assert.equal(testEv.source.type, "TEST");
});

test("evidence-schema: Snapshot and Change first-class entities", () => {
  const realSnapshot = {
    id: "snap_real_001",
    repository: "graphward",
    commit: "c123456",
    kind: "REAL",
    generatedAt: new Date().toISOString(),
    schemaVersion: "2.2",
  };
  assert.equal(realSnapshot.kind, "REAL");

  const counterfactualSnapshot = {
    id: "snap_cf_002",
    repository: "graphward",
    commit: "c123456",
    parentSnapshotId: "snap_real_001",
    kind: "COUNTERFACTUAL",
    baseCommit: "c123456",
    patchHash: "sha256_deadbeef",
    generatedAt: new Date().toISOString(),
    schemaVersion: "2.2",
  };
  assert.equal(counterfactualSnapshot.kind, "COUNTERFACTUAL");
  assert.equal(counterfactualSnapshot.parentSnapshotId, "snap_real_001");

  const change = {
    id: "chg_001",
    snapshotBefore: "snap_real_001",
    snapshotAfter: "snap_cf_002",
    intent: { action: "modify", description: "update payment retry" },
    actor: "agent",
    changedFiles: ["src/payment/retry.ts"],
    changedSymbols: [],
    predictedImpact: {
      affectedFiles: ["src/payment/retry.ts", "src/payment/checkout.ts"],
      affectedSymbols: [],
      affectedRoutes: ["/checkout"],
      affectedExecutionPaths: ["checkout -> retry -> pay"],
    },
    predictionAccuracy: {
      filePrecision: 1.0,
      fileRecall: 1.0,
      symbolPrecision: 1.0,
      symbolRecall: 1.0,
    },
  };
  assert.equal(change.actor, "agent");
  assert.equal(change.intent.action, "modify");
  assert.equal(change.predictionAccuracy.filePrecision, 1.0);
});

test("evidence-schema: generateWhyExplanation explainability", () => {
  // Case A: Dynamic call without compiler resolution
  const dynamicWhy = generateWhyExplanation(
    [{ id: "e1", kind: "AST", strength: "STRUCTURAL", scope: "FILE", source: { type: "SOURCE", file: "test.ts", startLine: 10 }, confidenceState: "CALIBRATED" }],
    { isDynamic: true, unresolvedTarget: true },
  );
  assert.ok(dynamicWhy.includes("dynamic property access"));
  assert.ok(dynamicWhy.includes("no compiler-resolved target"));
  assert.ok(dynamicWhy.includes("no runtime observation"));

  // Case B: Compiler verified with runtime observations
  const verifiedWhy = generateWhyExplanation(
    [
      { id: "e1", kind: "AST", strength: "STRUCTURAL", scope: "FILE", source: { type: "SOURCE", file: "test.ts", startLine: 10 }, confidenceState: "CALIBRATED" },
      { id: "e2", kind: "COMPILER", strength: "SEMANTIC", scope: "PROJECT", source: { type: "SOURCE", file: "test.ts", startLine: 10 }, confidenceState: "CALIBRATED" },
      { id: "e3", kind: "RUNTIME", strength: "OBSERVED", scope: "RUNTIME", source: { type: "RUNTIME", service: "payment" }, observations: 1832, environments: ["test", "dev"], confidenceState: "CALIBRATED" },
    ],
  );
  assert.ok(verifiedWhy.includes("AST verified"));
  assert.ok(verifiedWhy.includes("compiler confirmed type resolution"));
  assert.ok(verifiedWhy.some((w) => w.includes("observed 1832 calls")));
});

test("evidence-schema: UNKNOWN_* boundary nodes and edges", () => {
  const node = createUnknownBoundaryNode(UNKNOWN_DYNAMIC_TARGET, {
    file: "src/payment/dispatcher.ts",
    line: 42,
    reason: "dynamic property access service[method]()",
    rawExpression: "service[method]()",
  });

  assert.equal(node.kind, "unknown_boundary");
  assert.equal(node.confidence, "unknown");
  assert.ok(node.id.startsWith("unknown:unknown_dynamic_target:"));
  assert.equal(node.metadata.boundaryType, UNKNOWN_DYNAMIC_TARGET);
  assert.equal(node.metadata.rawExpression, "service[method]()");

  const edge = createUnknownBoundaryEdge("symbol:src/payment/dispatcher#dispatch", UNKNOWN_DYNAMIC_CALL, {
    file: "src/payment/dispatcher.ts",
    line: 42,
    reason: "unresolved callee",
  });

  assert.equal(edge.relation, "reaches_unknown");
  assert.equal(edge.from, "symbol:src/payment/dispatcher#dispatch");
  assert.equal(edge.confidence, "unknown");
  assert.equal(edge.metadata.boundaryType, UNKNOWN_DYNAMIC_CALL);
});

test("evidence-schema: backwards-compatible validateGraph passes with legacy graph", () => {
  const legacyGraph = {
    schemaVersion: 1,
    graphType: "dependency",
    generatedAt: new Date().toISOString(),
    scope: "test-scope",
    nodes: [
      { id: "node1", kind: "module", label: "Module 1", confidence: "verified", metadata: {}, evidence: ["file.ts"] },
    ],
    edges: [
      { from: "node1", to: "node1", relation: "calls", confidence: "verified", metadata: {}, evidence: ["file.ts"] },
    ],
    unknowns: [],
  };

  const validated = validateGraph(legacyGraph);
  assert.equal(validated.schemaVersion, 1);
  assert.equal(validated.nodes.length, 1);
  assert.equal(validated.edges.length, 1);
});
