import { checkEvidenceHashes } from "../evidence/index.js";
import { runGate, GATE_NAMES } from "../gates/index.js";
import { analyzeImpact, buildGraph, ensureFreshGraph } from "../graph/index.js";
import { runCceIndex } from "../providers/cce.js";
import { runGraphifyExtraction } from "../providers/graphify.js";
import { prepareProviders } from "../providers/manager.js";
import { deriveClaims, verifyClaims } from "../claims/index.js";
import { changedFiles } from "../verify/index.js";
import { verifyKnowledge } from "../verify/index.js";
import { checkTaskReadiness, loadTask } from "../aidlc/task-contract.js";
import type { GateRisk } from "../gates/index.js";

const SOURCE_FILE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|sql)$/i;

/** GraphWard's own intelligence artifacts: documentation about the code, never part of it. */
const isIntelligenceArtifact = (file: string) => file === ".graphward" || file.replace(/\\/g, "/").startsWith(".graphward/");

function inferRisk(changed: string[]): GateRisk {
  const files = changed.filter((file) => !isIntelligenceArtifact(file));
  if (files.some((file) => /(auth|security|crypto|migration|schema|mcp|permissions?|secrets?)/i.test(file))) return "high";
  if (files.some((file) => SOURCE_FILE_RE.test(file))) return "medium";
  return "low";
}

export async function validateChange(root: string, files?: string[], base = "HEAD", options: { taskId?: string } = {}) {
  const changed = files && files.length > 0 ? files : await changedFiles(root);
  const freshness = await ensureFreshGraph(root);
  // Intelligence artifacts have no graph node; analysing them only yields "unknown module" noise.
  const impact = await analyzeImpact(root, changed.filter((file) => !isIntelligenceArtifact(file)));
  const risk = inferRisk(changed);
  const readiness = await checkTaskReadiness(root, { taskId: options.taskId, files: changed });
  const task = options.taskId ? await loadTask(root, options.taskId) : undefined;
  const mappingGaps = task ? [
    ...task.contract.acceptanceCriteria.filter(criterion => !task.changeMapping?.some(entry => entry.criterion === criterion)).map(criterion => `Unmapped requirement: ${criterion}`),
    ...changed.filter(file => !task.changeMapping?.some(entry => entry.files.includes(file))).map(file => `Change lacks requirement rationale: ${file}`),
  ] : [];
  const [claims, knowledge, evidence, ...gates] = await Promise.all([
    verifyClaims(root),
    verifyKnowledge(root),
    checkEvidenceHashes(root),
    ...GATE_NAMES.map((gate) => runGate(gate, root, { base, changedFiles: changed, risk })),
  ]);
  const blocking = gates.filter((gate) => gate.status === "fail" || (gate.status === "unavailable" && gate.required));
  return {
    changedFiles: changed,
    readiness,
    mappingGaps,
    freshness,
    impact,
    risk,
    claims,
    knowledge,
    evidence,
    gates,
    verdict: readiness.ready && mappingGaps.length === 0 && blocking.length === 0 && claims.refuted + claims.stale + claims.missing === 0 && knowledge.drift === 0 && evidence.stale === 0 && !evidence.documentDrift ? "pass" : "needs-attention",
    blocking: [...(mappingGaps.length ? ["requirement-change-test-mapping"] : []), ...(!readiness.ready ? ["task-readiness"] : []), ...blocking.map((gate) => gate.gate), ...(claims.refuted + claims.stale + claims.missing > 0 ? ["claims"] : []), ...(knowledge.drift > 0 || evidence.stale > 0 || (evidence.documentDrift ?? 0) > 0 ? ["knowledge"] : [])],
  };
}

export async function syncEngineeringKnowledge(root: string, files?: string[]) {
  const changed = files && files.length > 0 ? files : await changedFiles(root);
  const providers = await prepareProviders(root, { installMissing: false });
  const graphifyHealthy = providers.statuses.some((status) => status.name === "graphify" && status.health === "healthy");
  const cceHealthy = providers.statuses.some((status) => status.name === "cce" && status.health === "healthy");
  const graphify = graphifyHealthy ? await runGraphifyExtraction(root) : { ok: false, degraded: providers.policy !== "native", message: "Graphify unavailable or disabled; native graph synchronization used." };
  const graph = await buildGraph(root, changed.length > 0 && changed.length <= 200 ? { update: true, files: changed, providerEvidence: graphify.ok } : { providerEvidence: graphify.ok });
  const cce = cceHealthy ? await runCceIndex(root) : { ok: false, degraded: providers.policy !== "native", message: "CCE unavailable or disabled; native retrieval remains active." };
  const derived = await deriveClaims(root);
  const [claims, knowledge, evidence] = await Promise.all([verifyClaims(root), verifyKnowledge(root), checkEvidenceHashes(root)]);
  return {
    changedFiles: changed,
    providers,
    graphify,
    graph,
    cce,
    derived,
    claims,
    knowledge,
    evidence,
    // A deterministic sync can refresh structure and derived facts, but it
    // cannot decide whether changed application code requires prose updates.
    // Signal that follow-up explicitly for source changes, even when the old
    // prose did not cite the newly added file.
    requiresModelKnowledgeSync: changed.some((file) => SOURCE_FILE_RE.test(file)) || knowledge.drift > 0 || evidence.stale > 0 || (evidence.documentDrift ?? 0) > 0,
    note: "Code, graph, provider index, and derived claims are synchronized. Canonical prose is never rewritten without evidence-aware model synthesis.",
  };
}
