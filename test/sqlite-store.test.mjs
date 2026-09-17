import test from "node:test";
import assert from "node:assert/strict";
import { SqlitePartitionedStore } from "../dist/storage/sqlite-store.js";

test("sqlite-store: in-memory store initialization and symbol insertion/retrieval", async () => {
  const store = new SqlitePartitionedStore(":memory:");
  await store.initialize();

  store.insertSymbol({
    id: "sym:payment#pay",
    repository: "graphward",
    package: "core",
    language: "typescript",
    path: "src/payment.ts",
    qualifiedName: "pay",
    signature: "(amount: number): void",
    declarationHash: "a1b2c3d4e5f67890",
  });

  const retrieved = store.getSymbol("sym:payment#pay");
  assert.ok(retrieved);
  assert.equal(retrieved.id, "sym:payment#pay");
  assert.equal(retrieved.qualifiedName, "pay");
  assert.equal(retrieved.declarationHash, "a1b2c3d4e5f67890");

  const byPath = store.getSymbolsByPath("src/payment.ts");
  assert.equal(byPath.length, 1);
  assert.equal(byPath[0].id, "sym:payment#pay");

  store.close();
});

test("sqlite-store: partitioned edges and evidence", async () => {
  const store = new SqlitePartitionedStore(":memory:");
  await store.initialize();

  store.insertEdge({
    id: "edge:checkout->pay",
    fromId: "sym:checkout#run",
    toId: "sym:payment#pay",
    relation: "calls",
    confidence: "verified",
    calibratedConfidence: 0.99,
    why: ["compiler confirmed", "runtime observed"],
  });

  const fromEdges = store.getEdgesFrom("sym:checkout#run");
  assert.equal(fromEdges.length, 1);
  assert.equal(fromEdges[0].toId, "sym:payment#pay");

  const toEdges = store.getEdgesTo("sym:payment#pay");
  assert.equal(toEdges.length, 1);
  assert.equal(toEdges[0].fromId, "sym:checkout#run");

  store.insertEvidence({
    id: "ev:1",
    edgeId: "edge:checkout->pay",
    kind: "RUNTIME",
    strength: "OBSERVED",
    scope: "RUNTIME",
    file: "src/checkout.ts",
    startLine: 12,
    observations: 1832,
    confidence: 0.99,
  });

  const evList = store.getEvidenceForEdge("edge:checkout->pay");
  assert.equal(evList.length, 1);
  assert.equal(evList[0].observations, 1832);

  store.close();
});

test("sqlite-store: runtime observations aggregation", async () => {
  const store = new SqlitePartitionedStore(":memory:");
  await store.initialize();

  store.recordRuntimeObservation({
    id: "obs:checkout->pay",
    fromSymbol: "checkout",
    toSymbol: "pay",
    route: "/api/checkout",
    environment: "test",
    testSuite: "checkout.spec.ts",
    count: 10,
    lastObserved: "2026-09-17T10:00:00Z",
  });

  // Second observation merges / increments count
  store.recordRuntimeObservation({
    id: "obs:checkout->pay",
    fromSymbol: "checkout",
    toSymbol: "pay",
    route: "/api/checkout",
    environment: "test",
    testSuite: "checkout.spec.ts",
    count: 5,
    lastObserved: "2026-09-17T10:05:00Z",
  });

  const obs = store.getRuntimeObservations("checkout", "pay");
  assert.equal(obs.length, 1);
  assert.equal(obs[0].count, 15, "Count should be aggregated to 10 + 5 = 15");
  assert.equal(obs[0].lastObserved, "2026-09-17T10:05:00Z");

  store.close();
});

test("sqlite-store: git coupling and embeddings storage", async () => {
  const store = new SqlitePartitionedStore(":memory:");
  await store.initialize();

  store.recordGitCoupling("src/payment.ts", "src/types.ts", 18, 0.85, "commit123");

  const coupled = store.getGitCoupling("src/payment.ts");
  assert.equal(coupled.length, 1);
  assert.equal(coupled[0].cochangeCount, 18);
  assert.equal(coupled[0].couplingScore, 0.85);

  store.saveEmbedding("sym:payment#pay", "CodeRankEmbed-v1", [0.12, 0.34, 0.56], "hash_chunk_1");
  const emb = store.getEmbedding("sym:payment#pay");
  assert.ok(emb);
  assert.equal(emb.modelId, "CodeRankEmbed-v1");
  assert.deepEqual(emb.vector, [0.12, 0.34, 0.56]);

  store.close();
});

test("sqlite-store: transactions and JSON snapshot round-trip", async () => {
  const store = new SqlitePartitionedStore(":memory:");
  await store.initialize();

  store.transaction(() => {
    store.insertSymbol({
      id: "sym:a",
      repository: "repo",
      package: "pkg",
      language: "ts",
      path: "a.ts",
      qualifiedName: "a",
      declarationHash: "hash_a",
    });
    store.insertSymbol({
      id: "sym:b",
      repository: "repo",
      package: "pkg",
      language: "ts",
      path: "b.ts",
      qualifiedName: "b",
      declarationHash: "hash_b",
    });
  });

  assert.equal(store.getSymbol("sym:a")?.qualifiedName, "a");
  assert.equal(store.getSymbol("sym:b")?.qualifiedName, "b");

  // Export snapshot
  const snapshot = store.exportSnapshot();
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.symbols.length, 2);

  // Restore into a fresh store
  const store2 = new SqlitePartitionedStore(":memory:");
  await store2.initialize();
  store2.importSnapshot(snapshot);

  assert.equal(store2.getSymbol("sym:a")?.qualifiedName, "a");
  assert.equal(store2.getSymbol("sym:b")?.qualifiedName, "b");

  store.close();
  store2.close();
});

test("sqlite-store: snapshots partition CRUD and lineage tracking", async () => {
  const store = new SqlitePartitionedStore(":memory:");
  await store.initialize();

  const realSnap = {
    id: "snap_real_001",
    repository: "graphward",
    commit: "c123456",
    kind: "REAL",
    generatedAt: "2026-09-17T10:00:00Z",
    environment: "dev",
    schemaVersion: "2.2",
  };
  store.insertSnapshot(realSnap);

  const cfSnap = {
    id: "snap_cf_002",
    repository: "graphward",
    commit: "c123456",
    parentSnapshotId: "snap_real_001",
    kind: "COUNTERFACTUAL",
    baseCommit: "c123456",
    patchHash: "patch_hash_123",
    generatedAt: "2026-09-17T10:05:00Z",
    environment: "dev",
    schemaVersion: "2.2",
  };
  store.insertSnapshot(cfSnap);

  const loadedReal = store.getSnapshot("snap_real_001");
  assert.ok(loadedReal);
  assert.equal(loadedReal.kind, "REAL");
  assert.equal(loadedReal.commit, "c123456");

  const loadedCf = store.getSnapshot("snap_cf_002");
  assert.ok(loadedCf);
  assert.equal(loadedCf.kind, "COUNTERFACTUAL");
  assert.equal(loadedCf.parentSnapshotId, "snap_real_001");
  assert.equal(loadedCf.patchHash, "patch_hash_123");

  const allSnaps = store.getAllSnapshots();
  assert.equal(allSnaps.length, 2);

  store.close();
});

test("sqlite-store: symbol origin and evidence snapshotId/confidenceState preserved across export/import", async () => {
  const store = new SqlitePartitionedStore(":memory:");
  await store.initialize();

  store.insertSymbol({
    id: "sym:generated_code",
    repository: "graphward",
    package: "core",
    language: "typescript",
    path: "src/generated/types.ts",
    qualifiedName: "GeneratedConfig",
    declarationHash: "hash_gen_123",
    origin: "GENERATED",
  });

  store.insertSymbol({
    id: "sym:dep_code",
    repository: "graphward",
    package: "core",
    language: "typescript",
    path: "node_modules/lib/index.d.ts",
    qualifiedName: "ExternalLib",
    declarationHash: "hash_dep_123",
    origin: "DEPENDENCY",
  });

  // Verify getAllSymbols preserves origin
  const allSymbols = store.getAllSymbols();
  const genSym = allSymbols.find((s) => s.id === "sym:generated_code");
  const depSym = allSymbols.find((s) => s.id === "sym:dep_code");
  assert.equal(genSym?.origin, "GENERATED", "getAllSymbols must preserve origin: GENERATED");
  assert.equal(depSym?.origin, "DEPENDENCY", "getAllSymbols must preserve origin: DEPENDENCY");

  // Insert evidence with snapshotId and confidenceState
  store.insertEdge({
    id: "edge:gen->dep",
    fromId: "sym:generated_code",
    toId: "sym:dep_code",
    relation: "uses_type",
    confidence: "verified",
  });

  store.insertEvidence({
    id: "ev:gen_dep",
    edgeId: "edge:gen->dep",
    snapshotId: "snap_real_001",
    kind: "COMPILER",
    strength: "SEMANTIC",
    scope: "PROJECT",
    file: "src/generated/types.ts",
    startLine: 1,
    confidence: 0.98,
    confidenceState: "CALIBRATED",
  });

  const evList = store.getEvidenceForEdge("edge:gen->dep");
  assert.equal(evList[0].snapshotId, "snap_real_001");
  assert.equal(evList[0].confidenceState, "CALIBRATED");

  // Export snapshot and verify round-trip
  const exported = store.exportSnapshot();
  const exportedGen = exported.symbols.find((s) => s.id === "sym:generated_code");
  assert.equal(exportedGen?.origin, "GENERATED", "exportSnapshot must preserve origin: GENERATED");

  const exportedEv = exported.evidence.find((e) => e.id === "ev:gen_dep");
  assert.equal(exportedEv?.snapshotId, "snap_real_001");
  assert.equal(exportedEv?.confidenceState, "CALIBRATED");

  // Re-import into fresh store
  const store2 = new SqlitePartitionedStore(":memory:");
  await store2.initialize();
  store2.importSnapshot(exported);

  const importedGen = store2.getSymbol("sym:generated_code");
  assert.equal(importedGen?.origin, "GENERATED", "imported symbol must preserve origin: GENERATED");

  store.close();
  store2.close();
});
