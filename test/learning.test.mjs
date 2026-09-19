import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { proposeLearnedPattern, promoteLearnedPattern, recordLearnedPattern, logUncertaintyEvent, queryProjectMemory } from "../dist/learning/index.js";
import { createConsolidatedRegistry } from "../dist/mcp/consolidated.js";

function setupLearningRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gw-learning-"));
  mkdirSync(path.join(dir, "src"), { recursive: true });
  return dir;
}

test("learned patterns require evidence, remain proposals, and promote through one writer", async () => {
  const dir = setupLearningRepo();
  try {
    await assert.rejects(() => proposeLearnedPattern(dir, { type: "regression", title: "Missing evidence", rule: "Rule", description: "Description" }), /evidence path/);
    const proposal = await proposeLearnedPattern(dir, { type: "regression", title: "Memory Leak", rule: "Unsubscribe listeners", description: "Prevent zombie listeners", targetFiles: ["src/index.ts"] });
    assert.equal(proposal.status, "proposed");
    assert.ok(existsSync(path.join(dir, proposal.path)));
    assert.equal(existsSync(path.join(dir, ".graphward/memory/regression-patterns.md")), false);
    const promoted = await promoteLearnedPattern(dir, proposal.id, { reviewer: "incremental-sync-engine", rationale: "Reusable regression backed by source", promote: true });
    assert.equal(promoted.saved, true);
    const duplicate = await promoteLearnedPattern(dir, proposal.id, { reviewer: "incremental-sync-engine", rationale: "Idempotency check", promote: true });
    assert.equal(duplicate.status, "duplicate");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("deprecated recordLearnedPattern creates a proposal rather than durable memory", async () => {
  const dir = setupLearningRepo();
  try {
    const result = await recordLearnedPattern(dir, { type: "convention", title: "File Naming", rule: "Use kebab-case", description: "Consistent imports", targetFiles: ["src/index.ts"] });
    assert.equal(result.saved, false);
    assert.equal(result.status, "proposed");
    assert.equal(result.deprecated, true);
    assert.equal(existsSync(path.join(dir, ".graphward/memory/coding-patterns.md")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("logUncertaintyEvent creates structured event records", async () => {
  const dir = setupLearningRepo();
  try {
    const res = await logUncertaintyEvent(dir, { trigger: "API Contract Ambiguity", area: "payment-gateway", description: "3DS response unspecified", severity: "high" });
    assert.equal(res.logged, true);
    assert.ok(existsSync(path.join(dir, ".graphward/events/uncertainty-log.jsonl")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("queryProjectMemory reads only promoted durable patterns", async () => {
  const dir = setupLearningRepo();
  try {
    const proposal = await proposeLearnedPattern(dir, { type: "convention", title: "Naming Auth Tokens", rule: "Prefix secrets with AUTH_JWT_", description: "Environment clarity", targetFiles: ["src/index.ts"] });
    assert.deepEqual((await queryProjectMemory(dir, { topic: "auth" })).conventions, []);
    await promoteLearnedPattern(dir, proposal.id, { reviewer: "incremental-sync-engine", rationale: "Durable convention", promote: true });
    assert.ok((await queryProjectMemory(dir, { topic: "auth" })).conventions.some((item) => item.includes("AUTH_JWT_")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MCP learning tools enforce proposal then single-writer promotion", async () => {
  const dir = setupLearningRepo();
  try {
    const registry = await createConsolidatedRegistry(dir);
    const result = await registry.execute("record_learned_pattern", { root: dir, type: "convention", title: "Pure Functions", rule: "Avoid side effects", description: "Deterministic tests", targetFiles: ["src/index.ts"] });
    assert.equal(result.saved, false);
    assert.equal(result.status, "proposed");
    const promoted = await registry.execute("promote_learned_pattern", { root: dir, id: result.id, reviewer: "incremental-sync-engine", rationale: "verified", promote: true });
    assert.equal(promoted.status, "promoted");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
