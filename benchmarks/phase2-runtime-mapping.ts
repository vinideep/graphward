/**
 * Phase 2 Gate 2: Runtime Mapping Benchmark (benchmarks/phase2-runtime-mapping.ts)
 *
 * Evaluates GraphWard's Runtime Identity Resolver and Trace Aggregator
 * against authoritative Runtime Ground Truth on the complex-backend suite.
 *
 * Hard Quality Gate Thresholds:
 * - Runtime -> Source Resolution Accuracy >= 99.0%
 * - False Mapping Rate                    <= 1.0%
 * - Trace Aggregation Overhead            <= 5.0%
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SymbolId } from "../dist/graph/symbol-identity.js";
import {
  RuntimeSymbolResolver,
  type RuntimeFrame,
  type SourceMapEntry,
} from "../dist/runtime/symbol-resolver.js";
import {
  ExecutionFlowTracker,
} from "../dist/runtime/execution-flow.js";
import {
  TracePrivacyPolicy,
} from "../dist/runtime/privacy-policy.js";
import {
  RuntimeTracer,
} from "../dist/runtime/tracer.js";
import {
  OtlpTraceReceiver,
} from "../dist/runtime/otlp-receiver.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const TARGET_PROJECT = path.resolve(REPO_ROOT, "benchmark/complex-backend");

// ---------------------------------------------------------------------------
// Runtime Ground Truth Dataset Definitions
// ---------------------------------------------------------------------------

export interface RuntimeTestCase {
  frame: RuntimeFrame;
  expectedStatus: "RESOLVED" | "AMBIGUOUS" | "UNRESOLVED";
  expectedSymbolKey?: string; // file#qualifiedName
  description: string;
}

const COMPLEX_BACKEND_SYMBOLS: SymbolId[] = [
  // orders
  {
    repository: "default",
    package: "complex-backend",
    language: "typescript",
    path: "src/orders/service.ts",
    qualifiedName: "createAndProcessOrder",
    declarationHash: "hash_order_1",
    origin: "SOURCE",
  },
  {
    repository: "default",
    package: "complex-backend",
    language: "typescript",
    path: "src/orders/service.ts",
    qualifiedName: "CreateOrderInput",
    declarationHash: "hash_order_2",
    origin: "SOURCE",
  },
  // payments
  {
    repository: "default",
    package: "complex-backend",
    language: "typescript",
    path: "src/payments/gateway.ts",
    qualifiedName: "processPayment",
    declarationHash: "hash_pay_1",
    origin: "SOURCE",
  },
  {
    repository: "default",
    package: "complex-backend",
    language: "typescript",
    path: "src/payments/gateway.ts",
    qualifiedName: "PaymentResult",
    declarationHash: "hash_pay_2",
    origin: "SOURCE",
  },
  // inventory
  {
    repository: "default",
    package: "complex-backend",
    language: "typescript",
    path: "src/inventory/stock.ts",
    qualifiedName: "reserveStock",
    declarationHash: "hash_inv_1",
    origin: "SOURCE",
  },
  {
    repository: "default",
    package: "complex-backend",
    language: "typescript",
    path: "src/inventory/stock.ts",
    qualifiedName: "releaseStock",
    declarationHash: "hash_inv_2",
    origin: "SOURCE",
  },
  // db client
  {
    repository: "default",
    package: "complex-backend",
    language: "typescript",
    path: "src/db/client.ts",
    qualifiedName: "InMemoryTenantDatabase.saveOrder",
    declarationHash: "hash_db_1",
    origin: "SOURCE",
  },
  {
    repository: "default",
    package: "complex-backend",
    language: "typescript",
    path: "src/db/client.ts",
    qualifiedName: "InMemoryTenantDatabase.saveInventory",
    declarationHash: "hash_db_2",
    origin: "SOURCE",
  },
  {
    repository: "default",
    package: "complex-backend",
    language: "typescript",
    path: "src/db/client.ts",
    qualifiedName: "InMemoryTenantDatabase.getInventory",
    declarationHash: "hash_db_3",
    origin: "SOURCE",
  },
  {
    repository: "default",
    package: "complex-backend",
    language: "typescript",
    path: "src/db/client.ts",
    qualifiedName: "InMemoryTenantDatabase.clear",
    declarationHash: "hash_db_4",
    origin: "SOURCE",
  },
  // events bus
  {
    repository: "default",
    package: "complex-backend",
    language: "typescript",
    path: "src/events/bus.ts",
    qualifiedName: "EventBus.publish",
    declarationHash: "hash_bus_1",
    origin: "SOURCE",
  },
  {
    repository: "default",
    package: "complex-backend",
    language: "typescript",
    path: "src/events/bus.ts",
    qualifiedName: "EventBus.subscribe",
    declarationHash: "hash_bus_2",
    origin: "SOURCE",
  },
  // auth
  {
    repository: "default",
    package: "complex-backend",
    language: "typescript",
    path: "src/auth/jwt.ts",
    qualifiedName: "verifySessionToken",
    declarationHash: "hash_jwt_1",
    origin: "SOURCE",
  },
  {
    repository: "default",
    package: "complex-backend",
    language: "typescript",
    path: "src/auth/jwt.ts",
    qualifiedName: "signSessionToken",
    declarationHash: "hash_jwt_2",
    origin: "SOURCE",
  },
];

const SOURCE_MAP_FIXTURES: SourceMapEntry[] = [
  {
    genLine: 18492,
    genColumn: 12,
    sourceFile: "src/payments/gateway.ts",
    sourceLine: 24,
    sourceColumn: 0,
    symbolName: "processPayment",
  },
  {
    genLine: 18550,
    genColumn: 4,
    sourceFile: "src/orders/service.ts",
    sourceLine: 15,
    sourceColumn: 0,
    symbolName: "createAndProcessOrder",
  },
  {
    genLine: 18600,
    genColumn: 8,
    sourceFile: "src/inventory/stock.ts",
    sourceLine: 12,
    sourceColumn: 0,
    symbolName: "reserveStock",
  },
  {
    genLine: 18650,
    genColumn: 8,
    sourceFile: "src/inventory/stock.ts",
    sourceLine: 35,
    sourceColumn: 0,
    symbolName: "releaseStock",
  },
  {
    genLine: 18700,
    genColumn: 2,
    sourceFile: "src/events/bus.ts",
    sourceLine: 18,
    sourceColumn: 0,
    symbolName: "EventBus.publish",
  },
];

export const RUNTIME_GROUND_TRUTH_CASES: RuntimeTestCase[] = [
  // 1. Source map exact matches from minified bundle
  {
    frame: { file: "dist/bundle.min.js", line: 18492, column: 12 },
    expectedStatus: "RESOLVED",
    expectedSymbolKey: "src/payments/gateway.ts#processPayment",
    description: "Minified bundle frame mapped via exact sourcemap coordinates",
  },
  {
    frame: { file: "dist/bundle.min.js", line: 18550, column: 4 },
    expectedStatus: "RESOLVED",
    expectedSymbolKey: "src/orders/service.ts#createAndProcessOrder",
    description: "Bundle frame mapped to order service entrypoint",
  },
  {
    frame: { file: "dist/bundle.min.js", line: 18600, column: 8 },
    expectedStatus: "RESOLVED",
    expectedSymbolKey: "src/inventory/stock.ts#reserveStock",
    description: "Bundle frame mapped to inventory reserveStock",
  },

  // 2. Dist file remapping (dist/orders/service.js -> src/orders/service.ts)
  {
    frame: { file: "dist/orders/service.js", line: 15, functionName: "createAndProcessOrder" },
    expectedStatus: "RESOLVED",
    expectedSymbolKey: "src/orders/service.ts#createAndProcessOrder",
    description: "Compiled dist JS file mapped to TypeScript source symbol via function name",
  },
  {
    frame: { file: "dist/payments/gateway.js", line: 20, functionName: "processPayment" },
    expectedStatus: "RESOLVED",
    expectedSymbolKey: "src/payments/gateway.ts#processPayment",
    description: "Payment gateway dist JS mapped to TypeScript payment function",
  },
  {
    frame: { file: "dist/auth/jwt.js", line: 10, functionName: "verifySessionToken" },
    expectedStatus: "RESOLVED",
    expectedSymbolKey: "src/auth/jwt.ts#verifySessionToken",
    description: "Auth JWT dist JS mapped to session verification function",
  },
  {
    frame: { file: "dist/events/bus.js", line: 8, functionName: "publish" },
    expectedStatus: "RESOLVED",
    expectedSymbolKey: "src/events/bus.ts#EventBus.publish",
    description: "Event bus method call mapped to EventBus.publish",
  },

  // 3. Direct source frame resolution
  {
    frame: { file: "src/inventory/stock.ts", line: 14, functionName: "reserveStock" },
    expectedStatus: "RESOLVED",
    expectedSymbolKey: "src/inventory/stock.ts#reserveStock",
    description: "Direct TypeScript source frame resolution",
  },
  {
    frame: { file: "src/db/client.ts", line: 45, functionName: "saveOrder" },
    expectedStatus: "RESOLVED",
    expectedSymbolKey: "src/db/client.ts#InMemoryTenantDatabase.saveOrder",
    description: "Database client method resolution",
  },

  // 4. Ambiguity Scoring Cases: Function name with no file hint or multiple candidates
  {
    frame: { file: "unknown_vendor.js", functionName: "nonExistentMethodXYZ" },
    expectedStatus: "UNRESOLVED",
    description: "Non-existent foreign method correctly classified as UNRESOLVED",
  },
  {
    frame: { file: "dist/bogus_file_123.js", line: 9999 },
    expectedStatus: "UNRESOLVED",
    description: "Bogus generated line correctly classified as UNRESOLVED without hallucination",
  },
  {
    frame: { file: "node_modules/express/lib/router/layer.js", line: 95, functionName: "handle_request" },
    expectedStatus: "UNRESOLVED",
    description: "Third-party node_modules internal correctly left UNRESOLVED",
  },
];

export interface Phase2BenchmarkResult {
  accuracy: number;
  falseMappingRate: number;
  overheadPct: number;
  totalEvaluated: number;
  correctlyResolved: number;
  falsePositives: number;
  traceSpansProcessed: number;
  durationMs: number;
  passed: boolean;
  failures: string[];
}

export async function runPhase2RuntimeBenchmark(): Promise<Phase2BenchmarkResult> {
  const resolver = new RuntimeSymbolResolver(TARGET_PROJECT);
  resolver.registerSymbols(COMPLEX_BACKEND_SYMBOLS);
  resolver.registerSourceMap("dist/bundle.min.js", SOURCE_MAP_FIXTURES);

  let correctCount = 0;
  let falsePositiveCount = 0;
  const failures: string[] = [];

  for (const testCase of RUNTIME_GROUND_TRUTH_CASES) {
    const result = resolver.resolve(testCase.frame);

    const statusMatch = result.status === testCase.expectedStatus;
    let symbolMatch = true;

    if (testCase.expectedStatus === "RESOLVED") {
      const resKey = result.resolvedSymbol
        ? `${result.resolvedSymbol.path}#${result.resolvedSymbol.qualifiedName}`
        : "";
      if (resKey !== testCase.expectedSymbolKey) {
        symbolMatch = false;
      }
    }

    if (testCase.expectedStatus === "UNRESOLVED" && result.status === "RESOLVED") {
      falsePositiveCount++;
    }

    if (statusMatch && symbolMatch) {
      correctCount++;
    } else {
      failures.push(
        `Case failed: "${testCase.description}". Expected [${testCase.expectedStatus} ${testCase.expectedSymbolKey ?? ""}], got [${result.status} ${result.resolvedSymbol ? `${result.resolvedSymbol.path}#${result.resolvedSymbol.qualifiedName}` : "none"}]`
      );
    }
  }

  const accuracy = correctCount / RUNTIME_GROUND_TRUTH_CASES.length;
  const falseMappingRate = falsePositiveCount / RUNTIME_GROUND_TRUTH_CASES.length;

  // -------------------------------------------------------------------------
  // Trace Aggregation Overhead Measurement (10,000 synthetic spans)
  // -------------------------------------------------------------------------
  const privacyPolicy = new TracePrivacyPolicy({
    redactSecrets: true,
    redactPii: true,
    stripHeaders: ["authorization", "cookie"],
    environmentAllowlist: ["dev", "test"],
  });

  const tracer = new RuntimeTracer("MODE_A_OTEL", {
    maxSpansPerSec: 50000,
    maxTraceStorageBytes: 100 * 1024 * 1024,
    maxOverheadPct: 5.0,
  }, privacyPolicy);

  const flowTracker = new ExecutionFlowTracker();
  const receiver = new OtlpTraceReceiver(resolver, tracer, flowTracker, privacyPolicy);

  const SPAN_COUNT = 10000;
  const spans: any[] = [];
  for (let i = 0; i < SPAN_COUNT; i++) {
    spans.push({
      traceId: `trace_${Math.floor(i / 2)}`,
      spanId: `span_${i}`,
      parentSpanId: i % 2 === 1 ? `span_${i - 1}` : undefined,
      name: i % 2 === 0 ? "createAndProcessOrder" : "processPayment",
      startTimeUnixNano: `${BigInt(1000000) * BigInt(i)}`,
      endTimeUnixNano: `${BigInt(1000000) * BigInt(i) + BigInt(2000000)}`, // 2ms duration
      attributes: [
        { key: "code.filepath", value: { stringValue: i % 2 === 0 ? "dist/orders/service.js" : "dist/payments/gateway.js" } },
        { key: "code.function", value: { stringValue: i % 2 === 0 ? "createAndProcessOrder" : "processPayment" } },
        { key: "http.route", value: { stringValue: "/api/v1/orders" } },
        { key: "test.suite", value: { stringValue: "orders.e2e.test.ts" } },
        { key: "authorization", value: { stringValue: "Bearer secret_token_12345" } }, // must be stripped
      ],
    });
  }

  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: "environment", value: { stringValue: "test" } }],
        },
        scopeSpans: [{ spans }],
      },
    ],
  };

  const startTime = performance.now();
  const summary = receiver.ingestPayload(payload);
  const durationMs = performance.now() - startTime;

  // Baseline simulated execution duration of the spans: 10000 spans * 2ms = 20,000ms
  const simulatedExecutionDurationMs = SPAN_COUNT * 2.0;
  const overheadPct = (durationMs / simulatedExecutionDurationMs) * 100;

  // Verify Quality Gate Thresholds
  const gateFailures: string[] = [];
  if (accuracy < 0.99) {
    gateFailures.push(`Resolution Accuracy ${(accuracy * 100).toFixed(2)}% is below threshold 99.0%`);
  }
  if (falseMappingRate > 0.01) {
    gateFailures.push(`False Mapping Rate ${(falseMappingRate * 100).toFixed(2)}% exceeds threshold 1.0%`);
  }
  if (overheadPct > 5.0) {
    gateFailures.push(`Aggregation Overhead ${overheadPct.toFixed(2)}% exceeds ceiling 5.0%`);
  }

  return {
    accuracy,
    falseMappingRate,
    overheadPct: Number(overheadPct.toFixed(2)),
    totalEvaluated: RUNTIME_GROUND_TRUTH_CASES.length,
    correctlyResolved: correctCount,
    falsePositives: falsePositiveCount,
    traceSpansProcessed: summary.acceptedSpans,
    durationMs: Number(durationMs.toFixed(2)),
    passed: gateFailures.length === 0,
    failures: [...failures, ...gateFailures],
  };
}

export async function main(): Promise<void> {
  console.log("===============================================================");
  console.log("GraphWard v2.2 - Phase 2 Gate 2: Runtime Mapping Gate");
  console.log("===============================================================");
  console.log(`Target: ${TARGET_PROJECT}`);
  console.log(`Evaluating against Runtime Ground Truth...\n`);

  try {
    const result = await runPhase2RuntimeBenchmark();

    console.log("Results Summary:");
    console.log("---------------------------------------------------------------");
    console.log(`  Resolution Accuracy      : ${(result.accuracy * 100).toFixed(2)}%  (Threshold >= 99.0%)  [${result.accuracy >= 0.99 ? "PASS" : "FAIL"}]`);
    console.log(`  False Mapping Rate       : ${(result.falseMappingRate * 100).toFixed(2)}%  (Threshold <= 1.0%)   [${result.falseMappingRate <= 0.01 ? "PASS" : "FAIL"}]`);
    console.log(`  Trace Aggregation Overhead: ${result.overheadPct.toFixed(2)}%   (Threshold <= 5.0%)   [${result.overheadPct <= 5.0 ? "PASS" : "FAIL"}]`);
    console.log("---------------------------------------------------------------");
    console.log(`  Frames Evaluated  : ${result.correctlyResolved} / ${result.totalEvaluated} correct`);
    console.log(`  Spans Processed   : ${result.traceSpansProcessed} in ${result.durationMs}ms\n`);

    if (!result.passed) {
      console.error("❌ GATE 2 FAILED:");
      for (const f of result.failures) {
        console.error(`  - ${f}`);
      }
      process.exit(1);
    }

    console.log("✅ GATE 2 PASSED: All Phase 2 runtime mapping thresholds met.");
    process.exit(0);
  } catch (err) {
    console.error("❌ GATE 2 ERROR:", err);
    process.exit(1);
  }
}

if (process.argv[1] && (process.argv[1].endsWith("phase2-runtime-mapping.ts") || process.argv[1].endsWith("phase2-runtime-mapping.js"))) {
  main();
}
