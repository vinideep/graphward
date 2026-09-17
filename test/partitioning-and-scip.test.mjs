import assert from "node:assert/strict";
import test from "node:test";
import { HierarchicalGraphPartitioner } from "../dist/graph/partitioning.js";
import { ScipBridge } from "../dist/graph/parsers/scip-bridge.js";
import { ResourceGovernor } from "../dist/governor/resource-governor.js";

test("HierarchicalGraphPartitioner: slices global, package, community, and task", () => {
  const partitioner = new HierarchicalGraphPartitioner();

  const graph = {
    nodes: [
      { id: "packages/auth/src/jwt.ts#sign", path: "packages/auth/src/jwt.ts", label: "sign", kind: "function", confidence: "verified" },
      { id: "packages/auth/src/jwt.ts#verify", path: "packages/auth/src/jwt.ts", label: "verify", kind: "function", confidence: "verified" },
      { id: "packages/orders/src/service.ts#placeOrder", path: "packages/orders/src/service.ts", label: "placeOrder", kind: "function", confidence: "verified" },
      { id: "packages/orders/src/service.ts#cancelOrder", path: "packages/orders/src/service.ts", label: "cancelOrder", kind: "function", confidence: "verified" },
    ],
    edges: [
      { from: "packages/orders/src/service.ts#placeOrder", to: "packages/auth/src/jwt.ts#verify", relation: "calls", confidence: "verified" },
      { from: "packages/orders/src/service.ts#placeOrder", to: "packages/orders/src/service.ts#cancelOrder", relation: "calls", confidence: "verified" },
    ],
  };

  // 1. Global Slice
  const globalSlice = partitioner.sliceGlobal(graph);
  assert.equal(globalSlice.level, "GLOBAL");
  assert.equal(globalSlice.packages.length, 2);
  const ordersPkg = globalSlice.packages.find((p) => p.name === "orders");
  assert.ok(ordersPkg?.dependencies.includes("auth"));

  // 2. Package Slice
  const pkgSlice = partitioner.slicePackage(graph, "auth");
  assert.equal(pkgSlice.level, "PACKAGE");
  assert.equal(pkgSlice.nodes.length, 2);

  // 3. Task Slice with token budgeting
  const taskSlice = partitioner.sliceTask(graph, ["packages/orders/src/service.ts#placeOrder"], 1000, 2);
  assert.equal(taskSlice.level, "TASK");
  assert.equal(taskSlice.hopRadius, 2);
  assert.ok(taskSlice.nodes.some((n) => n.id.includes("placeOrder")));
  assert.ok(taskSlice.nodes.some((n) => n.id.includes("verify")));
  assert.ok(taskSlice.estimatedTokens <= 1000);

  // 4. Task Slice with swapped argument order (maxHops=2, tokenBudget=1000)
  const taskSliceSwapped = partitioner.sliceTask(graph, ["packages/orders/src/service.ts#placeOrder"], 2, 1000);
  assert.equal(taskSliceSwapped.level, "TASK");
  assert.equal(taskSliceSwapped.hopRadius, 2);
  assert.ok(taskSliceSwapped.nodes.length >= 2);

  // 5. Task Slice with file path as seed
  const taskSlicePath = partitioner.sliceTask(graph, ["packages/orders/src/service.ts"], 1000, 2);
  assert.equal(taskSlicePath.level, "TASK");
  assert.ok(taskSlicePath.nodes.length >= 1);
});

test("ScipBridge: bidirectional conversion between GraphWard graph and SCIP index", () => {
  const bridge = new ScipBridge();

  const sym = {
    repository: "default",
    package: "core",
    language: "typescript",
    path: "src/billing.ts",
    qualifiedName: "chargeInvoice",
    declarationHash: "h1",
    origin: "SOURCE",
  };

  const scipStr = bridge.toScipSymbolString(sym);
  assert.ok(scipStr.includes("scip-typescript npm core 1.0.0 src/billing.ts#chargeInvoice."));

  const parsedSym = bridge.fromScipSymbolString(scipStr);
  assert.equal(parsedSym.path, "src/billing.ts");
  assert.equal(parsedSym.qualifiedName, "chargeInvoice");

  const graph = {
    nodes: [
      { id: "src/billing.ts#chargeInvoice", path: "src/billing.ts", label: "chargeInvoice", kind: "function", confidence: "verified" },
      { id: "src/gateway.ts#sendStripe", path: "src/gateway.ts", label: "sendStripe", kind: "function", confidence: "verified" },
    ],
    edges: [
      { from: "src/billing.ts#chargeInvoice", to: "src/gateway.ts#sendStripe", relation: "calls", confidence: "verified" },
    ],
  };

  const scipIndex = bridge.exportToScip(graph);
  assert.equal(scipIndex.documents.length, 2);
  assert.equal(scipIndex.metadata.tool_info.name, "graphward-scip-bridge");

  const roundTrip = bridge.importFromScip(scipIndex);
  assert.equal(roundTrip.nodes.length, 2);
  assert.equal(roundTrip.edges.length, 1, "SCIP round-trip must preserve edges");
  assert.equal(roundTrip.edges[0].from, "src/billing.ts#chargeInvoice");
  assert.equal(roundTrip.edges[0].to, "src/gateway.ts#sendStripe");
});

test("ResourceGovernor: advanced degradation, latency P95, IOPS throttling, and snapshot eviction", () => {
  const gov = new ResourceGovernor({
    maxLatencyMs: 100,
    iopsBudgetPerSec: 10,
  });

  // Record latencies
  for (let i = 1; i <= 100; i++) {
    gov.recordLatency(i);
  }
  const p95 = gov.getLatencyP95();
  assert.equal(p95, 96);

  // Initial runtime storage is 0
  assert.equal(gov.getMetrics().runtimeStorageBytes, 0);

  // IOPS check
  for (let i = 0; i < 10; i++) {
    const throttled = gov.checkIopsThrottle(1);
    assert.equal(throttled, false);
  }
  // 11th operation should be throttled
  const throttled = gov.checkIopsThrottle(1);
  assert.equal(throttled, true);

  // IOPS throttle must NOT have inflated runtimeStorageBytes
  assert.equal(gov.getMetrics().runtimeStorageBytes, 0, "IOPS checks must not increase disk storage bytes");

  // Ephemeral snapshot eviction
  const snapshots = [
    { id: "s1", kind: "COUNTERFACTUAL", generatedAt: "2026-09-17T10:00:00Z" },
    { id: "s2", kind: "COUNTERFACTUAL", generatedAt: "2026-09-17T11:00:00Z" },
    { id: "s3", kind: "COUNTERFACTUAL", generatedAt: "2026-09-17T12:00:00Z" },
    { id: "s_real", kind: "REAL", generatedAt: "2026-09-17T09:00:00Z" },
  ];

  const evicted = gov.evictEphemeralSnapshots(snapshots, 2);
  assert.deepEqual(evicted, ["s1"], "oldest ephemeral snapshot should be evicted");
});
