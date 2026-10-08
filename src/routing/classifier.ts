/**
 * Classifier & Complexity Evaluator for GraphWard Codex Auto-Model-Router (Milestone 2)
 * Path: src/routing/classifier.ts
 */

import { createHash } from "node:crypto";
import {
  DEFAULT_CAPABILITY_CARDS,
  DEFAULT_ROUTING_CONFIG,
  type CapabilityCard,
  type CostTier,
  type RoutingConfig,
} from "../config/index.js";
import type {
  ChatCompletionRequest,
  ClassificationContext,
  ClassifierBackend,
  ClassifierResult,
  RoutingDecision,
} from "./types.js";

/**
 * Resolved target model pair and indexing
 */
export interface TargetModelResolution {
  cheapCard: CapabilityCard;
  premiumCard: CapabilityCard;
  cardsByModel: Map<string, CapabilityCard>;
}

/**
 * Resolves the baseline cheap and premium target models from capability cards.
 * If multiple cards share the same tier, prioritizes first matching card.
 * Fallbacks to canonical defaults if cards are missing or empty.
 */
export function resolveTargetModels(cards?: CapabilityCard[]): TargetModelResolution {
  const activeCards = Array.isArray(cards) && cards.length > 0 ? cards : DEFAULT_CAPABILITY_CARDS;
  const cardsByModel = new Map<string, CapabilityCard>();

  for (const card of activeCards) {
    if (card && card.model) {
      cardsByModel.set(card.model, card);
    }
  }

  const cheapCard =
    activeCards.find((c) => c.costTier === "cheap") ||
    activeCards[0] ||
    DEFAULT_CAPABILITY_CARDS[0];

  const premiumCard =
    activeCards.find((c) => c.costTier === "premium") ||
    activeCards[activeCards.length - 1] ||
    DEFAULT_CAPABILITY_CARDS[1];

  return {
    cheapCard,
    premiumCard,
    cardsByModel,
  };
}

/**
 * Deterministically generates a compact 12-char SHA-256 task identifier from prompt text
 */
export function generateTaskIdFromPrompt(prompt: string): string {
  const digest = createHash("sha256").update(prompt || "").digest("hex").slice(0, 12);
  return `task-${digest}`;
}

/**
 * Extracts the user prompt string from a ChatCompletionRequest.
 * Prioritizes the latest user role message in the array.
 */
export function extractPromptFromRequest(req: ChatCompletionRequest): string {
  if (!req || typeof req !== "object") return "";
  const messages = Array.isArray(req.messages) ? req.messages : [];

  const lastUserMsg = [...messages].reverse().find((m) => m && m.role === "user");
  if (lastUserMsg) {
    if (typeof lastUserMsg.content === "string") {
      return lastUserMsg.content;
    }
    if (Array.isArray(lastUserMsg.content)) {
      return lastUserMsg.content
        .filter((part) => part && part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
    }
  }

  // Fallback: concatenate textual content from any messages
  const texts: string[] = [];
  for (const msg of messages) {
    if (msg && typeof msg.content === "string") {
      texts.push(msg.content);
    }
  }
  return texts.join("\n");
}

/**
 * Extracts or synthesizes a task ID from request metadata, user field, or prompt digest
 */
export function extractTaskIdFromRequest(req: ChatCompletionRequest, explicitPrompt?: string): string {
  if (typeof req.taskId === "string" && req.taskId.trim()) {
    return req.taskId.trim();
  }
  if (typeof req.user === "string" && req.user.trim()) {
    return req.user.trim();
  }
  if (
    req.metadata &&
    typeof req.metadata === "object" &&
    typeof req.metadata.taskId === "string" &&
    req.metadata.taskId.trim()
  ) {
    return req.metadata.taskId.trim();
  }
  const prompt = explicitPrompt !== undefined ? explicitPrompt : extractPromptFromRequest(req);
  return generateTaskIdFromPrompt(prompt);
}

/**
 * Known engineering keywords signifying architectural, distributed, or concurrency complexity
 */
export const COMPLEX_ENGINEERING_KEYWORDS = [
  "architect",
  "architecture",
  "refactor",
  "consensus",
  "distributed",
  "concurrency",
  "deadlock",
  "algorithm",
  "security vulnerability",
  "vulnerability",
  "crypto",
  "performance bottleneck",
  "race condition",
  "memory leak",
  "distributed-systems",
] as const;

/**
 * Known engineering keywords signifying mechanical or simple tasks
 */
export const SIMPLE_ENGINEERING_KEYWORDS = [
  "typo",
  "comment",
  "formatting",
  "syntax",
  "quick-fix",
  "rename",
  "style",
  "whitespace",
  "lint",
  "unit-test",
] as const;

/**
 * Builds the one-shot classification prompt for LLM-based classifiers
 */
export function buildClassificationPrompt(
  task: string,
  capabilityCards: CapabilityCard[],
): { system: string; user: string } {
  const cardsSummary = capabilityCards
    .map(
      (c) =>
        `- Model: ${c.model} (Tier: ${c.costTier})\n  Description: ${c.description}\n  Strengths: ${c.strengths.join(", ")}`,
    )
    .join("\n");

  const system = `You are the GraphWard Task Complexity Classifier for Codex.
Analyze the provided software engineering task and score its complexity on a scale from 0.0 to 1.0.

Scoring Guidelines:
- 0.00 to 0.35: Mechanical/simple changes: formatting, syntax fixes, typo corrections, comments, single trivial unit test.
- 0.35 to 0.69: Standard implementation: localized logic edits, single function refactors, straightforward bug fixes.
- 0.70 to 1.00: High complexity: architectural redesign, distributed systems, concurrency/deadlocks, consensus protocols, multi-file refactoring, security audits, cryptography, complex performance optimization.

Available Models and Capability Cards:
${cardsSummary}

Respond ONLY with a JSON object strictly adhering to this schema:
{
  "score": <number between 0.0 and 1.0>,
  "confidence": <number between 0.0 and 1.0>,
  "reasoning": "<concise 1-2 sentence justification>",
  "suggestedTier": "<cheap | standard | premium>",
  "suggestedModel": "<target model name>"
}`;

  const user = `Task to evaluate:\n${task}`;
  return { system, user };
}

/**
 * Parses and validates raw LLM classifier completion into a ClassifierResult
 */
export function parseClassificationResponse(
  raw: string,
  classifierModel: string,
  capabilityCards: CapabilityCard[],
): ClassifierResult {
  const { cheapCard, premiumCard } = resolveTargetModels(capabilityCards);

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON object found in classifier output");
    }

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const rawScore = typeof parsed.score === "number" && Number.isFinite(parsed.score) ? parsed.score : 0.5;
    const score = Math.max(0.0, Math.min(1.0, rawScore));
    const confidence =
      typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
        ? Math.max(0.0, Math.min(1.0, parsed.confidence))
        : Math.round(score * 1000) / 1000;

    const suggestedTier: CostTier =
      parsed.suggestedTier === "cheap" || parsed.suggestedTier === "premium" || parsed.suggestedTier === "standard"
        ? (parsed.suggestedTier as CostTier)
        : score >= 0.7
        ? "premium"
        : "cheap";

    const suggestedModel =
      typeof parsed.suggestedModel === "string" && parsed.suggestedModel.trim()
        ? parsed.suggestedModel.trim()
        : suggestedTier === "premium"
        ? premiumCard.model
        : cheapCard.model;

    const reasoning =
      typeof parsed.reasoning === "string" && parsed.reasoning.trim()
        ? parsed.reasoning.trim()
        : `Classified complexity score ${score}`;

    const cardScores: Record<string, number> = {
      [cheapCard.model]: Math.round((1 - score) * 1000) / 1000,
      [premiumCard.model]: confidence,
    };

    return {
      score,
      confidence,
      cardScores,
      scores: cardScores,
      reasoning,
      suggestedTier,
      tier: suggestedTier,
      suggestedModel,
      selectedModel: suggestedModel,
      classifierModel,
      rawOutput: raw,
    };
  } catch {
    // Fallback to deterministic heuristic on parse failure
    return evaluateComplexityHeuristic(raw, capabilityCards, classifierModel);
  }
}

/**
 * Deterministic rule-based / heuristic complexity evaluator.
 * Evaluates keywords, explicit score tokens, prompt length, and whitespace boundaries.
 * Guarantees zero network overhead and strict reproducibility.
 */
export function evaluateComplexityHeuristic(
  task: string,
  capabilityCards: CapabilityCard[] = DEFAULT_CAPABILITY_CARDS,
  classifierModel: string = "gpt-4o-mini",
): ClassifierResult {
  const { cheapCard, premiumCard } = resolveTargetModels(capabilityCards);
  const prompt = typeof task === "string" ? task : "";
  const trimmed = prompt.trim();

  // Edge Case 1: Empty or whitespace-only prompt (Tier 2 boundary test T2.2)
  if (!trimmed) {
    const score = 0.25;
    const confidence = 0.25;
    const cardScores = {
      [cheapCard.model]: 0.75,
      [premiumCard.model]: 0.25,
    };
    return {
      score,
      confidence,
      cardScores,
      scores: cardScores,
      reasoning: "Whitespace-only or empty prompt routed safely to baseline cheap model",
      suggestedTier: "cheap",
      tier: "cheap",
      suggestedModel: cheapCard.model,
      selectedModel: cheapCard.model,
      classifierModel,
    };
  }

  // Feature: Explicit score or complexity override token in prompt (e.g. "score:0.60")
  const scoreMatch = prompt.match(/(?:score|complexity)[:=]\s*([0-9.]+)/i);
  if (scoreMatch) {
    const parsedScore = parseFloat(scoreMatch[1]);
    const score = Number.isFinite(parsedScore) ? Math.max(0.0, Math.min(1.0, parsedScore)) : 0.5;
    const confidence = Math.round(score * 1000) / 1000;
    const isPremium = score >= 0.7; // default threshold comparison
    const cardScores = {
      [cheapCard.model]: Math.round((1 - score) * 1000) / 1000,
      [premiumCard.model]: confidence,
    };

    return {
      score,
      confidence,
      cardScores,
      scores: cardScores,
      reasoning: `Explicit complexity token parsed: ${scoreMatch[1]}`,
      suggestedTier: isPremium ? "premium" : "cheap",
      tier: isPremium ? "premium" : "cheap",
      suggestedModel: isPremium ? premiumCard.model : cheapCard.model,
      selectedModel: isPremium ? premiumCard.model : cheapCard.model,
      classifierModel,
    };
  }

  // Semantic keyword inspection and length heuristic
  const lowerPrompt = prompt.toLowerCase();
  const matches = COMPLEX_ENGINEERING_KEYWORDS.filter((k) => lowerPrompt.includes(k));

  let score = 0.25;
  if (matches.length > 0 || prompt.length > 400) {
    score = Math.min(0.95, 0.55 + matches.length * 0.15);
  } else {
    score = 0.25;
  }

  const confidence = Math.round(score * 1000) / 1000;
  const isPremium = score >= 0.7;

  let reasoning = "";
  if (matches.length > 0) {
    reasoning = `Detected complex engineering keywords (${matches.slice(0, 3).join(", ")})`;
  } else if (prompt.length > 400) {
    reasoning = `Large prompt payload (${prompt.length} chars) indicates elevated complexity`;
  } else {
    reasoning = "Standard low-complexity mechanical task";
  }

  const cardScores = {
    [cheapCard.model]: Math.round((1 - score) * 1000) / 1000,
    [premiumCard.model]: confidence,
  };

  return {
    score,
    confidence,
    cardScores,
    scores: cardScores,
    reasoning,
    suggestedTier: isPremium ? "premium" : "cheap",
    tier: isPremium ? "premium" : "cheap",
    suggestedModel: isPremium ? premiumCard.model : cheapCard.model,
    selectedModel: isPremium ? premiumCard.model : cheapCard.model,
    classifierModel,
  };
}

/**
 * Default heuristic classifier backend
 */
export class HeuristicClassifier implements ClassifierBackend {
  readonly name = "heuristic";

  async classify(task: string, context?: ClassificationContext): Promise<ClassifierResult> {
    const cards = context?.capabilityCards || DEFAULT_CAPABILITY_CARDS;
    const model = context?.config?.classifier || "gpt-4o-mini";
    return evaluateComplexityHeuristic(task, cards, model);
  }
}

/**
 * Mock classifier backend for testing and deterministic evaluation
 */
export class MockClassifier implements ClassifierBackend {
  readonly name = "mock";
  public calls: Array<{ task: string; context?: ClassificationContext }> = [];
  public customScore?: number;
  public customHandler?: (task: string, context?: ClassificationContext) => Promise<ClassifierResult> | ClassifierResult;

  constructor(options?: {
    score?: number;
    handler?: (task: string, context?: ClassificationContext) => Promise<ClassifierResult> | ClassifierResult;
  }) {
    if (options?.score !== undefined) this.customScore = options.score;
    if (options?.handler) this.customHandler = options.handler;
  }

  async classify(task: string, context?: ClassificationContext): Promise<ClassifierResult> {
    this.calls.push({ task, context });

    if (this.customHandler) {
      return await this.customHandler(task, context);
    }

    const cards = context?.capabilityCards || DEFAULT_CAPABILITY_CARDS;
    const model = context?.config?.classifier || "mock-classifier";
    const base = evaluateComplexityHeuristic(task, cards, model);

    if (this.customScore !== undefined) {
      const score = Math.max(0.0, Math.min(1.0, this.customScore));
      const confidence = Math.round(score * 1000) / 1000;
      const { cheapCard, premiumCard } = resolveTargetModels(cards);
      const cardScores = {
        [cheapCard.model]: Math.round((1 - score) * 1000) / 1000,
        [premiumCard.model]: confidence,
      };
      const threshold = context?.threshold ?? 0.7;
      const isPremium = score >= threshold;
      return {
        ...base,
        score,
        confidence,
        cardScores,
        scores: cardScores,
        suggestedTier: isPremium ? "premium" : "cheap",
        tier: isPremium ? "premium" : "cheap",
        suggestedModel: isPremium ? premiumCard.model : cheapCard.model,
        selectedModel: isPremium ? premiumCard.model : cheapCard.model,
      };
    }

    return base;
  }
}

/**
 * Candidate routing decision prior to caching and timestamping
 */
export type RoutingCandidate = Omit<RoutingDecision, "taskId" | "timestamp" | "cacheStatus" | "fromCache">;

/**
 * TaskClassifier orchestration engine.
 * Encapsulates backend execution, capability card resolution, threshold escalation, and manual overrides.
 */
export class TaskClassifier {
  private config: RoutingConfig;
  private backend: ClassifierBackend;
  public classifierCalls: number = 0;

  constructor(configOrModel?: RoutingConfig | string, backend?: ClassifierBackend) {
    if (typeof configOrModel === "string") {
      this.config = { ...DEFAULT_ROUTING_CONFIG, classifier: configOrModel };
    } else if (configOrModel && typeof configOrModel === "object") {
      this.config = { ...configOrModel };
    } else {
      this.config = { ...DEFAULT_ROUTING_CONFIG };
    }
    this.backend = backend || new HeuristicClassifier();
  }

  public getConfig(): RoutingConfig {
    return { ...this.config };
  }

  public updateConfig(patch: Partial<RoutingConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  public setBackend(backend: ClassifierBackend): void {
    this.backend = backend;
  }

  public getBackend(): ClassifierBackend {
    return this.backend;
  }

  /**
   * Evaluates prompt complexity using configured backend. Increments classifierCalls.
   */
  public async evaluate(
    prompt: string,
    contextOrCards?: ClassificationContext | CapabilityCard[],
    threshold?: number,
  ): Promise<ClassifierResult> {
    this.classifierCalls++;

    let ctx: ClassificationContext;
    if (Array.isArray(contextOrCards)) {
      ctx = {
        config: this.config,
        capabilityCards: contextOrCards,
        threshold: threshold !== undefined ? threshold : this.config.threshold,
      };
    } else {
      ctx = {
        config: this.config,
        capabilityCards: this.config.capabilityCards,
        threshold: threshold !== undefined ? threshold : this.config.threshold,
        ...contextOrCards,
      };
    }

    const result = await this.backend.classify(prompt, ctx);

    // Apply active threshold to determine suggested model and tier
    const activeThreshold = ctx.threshold ?? this.config.threshold;
    const { cheapCard, premiumCard } = resolveTargetModels(ctx.capabilityCards);
    const isPremium = result.score >= activeThreshold;

    const suggestedTier: CostTier = isPremium ? "premium" : "cheap";
    const suggestedModel = isPremium ? premiumCard.model : cheapCard.model;
    const cardScores = result.cardScores || {
      [cheapCard.model]: Math.round((1 - result.score) * 1000) / 1000,
      [premiumCard.model]: result.confidence,
    };

    return {
      ...result,
      suggestedTier,
      tier: suggestedTier,
      suggestedModel,
      selectedModel: suggestedModel,
      cardScores,
      scores: cardScores,
    };
  }

  /**
   * Resolves routing decision candidate based on complexity score vs threshold.
   * Handles disabled router and forceModel overrides (0 classifier calls).
   */
  public async decide(
    prompt: string,
    options?: { forceModel?: string; threshold?: number },
  ): Promise<RoutingCandidate> {
    const activeForceModel = options?.forceModel || this.config.forceModel;
    const activeThreshold =
      typeof options?.threshold === "number" && Number.isFinite(options.threshold)
        ? options.threshold
        : this.config.threshold;

    const { cheapCard, premiumCard } = resolveTargetModels(this.config.capabilityCards);

    // Override 1: Router disabled (bypasses classification with 0 classifier calls)
    if (!this.config.enabled) {
      const selectedModel = this.config.classifier || cheapCard.model || "gpt-4o-mini";
      return {
        model: selectedModel,
        selectedModel,
        confidence: 1.0,
        reasoning: "Routing bypassed: router is disabled",
        tier: "cheap",
        scores: { [selectedModel]: 1.0 },
        classifierModel: this.config.classifier || "none",
      };
    }

    // Override 2: Model forced explicitly (bypasses classification with 0 classifier calls)
    if (activeForceModel) {
      const tier: CostTier = activeForceModel.includes("mini") || activeForceModel.includes("haiku")
        ? "cheap"
        : activeForceModel.includes("4o") || activeForceModel.includes("opus")
        ? "premium"
        : "standard";

      return {
        model: activeForceModel,
        selectedModel: activeForceModel,
        confidence: 1.0,
        reasoning: `Routing forced to model: ${activeForceModel}`,
        tier,
        scores: { [activeForceModel]: 1.0 },
        classifierModel: this.config.classifier || "forced",
      };
    }

    // Active classification
    const result = await this.evaluate(prompt, { threshold: activeThreshold });

    let selectedModel: string;
    let tier: CostTier;
    let reasoning: string;

    if (result.score >= activeThreshold) {
      selectedModel = premiumCard.model;
      tier = "premium";
      reasoning = `Complexity score (${result.confidence}) meets or exceeds threshold (${activeThreshold}); escalated to premium model`;
    } else {
      selectedModel = cheapCard.model;
      tier = "cheap";
      reasoning = `Complexity score (${result.confidence}) is below threshold (${activeThreshold}); routed to cheap model`;
    }

    const scores: Record<string, number> = {
      [cheapCard.model]: Math.round((1 - result.score) * 1000) / 1000,
      [premiumCard.model]: result.confidence,
    };

    return {
      model: selectedModel,
      selectedModel,
      confidence: result.confidence,
      reasoning,
      tier,
      scores,
      classifierModel: this.config.classifier,
    };
  }
}

/**
 * Classifier alias for TaskClassifier
 */
export { TaskClassifier as Classifier };
