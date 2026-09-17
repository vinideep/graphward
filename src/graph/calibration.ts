import type { Evidence, ConfidenceState } from "./schema.js";
import { calculateCalibratedConfidence } from "./schema.js";

export interface CalibrationBin {
  lowerBound: number;
  upperBound: number;
  predictionsCount: number;
  positiveOutcomes: number;
  empiricalAccuracy: number;
  sumPredicted?: number;
}

export interface CalibrationReport {
  sampleSize: number;
  expectedCalibrationError: number; // ECE [0, 1]
  brierScore: number; // [0, 1]
  bins: CalibrationBin[];
  isCalibrated: boolean;
}

/**
 * Empirical Confidence Calibration Model (GraphWard v2.2)
 *
 * Employs non-parametric empirical binning (Platt / Isotonic-inspired)
 * to ensure that when GraphWard claims 90% confidence on a dependency,
 * it holds true 90% of the time in real code executions.
 */
export class EmpiricalCalibrationModel {
  private binCount: number;
  private bins: CalibrationBin[];
  private historicalSamples: Array<{ predicted: number; actual: number }> = [];

  constructor(binCount: number = 10) {
    this.binCount = binCount;
    this.bins = [];
    const step = 1.0 / binCount;
    for (let i = 0; i < binCount; i++) {
      this.bins.push({
        lowerBound: i * step,
        upperBound: (i + 1) * step,
        predictionsCount: 0,
        positiveOutcomes: 0,
        empiricalAccuracy: (i + 0.5) * step, // prior mean
        sumPredicted: 0,
      });
    }
  }

  /**
   * Records a historical validation outcome (e.g. from prediction vs reality or test run).
   */
  public recordObservation(predictedConfidence: number, actualSuccess: boolean): void {
    const clamped = Math.max(0.0, Math.min(1.0, predictedConfidence));
    const outcome = actualSuccess ? 1 : 0;
    this.historicalSamples.push({ predicted: clamped, actual: outcome });

    const binIndex = Math.min(
      this.binCount - 1,
      Math.floor(clamped * this.binCount)
    );

    const b = this.bins[binIndex];
    b.predictionsCount++;
    b.sumPredicted = (b.sumPredicted ?? 0) + clamped;
    if (actualSuccess) {
      b.positiveOutcomes++;
    }
    b.empiricalAccuracy = Number((b.positiveOutcomes / b.predictionsCount).toFixed(3));
  }

  /**
   * Calibrates a raw confidence score using the empirical bin distribution.
   */
  public calibrate(rawScore: number): number {
    const clamped = Math.max(0.0, Math.min(1.0, rawScore));
    const binIndex = Math.min(
      this.binCount - 1,
      Math.floor(clamped * this.binCount)
    );

    const b = this.bins[binIndex];
    // If sufficient observations exist in bin, blend empirical accuracy with prior
    if (b.predictionsCount >= 5) {
      const alpha = Math.min(0.85, b.predictionsCount / 50.0);
      return Number((alpha * b.empiricalAccuracy + (1 - alpha) * clamped).toFixed(3));
    }

    return Number(clamped.toFixed(3));
  }

  /**
   * Calculates Expected Calibration Error (ECE) across all bins.
   * ECE = sum_b (|B_b| / N) * |acc(B_b) - conf(B_b)|
   */
  public calculateECE(): number {
    const N = this.historicalSamples.length;
    if (N === 0) return 0.0;

    let totalWeightedError = 0;
    for (const b of this.bins) {
      if (b.predictionsCount === 0) continue;
      const binConfidence = (b.sumPredicted !== undefined && b.predictionsCount > 0)
        ? b.sumPredicted / b.predictionsCount
        : (b.lowerBound + b.upperBound) / 2.0;
      const error = Math.abs(b.empiricalAccuracy - binConfidence);
      totalWeightedError += (b.predictionsCount / N) * error;
    }

    return Number(totalWeightedError.toFixed(4));
  }

  /**
   * Calculates the Mean Squared Error (Brier Score).
   */
  public calculateBrierScore(): number {
    const N = this.historicalSamples.length;
    if (N === 0) return 0.0;

    let sumSq = 0;
    for (const s of this.historicalSamples) {
      const diff = s.predicted - s.actual;
      sumSq += diff * diff;
    }

    return Number((sumSq / N).toFixed(4));
  }

  /**
   * Evaluates evidence array and returns calibrated score with explicit confidence state.
   */
  public calibrateFromEvidence(
    evidenceList: Evidence[],
    options?: { isDynamic?: boolean }
  ): {
    calibratedScore: number;
    confidenceState: ConfidenceState;
    ece: number;
  } {
    const rawScore = calculateCalibratedConfidence(evidenceList, options);
    const calibratedScore = this.calibrate(rawScore);
    const ece = this.calculateECE();

    let confidenceState: ConfidenceState = "ESTIMATED";
    if (this.historicalSamples.length >= 20 && ece <= 0.08) {
      confidenceState = "CALIBRATED";
    }

    return {
      calibratedScore,
      confidenceState,
      ece,
    };
  }

  public getReport(): CalibrationReport {
    const ece = this.calculateECE();
    const brier = this.calculateBrierScore();
    return {
      sampleSize: this.historicalSamples.length,
      expectedCalibrationError: ece,
      brierScore: brier,
      bins: this.bins.map((b) => ({ ...b })),
      isCalibrated: this.historicalSamples.length >= 20 && ece <= 0.08,
    };
  }
}

export const defaultCalibrationModel = new EmpiricalCalibrationModel(10);
