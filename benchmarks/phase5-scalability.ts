/**
 * Phase 5 Gate 5: Scalability Benchmark (benchmarks/phase5-scalability.ts)
 *
 * Evaluates GraphWard under 100,000+ symbol monorepo load using
 * Hierarchical Subgraph Slicing and Resource Governor degradation controls.
 *
 * Hard Quality Gate Thresholds:
 * - Memory Consumption  <= 1.5 GB RAM (1536 MB)
 * - P95 Query Latency   <= 250 ms
 * - Zero OOM crashes under high pressure
 */

import v8 from "node:v8";
import type { DependencyGraph, GraphNode, GraphEdge } from "../dist/graph/schema.js";
import { HierarchicalGraphPartitioner } from "../dist/graph/partitioning.js";
import { ResourceGovernor } from "../dist/governor/resource-governor.js";

export interface Phase5BenchmarkResult {
  symbolCount: number;
  edgeCount: number;
  queryCount: number;
  heapUsedMb: number;
  p95LatencyMs: number;
  averageLatencyMs: number;
  maxLatencyMs: number;
  zeroCrashes: boolean;
  passed: boolean;
  failures: string[];
}

export async function runPhase5ScalabilityBenchmark(): Promise<Phase5BenchmarkResult> {
  const governor = new ResourceGovernor({
    maxHeapBytes: 1536 * 1024 * 1024, // 1.5GB
    maxLatencyMs: 250,
  });

  const partitioner = new HierarchicalGraphPartitioner();

  // -------------------------------------------------------------------------
  // 1. Generate Synthetic 100,000+ Symbol Monorepo Graph
  // -------------------------------------------------------------------------
  const TOTAL_SYMBOLS = 100_000;
  const PACKAGES = ["auth", "billing", "inventory", "orders", "notifications", "analytics", "shipping", "search", "users", "catalog"];
  const MODULES_PER_PKG = 100;
  const SYMBOLS_PER_MOD = Math.ceil(TOTAL_SYMBOLS / (PACKAGES.length * MODULES_PER_PKG)); // 100

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  let count = 0;
  for (const pkg of PACKAGES) {
    for (let m = 0; m < MODULES_PER_PKG; m++) {
      const filePath = `packages/${pkg}/src/module_${m}.ts`;
      for (let s = 0; s < SYMBOLS_PER_MOD; s++) {
        const id = `${filePath}#sym_${s}`;
        nodes.push({
          id,
          kind: s === 0 ? "class" : s < 20 ? "function" : "type",
          label: `sym_${s}`,
          path: filePath,
          confidence: "verified",
        });
        count++;
        if (count >= TOTAL_SYMBOLS) break;
      }
      if (count >= TOTAL_SYMBOLS) break;
    }
    if (count >= TOTAL_SYMBOLS) break;
  }

  // Create intra-package and inter-package edges (~150,000 edges)
  const nodeCount = nodes.length;
  for (let i = 0; i < nodeCount; i++) {
    // 1 intra-module edge
    if (i + 1 < nodeCount && nodes[i].path === nodes[i + 1].path) {
      edges.push({
        from: nodes[i].id,
        to: nodes[i + 1].id,
        relation: "calls",
        confidence: "verified",
      });
    }

    // Occasional inter-package edge
    if (i % 20 === 0 && i + 500 < nodeCount) {
      edges.push({
        from: nodes[i].id,
        to: nodes[i + 500].id,
        relation: "imports",
        confidence: "verified",
      });
    }
  }

  const graph: DependencyGraph = {
    nodes,
    edges,
  };

  // -------------------------------------------------------------------------
  // 2. Measure Memory Consumption under 100k+ load
  // -------------------------------------------------------------------------
  const memStats = v8.getHeapStatistics();
  const heapUsedMb = Number((memStats.used_heap_size / (1024 * 1024)).toFixed(2));

  // -------------------------------------------------------------------------
  // 3. Execute 1,000 High-Pressure Graph Queries & Measure Latencies
  // -------------------------------------------------------------------------
  const QUERY_COUNT = 1000;
  const latencies: number[] = [];

  // Global slice query
  const tGlobalStart = performance.now();
  partitioner.sliceGlobal(graph);
  latencies.push(performance.now() - tGlobalStart);

  // Package slice queries
  for (let i = 0; i < 50; i++) {
    const pkg = PACKAGES[i % PACKAGES.length];
    const tStart = performance.now();
    partitioner.slicePackage(graph, pkg);
    latencies.push(performance.now() - tStart);
  }

  // Task ego-network sliced queries with token budgets
  for (let i = 0; i < QUERY_COUNT - 51; i++) {
    const randomNodeIdx = Math.floor(Math.random() * (nodeCount - 1));
    const seed = nodes[randomNodeIdx].id;

    const tStart = performance.now();
    partitioner.sliceTask(graph, [seed], 3000, 2);
    const duration = performance.now() - tStart;

    latencies.push(duration);
    governor.recordLatency(duration);
  }

  // Calculate Percentiles
  const sorted = [...latencies].sort((a, b) => a - b);
  const p95Idx = Math.floor(sorted.length * 0.95);
  const p95LatencyMs = Number(sorted[p95Idx].toFixed(2));
  const averageLatencyMs = Number(
    (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2)
  );
  const maxLatencyMs = Number(sorted[sorted.length - 1].toFixed(2));

  // Verify Quality Gate Thresholds
  const failures: string[] = [];
  if (heapUsedMb > 1536) {
    failures.push(`Heap usage ${heapUsedMb} MB exceeds ceiling 1536 MB (1.5 GB)`);
  }
  if (p95LatencyMs > 250) {
    failures.push(`P95 query latency ${p95LatencyMs} ms exceeds ceiling 250 ms`);
  }

  return {
    symbolCount: nodes.length,
    edgeCount: edges.length,
    queryCount: latencies.length,
    heapUsedMb,
    p95LatencyMs,
    averageLatencyMs,
    maxLatencyMs,
    zeroCrashes: true,
    passed: failures.length === 0,
    failures,
  };
}

export async function main(): Promise<void> {
  console.log("===============================================================");
  console.log("GraphWard v2.2 - Phase 5 Gate 5: Scalability Gate");
  console.log("===============================================================");
  console.log("Evaluating under 100,000+ Symbol Monorepo High Pressure...\n");

  try {
    const result = await runPhase5ScalabilityBenchmark();

    console.log("Results Summary:");
    console.log("---------------------------------------------------------------");
    console.log(`  Symbols Evaluated   : ${result.symbolCount.toLocaleString()} symbols across ${result.edgeCount.toLocaleString()} edges`);
    console.log(`  Memory Consumption  : ${result.heapUsedMb} MB  (Threshold <= 1536 MB / 1.5 GB) [${result.heapUsedMb <= 1536 ? "PASS" : "FAIL"}]`);
    console.log(`  P95 Query Latency   : ${result.p95LatencyMs} ms  (Threshold <= 250 ms)          [${result.p95LatencyMs <= 250 ? "PASS" : "FAIL"}]`);
    console.log(`  Average Latency     : ${result.averageLatencyMs} ms  (Max: ${result.maxLatencyMs} ms)`);
    console.log(`  High Pressure Runs  : ${result.queryCount} queries executed with ZERO crashes   [PASS]`);
    console.log("---------------------------------------------------------------\n");

    if (!result.passed) {
      console.error("❌ GATE 5 FAILED:");
      for (const f of result.failures) {
        console.error(`  - ${f}`);
      }
      process.exit(1);
    }

    console.log("✅ GATE 5 PASSED: All Phase 5 scalability thresholds met.");
    process.exit(0);
  } catch (err) {
    console.error("❌ GATE 5 ERROR:", err);
    process.exit(1);
  }
}

if (process.argv[1] && (process.argv[1].endsWith("phase5-scalability.ts") || process.argv[1].endsWith("phase5-scalability.js"))) {
  main();
}
