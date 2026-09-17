import type { SymbolId } from "../graph/symbol-identity.js";
import type { Change } from "../graph/schema.js";

export interface ImpactPrediction {
  files: string[];
  symbols: SymbolId[];
}

export interface ActualImpact {
  modifiedFiles: string[];
  modifiedSymbols: SymbolId[];
}

export interface PredictionAccuracyMetrics {
  filePrecision: number;
  fileRecall: number;
  fileF1: number;
  symbolPrecision: number;
  symbolRecall: number;
  symbolF1: number;
  overallScore: number;
}

export interface HistoricalAccuracyRecord {
  changeId: string;
  timestamp: string;
  metrics: PredictionAccuracyMetrics;
}

export class PredictionAccuracyTracker {
  private history: HistoricalAccuracyRecord[] = [];

  /**
   * Computes precision, recall, and F1 metrics between predicted impact and verified reality.
   */
  public computeAccuracy(
    predicted: ImpactPrediction,
    actual: ActualImpact
  ): PredictionAccuracyMetrics {
    // 1. File metrics
    const predFiles = new Set(predicted.files.map((f) => this.normalizePath(f)));
    const actFiles = new Set(actual.modifiedFiles.map((f) => this.normalizePath(f)));

    let fileIntersection = 0;
    for (const f of predFiles) {
      if (actFiles.has(f)) fileIntersection++;
    }

    const filePrecision = predFiles.size > 0 ? fileIntersection / predFiles.size : 1.0;
    const fileRecall = actFiles.size > 0 ? fileIntersection / actFiles.size : 1.0;
    const fileF1 =
      filePrecision + fileRecall > 0
        ? (2 * filePrecision * fileRecall) / (filePrecision + fileRecall)
        : 0;

    // 2. Symbol metrics
    const predSymbols = new Set(predicted.symbols.map((s) => `${this.normalizePath(s.path)}#${s.qualifiedName}`));
    const actSymbols = new Set(actual.modifiedSymbols.map((s) => `${this.normalizePath(s.path)}#${s.qualifiedName}`));

    let symbolIntersection = 0;
    for (const s of predSymbols) {
      if (actSymbols.has(s)) symbolIntersection++;
    }

    const symbolPrecision = predSymbols.size > 0 ? symbolIntersection / predSymbols.size : 1.0;
    const symbolRecall = actSymbols.size > 0 ? symbolIntersection / actSymbols.size : 1.0;
    const symbolF1 =
      symbolPrecision + symbolRecall > 0
        ? (2 * symbolPrecision * symbolRecall) / (symbolPrecision + symbolRecall)
        : 0;

    const overallScore = Number(((fileF1 + symbolF1) / 2).toFixed(3));

    return {
      filePrecision: Number(filePrecision.toFixed(3)),
      fileRecall: Number(fileRecall.toFixed(3)),
      fileF1: Number(fileF1.toFixed(3)),
      symbolPrecision: Number(symbolPrecision.toFixed(3)),
      symbolRecall: Number(symbolRecall.toFixed(3)),
      symbolF1: Number(symbolF1.toFixed(3)),
      overallScore,
    };
  }

  /**
   * Records verification result of a Change entity and attaches accuracy metrics.
   */
  public recordChangeOutcome(change: Change, actual: ActualImpact): PredictionAccuracyMetrics {
    const metrics = this.computeAccuracy(
      {
        files: change.predictedImpact.affectedFiles,
        symbols: change.predictedImpact.affectedSymbols,
      },
      actual
    );

    change.actualImpact = {
      modifiedFiles: actual.modifiedFiles,
      modifiedSymbols: actual.modifiedSymbols,
      brokenTests: [],
    };

    change.predictionAccuracy = {
      filePrecision: metrics.filePrecision,
      fileRecall: metrics.fileRecall,
      symbolPrecision: metrics.symbolPrecision,
      symbolRecall: metrics.symbolRecall,
    };

    this.history.push({
      changeId: change.id,
      timestamp: new Date().toISOString(),
      metrics,
    });

    return metrics;
  }

  public getHistory(): HistoricalAccuracyRecord[] {
    return [...this.history];
  }

  public getAggregatedMetrics(): {
    meanFilePrecision: number;
    meanFileRecall: number;
    meanSymbolPrecision: number;
    meanSymbolRecall: number;
    sampleCount: number;
  } {
    if (this.history.length === 0) {
      return {
        meanFilePrecision: 1.0,
        meanFileRecall: 1.0,
        meanSymbolPrecision: 1.0,
        meanSymbolRecall: 1.0,
        sampleCount: 0,
      };
    }

    let sumFP = 0;
    let sumFR = 0;
    let sumSP = 0;
    let sumSR = 0;

    for (const h of this.history) {
      sumFP += h.metrics.filePrecision;
      sumFR += h.metrics.fileRecall;
      sumSP += h.metrics.symbolPrecision;
      sumSR += h.metrics.symbolRecall;
    }

    const n = this.history.length;
    return {
      meanFilePrecision: Number((sumFP / n).toFixed(3)),
      meanFileRecall: Number((sumFR / n).toFixed(3)),
      meanSymbolPrecision: Number((sumSP / n).toFixed(3)),
      meanSymbolRecall: Number((sumSR / n).toFixed(3)),
      sampleCount: n,
    };
  }

  private normalizePath(p: string): string {
    return p.replace(/\\/g, "/").replace(/^\.\//, "");
  }
}
