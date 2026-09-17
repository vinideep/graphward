import type { RawSpan } from "./privacy-policy.js";
import { TracePrivacyPolicy } from "./privacy-policy.js";

export type InstrumentationLevel = "OFF" | "BOUNDARY" | "TARGETED" | "DEEP";

export type TracingMode = "MODE_A_OTEL" | "MODE_B_PROBES" | "MODE_C_TEST_DIAGNOSTIC";

export interface ObservabilityBudget {
  level: InstrumentationLevel;
  maxInstrumentedSymbols: number; // e.g. 500 in BOUNDARY, 50 in TARGETED
  maxSpansPerSec: number; // e.g. 2,000 spans/sec limit
  maxTraceStorageBytes: number; // e.g. 500MB max before aggregation flush
  maxOverheadPct: number; // e.g. 5% CPU overhead ceiling
}

export const DEFAULT_OBSERVABILITY_BUDGET: ObservabilityBudget = {
  level: "BOUNDARY",
  maxInstrumentedSymbols: 500,
  maxSpansPerSec: 2000,
  maxTraceStorageBytes: 500 * 1024 * 1024, // 500MB
  maxOverheadPct: 5.0, // 5%
};

export interface TracerStats {
  mode: TracingMode;
  level: InstrumentationLevel;
  totalSpansRecorded: number;
  totalSpansDropped: number;
  currentSpansPerSec: number;
  instrumentedSymbolsCount: number;
  currentStorageBytes: number;
  overheadPctEstimate: number;
  budgetExceeded: boolean;
}

export class RuntimeTracer {
  private budget: ObservabilityBudget;
  private privacyPolicy: TracePrivacyPolicy;
  private mode: TracingMode;
  private instrumentedSymbols = new Set<string>();
  private targetedSymbols = new Set<string>();
  private activeTestSuite?: string;
  private activeTestCase?: string;

  // Rate limiting & sliding window
  private spanTimestamps: number[] = [];
  private totalRecorded = 0;
  private totalDropped = 0;
  private currentStorageBytes = 0;
  private totalTracingDurationMs = 0;
  private totalOperationDurationMs = 0;

  constructor(
    mode: TracingMode = "MODE_A_OTEL",
    budget: Partial<ObservabilityBudget> = {},
    privacyPolicy: TracePrivacyPolicy = new TracePrivacyPolicy()
  ) {
    this.mode = mode;
    this.budget = { ...DEFAULT_OBSERVABILITY_BUDGET, ...budget };
    this.privacyPolicy = privacyPolicy;
  }

  public setMode(mode: TracingMode): void {
    this.mode = mode;
  }

  public getMode(): TracingMode {
    return this.mode;
  }

  public setLevel(level: InstrumentationLevel): void {
    this.budget.level = level;
  }

  public getBudget(): ObservabilityBudget {
    return { ...this.budget };
  }

  public updateBudget(newBudget: Partial<ObservabilityBudget>): void {
    this.budget = { ...this.budget, ...newBudget };
  }

  public setTargetedSymbols(symbols: string[]): void {
    this.targetedSymbols = new Set(symbols);
  }

  public addTargetedSymbol(symbol: string): void {
    this.targetedSymbols.add(symbol);
  }

  /**
   * Mode C Diagnostic Test Context
   */
  public setTestContext(suite: string, testCase?: string): void {
    this.activeTestSuite = suite;
    this.activeTestCase = testCase;
  }

  public clearTestContext(): void {
    this.activeTestSuite = undefined;
    this.activeTestCase = undefined;
  }

  /**
   * Evaluates whether a symbol can be instrumented according to the active level and budget.
   */
  public shouldInstrumentSymbol(symbolId: string, isBoundary: boolean = false): boolean {
    if (this.budget.level === "OFF") {
      return false;
    }

    if (this.instrumentedSymbols.size >= this.budget.maxInstrumentedSymbols && !this.instrumentedSymbols.has(symbolId)) {
      return false;
    }

    switch (this.budget.level) {
      case "BOUNDARY":
        if (isBoundary) {
          this.instrumentedSymbols.add(symbolId);
          return true;
        }
        return false;

      case "TARGETED":
        if (this.targetedSymbols.has(symbolId)) {
          this.instrumentedSymbols.add(symbolId);
          return true;
        }
        return false;

      case "DEEP":
        this.instrumentedSymbols.add(symbolId);
        return true;

      default:
        return false;
    }
  }

  /**
   * Records a span through the tracer, enforcing privacy policy, rate limiting, and observability budget.
   * Returns true if span was recorded, false if dropped.
   */
  public recordSpan(rawSpan: RawSpan, executionDurationMs: number = 0, tracingOverheadMs: number = 0): boolean {
    const now = Date.now();

    // Mode B Probe Check
    if (this.mode === "MODE_B_PROBES" && this.budget.level === "OFF") {
      this.totalDropped++;
      return false;
    }

    // Clean up sliding 1-second window for rate calculation
    const oneSecAgo = now - 1000;
    while (this.spanTimestamps.length > 0 && this.spanTimestamps[0] < oneSecAgo) {
      this.spanTimestamps.shift();
    }

    // Rate Limit Check
    if (this.spanTimestamps.length >= this.budget.maxSpansPerSec) {
      this.totalDropped++;
      return false;
    }

    // Storage Size Check
    const estimatedSpanBytes = JSON.stringify(rawSpan).length;
    if (this.currentStorageBytes + estimatedSpanBytes > this.budget.maxTraceStorageBytes) {
      this.totalDropped++;
      return false;
    }

    // Mode C Test Diagnostic tagging
    if (this.mode === "MODE_C_TEST_DIAGNOSTIC" && this.activeTestSuite) {
      rawSpan.attributes = rawSpan.attributes ?? {};
      rawSpan.attributes["test.suite"] = this.activeTestSuite;
      if (this.activeTestCase) {
        rawSpan.attributes["test.case"] = this.activeTestCase;
      }
    }

    // Apply Privacy Policy
    const sanitized = this.privacyPolicy.sanitizeSpan(rawSpan);
    if (!sanitized) {
      this.totalDropped++;
      return false;
    }

    // Update metrics
    this.spanTimestamps.push(now);
    this.totalRecorded++;
    this.currentStorageBytes += estimatedSpanBytes;

    if (executionDurationMs > 0 || tracingOverheadMs > 0) {
      this.totalOperationDurationMs += executionDurationMs + tracingOverheadMs;
      this.totalTracingDurationMs += tracingOverheadMs;
    }

    return true;
  }

  /**
   * Resets trace storage buffer (e.g. after aggregation flush).
   */
  public flushStorage(): void {
    this.currentStorageBytes = 0;
  }

  /**
   * Returns current tracer statistics and budget compliance.
   */
  public getStats(): TracerStats {
    const now = Date.now();
    const oneSecAgo = now - 1000;
    const currentRate = this.spanTimestamps.filter((t) => t >= oneSecAgo).length;

    const overheadPct =
      this.totalOperationDurationMs > 0
        ? (this.totalTracingDurationMs / this.totalOperationDurationMs) * 100
        : 0;

    const budgetExceeded =
      currentRate > this.budget.maxSpansPerSec ||
      this.currentStorageBytes > this.budget.maxTraceStorageBytes ||
      overheadPct > this.budget.maxOverheadPct;

    return {
      mode: this.mode,
      level: this.budget.level,
      totalSpansRecorded: this.totalRecorded,
      totalSpansDropped: this.totalDropped,
      currentSpansPerSec: currentRate,
      instrumentedSymbolsCount: this.instrumentedSymbols.size,
      currentStorageBytes: this.currentStorageBytes,
      overheadPctEstimate: Number(overheadPct.toFixed(2)),
      budgetExceeded,
    };
  }
}
