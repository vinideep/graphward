import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordLearnedPattern, promoteLearnedPattern } from "../dist/learning/index.js";
import { coverageFor, runVerification } from "../dist/verify/index.js";

test("recordLearnedPattern includes provenance in markdown", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ei-prov-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src/a.ts"), "export const reviewed = true;\n");
    const proposal = await recordLearnedPattern(dir, {
      type: "convention",
      title: "Test pattern",
      description: "Desc",
      rule: "Rule",
      provenance: "agent",
      targetFiles: ["src/a.ts"]
    });
    await promoteLearnedPattern(dir, proposal.id, { reviewer: "incremental-sync-engine", rationale: "provenance test", promote: true });

    const content = readFileSync(path.join(dir, ".graphward", "memory", "coding-patterns.md"), "utf8");
    assert.ok(content.includes("[provenance: agent]"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("coverageFor sets agentOnly to true when covered only by agent receipts", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ei-cov-prov-"));
  try {
    const fileContent = "export const verified = true;\n";
    const filePath = "src/a.ts";
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));

    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, filePath), fileContent);

    // Only agent record -> agentOnly: true
    const agentRun = await runVerification(dir, { provenance: "agent" });
    assert.equal(agentRun.record.verdict, "pass");
    assert.equal(agentRun.record.provenanceAssurance, "declared");
    const cov1 = await coverageFor(dir, [filePath]);
    assert.equal(cov1.covered, true);
    assert.equal(cov1.agentOnly, true);

    // Add human record -> agentOnly: false
    const humanRun = await runVerification(dir, { provenance: "human" });
    assert.equal(humanRun.record.verdict, "pass");
    assert.equal(humanRun.record.provenanceAssurance, "declared");
    const cov2 = await coverageFor(dir, [filePath]);
    assert.equal(cov2.covered, true);
    assert.equal(cov2.agentOnly, false);

  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
