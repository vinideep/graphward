import assert from "node:assert/strict";
import test from "node:test";
import {
  CodeRankEmbedProvider,
  RetrievalPolicy,
  GraphAwareReranker,
  HybridRetrieverV2,
  cosineSimilarity,
} from "../dist/retrieval/index.js";
import { evaluateEvidencePolicy } from "../dist/context/evidence-policy.js";

test("CodeRankEmbedProvider: deterministic vectors and model pinning validation", async () => {
  const provider = new CodeRankEmbedProvider(64);
  assert.equal(provider.dimensions, 64);
  assert.equal(provider.metadata.providerId, "coderank-embed-v2");

  const vec1 = await provider.embedQuery("processPayment with idempotency key");
  const vec2 = await provider.embedQuery("processPayment with idempotency key");
  assert.deepEqual(vec1, vec2, "embeddings should be strictly deterministic");

  // Cosine similarity of identical queries is 1.0
  const simSelf = cosineSimilarity(vec1, vec2);
  assert.ok(Math.abs(simSelf - 1.0) < 0.001);

  // Cosine similarity with completely unrelated query is lower
  const vecUnrelated = await provider.embedQuery("random unrelated string banana monkey");
  const simUnrelated = cosineSimilarity(vec1, vecUnrelated);
  assert.ok(simUnrelated < simSelf);

  // Model pinning check
  assert.equal(provider.validatePinning(provider.metadata), true);
  assert.equal(
    provider.validatePinning({ ...provider.metadata, version: "9.9.9" }),
    false
  );
});

test("RetrievalPolicy: negative filtering excludes dist, vendor, snapshots, and lockfiles", () => {
  const policy = new RetrievalPolicy();
  assert.equal(policy.isRetrievable("src/payments/gateway.ts"), true);
  assert.equal(policy.isRetrievable("src/orders/service.ts"), true);

  assert.equal(policy.isRetrievable("node_modules/express/index.js"), false);
  assert.equal(policy.isRetrievable("dist/bundle.min.js"), false);
  assert.equal(policy.isRetrievable("build/out.js"), false);
  assert.equal(policy.isRetrievable("package-lock.json"), false);
  assert.equal(policy.isRetrievable("test/__snapshots__/foo.snap"), false);
  assert.equal(policy.isRetrievable("coverage/lcov.info"), false);
});

test("GraphAwareReranker: combines multi-modal features with topology boost", () => {
  const reranker = new GraphAwareReranker();

  const sym1 = {
    repository: "default",
    package: "pkg",
    language: "ts",
    path: "src/a.ts",
    qualifiedName: "chargeCard",
    declarationHash: "h1",
    origin: "SOURCE",
  };
  const sym2 = {
    repository: "default",
    package: "pkg",
    language: "ts",
    path: "src/b.ts",
    qualifiedName: "unrelatedMethod",
    declarationHash: "h2",
    origin: "SOURCE",
  };

  const candidates = [
    {
      symbolId: sym2,
      path: sym2.path,
      qualifiedName: sym2.qualifiedName,
      features: { lexical: 0.1, vector: 0.2, graph: 0.1, runtime: 0.0, recency: 0.5 },
      isDirectNeighbor: false,
    },
    {
      symbolId: sym1,
      path: sym1.path,
      qualifiedName: sym1.qualifiedName,
      features: { lexical: 0.9, vector: 0.85, graph: 0.8, runtime: 0.5, recency: 0.9 },
      isDirectNeighbor: true,
    },
  ];

  const ranked = reranker.rerank(candidates);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].qualifiedName, "chargeCard");
  assert.equal(ranked[0].rank, 1);
  assert.ok(ranked[0].score > ranked[1].score);
  assert.ok(ranked[0].explanation.includes("graph caller/callee neighbor"));
});

test("EvidencePolicy Decision Matrix: evaluates LOW, MEDIUM, HIGH, CRITICAL correctly", () => {
  // LOW: local internal edit
  const decLow = evaluateEvidencePolicy({
    task: "fix typo in local variable",
    changedFiles: ["src/utils/math.ts"],
    isPublicApi: false,
    routeExposure: false,
  });
  assert.equal(decLow.tier, "LOW");
  assert.equal(decLow.action, "PROCEED");
  assert.equal(decLow.blocked, false);

  // MEDIUM: internal interface with tests
  const decMed = evaluateEvidencePolicy({
    task: "refactor internal helper service",
    changedFiles: ["src/service/helper.ts", "src/service/caller.ts"],
    dependentTestCount: 2,
  });
  assert.equal(decMed.tier, "MEDIUM");
  assert.equal(decMed.action, "RETRIEVE");
  assert.equal(decMed.blocked, false);

  // HIGH: payment contract or public API
  const decHigh = evaluateEvidencePolicy({
    task: "update payment processing contract",
    changedFiles: ["src/payments/gateway.ts"],
    isPaymentContract: true,
  });
  assert.equal(decHigh.tier, "HIGH");
  assert.equal(decHigh.action, "VERIFY");
  assert.equal(decHigh.blocked, false);

  // CRITICAL: unknown dynamic downstream callers under high runtime exposure
  const decCrit = evaluateEvidencePolicy({
    task: "modify dynamic route with high runtime traffic",
    hasUnknownCallers: true,
    routeExposure: true,
  });
  assert.equal(decCrit.tier, "CRITICAL");
  assert.equal(decCrit.action, "REFUSE");
  assert.equal(decCrit.blocked, true);
});

test("HybridRetrieverV2: preserves 2-letter query terms (db, ui, ip, tx)", async () => {
  const retriever = new HybridRetrieverV2();
  await retriever.indexSymbols([
    {
      symbolId: {
        repository: "default",
        package: "pkg",
        language: "ts",
        path: "src/db.ts",
        qualifiedName: "dbConnection",
        declarationHash: "h1",
        origin: "SOURCE",
      },
      content: "database connection pool for postgres",
    },
  ]);

  const { results } = await retriever.retrieve("db", { topK: 5 });
  assert.ok(results.length > 0, "Query 'db' must retrieve the symbol");
  assert.equal(results[0].qualifiedName, "dbConnection");
  assert.ok(results[0].features.lexical > 0, "Lexical match should be non-zero for 2-letter term");
});
