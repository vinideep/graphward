import type { RiskTier } from "../context/evidence-policy.js";
import type { PredictedImpact } from "../simulation/change-simulator.js";

export interface RiskProfileDimensions {
  blastRadiusRisk: number; // 0.0 to 1.0
  runtimeExposureRisk: number; // 0.0 to 1.0
  unknownBoundaryRisk: number; // 0.0 to 1.0
  testCoverageDeficit: number; // 0.0 to 1.0
  architecturalPurityRisk: number; // 0.0 to 1.0
}

export interface RiskProfile {
  tier: RiskTier;
  compositeScore: number; // 0.0 to 1.0
  dimensions: RiskProfileDimensions;
  summary: string;
  verificationPlan?: VerificationTierPlan;
}

export interface VerificationTierPlan {
  tierNumber: 1 | 2 | 3 | 4;
  tierName: "SMOKE" | "TARGETED" | "COMPREHENSIVE" | "AIR_TIGHT";
  requiredGates: string[];
  executionSteps: string[];
  requiresHumanApproval: boolean;
}

export interface RiskAssessmentInput {
  predictedImpact: PredictedImpact;
  inboundRuntimeRequests?: number;
  hasUnknownBoundaries?: boolean;
  existingTestCount?: number;
  introducesCycle?: boolean;
  isPublicApi?: boolean;
  isFinancialOrDb?: boolean;
}

export class RiskEngine {
  /**
   * Assesses multi-dimensional risk profile based on structural impact and runtime metrics.
   */
  public static assessRisk(input: RiskAssessmentInput): RiskProfile {
    return new RiskEngine().assessRisk(input);
  }

  public assessRisk(input: RiskAssessmentInput): RiskProfile {
    const predictedImpact = input?.predictedImpact ?? {
      affectedFiles: [],
      affectedSymbols: [],
      affectedRoutes: [],
      affectedExecutionPaths: [],
      suggestedTests: [],
    };
    const affectedFiles = Array.isArray(predictedImpact.affectedFiles) ? predictedImpact.affectedFiles : [];
    const affectedSymbols = Array.isArray(predictedImpact.affectedSymbols) ? predictedImpact.affectedSymbols : [];
    const affectedRoutes = Array.isArray(predictedImpact.affectedRoutes) ? predictedImpact.affectedRoutes : [];

    // 1. Blast Radius: normalized based on affected files/symbols count
    const totalEntities = affectedFiles.length + affectedSymbols.length;
    const blastRadiusRisk = Math.min(1.0, totalEntities / 15.0);

    // 2. Runtime Exposure: route exposure and request volume
    const routeFactor = affectedRoutes.length > 0 ? 0.5 : 0.0;
    const volumeFactor = Math.min(0.5, (input?.inboundRuntimeRequests ?? 0) / 2000.0);
    const runtimeExposureRisk = Math.min(1.0, routeFactor + volumeFactor);

    // 3. Unknown Boundary Risk
    const unknownBoundaryRisk = input?.hasUnknownBoundaries ? 1.0 : 0.0;

    // 4. Test Coverage Deficit
    let testCoverageDeficit = 0.5;
    if (input?.existingTestCount !== undefined) {
      if (input.existingTestCount >= 3) testCoverageDeficit = 0.1;
      else if (input.existingTestCount === 0) testCoverageDeficit = 0.9;
      else testCoverageDeficit = 0.4;
    }

    // 5. Architectural Purity Risk
    const architecturalPurityRisk = input?.introducesCycle ? 1.0 : (input?.isFinancialOrDb || input?.isPublicApi) ? 0.7 : 0.2;

    const dimensions: RiskProfileDimensions = {
      blastRadiusRisk: Number(blastRadiusRisk.toFixed(2)),
      runtimeExposureRisk: Number(runtimeExposureRisk.toFixed(2)),
      unknownBoundaryRisk: Number(unknownBoundaryRisk.toFixed(2)),
      testCoverageDeficit: Number(testCoverageDeficit.toFixed(2)),
      architecturalPurityRisk: Number(architecturalPurityRisk.toFixed(2)),
    };

    // Composite weighted score
    const composite =
      0.25 * dimensions.blastRadiusRisk +
      0.25 * dimensions.runtimeExposureRisk +
      0.20 * dimensions.unknownBoundaryRisk +
      0.15 * dimensions.testCoverageDeficit +
      0.15 * dimensions.architecturalPurityRisk;

    const compositeScore = Number(composite.toFixed(3));

    let tier: RiskTier = "LOW";
    if (dimensions.unknownBoundaryRisk > 0.8 && dimensions.runtimeExposureRisk > 0.5) {
      tier = "CRITICAL";
    } else if (compositeScore >= 0.65 || dimensions.architecturalPurityRisk >= 0.8 || input?.introducesCycle) {
      tier = "CRITICAL";
    } else if (compositeScore >= 0.40 || input?.isFinancialOrDb || input?.isPublicApi) {
      tier = "HIGH";
    } else if (compositeScore >= 0.20 || dimensions.blastRadiusRisk > 0.3) {
      tier = "MEDIUM";
    } else {
      tier = "LOW";
    }

    const profile: RiskProfile = {
      tier,
      compositeScore,
      dimensions,
      summary: `Risk Tier: ${tier} (Composite: ${compositeScore}) [Blast: ${dimensions.blastRadiusRisk}, Runtime: ${dimensions.runtimeExposureRisk}, Unknowns: ${dimensions.unknownBoundaryRisk}]`,
    };
    profile.verificationPlan = this.generateVerificationPlan(profile, predictedImpact.suggestedTests ?? []);
    return profile;
  }

  /**
   * Generates an adaptive verification execution plan based on the computed risk tier.
   */
  public generateVerificationPlan(profile: RiskProfile, suggestedTests: string[] = []): VerificationTierPlan {
    switch (profile.tier) {
      case "LOW":
        return {
          tierNumber: 1,
          tierName: "SMOKE",
          requiredGates: ["typecheck", "linter"],
          executionSteps: [
            "Run TypeScript compiler check (tsc --noEmit)",
            "Run syntax/style linter",
          ],
          requiresHumanApproval: false,
        };

      case "MEDIUM":
        return {
          tierNumber: 2,
          tierName: "TARGETED",
          requiredGates: ["typecheck", "linter", "affected-tests"],
          executionSteps: [
            "Run compiler typecheck",
            `Execute targeted unit tests (${suggestedTests.slice(0, 3).join(", ") || "affected suites"})`,
          ],
          requiresHumanApproval: false,
        };

      case "HIGH":
        return {
          tierNumber: 3,
          tierName: "COMPREHENSIVE",
          requiredGates: ["typecheck", "affected-tests", "api-contract", "regression-suite"],
          executionSteps: [
            "Run compiler typecheck",
            "Execute full affected integration test suite",
            "Perform API backwards-compatibility contract diff",
            "Verify idempotency and migration safety",
          ],
          requiresHumanApproval: false,
        };

      case "CRITICAL":
        return {
          tierNumber: 4,
          tierName: "AIR_TIGHT",
          requiredGates: ["typecheck", "full-test-suite", "counterfactual-cycle-gate", "human-gate"],
          executionSteps: [
            "Run counterfactual overlay dependency cycle check",
            "Resolve dynamic unknown caller boundaries",
            "Execute full project test suite and contract replay",
            "Require explicit human operator confirmation before merge",
          ],
          requiresHumanApproval: true,
        };
    }
  }
}
