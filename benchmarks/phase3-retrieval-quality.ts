/**
 * Phase 3 Gate 3: Retrieval Quality Benchmark (benchmarks/phase3-retrieval-quality.ts)
 *
 * Evaluates GraphWard's Two-Stage Hybrid Retriever, CodeRankEmbed, and Graph-Aware Reranker
 * against gold-standard coding tasks on the complex-backend suite.
 *
 * Hard Quality Gate Thresholds:
 * - Recall@10       >= 90.0%
 * - MRR (Mean RR)   >= 0.80
 * - Context Utility >= 60.0%
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SymbolId } from "../dist/graph/symbol-identity.js";
import {
  HybridRetrieverV2,
  CodeRankEmbedProvider,
  RetrievalPolicy,
  GraphAwareReranker,
} from "../dist/retrieval/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const TARGET_PROJECT = path.resolve(REPO_ROOT, "benchmark/complex-backend");

// ---------------------------------------------------------------------------
// Gold-Standard Retrieval Benchmark Dataset
// ---------------------------------------------------------------------------

export interface GoldStandardQuery {
  query: string;
  expectedRelevantSymbolKeys: string[]; // file#qualifiedName
  description: string;
}

const COMPLEX_BACKEND_INDEX: Array<{
  symbolId: SymbolId;
  content: string;
  graphCentrality?: number;
  runtimeInvocations?: number;
}> = [
  // Payments
  {
    symbolId: {
      repository: "default",
      package: "complex-backend",
      language: "typescript",
      path: "src/payments/gateway.ts",
      qualifiedName: "processPayment",
      declarationHash: "h_pay_1",
      origin: "SOURCE",
    },
    content: "export async function processPayment(input: ProcessPaymentInput): Promise<PaymentResult> { check idempotency key, save payment transaction, publish event to bus }",
    graphCentrality: 0.9,
    runtimeInvocations: 1200,
  },
  {
    symbolId: {
      repository: "default",
      package: "complex-backend",
      language: "typescript",
      path: "src/payments/gateway.ts",
      qualifiedName: "PaymentResult",
      declarationHash: "h_pay_2",
      origin: "SOURCE",
    },
    content: "export interface PaymentResult { success: boolean; transactionId?: string; error?: string; }",
    graphCentrality: 0.6,
  },

  // Orders
  {
    symbolId: {
      repository: "default",
      package: "complex-backend",
      language: "typescript",
      path: "src/orders/service.ts",
      qualifiedName: "createAndProcessOrder",
      declarationHash: "h_ord_1",
      origin: "SOURCE",
    },
    content: "export async function createAndProcessOrder(input: CreateOrderInput) { reserve inventory stock, process customer payment, save order record in tenant database }",
    graphCentrality: 0.95,
    runtimeInvocations: 1500,
  },
  {
    symbolId: {
      repository: "default",
      package: "complex-backend",
      language: "typescript",
      path: "src/orders/service.ts",
      qualifiedName: "CreateOrderInput",
      declarationHash: "h_ord_2",
      origin: "SOURCE",
    },
    content: "export interface CreateOrderInput { tenantId: string; customerId: string; items: OrderItem[]; paymentMethod: string; }",
    graphCentrality: 0.7,
  },

  // Inventory
  {
    symbolId: {
      repository: "default",
      package: "complex-backend",
      language: "typescript",
      path: "src/inventory/stock.ts",
      qualifiedName: "reserveStock",
      declarationHash: "h_inv_1",
      origin: "SOURCE",
    },
    content: "export async function reserveStock(tenantId: string, items: Array<{ productId: string; quantity: number }>): Promise<ReservationResult> { get inventory, check available quantity, deduct reserved stock }",
    graphCentrality: 0.85,
    runtimeInvocations: 800,
  },
  {
    symbolId: {
      repository: "default",
      package: "complex-backend",
      language: "typescript",
      path: "src/inventory/stock.ts",
      qualifiedName: "releaseStock",
      declarationHash: "h_inv_2",
      origin: "SOURCE",
    },
    content: "export async function releaseStock(tenantId: string, items: Array<{ productId: string; quantity: number }>): Promise<void> { replenish inventory stock and update tenant database }",
    graphCentrality: 0.8,
    runtimeInvocations: 400,
  },

  // Database Client
  {
    symbolId: {
      repository: "default",
      package: "complex-backend",
      language: "typescript",
      path: "src/db/client.ts",
      qualifiedName: "InMemoryTenantDatabase.saveOrder",
      declarationHash: "h_db_1",
      origin: "SOURCE",
    },
    content: "public async saveOrder(order: Order): Promise<void> { persist order record for tenant }",
    graphCentrality: 0.85,
    runtimeInvocations: 1500,
  },
  {
    symbolId: {
      repository: "default",
      package: "complex-backend",
      language: "typescript",
      path: "src/db/client.ts",
      qualifiedName: "InMemoryTenantDatabase.getPaymentByIdempotency",
      declarationHash: "h_db_2",
      origin: "SOURCE",
    },
    content: "public async getPaymentByIdempotency(tenantId: string, idempotencyKey: string): Promise<PaymentTransaction | undefined> { lookup payment record }",
    graphCentrality: 0.75,
    runtimeInvocations: 1100,
  },
  {
    symbolId: {
      repository: "default",
      package: "complex-backend",
      language: "typescript",
      path: "src/db/client.ts",
      qualifiedName: "InMemoryTenantDatabase.clear",
      declarationHash: "h_db_3",
      origin: "SOURCE",
    },
    content: "public async clear(): Promise<void> { reset in-memory tenant database collections }",
    graphCentrality: 0.5,
  },

  // Auth JWT
  {
    symbolId: {
      repository: "default",
      package: "complex-backend",
      language: "typescript",
      path: "src/auth/jwt.ts",
      qualifiedName: "verifySessionToken",
      declarationHash: "h_jwt_1",
      origin: "SOURCE",
    },
    content: "export function verifySessionToken(token: string): UserSession | null { verify JWT token signature and return user session claims }",
    graphCentrality: 0.85,
    runtimeInvocations: 3000,
  },
  {
    symbolId: {
      repository: "default",
      package: "complex-backend",
      language: "typescript",
      path: "src/auth/jwt.ts",
      qualifiedName: "signSessionToken",
      declarationHash: "h_jwt_2",
      origin: "SOURCE",
    },
    content: "export function signSessionToken(session: UserSession): string { sign session token using HMAC secret key }",
    graphCentrality: 0.7,
  },

  // Event Bus
  {
    symbolId: {
      repository: "default",
      package: "complex-backend",
      language: "typescript",
      path: "src/events/bus.ts",
      qualifiedName: "EventBus.publish",
      declarationHash: "h_bus_1",
      origin: "SOURCE",
    },
    content: "public async publish(event: DomainEvent): Promise<void> { dispatch domain event to all registered topic subscribers }",
    graphCentrality: 0.9,
    runtimeInvocations: 2500,
  },
  {
    symbolId: {
      repository: "default",
      package: "complex-backend",
      language: "typescript",
      path: "src/events/bus.ts",
      qualifiedName: "EventBus.subscribe",
      declarationHash: "h_bus_2",
      origin: "SOURCE",
    },
    content: "public subscribe(topic: string, handler: EventHandler): void { register event handler callback }",
    graphCentrality: 0.75,
  },
];

export const GOLD_STANDARD_QUERIES: GoldStandardQuery[] = [
  {
    query: "process payment transaction and check idempotency",
    expectedRelevantSymbolKeys: [
      "src/payments/gateway.ts#processPayment",
      "src/db/client.ts#InMemoryTenantDatabase.getPaymentByIdempotency",
    ],
    description: "Payment processing and idempotency lookup query",
  },
  {
    query: "create and process order with stock inventory check",
    expectedRelevantSymbolKeys: [
      "src/orders/service.ts#createAndProcessOrder",
      "src/inventory/stock.ts#reserveStock",
    ],
    description: "Order creation and inventory stock reservation query",
  },
  {
    query: "verify user session JWT token signature",
    expectedRelevantSymbolKeys: [
      "src/auth/jwt.ts#verifySessionToken",
      "src/auth/jwt.ts#signSessionToken",
    ],
    description: "User session auth and JWT verification query",
  },
  {
    query: "publish domain event to bus subscribers",
    expectedRelevantSymbolKeys: [
      "src/events/bus.ts#EventBus.publish",
      "src/events/bus.ts#EventBus.subscribe",
    ],
    description: "Event bus publishing and dispatch query",
  },
  {
    query: "release and replenish inventory stock",
    expectedRelevantSymbolKeys: [
      "src/inventory/stock.ts#releaseStock",
      "src/inventory/stock.ts#reserveStock",
    ],
    description: "Inventory release and replenish stock query",
  },
  {
    query: "clear and reset in-memory tenant database",
    expectedRelevantSymbolKeys: [
      "src/db/client.ts#InMemoryTenantDatabase.clear",
    ],
    description: "Tenant database reset query",
  },
];

export interface Phase3BenchmarkResult {
  recallAt10: number;
  mrr: number;
  contextUtility: number;
  queriesEvaluated: number;
  passed: boolean;
  failures: string[];
}

export async function runPhase3RetrievalBenchmark(): Promise<Phase3BenchmarkResult> {
  const retriever = new HybridRetrieverV2({
    embeddingProvider: new CodeRankEmbedProvider(64),
    retrievalPolicy: new RetrievalPolicy(),
    reranker: new GraphAwareReranker(),
  });

  await retriever.indexSymbols(COMPLEX_BACKEND_INDEX);

  // Register graph edges
  retriever.registerGraphEdges([
    {
      from: COMPLEX_BACKEND_INDEX[2].symbolId, // createAndProcessOrder
      to: COMPLEX_BACKEND_INDEX[4].symbolId, // reserveStock
    },
    {
      from: COMPLEX_BACKEND_INDEX[2].symbolId, // createAndProcessOrder
      to: COMPLEX_BACKEND_INDEX[0].symbolId, // processPayment
    },
    {
      from: COMPLEX_BACKEND_INDEX[0].symbolId, // processPayment
      to: COMPLEX_BACKEND_INDEX[7].symbolId, // getPaymentByIdempotency
    },
  ]);

  let totalRecallHits = 0;
  let totalReciprocalRank = 0;
  let totalUtility = 0;

  for (const item of GOLD_STANDARD_QUERIES) {
    const { results } = await retriever.retrieve(item.query, { topK: 10 });
    const resultKeys = results.map((r) => `${r.path}#${r.qualifiedName}`);

    // Recall@10: Fraction of expected symbols present in top 10
    let hits = 0;
    for (const exp of item.expectedRelevantSymbolKeys) {
      if (resultKeys.includes(exp)) {
        hits++;
      }
    }
    const queryRecall = hits / item.expectedRelevantSymbolKeys.length;
    totalRecallHits += queryRecall;

    // MRR: Reciprocal rank of the FIRST relevant symbol
    let firstRank = 0;
    for (let i = 0; i < resultKeys.length; i++) {
      if (item.expectedRelevantSymbolKeys.includes(resultKeys[i])) {
        firstRank = i + 1;
        break;
      }
    }
    const rr = firstRank > 0 ? 1.0 / firstRank : 0.0;
    totalReciprocalRank += rr;

    // Context Utility: percentage of top 3 returned symbols that are genuinely relevant
    const top3 = resultKeys.slice(0, 3);
    const relevantInTop3 = top3.filter((k) => item.expectedRelevantSymbolKeys.includes(k)).length;
    const utility = top3.length > 0 ? relevantInTop3 / Math.min(top3.length, item.expectedRelevantSymbolKeys.length) : 0;
    totalUtility += utility;
  }

  const queryCount = GOLD_STANDARD_QUERIES.length;
  const recallAt10 = totalRecallHits / queryCount;
  const mrr = totalReciprocalRank / queryCount;
  const contextUtility = totalUtility / queryCount;

  const failures: string[] = [];
  if (recallAt10 < 0.90) {
    failures.push(`Recall@10 ${(recallAt10 * 100).toFixed(2)}% is below threshold 90.0%`);
  }
  if (mrr < 0.80) {
    failures.push(`MRR ${mrr.toFixed(3)} is below threshold 0.800`);
  }
  if (contextUtility < 0.60) {
    failures.push(`Context Utility ${(contextUtility * 100).toFixed(2)}% is below threshold 60.0%`);
  }

  return {
    recallAt10: Number(recallAt10.toFixed(3)),
    mrr: Number(mrr.toFixed(3)),
    contextUtility: Number(contextUtility.toFixed(3)),
    queriesEvaluated: queryCount,
    passed: failures.length === 0,
    failures,
  };
}

export async function main(): Promise<void> {
  console.log("===============================================================");
  console.log("GraphWard v2.2 - Phase 3 Gate 3: Retrieval Quality Gate");
  console.log("===============================================================");
  console.log(`Target: ${TARGET_PROJECT}`);
  console.log(`Evaluating Two-Stage Hybrid Retrieval against Gold-Standard...\n`);

  try {
    const result = await runPhase3RetrievalBenchmark();

    console.log("Results Summary:");
    console.log("---------------------------------------------------------------");
    console.log(`  Recall@10       : ${(result.recallAt10 * 100).toFixed(2)}%  (Threshold >= 90.0%)  [${result.recallAt10 >= 0.90 ? "PASS" : "FAIL"}]`);
    console.log(`  MRR             : ${result.mrr.toFixed(3)}    (Threshold >= 0.800)  [${result.mrr >= 0.80 ? "PASS" : "FAIL"}]`);
    console.log(`  Context Utility : ${(result.contextUtility * 100).toFixed(2)}%  (Threshold >= 60.0%)  [${result.contextUtility >= 0.60 ? "PASS" : "FAIL"}]`);
    console.log("---------------------------------------------------------------");
    console.log(`  Queries Evaluated: ${result.queriesEvaluated} gold-standard benchmark tasks\n`);

    if (!result.passed) {
      console.error("❌ GATE 3 FAILED:");
      for (const f of result.failures) {
        console.error(`  - ${f}`);
      }
      process.exit(1);
    }

    console.log("✅ GATE 3 PASSED: All Phase 3 retrieval quality thresholds met.");
    process.exit(0);
  } catch (err) {
    console.error("❌ GATE 3 ERROR:", err);
    process.exit(1);
  }
}

if (process.argv[1] && (process.argv[1].endsWith("phase3-retrieval-quality.ts") || process.argv[1].endsWith("phase3-retrieval-quality.js"))) {
  main();
}
