import assert from "node:assert/strict";
import test from "node:test";
import { routeRequest, WORKFLOW_CATALOG, workflowCatalogErrors } from "../dist/routing/catalog.js";
import { renderAdapters } from "../dist/adapters/index.js";
import { GATE_NAMES } from "../dist/gates/index.js";

const CORPUS = [
  ["Implement account lockout", "graphward"], ["Fix the parser bug", "graphward"],
  ["Initialize GraphWard for this repository", "initialize-graphward"],
  ["Decompose this initiative into an epic backlog", "decompose-backlog"],
  ["Deliver backlog feature FEAT-004", "deliver-backlog"], ["Map the architecture", "map-architecture"],
  ["Analyze the impact of changing UserId", "analyze-impact"], ["Sync GraphWard knowledge", "sync-graphward"],
  ["Review this engineering diff", "review-engineering-change"], ["Audit this repository, read-only", "review-engineering-change"],
  ["Scope the requirement for tenant billing", "scope-requirement"], ["Discover this codebase", "discover-codebase"],
  ["Create a new greenfield application", "create-project"], ["Grill this plan", "grill-me"],
  ["Handoff this session", "handoff"], ["Implement this using TDD", "tdd"],
  ["Design an interface for storage providers", "design-an-interface"],
  ["Quick auth fix, do not modify anything; review only", "review-engineering-change"],
  ["What will this API change affect? analysis only", "analyze-impact"], ["Refactor the adapter", "graphward"],
];

test("routing corpus reaches at least 95% precision and preserves read-only safety", () => {
  const correct = CORPUS.filter(([prompt, expected]) => routeRequest(prompt) === expected).length;
  assert.ok(correct / CORPUS.length >= 0.95, `${correct}/${CORPUS.length} prompts routed correctly`);
  for (const [prompt] of CORPUS.filter(([prompt]) => /read-only|do not modify|analysis only|review only/i.test(prompt))) assert.equal(WORKFLOW_CATALOG[routeRequest(prompt)].mutatesProduct, false, prompt);
  assert.deepEqual(workflowCatalogErrors(), []);
  assert.deepEqual([...WORKFLOW_CATALOG.graphward.requiredGates].sort(), [...GATE_NAMES].sort(), "advertised implementation gates must equal the executable registry");
});

test("provider bundles expose workflows once and internal engines are route-only", async () => {
  for (const ide of ["claude-code", "cursor", "github-copilot", "gemini-cli", "codex"]) {
    const files = await renderAdapters([ide]);
    const skills = files.filter((file) => /\/skills\/[^/]+\/SKILL\.md$/.test(file.path));
    assert.equal(skills.length, 48, `${ide} must expose exactly 48 internal engines`);
    if (ide === "codex") {
      const launcher = skills.find((file) => file.path.endsWith("/skills/graphward/SKILL.md"));
      assert.ok(launcher, "codex must expose the GraphWard custom-agent launcher");
      assert.ok(!skills.some((file) => file.path.endsWith("/skills/graphward-skill/SKILL.md")));
      assert.ok(skills.filter((file) => file !== launcher).every((file) => /disable-model-invocation: true/.test(file.content)));
    } else {
      assert.ok(skills.every((file) => /disable-model-invocation: true/.test(file.content)));
      assert.ok(!skills.some((file) => /\/skills\/(graphward|analyze-impact|tdd)\/SKILL\.md$/.test(file.path)));
    }
  }
});

test("provider routing never requires missing skill briefs", async () => {
  for (const ide of ["cursor", "github-copilot", "gemini-cli", "codex"]) {
    const files = await renderAdapters([ide]);
    const routing = files.find((file) => file.path.endsWith("WORKFLOW-ROUTING.md"));
    assert.ok(routing, `${ide} routing exists`);
    assert.doesNotMatch(routing.content, /load `SKILL-BRIEF\.md`/);
  }
});
