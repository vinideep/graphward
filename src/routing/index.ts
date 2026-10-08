/**
 * Routing Subsystem Unified Exports
 * Path: src/routing/index.ts
 */

export * from "./types.js";
export * from "./classifier.js";
export * from "./cache.js";
export * from "./logger.js";
export * from "./model-router.js";
export * from "./codex-shim.js";
export * from "./catalog.js"; // Preserve existing workflow catalog exports

import { loadGwConfig, RoutingConfig } from "../config/index.js";
import { RoutingStats } from "./types.js";
import { ModelRouter } from "./model-router.js";

let globalRouterInstance: ModelRouter | null = null;

export async function getGlobalRouter(projectRoot?: string): Promise<ModelRouter> {
  if (!globalRouterInstance) {
    const config = await loadGwConfig(projectRoot || process.cwd());
    globalRouterInstance = new ModelRouter(config.routing);
  }
  return globalRouterInstance;
}

export function resetGlobalRouter(): void {
  globalRouterInstance = null;
}

export function renderRoutingStatus(config: RoutingConfig): string {
  return [
    "Codex Model Router Status:",
    `  Enabled: ${config.enabled}`,
    `  Threshold: ${config.threshold}`,
    `  Classifier: ${config.classifier}`,
    `  Log Level: ${config.logLevel}`,
    `  Force Model: ${config.forceModel || "none"}`,
  ].join("\n");
}

export function renderRoutingStats(stats: RoutingStats): string {
  const lines = [
    "Codex Routing Aggregate Stats:",
    `  Total Routed: ${stats.totalRouted}`,
    `  Cache Hits: ${stats.cacheHits}`,
    `  Cache Misses: ${stats.cacheMisses}`,
    `  Cache Hit Rate: ${(stats.cacheHitRate * 100).toFixed(1)}%`,
    `  Cost Savings: $${stats.estimatedCostSavings.toFixed(4)}`,
  ];
  if (stats.modelDistribution && Object.keys(stats.modelDistribution).length > 0) {
    lines.push("  Model Distribution:");
    for (const [model, count] of Object.entries(stats.modelDistribution)) {
      lines.push(`    ${model}: ${count}`);
    }
  }
  return lines.join("\n");
}
