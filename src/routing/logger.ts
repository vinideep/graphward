/**
 * Structured Real-Time NDJSON Logger & Metrics Accumulator for GraphWard Codex Auto-Model-Router (Milestone 2)
 * Path: src/routing/logger.ts
 */

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { CostTier, RoutingLogLevel } from "../config/index.js";
import type { CacheStatus, RoutingLogEntry, RoutingStats } from "./types.js";

export type { CacheStatus, RoutingLogEntry };

export interface RoutingLoggerOptions {
  logLevel?: RoutingLogLevel;
  stream?: NodeJS.WritableStream;
  filePath?: string;
  onLog?: (entry: RoutingLogEntry) => void | Promise<void>;
  env?: NodeJS.ProcessEnv;
}

/**
 * Structured Real-Time NDJSON Logger.
 * Emits newline-delimited JSON with guaranteed field structure and line integrity.
 */
export class RoutingLogger {
  private logLevel: RoutingLogLevel;
  private readonly stream?: NodeJS.WritableStream;
  private readonly filePath?: string;
  private readonly onLogCallback?: (entry: RoutingLogEntry) => void | Promise<void>;
  private isLogEnabled: boolean;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: RoutingLoggerOptions = {}) {
    const env = options.env ?? process.env;
    let resolvedLogLevel: RoutingLogLevel = options.logLevel ?? "summary";

    // Handle environment override CODEX_SHIM_ROUTER_LOG
    if (env?.CODEX_SHIM_ROUTER_LOG !== undefined && env.CODEX_SHIM_ROUTER_LOG.trim() !== "") {
      const val = env.CODEX_SHIM_ROUTER_LOG.trim().toLowerCase();
      if (val === "verbose") {
        resolvedLogLevel = "verbose";
      } else if (val === "summary") {
        resolvedLogLevel = "summary";
      } else if (val === "0" || val === "false" || val === "none") {
        resolvedLogLevel = "none";
      } else if (val === "1" || val === "true") {
        resolvedLogLevel = resolvedLogLevel === "none" ? "summary" : resolvedLogLevel;
      }
    }

    this.logLevel = resolvedLogLevel;
    this.isLogEnabled = this.logLevel !== "none";
    this.stream = options.stream;
    this.filePath = options.filePath;
    this.onLogCallback = options.onLog;
  }

  setLogLevel(level: RoutingLogLevel): void {
    this.logLevel = level;
    this.isLogEnabled = this.logLevel !== "none";
  }

  getLogLevel(): RoutingLogLevel {
    return this.logLevel;
  }

  isEnabled(): boolean {
    return this.isLogEnabled;
  }

  /**
   * Emit a structured log entry.
   */
  async log(entry: RoutingLogEntry): Promise<void> {
    if (!this.isLogEnabled) return;

    // Filter payload based on log level
    const payload: RoutingLogEntry =
      this.logLevel === "verbose"
        ? entry
        : {
            taskId: entry.taskId,
            classifierModel: entry.classifierModel,
            scores: entry.scores,
            selectedModel: entry.selectedModel,
            cacheStatus: entry.cacheStatus,
            timestamp: entry.timestamp,
          };

    // 1. Invoke onLog callback if configured (used in test suite)
    if (this.onLogCallback) {
      try {
        await this.onLogCallback(payload);
      } catch {
        // Suppress onLog error to prevent breaking routing flow
      }
    }

    // 2. Format single-line NDJSON
    const line = `${JSON.stringify(payload)}\n`;

    // 3. Emit to stream if provided
    if (this.stream) {
      this.stream.write(line);
      return;
    }

    // 4. Emit to file if configured
    if (this.filePath) {
      const target = this.filePath;
      this.writeQueue = this.writeQueue
        .then(async () => {
          await mkdir(path.dirname(target), { recursive: true });
          await appendFile(target, line, "utf8");
        })
        .catch(() => undefined);
      await this.writeQueue;
      return;
    }

    // 5. Default fallback: stdout if neither file nor custom stream is provided
    if (!this.onLogCallback) {
      process.stdout.write(line);
    }
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }
}

const PREMIUM_BASELINE_COST = 0.03;

const TIER_COST_MAP: Record<CostTier, number> = {
  cheap: 0.001,
  standard: 0.010,
  premium: 0.030,
};

/**
 * Thread-safe In-Memory Metrics Accumulator for ModelRouter.
 */
export class RoutingStatsTracker {
  private totalRouted = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private bypasses = 0;
  private readonly modelDistribution: Record<string, number> = {};
  private estimatedCostSavings = 0.0;

  record(params: {
    model: string;
    tier: CostTier;
    cacheStatus: CacheStatus;
  }): void {
    this.totalRouted++;

    if (params.cacheStatus === "hit") {
      this.cacheHits++;
    } else if (params.cacheStatus === "miss") {
      this.cacheMisses++;
    } else if (params.cacheStatus === "bypass") {
      this.bypasses++;
    }

    // Update distribution
    this.modelDistribution[params.model] = (this.modelDistribution[params.model] || 0) + 1;

    // Cost savings calculation
    const actualCost = TIER_COST_MAP[params.tier] ?? (params.model.includes("mini") ? 0.001 : 0.03);
    const savings = Math.max(0, PREMIUM_BASELINE_COST - actualCost);
    this.estimatedCostSavings += savings;
  }

  getStats(): RoutingStats {
    const total = this.totalRouted;
    const hitRate = total > 0 ? this.cacheHits / total : 0;
    return {
      totalRouted: this.totalRouted,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      cacheHitRate: Math.round(hitRate * 1000) / 1000,
      modelDistribution: { ...this.modelDistribution },
      estimatedCostSavings: Math.round(this.estimatedCostSavings * 10000) / 10000,
      bypasses: this.bypasses,
      bypassed: this.bypasses,
    };
  }

  reset(): void {
    this.totalRouted = 0;
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.bypasses = 0;
    for (const key of Object.keys(this.modelDistribution)) {
      delete this.modelDistribution[key];
    }
    this.estimatedCostSavings = 0.0;
  }
}

/**
 * Format RoutingStats into text table for CLI `gw routing stats`.
 */
export function renderRoutingStats(stats: RoutingStats): string {
  const distributionLines = Object.entries(stats.modelDistribution)
    .map(([model, count]) => `    ${model}: ${count}`)
    .join("\n");

  return [
    "Codex Routing Aggregate Stats:",
    `  Total Routed: ${stats.totalRouted}`,
    `  Cache Hits: ${stats.cacheHits}`,
    `  Cache Misses: ${stats.cacheMisses}`,
    `  Cache Hit Rate: ${(stats.cacheHitRate * 100).toFixed(1)}%`,
    `  Cost Savings: $${stats.estimatedCostSavings.toFixed(4)}`,
    distributionLines ? `  Model Distribution:\n${distributionLines}` : "  Model Distribution: none",
  ].join("\n");
}
