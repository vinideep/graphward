import type { SymbolId } from "./symbol-identity.js";

export type Confidence = "verified" | "inferred" | "unknown";

export type EvidenceStrength =
  | "HEURISTIC"
  | "STRUCTURAL"
  | "SEMANTIC"
  | "OBSERVED"
  | "CORROBORATED";

export type EvidenceScope =
  | "FILE"
  | "PROJECT"
  | "TEST"
  | "RUNTIME"
  | "ENVIRONMENT"
  | "HISTORY";

export type EvidenceKind =
  | "AST"
  | "COMPILER"
  | "RUNTIME"
  | "GIT"
  | "TEST"
  | "CONFIG"
  | "BUILD";

export type ConfidenceState = "CALIBRATED" | "ESTIMATED" | "UNKNOWN";

export type EvidenceSource =
  | { type: "SOURCE"; file: string; startLine?: number; endLine?: number; hash?: string }
  | { type: "RUNTIME"; buildId?: string; traceId?: string; spanId?: string; module?: string; service?: string }
  | { type: "GIT"; commit: string; parent?: string; author?: string; cochangeFiles?: string[] }
  | { type: "TEST"; suite: string; case?: string; runner?: string; executionTimeMs?: number };

export type EvidenceSourceLocation = {
  file: string;
  startLine: number;
  endLine?: number;
  hash?: string;
};

export interface Evidence {
  id: string;
  snapshotId?: string;
  kind: EvidenceKind;
  strength: EvidenceStrength;
  scope: EvidenceScope;
  source: EvidenceSource;
  timestamp?: string;
  observations?: number;
  testDetails?: {
    executed: boolean;
    asserted: boolean;
    passed: boolean;
    assertionStrength: "WEAK" | "MEDIUM" | "STRONG";
  };
  testSuites?: string[];
  environments?: string[];
  confidence?: number; // Optional; absent when confidenceState is UNKNOWN
  confidenceState: ConfidenceState;
  calibrationMeta?: { sampleSize: number; version: string; date: string };
  coverage?: number;
}

export interface UserAssertion {
  id: string;
  snapshotId: string;
  claim: string;
  author: string;
  createdAt: string;
}

export interface Inference {
  id: string;
  snapshotId: string;
  claim: string;
  derivedFrom: string[]; // Evidence IDs supporting this conclusion
  method: "LLM_SYNTHESIS" | "STATIC_HEURISTIC" | "PATTERN_MATCH";
  confidence?: number;
  confidenceState: ConfidenceState;
  createdAt: string;
}

export interface Snapshot {
  id: string;                         // e.g. snap_20260917_a8f3d1
  repository: string;
  commit: string;
  parentSnapshotId?: string;          // Parent snapshot for branch/counterfactual lineage
  kind: "REAL" | "COUNTERFACTUAL";    // Distinguishes observed ground truth from tentative patch branches
  baseCommit?: string;                // Base commit for counterfactual evaluation
  patchHash?: string;                 // SHA-256 hash of evaluated patch
  generatedAt: string;
  environment?: "dev" | "test" | "staging" | "prod";
  buildId?: string;
  schemaVersion: "2.2";
}

export const GRAPH_SCHEMA_VERSION = "2.2" as const;
export const MCP_API_VERSION = "2.2" as const;

export interface UnknownBoundary {
  id: string;
  snapshotId: string;
  kind: "UNKNOWN_DYNAMIC_TARGET" | "UNKNOWN_DYNAMIC_CALL" | "UNKNOWN_RUNTIME_PATH" | "UNKNOWN_REFLECTION" | "UNKNOWN_EXTERNAL_SYSTEM";
  reason: string;                     // e.g. "Dynamic property access service[method]()"
  firstObservedAt: string;
  lastObservedAt: string;
  resolutionAttempts: number;
  possibleTargets: SymbolId[];        // Candidates identified by type union or lexical scan
  risk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
}

export interface Change {
  id: string;
  snapshotBefore: string;             // Baseline Snapshot ID
  snapshotAfter?: string;             // Resulting Snapshot ID post-verification
  intent: {
    symbol?: SymbolId;
    action: "create" | "modify" | "delete" | "rename" | "refactor";
    description: string;
  };
  actor: "agent" | "human";
  changedFiles: string[];
  changedSymbols: SymbolId[];
  predictedImpact: {
    affectedFiles: string[];
    affectedSymbols: SymbolId[];
    affectedRoutes: string[];
    affectedExecutionPaths: string[];
  };
  actualImpact?: {
    modifiedFiles: string[];
    modifiedSymbols: SymbolId[];
    brokenTests: string[];
  };
  predictionAccuracy?: {
    filePrecision: number;
    fileRecall: number;
    symbolPrecision: number;
    symbolRecall: number;
  };
  verificationResult?: {
    passed: boolean;
    executedGates: string[];
    durationMs: number;
  };
}

export type MultiEvidenceRelation =
  | "imports"
  | "calls"
  | "defines"
  | "extends"
  | "implements"
  | "uses_type"
  | "routes_to"
  | "observed_call";

export interface MultiEvidenceEdge {
  from: SymbolId;
  to: SymbolId;
  relation: MultiEvidenceRelation;
  evidence: Evidence[];
  why: string[]; // Explainability trace
  runtimeCriticality?: number;
  gitCouplingStrength?: number;
  calibratedConfidence?: number;
}

// ---------------------------------------------------------------------------
// UNKNOWN Boundary Types & Constants
// ---------------------------------------------------------------------------
export const UNKNOWN_DYNAMIC_TARGET = "UNKNOWN_DYNAMIC_TARGET" as const;
export const UNKNOWN_DYNAMIC_CALL = "UNKNOWN_DYNAMIC_CALL" as const;
export const UNKNOWN_RUNTIME_PATH = "UNKNOWN_RUNTIME_PATH" as const;
export const UNKNOWN_REFLECTION = "UNKNOWN_REFLECTION" as const;
export const UNKNOWN_EXTERNAL_SYSTEM = "UNKNOWN_EXTERNAL_SYSTEM" as const;

export type UnknownBoundaryType =
  | typeof UNKNOWN_DYNAMIC_TARGET
  | typeof UNKNOWN_DYNAMIC_CALL
  | typeof UNKNOWN_RUNTIME_PATH
  | typeof UNKNOWN_REFLECTION
  | typeof UNKNOWN_EXTERNAL_SYSTEM;

export interface UnknownBoundaryContext {
  file?: string;
  line?: number;
  reason: string;
  rawExpression?: string;
}

export function createUnknownBoundaryNode(
  type: UnknownBoundaryType,
  context: UnknownBoundaryContext,
): GraphNode {
  const id = `unknown:${type.toLowerCase()}:${context.file ?? "global"}:${context.line ?? 0}`;
  return {
    id,
    kind: "unknown_boundary",
    label: `${type}: ${context.reason}`,
    path: context.file,
    confidence: "unknown",
    metadata: {
      boundaryType: type,
      reason: context.reason,
      rawExpression: context.rawExpression,
      line: context.line,
    },
    evidence: context.file ? [`${context.file}:${context.line ?? 1}`] : [],
  };
}

export function createUnknownBoundaryEdge(
  fromId: string,
  type: UnknownBoundaryType,
  context: UnknownBoundaryContext,
): GraphEdge {
  const toNode = createUnknownBoundaryNode(type, context);
  return {
    from: fromId,
    to: toNode.id,
    relation: "reaches_unknown",
    confidence: "unknown",
    metadata: {
      boundaryType: type,
      reason: context.reason,
      rawExpression: context.rawExpression,
    },
    evidence: context.file ? [`${context.file}:${context.line ?? 1}`] : [],
  };
}

// ---------------------------------------------------------------------------
// Calibrated Confidence & Explainability
// ---------------------------------------------------------------------------

/**
 * Calculates an empirical, calibrated confidence score [0, 1] from an array of evidence.
 *
 * Ladder principles:
 * - HEURISTIC alone: 0.40 - 0.50
 * - STRUCTURAL (AST) alone: 0.75 - 0.82
 * - SEMANTIC (Compiler type-confirmed): 0.95 - 0.98
 * - OBSERVED (Runtime trace): 0.95 + log bonus (up to 0.999)
 * - CORROBORATED (Multi-evidence: e.g. AST + Compiler + Runtime): 0.99+
 */
export function calculateCalibratedConfidence(
  evidenceList: Array<Evidence | { kind: string; strength?: string; observations?: number; environments?: string[]; testSuites?: string[]; confidenceState?: string }>,
  options?: { isDynamic?: boolean },
): number {
  if (!evidenceList || evidenceList.length === 0) {
    return 0.1;
  }

  // Filter out evidence with UNKNOWN confidence state from positive signal calculation
  const validEvidence = evidenceList.filter((e) => (e as any).confidenceState !== "UNKNOWN");
  if (validEvidence.length === 0) {
    return 0.1;
  }

  const kinds = new Set(validEvidence.map((e) => e.kind));
  const strengths = new Set(validEvidence.map((e) => e.strength));

  // Dynamic dispatch penalty (Evidence Ladder E0-E5):
  // When an access is dynamic and unconfirmed by runtime observation or compiler symbol,
  // confidence is capped around 0.42.
  if (options?.isDynamic && !kinds.has("RUNTIME") && !kinds.has("COMPILER")) {
    return 0.42;
  }

  let totalObservations = 0;
  for (const ev of validEvidence) {
    if (ev.observations && ev.observations > 0) {
      totalObservations += ev.observations;
    }
  }

  // Corroborated: AST + COMPILER + RUNTIME
  if (kinds.has("AST") && kinds.has("COMPILER") && kinds.has("RUNTIME")) {
    const obsBonus = Math.min(0.009, Math.log10(totalObservations + 1) * 0.002);
    return Math.min(0.999, 0.99 + obsBonus);
  }

  // Corroborated: COMPILER + RUNTIME
  if (kinds.has("COMPILER") && kinds.has("RUNTIME")) {
    const obsBonus = Math.min(0.008, Math.log10(totalObservations + 1) * 0.002);
    return Math.min(0.998, 0.985 + obsBonus);
  }

  // Runtime Observed
  if (kinds.has("RUNTIME") || strengths.has("OBSERVED")) {
    const obsBonus = Math.min(0.045, Math.log10(totalObservations + 1) * 0.01);
    return Math.min(0.995, 0.95 + obsBonus);
  }

  // Semantic Compiler Truth
  if (kinds.has("COMPILER") || strengths.has("SEMANTIC")) {
    return 0.97;
  }

  // Corroborated: AST + GIT or TEST
  if (kinds.has("AST") && (kinds.has("GIT") || kinds.has("TEST"))) {
    return 0.88;
  }

  // Heuristic (unconfirmed by compiler or runtime)
  if (strengths.has("HEURISTIC") && !kinds.has("COMPILER") && !kinds.has("RUNTIME")) {
    return 0.45;
  }

  // Structural AST
  if (kinds.has("AST") || strengths.has("STRUCTURAL")) {
    return 0.80;
  }

  return 0.50;
}

/**
 * Generates an explainability trace ("why") explaining how confidence was derived and any missing signals.
 */
export function generateWhyExplanation(
  evidenceList: Array<Evidence | { kind: string; strength?: string; observations?: number; environments?: string[]; testSuites?: string[] }>,
  context?: {
    isDynamic?: boolean;
    unresolvedTarget?: boolean;
    rawExpression?: string;
  },
): string[] {
  const why: string[] = [];
  const kinds = new Set(evidenceList.map((e) => e.kind));

  if (context?.isDynamic) {
    why.push("dynamic property access");
  }

  if (context?.unresolvedTarget || !kinds.has("COMPILER")) {
    why.push("no compiler-resolved target");
  } else if (kinds.has("COMPILER")) {
    why.push("compiler confirmed type resolution");
  }

  if (kinds.has("AST")) {
    why.push("AST verified");
  }

  const runtimeEv = evidenceList.find((e) => e.kind === "RUNTIME");
  if (runtimeEv && runtimeEv.observations) {
    const envs = runtimeEv.environments?.join(", ") ?? "test";
    why.push(`observed ${runtimeEv.observations} calls across [${envs}]`);
  } else {
    why.push("no runtime observation");
  }

  const gitEv = evidenceList.find((e) => e.kind === "GIT");
  if (gitEv && gitEv.observations) {
    why.push(`git co-change history (${gitEv.observations} shared commits)`);
  }

  const testEv = evidenceList.find((e) => e.kind === "TEST");
  if (testEv && testEv.testSuites && testEv.testSuites.length > 0) {
    why.push(`covered by ${testEv.testSuites.length} test suites`);
  }

  return why;
}

// ---------------------------------------------------------------------------
// Legacy & Unified Graph Models (Backwards Compatible)
// ---------------------------------------------------------------------------

export interface GraphNode {
  id: string;
  kind: string;
  label: string;
  path?: string;
  confidence: Confidence;
  metadata: Record<string, unknown>;
  evidence: string[];
}

export interface GraphEdge {
  from: string;
  to: string;
  relation: string;
  confidence: Confidence;
  metadata: Record<string, unknown>;
  evidence: string[];
}

export interface DependencyGraph {
  schemaVersion: 1;
  graphType: "dependency";
  generatedAt: string;
  scope: string;
  /** Git commit HEAD was at when the graph was built; enables freshness checks. Absent for non-git repos. */
  commit?: string;
  /** Hash of the approved graph source universe, including uncommitted bytes. */
  workspaceHash?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  unknowns: string[];
}

export class SchemaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaValidationError";
  }
}

function validateConfidence(value: unknown, path: string): Confidence {
  if (value === "verified" || value === "inferred" || value === "unknown") {
    return value;
  }
  throw new SchemaValidationError(`${path}: confidence must be "verified" | "inferred" | "unknown", got ${JSON.stringify(value)}`);
}

function validateNode(value: unknown, index: number): GraphNode {
  if (!value || typeof value !== "object") throw new SchemaValidationError(`nodes[${index}]: must be an object`);
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !v.id) throw new SchemaValidationError(`nodes[${index}].id: must be a non-empty string`);
  if (typeof v.kind !== "string" || !v.kind) throw new SchemaValidationError(`nodes[${index}].kind: must be a non-empty string`);
  if (typeof v.label !== "string") throw new SchemaValidationError(`nodes[${index}].label: must be a string`);
  if (!Array.isArray(v.evidence)) throw new SchemaValidationError(`nodes[${index}].evidence: must be an array`);
  return {
    id: v.id,
    kind: v.kind,
    label: v.label,
    path: typeof v.path === "string" ? v.path : undefined,
    confidence: validateConfidence(v.confidence, `nodes[${index}].confidence`),
    metadata: (v.metadata && typeof v.metadata === "object" && !Array.isArray(v.metadata)) ? (v.metadata as Record<string, unknown>) : {},
    evidence: (v.evidence as unknown[]).map((e, i) => {
      if (typeof e !== "string") throw new SchemaValidationError(`nodes[${index}].evidence[${i}]: must be a string`);
      return e;
    }),
  };
}

function validateEdge(value: unknown, index: number): GraphEdge {
  if (!value || typeof value !== "object") throw new SchemaValidationError(`edges[${index}]: must be an object`);
  const v = value as Record<string, unknown>;
  if (typeof v.from !== "string" || !v.from) throw new SchemaValidationError(`edges[${index}].from: must be a non-empty string`);
  if (typeof v.to !== "string" || !v.to) throw new SchemaValidationError(`edges[${index}].to: must be a non-empty string`);
  if (typeof v.relation !== "string" || !v.relation) throw new SchemaValidationError(`edges[${index}].relation: must be a non-empty string`);
  if (!Array.isArray(v.evidence)) throw new SchemaValidationError(`edges[${index}].evidence: must be an array`);
  return {
    from: v.from,
    to: v.to,
    relation: v.relation,
    confidence: validateConfidence(v.confidence, `edges[${index}].confidence`),
    metadata: (v.metadata && typeof v.metadata === "object" && !Array.isArray(v.metadata)) ? (v.metadata as Record<string, unknown>) : {},
    evidence: (v.evidence as unknown[]).map((e, i) => {
      if (typeof e !== "string") throw new SchemaValidationError(`edges[${index}].evidence[${i}]: must be a string`);
      return e;
    }),
  };
}

export function validateGraph(value: unknown): DependencyGraph {
  if (!value || typeof value !== "object") throw new SchemaValidationError("graph: must be an object");
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== 1) throw new SchemaValidationError(`schemaVersion: must be 1, got ${JSON.stringify(v.schemaVersion)}`);
  if (v.graphType !== "dependency") throw new SchemaValidationError(`graphType: must be "dependency", got ${JSON.stringify(v.graphType)}`);
  if (typeof v.generatedAt !== "string") throw new SchemaValidationError("generatedAt: must be a string");
  if (typeof v.scope !== "string") throw new SchemaValidationError("scope: must be a string");
  if (!Array.isArray(v.nodes)) throw new SchemaValidationError("nodes: must be an array");
  if (!Array.isArray(v.edges)) throw new SchemaValidationError("edges: must be an array");
  if (!Array.isArray(v.unknowns)) throw new SchemaValidationError("unknowns: must be an array");
  if (v.commit !== undefined && typeof v.commit !== "string") {
    throw new SchemaValidationError("commit: must be a string when present");
  }
  if (v.workspaceHash !== undefined && typeof v.workspaceHash !== "string") {
    throw new SchemaValidationError("workspaceHash: must be a string when present");
  }
  return {
    schemaVersion: 1,
    graphType: "dependency",
    generatedAt: v.generatedAt,
    scope: v.scope,
    ...(typeof v.commit === "string" ? { commit: v.commit } : {}),
    ...(typeof v.workspaceHash === "string" ? { workspaceHash: v.workspaceHash } : {}),
    nodes: (v.nodes as unknown[]).map(validateNode),
    edges: (v.edges as unknown[]).map(validateEdge),
    unknowns: (v.unknowns as unknown[]).map((u, i) => {
      if (typeof u !== "string") throw new SchemaValidationError(`unknowns[${i}]: must be a string`);
      return u;
    }),
  };
}
