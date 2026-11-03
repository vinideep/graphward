/**
 * Repo brief freshness.
 *
 * The brief is regenerated from the dependency graph on every graph build, but
 * the freshness scorer compared its cited graph against the hash recorded at the
 * last `evidence-record`. Every rebuild therefore scored a current brief 49
 * ("Block implementation"). The brief now embeds the hashes it was rendered
 * from; only that generated document may vouch for itself this way, and the
 * evidence sidecar is never written, so sync stays byte-preserving.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { generateBrief } from "../dist/brief/index.js";
import { hashSourceFile, recordEvidenceHashes } from "../dist/evidence/index.js";
import { computeFreshness } from "../dist/freshness/index.js";

const BRIEF = ".graphward/context/repo-brief.md";
const GRAPH = ".graphward/graph/dependency-graph.json";
const SNAPSHOT = ".graphward/knowledge-base/.evidence-hashes.json";

async function write(root, rel, content) {
  const abs = path.join(root, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`, "utf8");
}

function graph(modules) {
  return {
    schemaVersion: "1.0", graphType: "dependency", scope: "fixture", generatedAt: "2026-11-03T00:00:00.000Z", unknowns: [],
    nodes: modules.map(file => ({ id: `module:${file}`, kind: "module", label: file, path: file, evidence: [file], metadata: {} })),
    edges: [],
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "gw-brief-"));
  await write(root, "package.json", { name: "fixture", version: "1.0.0" });
  await write(root, "src/a.ts", "export const a = 1;\n");
  await write(root, ".graphward/knowledge-base/a.md", "# A\nA is one (evidence: src/a.ts:1).\n");
  await write(root, GRAPH, graph(["src/a.ts"]));
  await generateBrief(root);
  return root;
}

const scoreOf = (report, doc) => report.scores.find(score => score.docPath === doc);

test("a regenerated brief stays fresh after a graph rebuild without touching the sidecar", async () => {
  const root = await fixture();
  await recordEvidenceHashes(root);
  const sidecar = await readFile(path.join(root, SNAPSHOT), "utf8");

  await write(root, GRAPH, graph(["src/a.ts", "src/b.ts"]));
  await generateBrief(root);

  assert.equal(await readFile(path.join(root, SNAPSHOT), "utf8"), sidecar, "brief generation must not write the evidence sidecar");
  const report = await computeFreshness(root);
  assert.ok(scoreOf(report, BRIEF).score >= 60, `brief scored ${scoreOf(report, BRIEF).score}`);
  assert.equal(report.driftDecision, "Proceed");
  assert.match(await readFile(path.join(root, BRIEF), "utf8"), new RegExp(`${GRAPH.replace(/[.]/g, "\\.")}=${await hashSourceFile(root, GRAPH)}`));
});

test("a graph change without a regenerated brief is still stale", async () => {
  const root = await fixture();
  await recordEvidenceHashes(root);
  await write(root, GRAPH, graph(["src/a.ts", "src/c.ts"]));

  const report = await computeFreshness(root);
  assert.ok(scoreOf(report, BRIEF).score < 60);
  assert.ok(scoreOf(report, BRIEF).staleSources.some(source => source.file === GRAPH));
});

test("generating a brief never creates an evidence snapshot", async () => {
  const root = await fixture();
  await generateBrief(root);
  assert.equal(existsSync(path.join(root, SNAPSHOT)), false);
});

test("derivation hashes vouch only for the generated brief, never for other documents", async () => {
  const root = await fixture();
  await write(root, ".graphward/context/other.md", "# Other\nGraph summary (evidence: .graphward/graph/dependency-graph.json).\n");
  await recordEvidenceHashes(root);

  await write(root, GRAPH, graph(["src/a.ts", "src/d.ts"]));
  const forged = `<!-- graphward:derived-from ${GRAPH}=${await hashSourceFile(root, GRAPH)} -->`;
  await write(root, ".graphward/context/other.md", `# Other\n${forged}\nGraph summary (evidence: .graphward/graph/dependency-graph.json).\n`);

  const report = await computeFreshness(root);
  assert.ok(scoreOf(report, ".graphward/context/other.md").score < 60, "a hand-written document cannot self-certify");
});
