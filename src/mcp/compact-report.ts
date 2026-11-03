/**
 * MCP responses for validate_change / sync_engineering_knowledge used to carry every
 * verified claim and every gate finding verbatim — thousands of rows on a real repository,
 * which buries the handful that need action. The summary view keeps all counts and lists
 * only what is not passing, capped, with the omitted totals stated explicitly.
 */

const COMPACT_LIST_LIMIT = 25;

const CLAIM_STATUS_ORDER: Record<string, number> = { refuted: 0, missing: 1, stale: 2, unverified: 3 };

interface Listed<T> { items: T[]; omitted: number }

function cap<T>(items: T[], limit = COMPACT_LIST_LIMIT): Listed<T> {
  return { items: items.slice(0, limit), omitted: Math.max(0, items.length - limit) };
}

function compactClaims(claims: any) {
  if (!claims || !Array.isArray(claims.results)) return claims;
  const { results, ...counts } = claims;
  const open = results
    .filter((claim: any) => claim.status !== "verified")
    .sort((a: any, b: any) => (CLAIM_STATUS_ORDER[a.status] ?? 9) - (CLAIM_STATUS_ORDER[b.status] ?? 9));
  const listed = cap(open);
  return { ...counts, notVerified: listed.items, ...(listed.omitted ? { notVerifiedOmitted: listed.omitted } : {}) };
}

function compactGates(gates: any) {
  if (!Array.isArray(gates)) return gates;
  return gates.map((gate: any) => {
    if (!Array.isArray(gate?.findings) || gate.findings.length <= COMPACT_LIST_LIMIT) return gate;
    const rank: Record<string, number> = { error: 0, warning: 1, info: 2 };
    const sorted = [...gate.findings].sort((a: any, b: any) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
    const listed = cap(sorted);
    return { ...gate, findings: listed.items, findingsTotal: gate.findings.length, findingsOmitted: listed.omitted };
  });
}

function compactKnowledge(knowledge: any) {
  if (!knowledge || !Array.isArray(knowledge.details)) return knowledge;
  const listed = cap(knowledge.details);
  return { ...knowledge, details: listed.items, ...(listed.omitted ? { detailsOmitted: listed.omitted } : {}) };
}

function compactEvidence(evidence: any) {
  if (!evidence || !Array.isArray(evidence.results)) return evidence;
  const results = cap(evidence.results.filter((result: any) => result.status !== "ok"));
  const documents = Array.isArray(evidence.documents) ? evidence.documents.filter((document: any) => !document.verified) : [];
  const listedDocuments = cap(documents);
  return {
    ...evidence,
    results: results.items,
    ...(results.omitted ? { resultsOmitted: results.omitted } : {}),
    documents: listedDocuments.items,
    documentsVerified: Array.isArray(evidence.documents) ? evidence.documents.length - documents.length : 0,
    ...(listedDocuments.omitted ? { documentsOmitted: listedDocuments.omitted } : {}),
  };
}

function compactImpact(impact: any) {
  if (!impact || !Array.isArray(impact.details) || impact.details.length <= COMPACT_LIST_LIMIT) return impact;
  const listed = cap(impact.details);
  return { ...impact, details: listed.items, detailsTotal: impact.details.length, detailsOmitted: listed.omitted };
}

export function compactReport<T extends Record<string, any>>(report: T): T {
  return {
    ...report,
    ...("impact" in report ? { impact: compactImpact(report.impact) } : {}),
    ...("claims" in report ? { claims: compactClaims(report.claims) } : {}),
    ...("gates" in report ? { gates: compactGates(report.gates) } : {}),
    ...("knowledge" in report ? { knowledge: compactKnowledge(report.knowledge) } : {}),
    ...("evidence" in report ? { evidence: compactEvidence(report.evidence) } : {}),
  };
}
