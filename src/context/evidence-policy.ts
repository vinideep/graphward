import type { SymbolId } from "../graph/symbol-identity.js";

export type RiskTier = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type PolicyAction = "PROCEED" | "RETRIEVE" | "VERIFY" | "REFUSE";

export interface EvidencePolicyEvaluationInput {
  symbol?: SymbolId;
  task: string;
  changedFiles?: string[];
  isPublicApi?: boolean;
  isDatabaseSchema?: boolean;
  isPaymentContract?: boolean;
  hasUnknownCallers?: boolean;
  routeExposure?: boolean;
  dependentTestCount?: number;
  runtimeInvocations?: number;
}

export interface EvidencePolicyDecision {
  tier: RiskTier;
  action: PolicyAction;
  reasons: string[];
  requiredValidations: string[];
  blocked: boolean;
  provenanceBadge: string;
}

/**
 * Formal EvidencePolicy Decision Matrix (v2.2 Frozen Specification)
 *
 * Rules:
 * - LOW: Local edit, 0 dynamic calls, 0 route exposure -> PROCEED (allow direct implementation)
 * - MEDIUM: Internal module interface change, 1-2 test dependencies -> RETRIEVE (require targeted closure retrieval)
 * - HIGH: Public API change, database schema, payment contract -> VERIFY (require pre-flight verification & affected tests)
 * - CRITICAL: High runtime exposure + unresolved unknown downstream callers -> REFUSE (block broad edits)
 */
export function evaluateEvidencePolicy(input: EvidencePolicyEvaluationInput): EvidencePolicyDecision {
  const reasons: string[] = [];
  const requiredValidations: string[] = [];

  const taskLower = input.task.toLowerCase();
  const changedFiles = input.changedFiles ?? [];

  // Check CRITICAL conditions:
  // High runtime exposure + unresolved unknown downstream callers
  const isCriticalRisk =
    (input.hasUnknownCallers || taskLower.includes("unknown_dynamic") || taskLower.includes("unresolved unknown")) &&
    (input.routeExposure || (input.runtimeInvocations && input.runtimeInvocations > 1000) || taskLower.includes("high runtime"));

  if (isCriticalRisk) {
    reasons.push("Unresolved unknown dynamic downstream callers under high runtime exposure");
    requiredValidations.push("Resolve dynamic property/reflection boundaries before modification");
    return {
      tier: "CRITICAL",
      action: "REFUSE",
      reasons,
      requiredValidations,
      blocked: true,
      provenanceBadge: "CRITICAL-REFUSE [UNKNOWN BOUNDARY DETECTED]",
    };
  }

  // Check HIGH conditions:
  // Public API change, database schema, payment contract
  const isHighRisk =
    input.isPublicApi ||
    input.isDatabaseSchema ||
    input.isPaymentContract ||
    changedFiles.some((f) => f.includes("schema") || f.includes("payment") || f.includes("migration") || f.includes("gateway")) ||
    taskLower.includes("payment") ||
    taskLower.includes("database schema") ||
    taskLower.includes("public api") ||
    taskLower.includes("breaking change");

  if (isHighRisk) {
    if (input.isPaymentContract || taskLower.includes("payment")) {
      reasons.push("Touches critical payment financial processing contract");
      requiredValidations.push("Run payment integration test suite");
      requiredValidations.push("Verify transaction idempotency guarantees");
    }
    if (input.isDatabaseSchema || changedFiles.some((f) => f.includes("schema") || f.includes("migration"))) {
      reasons.push("Database schema or migration boundary change");
      requiredValidations.push("Run migration-safety check");
    }
    if (input.isPublicApi || taskLower.includes("public api")) {
      reasons.push("Modifies public API contract surface");
      requiredValidations.push("Verify backwards compatibility and route contracts");
    }

    return {
      tier: "HIGH",
      action: "VERIFY",
      reasons,
      requiredValidations,
      blocked: false,
      provenanceBadge: "HIGH-VERIFY [PRE-FLIGHT VALIDATION REQUIRED]",
    };
  }

  // Check MEDIUM conditions:
  // Internal module interface change, 1-2 test dependencies
  const isMediumRisk =
    (input.dependentTestCount !== undefined && input.dependentTestCount > 0) ||
    changedFiles.length > 1 ||
    taskLower.includes("refactor") ||
    taskLower.includes("service") ||
    taskLower.includes("module");

  if (isMediumRisk) {
    reasons.push("Internal module interface change with dependent test coverage");
    requiredValidations.push("Retrieve targeted dependency closure before editing");
    requiredValidations.push("Run affected unit tests");

    return {
      tier: "MEDIUM",
      action: "RETRIEVE",
      reasons,
      requiredValidations,
      blocked: false,
      provenanceBadge: "MEDIUM-RETRIEVE [TARGETED CLOSURE RETRIEVED]",
    };
  }

  // Otherwise LOW: Local variable / internal function edit, 0 dynamic calls, 0 route exposure
  reasons.push("Local internal change with zero external route or schema exposure");
  return {
    tier: "LOW",
    action: "PROCEED",
    reasons,
    requiredValidations: ["Standard typecheck"],
    blocked: false,
    provenanceBadge: "LOW-PROCEED [DIRECT EDIT AUTHORIZED]",
  };
}
