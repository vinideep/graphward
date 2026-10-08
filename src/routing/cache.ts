/**
 * Per-Task Routing Cache for GraphWard Codex Auto-Model-Router (Milestone 2)
 * Path: src/routing/cache.ts
 */

import { createHash } from "node:crypto";
import type { CostTier } from "../config/index.js";
import type { CacheStatus, RoutingDecision } from "./types.js";

/**
 * Standard routing decision payload stored in cache.
 */
export interface CachedDecision {
  taskId: string;
  model: string;
  selectedModel?: string;
  confidence: number;
  reasoning: string;
  tier: CostTier;
  scores: Record<string, number>;
  classifierModel?: string;
  cacheStatus?: CacheStatus;
  fromCache?: boolean;
  timestamp: string;
  expiresAt?: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  hitRate: number;
  evictions: number;
}

export interface TaskRoutingCacheOptions {
  maxEntries?: number;      // Default: 10_000
  defaultTtlMs?: number;    // Default: undefined (no TTL within process lifecycle)
}

/**
 * Deterministic Task Key Generator.
 * Resolves explicit taskId from request fields, or falls back to SHA-256 prompt hash.
 */
export function resolveTaskId(input: {
  taskId?: string;
  user?: string;
  metadata?: { taskId?: string; [key: string]: unknown };
  messages?: Array<{ role?: string; content?: unknown }>;
  prompt?: string;
}): string {
  if (typeof input.taskId === "string" && input.taskId.trim()) {
    return input.taskId.trim();
  }
  if (input.metadata && typeof input.metadata.taskId === "string" && input.metadata.taskId.trim()) {
    return input.metadata.taskId.trim();
  }
  if (typeof input.user === "string" && input.user.trim()) {
    return input.user.trim();
  }

  // Fallback: extract prompt string
  let promptText = "";
  if (typeof input.prompt === "string") {
    promptText = input.prompt;
  } else if (Array.isArray(input.messages)) {
    const lastUser = [...input.messages].reverse().find((m) => m && m.role === "user");
    if (lastUser && typeof lastUser.content === "string") {
      promptText = lastUser.content;
    } else {
      promptText = input.messages
        .map((m) => (m && typeof m.content === "string" ? m.content : ""))
        .join("\n");
    }
  }

  return computePromptHashKey(promptText);
}

/**
 * Generate deterministic fallback task key: "task-" + sha256(prompt)[0..12]
 */
export function computePromptHashKey(prompt: string): string {
  const normalized = typeof prompt === "string" ? prompt.trim() : "";
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  return `task-${hash}`;
}

/**
 * Production LRU Per-Task Routing Decision Cache.
 * Provides Map-compatible interface and guarantees zero re-scoring for existing tasks.
 */
export class TaskRoutingCache {
  private readonly store = new Map<string, CachedDecision>();
  private readonly maxEntries: number;
  private readonly defaultTtlMs?: number;

  private hitsCount = 0;
  private missesCount = 0;
  private evictionsCount = 0;

  constructor(options: TaskRoutingCacheOptions = {}) {
    this.maxEntries = options.maxEntries && options.maxEntries > 0 ? options.maxEntries : 10_000;
    this.defaultTtlMs = options.defaultTtlMs && options.defaultTtlMs > 0 ? options.defaultTtlMs : undefined;
  }

  get size(): number {
    this.cleanExpired();
    return this.store.size;
  }

  has(taskId: string): boolean {
    const entry = this.store.get(taskId);
    if (!entry) return false;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(taskId);
      return false;
    }
    return true;
  }

  get(taskId: string): CachedDecision | undefined {
    const entry = this.store.get(taskId);
    if (!entry) {
      this.missesCount++;
      return undefined;
    }

    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(taskId);
      this.missesCount++;
      return undefined;
    }

    // LRU refresh: re-insert at end of Map iteration order
    this.store.delete(taskId);
    this.store.set(taskId, entry);
    this.hitsCount++;

    return entry;
  }

  set(taskId: string, decision: Omit<CachedDecision, "taskId"> & { taskId?: string }, ttlMs?: number): void {
    if (!taskId || typeof taskId !== "string") return;

    const ttl = ttlMs ?? this.defaultTtlMs;
    const expiresAt = ttl ? Date.now() + ttl : undefined;

    const cached: CachedDecision = {
      ...decision,
      taskId,
      selectedModel: decision.selectedModel ?? decision.model,
      expiresAt,
    };

    // If key already exists, delete first to refresh position
    if (this.store.has(taskId)) {
      this.store.delete(taskId);
    } else if (this.store.size >= this.maxEntries) {
      // Evict oldest item (first item in Map)
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
        this.evictionsCount++;
      }
    }

    this.store.set(taskId, cached);
  }

  delete(taskId: string): boolean {
    return this.store.delete(taskId);
  }

  clear(): void {
    this.store.clear();
    this.hitsCount = 0;
    this.missesCount = 0;
    this.evictionsCount = 0;
  }

  getStats(): CacheStats {
    this.cleanExpired();
    const total = this.hitsCount + this.missesCount;
    return {
      hits: this.hitsCount,
      misses: this.missesCount,
      size: this.store.size,
      hitRate: total > 0 ? Math.round((this.hitsCount / total) * 1000) / 1000 : 0,
      evictions: this.evictionsCount,
    };
  }

  private cleanExpired(): void {
    const now = Date.now();
    for (const [key, value] of this.store.entries()) {
      if (value.expiresAt && now > value.expiresAt) {
        this.store.delete(key);
      }
    }
  }
}

/**
 * TaskCache alias for TaskRoutingCache
 */
export { TaskRoutingCache as TaskCache };
