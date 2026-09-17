/**
 * Phase 4 Gate 4: Simulation Accuracy Benchmark (benchmarks/phase4-simulation-accuracy.ts)
 *
 * Evaluates GraphWard's Stage 1 Intent Simulator, Stage 2 Counterfactual Branch,
 * and Prediction Accuracy Tracker on complex-backend change scenarios.
 *
 * Hard Quality Gate Thresholds:
 * - Blast Radius Impact Precision  >= 80.0%
 * - Blast Radius Impact Recall     >= 85.0%
 * - Cycle Detection Precision      = 100.0%
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Snapshot } from "../dist/graph/schema.js";
import type { SymbolId } from "../dist/graph/symbol-identity.js";
import {
  ChangeSimulator,
  type GraphLike,
} from "../dist/simulation/change-simulator.js";
import {
  CounterfactualGraphBranch,
} from "../dist/simulation/counterfactual-graph.js";
import {
  PredictionAccuracyTracker,
} from "../dist/simulation/prediction-accuracy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const TARGET_PROJECT = path.resolve(REPO_ROOT, "benchmark/complex-backend");

// ---------------------------------------------------------------------------
// Base Architecture Graph Fixture (complex-backend)
// ---------------------------------------------------------------------------

const BASE_SNAPSHOT: Snapshot = {
  id: "snap_base_20260917",
  repository: "complex-backend",
  commit: "a8f3d1e2",
  kind: "REAL",
  generatedAt: new Date().toISOString(),
  schemaVersion: "2.2",
};

const symOrderService: SymbolId = {
  repository: "complex-backend",
  package: "orders",
  language: "typescript",
  path: "src/orders/service.ts",
  qualifiedName: "createAndProcessOrder",
  declarationHash: "h_ord_1",
  origin: "SOURCE",
};

const symPaymentGateway: SymbolId = {
  repository: "complex-backend",
  package: "payments",
  language: "typescript",
  path: "src/payments/gateway.ts",
  qualifiedName: "processPayment",
  declarationHash: "h_pay_1",
  origin: "SOURCE",
};

const symInventoryStock: SymbolId = {
  repository: "complex-backend",
  package: "inventory",
  language: "typescript",
  path: "src/inventory/stock.ts",
  qualifiedName: "reserveStock",
  declarationHash: "h_inv_1",
  origin: "SOURCE",
};

const symDbClient: SymbolId = {
  repository: "complex-backend",
  package: "db",
  language: "typescript",
  path: "src/db/client.ts",
  qualifiedName: "InMemoryTenantDatabase.saveOrder",
  declarationHash: "h_db_1",
  origin: "SOURCE",
};

const symEventBus: SymbolId = {
  repository: "complex-backend",
  package: "events",
  language: "typescript",
  path: "src/events/bus.ts",
  qualifiedName: "EventBus.publish",
  declarationHash: "h_bus_1",
  origin: "SOURCE",
};

const BASE_GRAPH: GraphLike = {
  nodes: [
    { id: "src/orders/service.ts#createAndProcessOrder", path: "src/orders/service.ts", route: "/api/v1/orders", symbolId: symOrderService },
    { id: "src/payments/gateway.ts#processPayment", path: "src/payments/gateway.ts", route: "/api/v1/payments", symbolId: symPaymentGateway },
    { id: "src/inventory/stock.ts#reserveStock", path: "src/inventory/stock.ts", symbolId: symInventoryStock },
    { id: "src/db/client.ts#InMemoryTenantDatabase.saveOrder", path: "src/db/client.ts", symbolId: symDbClient },
    { id: "src/events/bus.ts#EventBus.publish", path: "src/events/bus.ts", symbolId: symEventBus },
    { id: "test/orders.test.ts", path: "test/orders.test.ts" },
    { id: "test/payments.test.ts", path: "test/payments.test.ts" },
  ],
  edges: [
    // order service calls payment, inventory, db, events
    { from: "src/orders/service.ts#createAndProcessOrder", to: "src/payments/gateway.ts#processPayment" },
    { from: "src/orders/service.ts#createAndProcessOrder", to: "src/inventory/stock.ts#reserveStock" },
    { from: "src/orders/service.ts#createAndProcessOrder", to: "src/db/client.ts#InMemoryTenantDatabase.saveOrder" },
    { from: "src/orders/service.ts#createAndProcessOrder", to: "src/events/bus.ts#EventBus.publish" },

    // payment gateway calls db and events
    { from: "src/payments/gateway.ts#processPayment", to: "src/db/client.ts#InMemoryTenantDatabase.saveOrder" },
    { from: "src/payments/gateway.ts#processPayment", to: "src/events/bus.ts#EventBus.publish" },

    // tests call services
    { from: "test/orders.test.ts", to: "src/orders/service.ts#createAndProcessOrder", isTest: true },
    { from: "test/payments.test.ts", to: "src/payments/gateway.ts#processPayment", isTest: true },
  ],
};

// ---------------------------------------------------------------------------
// Verified Ground Truth Patch Impact Datasets
// ---------------------------------------------------------------------------

export interface PatchScenario {
  intentDescription: string;
  targetSymbol: SymbolId;
  verifiedActualFiles: string[];
  verifiedActualSymbols: SymbolId[];
}

const PATCH_SCENARIOS: PatchScenario[] = [
  {
    intentDescription: "Update payment gateway fee calculation logic",
    targetSymbol: symPaymentGateway,
    verifiedActualFiles: [
      "src/payments/gateway.ts",
      "src/orders/service.ts",
      "test/payments.test.ts",
      "test/orders.test.ts",
    ],
    verifiedActualSymbols: [symPaymentGateway, symOrderService],
  },
  {
    intentDescription: "Refactor inventory stock reservation lock",
    targetSymbol: symInventoryStock,
    verifiedActualFiles: [
      "src/inventory/stock.ts",
      "src/orders/service.ts",
      "test/orders.test.ts",
    ],
    verifiedActualSymbols: [symInventoryStock, symOrderService],
  },
  {
    intentDescription: "Modify tenant database saveOrder schema binding",
    targetSymbol: symDbClient,
    verifiedActualFiles: [
      "src/db/client.ts",
      "src/orders/service.ts",
      "src/payments/gateway.ts",
      "test/orders.test.ts",
      "test/payments.test.ts",
    ],
    verifiedActualSymbols: [symDbClient, symOrderService, symPaymentGateway],
  },
];

export interface Phase4BenchmarkResult {
  meanImpactPrecision: number;
  meanImpactRecall: number;
  cycleDetectionPrecision: number;
  scenariosEvaluated: number;
  cyclesEvaluated: number;
  passed: boolean;
  failures: string[];
}

export async function runPhase4SimulationBenchmark(): Promise<Phase4BenchmarkResult> {
  const simulator = new ChangeSimulator();
  const tracker = new PredictionAccuracyTracker();

  let sumFilePrecision = 0;
  let sumFileRecall = 0;

  // 1. Evaluate Stage 1 Blast Radius Simulation
  for (const scenario of PATCH_SCENARIOS) {
    const predicted = simulator.simulateChangeIntent(
      {
        symbol: scenario.targetSymbol,
        action: "modify",
        description: scenario.intentDescription,
      },
      BASE_GRAPH
    );

    const change = simulator.createChange(
      {
        symbol: scenario.targetSymbol,
        action: "modify",
        description: scenario.intentDescription,
      },
      BASE_SNAPSHOT.id,
      predicted
    );

    const metrics = tracker.recordChangeOutcome(change, {
      modifiedFiles: scenario.verifiedActualFiles,
      modifiedSymbols: scenario.verifiedActualSymbols,
    });

    sumFilePrecision += metrics.filePrecision;
    sumFileRecall += metrics.fileRecall;
  }

  const scenarioCount = PATCH_SCENARIOS.length;
  const meanImpactPrecision = sumFilePrecision / scenarioCount;
  const meanImpactRecall = sumFileRecall / scenarioCount;

  // 2. Evaluate Stage 2 Counterfactual Graph Branch & Cycle Detection
  let cycleTruePositives = 0;
  let cycleFalsePositives = 0;
  let cycleTrueNegatives = 0;

  // Case A: Introduces cyclic edge (db -> orders when orders already calls db)
  const cyclicBranch = new CounterfactualGraphBranch(BASE_SNAPSHOT, BASE_GRAPH, {
    addedEdges: [
      { from: "src/db/client.ts#InMemoryTenantDatabase.saveOrder", to: "src/orders/service.ts#createAndProcessOrder" },
    ],
  });
  const cyclicEval = cyclicBranch.evaluate();
  if (cyclicEval.newCyclesDetected.length > 0) {
    cycleTruePositives++;
  }

  // Case B: Introduces 3-node cycle (events -> db when orders -> events and db is called by orders)
  // Let's add events -> orders
  const cyclicBranch2 = new CounterfactualGraphBranch(BASE_SNAPSHOT, BASE_GRAPH, {
    addedEdges: [
      { from: "src/events/bus.ts#EventBus.publish", to: "src/orders/service.ts#createAndProcessOrder" },
    ],
  });
  const cyclicEval2 = cyclicBranch2.evaluate();
  if (cyclicEval2.newCyclesDetected.length > 0) {
    cycleTruePositives++;
  }

  // Case C: Clean non-cyclic patch (adding a new leaf subscriber node)
  const cleanBranch = new CounterfactualGraphBranch(BASE_SNAPSHOT, BASE_GRAPH, {
    addedNodes: [
      { id: "src/analytics/audit.ts#recordLog", path: "src/analytics/audit.ts" },
    ],
    addedEdges: [
      { from: "src/events/bus.ts#EventBus.publish", to: "src/analytics/audit.ts#recordLog" },
    ],
  });
  const cleanEval = cleanBranch.evaluate();
  if (cleanEval.newCyclesDetected.length === 0) {
    cycleTrueNegatives++;
  } else {
    cycleFalsePositives++;
  }

  // Case D: Clean removal of an edge
  const removalBranch = new CounterfactualGraphBranch(BASE_SNAPSHOT, BASE_GRAPH, {
    removedEdges: [
      { from: "src/payments/gateway.ts#processPayment", to: "src/events/bus.ts#EventBus.publish" },
    ],
  });
  const removalEval = removalBranch.evaluate();
  if (removalEval.newCyclesDetected.length === 0) {
    cycleTrueNegatives++;
  } else {
    cycleFalsePositives++;
  }

  const totalCycleReports = cycleTruePositives + cycleFalsePositives;
  const cycleDetectionPrecision =
    totalCycleReports > 0 ? cycleTruePositives / totalCycleReports : 1.0;

  const failures: string[] = [];
  if (meanImpactPrecision < 0.80) {
    failures.push(`Blast Radius Impact Precision ${(meanImpactPrecision * 100).toFixed(2)}% is below threshold 80.0%`);
  }
  if (meanImpactRecall < 0.85) {
    failures.push(`Blast Radius Impact Recall ${(meanImpactRecall * 100).toFixed(2)}% is below threshold 85.0%`);
  }
  if (cycleDetectionPrecision < 1.0) {
    failures.push(`Cycle Detection Precision ${(cycleDetectionPrecision * 100).toFixed(2)}% is below required 100.0%`);
  }

  return {
    meanImpactPrecision: Number(meanImpactPrecision.toFixed(3)),
    meanImpactRecall: Number(meanImpactRecall.toFixed(3)),
    cycleDetectionPrecision: Number(cycleDetectionPrecision.toFixed(3)),
    scenariosEvaluated: scenarioCount,
    cyclesEvaluated: 4,
    passed: failures.length === 0,
    failures,
  };
}

export async function main(): Promise<void> {
  console.log("===============================================================");
  console.log("GraphWard v2.2 - Phase 4 Gate 4: Simulation Accuracy Gate");
  console.log("===============================================================");
  console.log(`Target: ${TARGET_PROJECT}`);
  console.log(`Evaluating Change Simulation & Counterfactual Evaluation...\n`);

  try {
    const result = await runPhase4SimulationBenchmark();

    console.log("Results Summary:");
    console.log("---------------------------------------------------------------");
    console.log(`  Blast Radius Precision : ${(result.meanImpactPrecision * 100).toFixed(2)}%  (Threshold >= 80.0%)  [${result.meanImpactPrecision >= 0.80 ? "PASS" : "FAIL"}]`);
    console.log(`  Blast Radius Recall    : ${(result.meanImpactRecall * 100).toFixed(2)}%  (Threshold >= 85.0%)  [${result.meanImpactRecall >= 0.85 ? "PASS" : "FAIL"}]`);
    console.log(`  Cycle Detection Prec   : ${(result.cycleDetectionPrecision * 100).toFixed(2)}%  (Threshold = 100.0%)  [${result.cycleDetectionPrecision === 1.0 ? "PASS" : "FAIL"}]`);
    console.log("---------------------------------------------------------------");
    console.log(`  Scenarios Evaluated : ${result.scenariosEvaluated} verified patch closures`);
    console.log(`  Branches Tested     : ${result.cyclesEvaluated} counterfactual overlay evaluations\n`);

    if (!result.passed) {
      console.error("❌ GATE 4 FAILED:");
      for (const f of result.failures) {
        console.error(`  - ${f}`);
      }
      process.exit(1);
    }

    console.log("✅ GATE 4 PASSED: All Phase 4 simulation accuracy thresholds met.");
    process.exit(0);
  } catch (err) {
    console.error("❌ GATE 4 ERROR:", err);
    process.exit(1);
  }
}

if (process.argv[1] && (process.argv[1].endsWith("phase4-simulation-accuracy.ts") || process.argv[1].endsWith("phase4-simulation-accuracy.js"))) {
  main();
}
