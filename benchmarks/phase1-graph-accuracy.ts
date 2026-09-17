/**
 * Phase 1 Gate 1: Graph Accuracy Benchmark (benchmarks/phase1-graph-accuracy.ts)
 *
 * Evaluates GraphWard's compiler-confirmed static intelligence against
 * authoritative Static Ground Truth on the complex-backend benchmark suite.
 *
 * Hard Quality Gate Thresholds:
 * - Symbol Precision >= 98%
 * - Symbol Recall    >= 95%
 * - Call Precision   >= 95%
 * - Call Recall      >= 90%
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { TypeScriptCompilerResolver } from "../dist/graph/parsers/typescript-compiler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const TARGET_PROJECT = path.resolve(REPO_ROOT, "benchmark/complex-backend");

// ---------------------------------------------------------------------------
// Static Ground Truth Dataset Definitions
// ---------------------------------------------------------------------------

export interface GroundTruthSymbol {
  file: string;
  qualifiedName: string;
  kind?: string;
}

export interface GroundTruthCall {
  file: string;
  caller: string;
  callee: string; // e.g. "InMemoryTenantDatabase.saveOrder" or "reserveStock"
}

export const STATIC_GROUND_TRUTH_SYMBOLS: GroundTruthSymbol[] = [
  // auth/jwt.ts
  { file: "src/auth/jwt.ts", qualifiedName: "UserSession" },
  { file: "src/auth/jwt.ts", qualifiedName: "signSessionToken" },
  { file: "src/auth/jwt.ts", qualifiedName: "verifySessionToken" },

  // db/client.ts
  { file: "src/db/client.ts", qualifiedName: "InMemoryTenantDatabase" },
  { file: "src/db/client.ts", qualifiedName: "InMemoryTenantDatabase.saveTenant" },
  { file: "src/db/client.ts", qualifiedName: "InMemoryTenantDatabase.getTenant" },
  { file: "src/db/client.ts", qualifiedName: "InMemoryTenantDatabase.saveInventory" },
  { file: "src/db/client.ts", qualifiedName: "InMemoryTenantDatabase.getInventory" },
  { file: "src/db/client.ts", qualifiedName: "InMemoryTenantDatabase.saveOrder" },
  { file: "src/db/client.ts", qualifiedName: "InMemoryTenantDatabase.getOrder" },
  { file: "src/db/client.ts", qualifiedName: "InMemoryTenantDatabase.savePayment" },
  { file: "src/db/client.ts", qualifiedName: "InMemoryTenantDatabase.getPaymentByIdempotency" },
  { file: "src/db/client.ts", qualifiedName: "InMemoryTenantDatabase.registerIdempotencyKey" },
  { file: "src/db/client.ts", qualifiedName: "InMemoryTenantDatabase.clear" },
  { file: "src/db/client.ts", qualifiedName: "InMemoryTenantDatabase.reset" },

  // db/schema.ts
  { file: "src/db/schema.ts", qualifiedName: "OrderStatus" },
  { file: "src/db/schema.ts", qualifiedName: "Tenant" },
  { file: "src/db/schema.ts", qualifiedName: "ProductInventory" },
  { file: "src/db/schema.ts", qualifiedName: "OrderItem" },
  { file: "src/db/schema.ts", qualifiedName: "Order" },
  { file: "src/db/schema.ts", qualifiedName: "PaymentTransaction" },

  // events/bus.ts
  { file: "src/events/bus.ts", qualifiedName: "DomainEvent" },
  { file: "src/events/bus.ts", qualifiedName: "EventHandler" },
  { file: "src/events/bus.ts", qualifiedName: "EventBus" },
  { file: "src/events/bus.ts", qualifiedName: "EventBus.subscribe" },
  { file: "src/events/bus.ts", qualifiedName: "EventBus.publish" },
  { file: "src/events/bus.ts", qualifiedName: "EventBus.clear" },
  { file: "src/events/bus.ts", qualifiedName: "EventBus.events" },
  { file: "src/events/bus.ts", qualifiedName: "EventBus.history" },

  // inventory/stock.ts
  { file: "src/inventory/stock.ts", qualifiedName: "ReservationResult" },
  { file: "src/inventory/stock.ts", qualifiedName: "reserveStock" },
  { file: "src/inventory/stock.ts", qualifiedName: "releaseStock" },

  // orders/service.ts
  { file: "src/orders/service.ts", qualifiedName: "CreateOrderInput" },
  { file: "src/orders/service.ts", qualifiedName: "createAndProcessOrder" },

  // payments/gateway.ts
  { file: "src/payments/gateway.ts", qualifiedName: "ProcessPaymentInput" },
  { file: "src/payments/gateway.ts", qualifiedName: "PaymentResult" },
  { file: "src/payments/gateway.ts", qualifiedName: "processPayment" },
];

export const STATIC_GROUND_TRUTH_CALLS: GroundTruthCall[] = [
  // orders/service.ts
  { file: "src/orders/service.ts", caller: "createAndProcessOrder", callee: "InMemoryTenantDatabase.saveOrder" },
  { file: "src/orders/service.ts", caller: "createAndProcessOrder", callee: "reserveStock" },
  { file: "src/orders/service.ts", caller: "createAndProcessOrder", callee: "releaseStock" },
  { file: "src/orders/service.ts", caller: "createAndProcessOrder", callee: "processPayment" },
  { file: "src/orders/service.ts", caller: "createAndProcessOrder", callee: "EventBus.publish" },

  // inventory/stock.ts
  { file: "src/inventory/stock.ts", caller: "reserveStock", callee: "InMemoryTenantDatabase.getInventory" },
  { file: "src/inventory/stock.ts", caller: "reserveStock", callee: "InMemoryTenantDatabase.saveInventory" },
  { file: "src/inventory/stock.ts", caller: "reserveStock", callee: "EventBus.publish" },
  { file: "src/inventory/stock.ts", caller: "releaseStock", callee: "InMemoryTenantDatabase.getInventory" },
  { file: "src/inventory/stock.ts", caller: "releaseStock", callee: "InMemoryTenantDatabase.saveInventory" },
  { file: "src/inventory/stock.ts", caller: "releaseStock", callee: "EventBus.publish" },

  // events/bus.ts
  { file: "src/events/bus.ts", caller: "EventBus.publish", callee: "handler" },

  // payments/gateway.ts
  { file: "src/payments/gateway.ts", caller: "processPayment", callee: "InMemoryTenantDatabase.getPaymentByIdempotency" },
  { file: "src/payments/gateway.ts", caller: "processPayment", callee: "InMemoryTenantDatabase.savePayment" },
  { file: "src/payments/gateway.ts", caller: "processPayment", callee: "InMemoryTenantDatabase.registerIdempotencyKey" },
  { file: "src/payments/gateway.ts", caller: "processPayment", callee: "EventBus.publish" },

  // db/client.ts
  { file: "src/db/client.ts", caller: "InMemoryTenantDatabase.reset", callee: "InMemoryTenantDatabase.clear" },
];

// ---------------------------------------------------------------------------
// Benchmark Execution & Metric Calculation
// ---------------------------------------------------------------------------

export interface BenchmarkResult {
  symbolPrecision: number;
  symbolRecall: number;
  callPrecision: number;
  callRecall: number;
  extractedSymbolsCount: number;
  expectedSymbolsCount: number;
  extractedCallsCount: number;
  uniqueExtractedCallsCount: number;
  expectedCallsCount: number;
  passed: boolean;
  failures: string[];
}

export async function runPhase1AccuracyBenchmark(projectRoot: string = TARGET_PROJECT): Promise<BenchmarkResult> {
  const resolver = new TypeScriptCompilerResolver(projectRoot);
  const ready = await resolver.initialize();
  if (!ready) {
    throw new Error(`Failed to initialize TypeScriptCompilerResolver for ${projectRoot}`);
  }

  const files = [
    "src/auth/jwt.ts",
    "src/db/client.ts",
    "src/db/schema.ts",
    "src/events/bus.ts",
    "src/inventory/stock.ts",
    "src/orders/service.ts",
    "src/payments/gateway.ts",
  ];

  const extractedSymbols: Array<{ file: string; qualifiedName: string }> = [];
  const extractedCalls: Array<{ file: string; caller: string; callee: string }> = [];

  for (const file of files) {
    const analysis = await resolver.analyzeFile(file);
    for (const sym of analysis.symbols) {
      extractedSymbols.push({
        file,
        qualifiedName: sym.qualifiedName,
      });
    }

    for (const c of analysis.calls) {
      if (c.resolvedTarget && !c.resolvedTarget.isExternal && !c.resolvedTarget.isBuiltin) {
        extractedCalls.push({
          file,
          caller: c.callerSymbol,
          callee: c.resolvedTarget.qualifiedName,
        });
      }
    }
  }

  // --- Symbol Metrics ---
  const expectedSymKeys = new Set(STATIC_GROUND_TRUTH_SYMBOLS.map((s) => `${s.file}#${s.qualifiedName}`));
  const extractedSymKeys = new Set(extractedSymbols.map((s) => `${s.file}#${s.qualifiedName}`));

  let tpSymbols = 0;
  let fpSymbols = 0;
  for (const symKey of extractedSymKeys) {
    if (expectedSymKeys.has(symKey)) {
      tpSymbols++;
    } else {
      fpSymbols++;
    }
  }
  let fnSymbols = 0;
  for (const expKey of expectedSymKeys) {
    if (!extractedSymKeys.has(expKey)) {
      fnSymbols++;
    }
  }

  const symbolPrecision = tpSymbols / (tpSymbols + fpSymbols || 1);
  const symbolRecall = tpSymbols / (tpSymbols + fnSymbols || 1);

  // --- Call Metrics ---
  const expectedCallKeys = new Set(STATIC_GROUND_TRUTH_CALLS.map((c) => `${c.file}:${c.caller}->${c.callee}`));
  const extractedCallKeys = new Set(extractedCalls.map((c) => `${c.file}:${c.caller}->${c.callee}`));

  let tpCalls = 0;
  let fpCalls = 0;
  for (const callKey of extractedCallKeys) {
    if (expectedCallKeys.has(callKey)) {
      tpCalls++;
    } else {
      fpCalls++;
    }
  }

  let fnCalls = 0;
  for (const expCall of expectedCallKeys) {
    if (!extractedCallKeys.has(expCall)) {
      fnCalls++;
    }
  }

  const callPrecision = tpCalls / (tpCalls + fpCalls || 1);
  const callRecall = tpCalls / (tpCalls + fnCalls || 1);

  // --- Gate Evaluation ---
  const failures: string[] = [];
  if (symbolPrecision < 0.98) {
    failures.push(`Symbol Precision ${(symbolPrecision * 100).toFixed(2)}% is below threshold 98.0%`);
  }
  if (symbolRecall < 0.95) {
    failures.push(`Symbol Recall ${(symbolRecall * 100).toFixed(2)}% is below threshold 95.0%`);
  }
  if (callPrecision < 0.95) {
    failures.push(`Call Precision ${(callPrecision * 100).toFixed(2)}% is below threshold 95.0%`);
  }
  if (callRecall < 0.90) {
    failures.push(`Call Recall ${(callRecall * 100).toFixed(2)}% is below threshold 90.0%`);
  }

  return {
    symbolPrecision,
    symbolRecall,
    callPrecision,
    callRecall,
    extractedSymbolsCount: extractedSymbols.length,
    expectedSymbolsCount: STATIC_GROUND_TRUTH_SYMBOLS.length,
    extractedCallsCount: extractedCalls.length,
    uniqueExtractedCallsCount: extractedCallKeys.size,
    expectedCallsCount: STATIC_GROUND_TRUTH_CALLS.length,
    passed: failures.length === 0,
    failures,
  };
}

// ---------------------------------------------------------------------------
// CLI Execution Entry Point
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  console.log("===============================================================");
  console.log("GraphWard v2.2 - Phase 1 Gate 1: Graph Accuracy Gate");
  console.log("===============================================================");
  console.log(`Target: ${TARGET_PROJECT}`);
  console.log(`Evaluating against Static Ground Truth...\n`);

  try {
    const result = await runPhase1AccuracyBenchmark();

    console.log("Results Summary:");
    console.log("---------------------------------------------------------------");
    console.log(`  Symbol Resolution Precision : ${(result.symbolPrecision * 100).toFixed(2)}%  (Threshold >= 98.0%)  [${result.symbolPrecision >= 0.98 ? "PASS" : "FAIL"}]`);
    console.log(`  Symbol Resolution Recall    : ${(result.symbolRecall * 100).toFixed(2)}%  (Threshold >= 95.0%)  [${result.symbolRecall >= 0.95 ? "PASS" : "FAIL"}]`);
    console.log(`  Call Graph Precision        : ${(result.callPrecision * 100).toFixed(2)}%  (Threshold >= 95.0%)  [${result.callPrecision >= 0.95 ? "PASS" : "FAIL"}]`);
    console.log(`  Call Graph Recall           : ${(result.callRecall * 100).toFixed(2)}%  (Threshold >= 90.0%)  [${result.callRecall >= 0.90 ? "PASS" : "FAIL"}]`);
    console.log("---------------------------------------------------------------");
    console.log(`  Symbols Evaluated : ${result.extractedSymbolsCount} extracted / ${result.expectedSymbolsCount} ground truth`);
    console.log(`  Calls Evaluated   : ${result.extractedCallsCount} extracted (${result.uniqueExtractedCallsCount} unique edges) / ${result.expectedCallsCount} ground truth\n`);

    if (!result.passed) {
      console.error("❌ GATE 1 FAILED:");
      for (const f of result.failures) {
        console.error(`  - ${f}`);
      }
      process.exit(1);
    }

    console.log("✅ GATE 1 PASSED: All Phase 1 graph accuracy thresholds met.");
    process.exit(0);
  } catch (err) {
    console.error("❌ GATE 1 ERROR:", err);
    process.exit(1);
  }
}

if (process.argv[1] && (process.argv[1].endsWith("phase1-graph-accuracy.ts") || process.argv[1].endsWith("phase1-graph-accuracy.js"))) {
  main();
}
