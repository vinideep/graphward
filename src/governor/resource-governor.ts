import v8 from "node:v8";

export type DegradationLevel = "NORMAL" | "MEDIUM_PRESSURE" | "HIGH_PRESSURE";

export interface ResourceBudget {
  maxHeapBytes: number;               // Default: 1.5GB
  maxCpuPct: number;                  // Default: 80%
  maxIoBytesPerSec: number;           // Default: 50MB/s
  maxDiskBytes: number;               // Default: 5GB storage
  maxQueueDepth: number;              // Default: 64 tasks
  maxLatencyMs: number;               // Default: 250ms per query
}

export interface ResourceState {
  heapPressure: number;               // 0.0 to 1.0
  cpuPressure: number;
  ioPressure: number;
  diskPressure: number;
  queuePressure: number;
  latencyPressure: number;
  state: "NORMAL" | "DEGRADED" | "CRITICAL";
}

export interface ResourceLimits extends Partial<ResourceBudget> {
  maxHeapBytes: number;
  maxIndexQueueDepth: number;
  maxEmbeddingQueueDepth: number;
  maxRuntimeStorageBytes: number;
  iopsBudgetPerSec: number;
}

export interface ResourceUsageMetrics {
  heapUsedBytes: number;
  heapTotalBytes: number;
  heapLimitBytes: number;
  heapPercentage: number;
  cpuPercentage?: number;
  indexQueueDepth: number;
  maxIndexQueueDepth: number;
  embeddingQueueDepth: number;
  maxEmbeddingQueueDepth: number;
  runtimeStorageBytes: number;
  maxRuntimeStorageBytes: number;
  iopsCurrent: number;
  degradationLevel: DegradationLevel;
  timestamp: string;
}

export interface DegradationPolicy {
  level: DegradationLevel;
  enableTypechecking: boolean;
  enableEmbeddings: boolean;
  enableRuntimeTracing: boolean;
  enableFtsSearch: boolean;
  allowBackgroundVectorization: boolean;
  strategyDescription: string;
}

export class ResourceGovernor {
  private limits: ResourceLimits;
  private indexQueueDepth = 0;
  private embeddingQueueDepth = 0;
  private runtimeStorageBytes = 0;
  private ioOperationsCount = 0;
  private ioBytesCount = 0;
  private lastIoBytesPerSec = 0;
  private lastQueryLatencyMs = 0;
  private lastIoResetTime = Date.now();
  private lastCpuUsage = process.cpuUsage();
  private lastCpuSampleTime = Date.now();

  constructor(customLimits?: Partial<ResourceLimits>) {
    // Default limit: 80% of available V8 heap limit, or default 2GB
    const v8Limit = v8.getHeapStatistics().heap_size_limit;
    this.limits = {
      maxHeapBytes: customLimits?.maxHeapBytes ?? v8Limit,
      maxIndexQueueDepth: customLimits?.maxIndexQueueDepth ?? (customLimits?.maxQueueDepth ?? 32),
      maxEmbeddingQueueDepth: customLimits?.maxEmbeddingQueueDepth ?? 200,
      maxRuntimeStorageBytes: customLimits?.maxRuntimeStorageBytes ?? (customLimits?.maxDiskBytes ?? 5 * 1024 * 1024 * 1024), // 5GB
      iopsBudgetPerSec: customLimits?.iopsBudgetPerSec ?? 1000,
      maxCpuPct: customLimits?.maxCpuPct ?? 80,
      maxIoBytesPerSec: customLimits?.maxIoBytesPerSec ?? 50 * 1024 * 1024,
      maxDiskBytes: customLimits?.maxDiskBytes ?? 5 * 1024 * 1024 * 1024,
      maxQueueDepth: customLimits?.maxQueueDepth ?? 64,
      maxLatencyMs: customLimits?.maxLatencyMs ?? 250,
    };
  }

  setCustomLimits(limits: Partial<ResourceLimits>): void {
    this.limits = { ...this.limits, ...limits };
  }

  getLimits(): ResourceLimits {
    return { ...this.limits };
  }

  recordQueryLatency(latencyMs: number): void {
    this.lastQueryLatencyMs = Math.max(0, latencyMs);
  }

  getResourceBudget(): ResourceBudget {
    return {
      maxHeapBytes: this.limits.maxHeapBytes,
      maxCpuPct: this.limits.maxCpuPct ?? 80,
      maxIoBytesPerSec: this.limits.maxIoBytesPerSec ?? 50 * 1024 * 1024,
      maxDiskBytes: this.limits.maxDiskBytes ?? this.limits.maxRuntimeStorageBytes,
      maxQueueDepth: this.limits.maxQueueDepth ?? this.limits.maxIndexQueueDepth,
      maxLatencyMs: this.limits.maxLatencyMs ?? 250,
    };
  }

  getResourceState(): ResourceState {
    const metrics = this.getMetrics();
    const budget = this.getResourceBudget();
    const heapPressure = Math.min(1, metrics.heapUsedBytes / budget.maxHeapBytes);
    const cpuPressure = Math.min(1, (metrics.cpuPercentage ?? 0) / budget.maxCpuPct);
    const ioPressure = Math.min(
      1,
      Math.max(
        metrics.iopsCurrent / (this.limits.iopsBudgetPerSec || 1000),
        (this.lastIoBytesPerSec || 0) / (budget.maxIoBytesPerSec || 50 * 1024 * 1024),
      ),
    );
    const diskPressure = Math.min(1, metrics.runtimeStorageBytes / budget.maxDiskBytes);
    const queuePressure = Math.min(
      1,
      Math.max(metrics.indexQueueDepth, metrics.embeddingQueueDepth) / (budget.maxQueueDepth || 64),
    );
    const latencyPressure = Math.min(1, this.lastQueryLatencyMs / (budget.maxLatencyMs || 250));

    let state: "NORMAL" | "DEGRADED" | "CRITICAL" = "NORMAL";
    const maxPressure = Math.max(heapPressure, cpuPressure, ioPressure, diskPressure, queuePressure, latencyPressure);
    if (maxPressure >= 0.80) {
      state = "CRITICAL";
    } else if (maxPressure >= 0.65) {
      state = "DEGRADED";
    }

    return {
      heapPressure,
      cpuPressure,
      ioPressure,
      diskPressure,
      queuePressure,
      latencyPressure,
      state,
    };
  }

  setRuntimeStorageBytes(bytes: number): void {
    this.runtimeStorageBytes = Math.max(0, bytes);
  }

  recordBytesStored(bytes: number): void {
    if (bytes > 0) {
      this.runtimeStorageBytes += bytes;
    }
  }

  recordIoOperation(bytesProcessed?: number): void {
    const now = Date.now();
    const elapsed = now - this.lastIoResetTime;
    if (elapsed >= 1000) {
      this.lastIoBytesPerSec = Math.round((this.ioBytesCount * 1000) / Math.max(1, elapsed));
      this.ioOperationsCount = 0;
      this.ioBytesCount = 0;
      this.lastIoResetTime = now;
    }
    this.ioOperationsCount++;
    if (bytesProcessed && bytesProcessed > 0) {
      this.ioBytesCount += bytesProcessed;
      this.runtimeStorageBytes += bytesProcessed;
    }
  }

  enqueueIndexTask(): boolean {
    if (this.indexQueueDepth >= this.limits.maxIndexQueueDepth) {
      return false;
    }
    this.indexQueueDepth++;
    return true;
  }

  dequeueIndexTask(): void {
    if (this.indexQueueDepth > 0) {
      this.indexQueueDepth--;
    }
  }

  enqueueEmbeddingTask(): boolean {
    const policy = this.getActivePolicy();
    if (!policy.allowBackgroundVectorization) {
      return false;
    }
    if (this.embeddingQueueDepth >= this.limits.maxEmbeddingQueueDepth) {
      return false;
    }
    this.embeddingQueueDepth++;
    return true;
  }

  dequeueEmbeddingTask(): void {
    if (this.embeddingQueueDepth > 0) {
      this.embeddingQueueDepth--;
    }
  }

  /**
   * Evaluates live V8 heap statistics and calculates degradation level:
   * - NORMAL (< 65% heap limit)
   * - MEDIUM_PRESSURE (65% - 80% heap limit)
   * - HIGH_PRESSURE (> 80% heap limit)
   */
  getDegradationLevel(simulatedHeapPercent?: number): DegradationLevel {
    if (typeof simulatedHeapPercent === "number") {
      if (simulatedHeapPercent > 80) return "HIGH_PRESSURE";
      if (simulatedHeapPercent >= 65) return "MEDIUM_PRESSURE";
      return "NORMAL";
    }

    const stats = v8.getHeapStatistics();
    const used = stats.used_heap_size;
    const limit = this.limits.maxHeapBytes || stats.heap_size_limit;
    const percent = (used / limit) * 100;

    if (percent > 80) return "HIGH_PRESSURE";
    if (percent >= 65) return "MEDIUM_PRESSURE";
    return "NORMAL";
  }

  getActivePolicy(simulatedLevel?: DegradationLevel): DegradationPolicy {
    const level = simulatedLevel ?? this.getDegradationLevel();

    switch (level) {
      case "NORMAL":
        return {
          level: "NORMAL",
          enableTypechecking: true,
          enableEmbeddings: true,
          enableRuntimeTracing: true,
          enableFtsSearch: true,
          allowBackgroundVectorization: true,
          strategyDescription: "Full semantic embedding + TS compiler typechecking + runtime tracing",
        };
      case "MEDIUM_PRESSURE":
        return {
          level: "MEDIUM_PRESSURE",
          enableTypechecking: false,
          enableEmbeddings: true, // cached embeddings only
          enableRuntimeTracing: true,
          enableFtsSearch: true,
          allowBackgroundVectorization: false,
          strategyDescription: "Cached embeddings + pure AST parsing + SQLite FTS5 (Compiler disabled)",
        };
      case "HIGH_PRESSURE":
        return {
          level: "HIGH_PRESSURE",
          enableTypechecking: false,
          enableEmbeddings: false,
          enableRuntimeTracing: false,
          enableFtsSearch: true,
          allowBackgroundVectorization: false,
          strategyDescription: "Pure deterministic lexical + graph topology search (Vectors & Tracing paused)",
        };
    }
  }

  getMetrics(): ResourceUsageMetrics {
    const stats = v8.getHeapStatistics();
    const limit = this.limits.maxHeapBytes || stats.heap_size_limit;
    const heapPercentage = Math.round((stats.used_heap_size / (limit || 1)) * 100);

    const now = Date.now();
    const currentCpu = process.cpuUsage(this.lastCpuUsage);
    const elapsedMs = Math.max(1, now - this.lastCpuSampleTime);
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuSampleTime = now;
    const cpuTotalMicros = currentCpu.user + currentCpu.system;
    const cpuPercentage = Math.min(100, Math.max(0, Math.round((cpuTotalMicros / (elapsedMs * 1000)) * 100)));

    return {
      heapUsedBytes: stats.used_heap_size,
      heapTotalBytes: stats.total_heap_size,
      heapLimitBytes: limit,
      heapPercentage,
      cpuPercentage,
      indexQueueDepth: this.indexQueueDepth,
      maxIndexQueueDepth: this.limits.maxIndexQueueDepth,
      embeddingQueueDepth: this.embeddingQueueDepth,
      maxEmbeddingQueueDepth: this.limits.maxEmbeddingQueueDepth,
      runtimeStorageBytes: this.runtimeStorageBytes,
      maxRuntimeStorageBytes: this.limits.maxRuntimeStorageBytes,
      iopsCurrent: this.ioOperationsCount,
      degradationLevel: this.getDegradationLevel(),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Generates a terminal report with ASCII bar graphs for `graphward resources`.
   */
  formatResourceReport(): string {
    const metrics = this.getMetrics();
    const policy = this.getActivePolicy();

    function renderBar(pct: number, length: number = 16): string {
      const clamped = Math.max(0, Math.min(100, pct));
      const filled = Math.round((clamped / 100) * length);
      const empty = length - filled;
      return "█".repeat(filled) + "░".repeat(empty);
    }

    function formatBytes(bytes: number): string {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    }

    const cpuPct = metrics.cpuPercentage ?? 0;
    const lines: string[] = [
      "GraphWard Resource Governor",
      "===========================",
      `Memory          ${renderBar(metrics.heapPercentage)} ${metrics.heapPercentage}% (${formatBytes(metrics.heapUsedBytes)} / ${formatBytes(metrics.heapLimitBytes)})`,
      `CPU             ${renderBar(cpuPct)} ${cpuPct}%`,
      `Index Queue     ${metrics.indexQueueDepth} / ${metrics.maxIndexQueueDepth}`,
      `Embedding Queue ${metrics.embeddingQueueDepth} / ${metrics.maxEmbeddingQueueDepth}`,
      `Runtime Storage ${formatBytes(metrics.runtimeStorageBytes)} / ${formatBytes(metrics.maxRuntimeStorageBytes)}`,
      `IOPS            ${metrics.iopsCurrent} / ${this.limits.iopsBudgetPerSec} per sec`,
      "",
      `Degradation Level: ${metrics.degradationLevel}`,
      `Active Policy:     ${policy.strategyDescription}`,
    ];

    return lines.join("\n");
  }

  private queryLatenciesMs: number[] = [];

  public recordLatency(queryMs: number): void {
    this.queryLatenciesMs.push(queryMs);
    if (this.queryLatenciesMs.length > 200) {
      this.queryLatenciesMs.shift();
    }
  }

  public getLatencyP95(): number {
    if (this.queryLatenciesMs.length === 0) return 0;
    const sorted = [...this.queryLatenciesMs].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * 0.95);
    return sorted[idx] ?? sorted[sorted.length - 1];
  }

  public checkIopsThrottle(operationCost: number = 1): boolean {
    const limit = this.limits.iopsBudgetPerSec;
    if (this.ioOperationsCount + operationCost > limit) {
      return true; // throttle
    }
    for (let i = 0; i < operationCost; i++) {
      this.recordIoOperation();
    }
    return false; // permitted
  }

  public shouldThrottleBackgroundWork(): boolean {
    const p95 = this.getLatencyP95();
    const maxLatency = this.limits.maxLatencyMs ?? 250;
    const state = this.getResourceState();
    return p95 > maxLatency || state.ioPressure > 0.85 || state.heapPressure > 0.80;
  }

  public evictEphemeralSnapshots<T extends { kind?: string; generatedAt?: string; id: string }>(
    snapshots: T[],
    maxRetained: number = 10
  ): string[] {
    const ephemerals = snapshots.filter((s) => s.kind === "COUNTERFACTUAL");
    if (ephemerals.length <= maxRetained) {
      return [];
    }
    const sorted = [...ephemerals].sort((a, b) => {
      const tA = a.generatedAt ? new Date(a.generatedAt).getTime() : 0;
      const tB = b.generatedAt ? new Date(b.generatedAt).getTime() : 0;
      return tA - tB;
    });
    const toEvict = sorted.slice(0, ephemerals.length - maxRetained);
    return toEvict.map((s) => s.id);
  }
}

export const defaultGovernor = new ResourceGovernor();
