/**
 * ModelRouter Orchestration Layer
 *
 * Coordinates configuration, task complexity classifier, per-task caching,
 * real-time structured logging, and metrics aggregation for Codex requests.
 */

import {
  CostTier,
  DEFAULT_CAPABILITY_CARDS,
  normalizeRoutingConfig,
  RoutingConfig,
} from "../config/index.js";
import {
  ChatCompletionRequest,
  ModelRouterOptions,
  RouteOptions,
  RoutingDecision,
  RoutingStats,
} from "./types.js";
import {
  generateTaskIdFromPrompt,
  resolveTargetModels,
  TaskClassifier,
} from "./classifier.js";
import { TaskRoutingCache } from "./cache.js";
import { RoutingLogger } from "./logger.js";

export class ModelRouter {
  public config: RoutingConfig;
  public options: ModelRouterOptions;
  public cache: TaskRoutingCache;
  public classifierCalls: number = 0;

  private classifier: TaskClassifier;
  private logger: RoutingLogger;
  private cheapCost: number;
  private premiumCost: number;

  private statsInternal = {
    totalRouted: 0,
    cacheHits: 0,
    cacheMisses: 0,
    modelDistribution: {} as Record<string, number>,
    estimatedCostSavings: 0.0,
  };

  constructor(config: RoutingConfig, options: ModelRouterOptions = {}) {
    this.options = options;
    this.config = { ...config };

    this.cheapCost = options.costModel?.cheapCost ?? 0.001;
    this.premiumCost = options.costModel?.premiumCost ?? 0.03;

    this.cache = options.cache || new TaskRoutingCache();
    this.classifier =
      options.classifier instanceof TaskClassifier
        ? options.classifier
        : new TaskClassifier(this.config, options.classifier);
    this.logger =
      options.logger ||
      new RoutingLogger({
        logLevel: this.config.logLevel,
        onLog: options.onLog,
      });
  }

  public getConfig(): RoutingConfig {
    return { ...this.config };
  }

  public updateConfig(patch: Partial<RoutingConfig>): void {
    this.config = normalizeRoutingConfig({ ...this.config, ...patch }, process.env);
    this.logger.setLogLevel(this.config.logLevel);
    this.classifier.updateConfig(this.config);
  }

  public clearCache(): void {
    this.cache.clear();
  }

  public get stats(): RoutingStats {
    return this.getStats();
  }

  public getStats(): RoutingStats {
    const total = this.statsInternal.totalRouted;
    const rate = total > 0 ? this.statsInternal.cacheHits / total : 0;
    return {
      totalRouted: this.statsInternal.totalRouted,
      cacheHits: this.statsInternal.cacheHits,
      cacheMisses: this.statsInternal.cacheMisses,
      cacheHitRate: Math.round(rate * 1000) / 1000,
      modelDistribution: { ...this.statsInternal.modelDistribution },
      estimatedCostSavings: Math.round(this.statsInternal.estimatedCostSavings * 10000) / 10000,
    };
  }

  public async route(
    taskOrRequest: string | ChatCompletionRequest,
    options: RouteOptions = {},
  ): Promise<RoutingDecision> {
    // 1. Extract prompt, taskId, and forceModel from polymorphic input
    let prompt = "";
    let taskId = options.taskId;
    let forceModel = options.forceModel || this.config.forceModel;

    if (typeof taskOrRequest === "string") {
      prompt = taskOrRequest;
    } else if (taskOrRequest && typeof taskOrRequest === "object") {
      const messages = Array.isArray(taskOrRequest.messages) ? taskOrRequest.messages : [];
      const lastUser = [...messages].reverse().find((m) => m && m.role === "user");
      if (lastUser) {
        if (typeof lastUser.content === "string") {
          prompt = lastUser.content;
        } else if (Array.isArray(lastUser.content)) {
          prompt = lastUser.content
            .filter((p) => p && p.type === "text" && typeof p.text === "string")
            .map((p) => p.text)
            .join("\n");
        }
      }

      if (!taskId) {
        taskId =
          taskOrRequest.taskId ||
          taskOrRequest.user ||
          (taskOrRequest.metadata && (taskOrRequest.metadata as Record<string, unknown>).taskId as string | undefined);
      }
      if (!options.forceModel && taskOrRequest.forceModel) {
        forceModel = taskOrRequest.forceModel;
      }
    }

    if (!taskId) {
      taskId = generateTaskIdFromPrompt(prompt);
    }

    const now = new Date().toISOString();

    // 2. Resolve runtime environment variable overrides (R5 precedence)
    let isEnabled = this.config.enabled;
    if (process.env.CODEX_SHIM_DISABLE_ROUTER !== undefined && process.env.CODEX_SHIM_DISABLE_ROUTER.trim() !== "") {
      const disableVal = process.env.CODEX_SHIM_DISABLE_ROUTER.trim().toLowerCase();
      if (disableVal === "1" || disableVal === "true" || disableVal === "yes" || disableVal === "on") {
        isEnabled = false;
      } else if (disableVal === "0" || disableVal === "false" || disableVal === "no" || disableVal === "off") {
        isEnabled = true;
      }
    }

    let activeForceModel = forceModel;
    if (process.env.CODEX_SHIM_FORCE_MODEL !== undefined && process.env.CODEX_SHIM_FORCE_MODEL.trim() !== "") {
      activeForceModel = process.env.CODEX_SHIM_FORCE_MODEL.trim();
    }

    let activeThreshold = this.config.threshold;
    if (process.env.CODEX_SHIM_THRESHOLD !== undefined && process.env.CODEX_SHIM_THRESHOLD.trim() !== "") {
      const parsed = parseFloat(process.env.CODEX_SHIM_THRESHOLD.trim());
      if (!Number.isNaN(parsed) && parsed >= 0.0 && parsed <= 1.0) {
        activeThreshold = parsed;
      }
    }

    let effectiveLogLevel = this.config.logLevel;
    if (process.env.CODEX_SHIM_ROUTER_LOG !== undefined && process.env.CODEX_SHIM_ROUTER_LOG.trim() !== "") {
      const logEnv = process.env.CODEX_SHIM_ROUTER_LOG.trim().toLowerCase();
      if (logEnv === "1" || logEnv === "true") {
        effectiveLogLevel = effectiveLogLevel === "none" ? "summary" : effectiveLogLevel;
      } else if (logEnv === "none" || logEnv === "0" || logEnv === "false") {
        effectiveLogLevel = "none";
      } else if (logEnv === "verbose") {
        effectiveLogLevel = "verbose";
      } else if (logEnv === "summary") {
        effectiveLogLevel = "summary";
      }
    }

    const { cheapCard } = resolveTargetModels(this.config.capabilityCards);

    // 3. Per-Task Cache Lookup (only when router is enabled)
    if (isEnabled && this.cache.has(taskId)) {
      this.statsInternal.totalRouted++;
      this.statsInternal.cacheHits++;
      const cached = this.cache.get(taskId)!;
      this.statsInternal.modelDistribution[cached.model] =
        (this.statsInternal.modelDistribution[cached.model] || 0) + 1;

      const actualCost = cached.tier === "cheap" ? this.cheapCost : this.premiumCost;
      this.statsInternal.estimatedCostSavings += Math.max(0, this.premiumCost - actualCost);

      const decision: RoutingDecision = {
        taskId,
        model: cached.model,
        selectedModel: cached.selectedModel ?? cached.model,
        confidence: cached.confidence,
        reasoning: cached.reasoning,
        tier: cached.tier,
        scores: cached.scores,
        classifierModel: cached.classifierModel ?? this.config.classifier,
        cacheStatus: "hit",
        fromCache: true,
        timestamp: now,
      };

      if (effectiveLogLevel !== "none") {
        await this.logger.log({
          taskId,
          classifierModel: this.config.classifier,
          scores: cached.scores,
          selectedModel: cached.model,
          cacheStatus: "hit",
          timestamp: now,
          reasoning: cached.reasoning,
          tier: cached.tier,
          confidence: cached.confidence,
        });
      }

      return decision;
    }

    // 4. Cache Miss Path: Evaluate Routing Decision
    this.statsInternal.totalRouted++;
    this.statsInternal.cacheMisses++;

    let selectedModel = "gpt-4o-mini";
    let tier: CostTier = "cheap";
    let confidence = 0.5;
    let reasoning = "";
    let scores: Record<string, number> = { "gpt-4o-mini": 0.5, "gpt-4o": 0.5 };
    let cacheStatus: "hit" | "miss" | "bypass" = "miss";

    if (!isEnabled) {
      selectedModel = this.config.classifier || cheapCard.model || "gpt-4o-mini";
      tier = "cheap";
      confidence = 1.0;
      reasoning = "Routing bypassed: router is disabled";
      scores = { [selectedModel]: 1.0 };
      cacheStatus = "bypass";
    } else if (activeForceModel) {
      selectedModel = activeForceModel;
      tier =
        activeForceModel.includes("mini") || activeForceModel.includes("haiku")
          ? "cheap"
          : activeForceModel.includes("4o") || activeForceModel.includes("opus")
          ? "premium"
          : "standard";
      confidence = 1.0;
      reasoning = `Routing forced to model: ${activeForceModel}`;
      scores = { [selectedModel]: 1.0 };
      cacheStatus = "miss";
    } else {
      this.classifierCalls++;
      const evalResult = await this.classifier.evaluate(
        prompt,
        this.config.capabilityCards,
        activeThreshold,
      );
      selectedModel = evalResult.selectedModel || evalResult.suggestedModel;
      tier = evalResult.tier || evalResult.suggestedTier;
      confidence = evalResult.confidence;
      reasoning = evalResult.reasoning;
      scores = evalResult.scores || evalResult.cardScores;
      cacheStatus = "miss";
    }

    // 5. Update Metrics
    this.statsInternal.modelDistribution[selectedModel] =
      (this.statsInternal.modelDistribution[selectedModel] || 0) + 1;
    const actualCost = tier === "cheap" ? this.cheapCost : this.premiumCost;
    this.statsInternal.estimatedCostSavings += Math.max(0, this.premiumCost - actualCost);

    const decision: RoutingDecision = {
      taskId,
      model: selectedModel,
      selectedModel,
      confidence,
      reasoning,
      tier,
      scores,
      classifierModel: this.config.classifier,
      cacheStatus,
      fromCache: false,
      timestamp: now,
    };

    // 6. Store in Cache (only when router is enabled to avoid cache pollution)
    if (isEnabled) {
      this.cache.set(taskId, decision);
    }

    // 7. Structured Real-Time Log Emission
    if (effectiveLogLevel !== "none") {
      await this.logger.log({
        taskId,
        classifierModel: this.config.classifier,
        scores,
        selectedModel,
        cacheStatus,
        timestamp: now,
        reasoning,
        tier,
        confidence,
      });
    }

    return decision;
  }
}
