/**
 * Types and data contracts for GraphWard Codex Auto-Model-Router (Milestone 2)
 * Path: src/routing/types.ts
 */

import type {
  CapabilityCard,
  CostTier,
  RoutingConfig,
  RoutingLogLevel,
} from "../config/index.js";

export type {
  CapabilityCard,
  CostTier,
  RoutingConfig,
  RoutingLogLevel,
};

export {
  DEFAULT_CAPABILITY_CARDS,
  DEFAULT_ROUTING_CONFIG,
} from "../config/index.js";

/**
 * Cache resolution status for a routing decision:
 * - "hit": decision retrieved from in-memory per-task cache without re-scoring
 * - "miss": task scored via classifier and inserted into cache
 * - "bypass": routing disabled or forced, classification bypassed
 */
export type CacheStatus = "hit" | "miss" | "bypass";

/**
 * Full routing decision structure conforming to:
 * - R1: Transparent proxy routing decision
 * - R4: Structured NDJSON log emission fields
 * - M2 ↔ M3 interface contract in PROJECT.md
 * - Milestone 2 Dispatch requirements
 */
export interface RoutingDecision {
  /** Unique task identifier (explicitly supplied or deterministic hash) */
  taskId: string;
  /** Primary target model selected for the task */
  model: string;
  /** Explicit alias for selected model (for R4 log and dispatch compatibility) */
  selectedModel: string;
  /** Complexity score or selection confidence (0.0 .. 1.0) */
  confidence: number;
  /** Human-readable explanation of why this model was chosen */
  reasoning: string;
  /** Cost tier of the selected model ("cheap" | "standard" | "premium") */
  tier: CostTier;
  /** Scores/probabilities per candidate model or capability card */
  scores: Record<string, number>;
  /** Model used to perform the complexity classification */
  classifierModel: string;
  /** Cache resolution status ("hit" | "miss" | "bypass") */
  cacheStatus: CacheStatus;
  /** Boolean flag: true if served from cache, false otherwise */
  fromCache: boolean;
  /** ISO 8601 timestamp when decision was resolved */
  timestamp: string;
}

/**
 * Message content part for multimodal or structured content
 */
export interface ChatCompletionContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
}

/**
 * Function call representation within a tool call
 */
export interface ChatCompletionToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * Chat completion message compatible with OpenAI/Codex format
 */
export interface ChatCompletionMessage {
  role: "system" | "user" | "assistant" | "tool" | "function";
  content: string | ChatCompletionContentPart[] | null;
  name?: string;
  tool_calls?: ChatCompletionToolCall[];
  tool_call_id?: string;
}

/**
 * Alias for ChatCompletionMessage
 */
export type ChatMessage = ChatCompletionMessage;

/**
 * Tool definition compatible with OpenAI format
 */
export interface ChatCompletionTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/**
 * Request payload conforming to standard OpenAI/Codex chat completion APIs,
 * extended with optional task identification and routing override properties.
 */
export interface ChatCompletionRequest {
  model?: string;
  messages: ChatCompletionMessage[];
  temperature?: number;
  top_p?: number;
  n?: number;
  stream?: boolean;
  stop?: string | string[];
  max_tokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  logit_bias?: Record<string, number>;
  user?: string;
  tools?: ChatCompletionTool[];
  tool_choice?: unknown;

  // Extension & Routing Fields
  /** Explicit task identifier for per-task caching loop */
  taskId?: string;
  /** Runtime override to force request to specific target model */
  forceModel?: string;
  /** Custom metadata object that may contain taskId or tracking attributes */
  metadata?: Record<string, unknown> & { taskId?: string };
  [key: string]: unknown;
}

/**
 * Output choice item in chat completion response
 */
export interface ChatCompletionChoice {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: ChatCompletionToolCall[];
  };
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

/**
 * Token usage metadata
 */
export interface CompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/**
 * Response payload returned to calling Codex agents
 */
export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: CompletionUsage;
  /** Internal routing metadata attached transparently for observability */
  _routing?: RoutingDecision;
  [key: string]: unknown;
}

/**
 * Result produced by a complexity classification evaluation
 */
export interface ClassifierResult {
  /** Numeric complexity score between 0.0 (simple/mechanical) and 1.0 (complex/architectural) */
  score: number;
  /** Confidence in classification (0.0 .. 1.0) */
  confidence: number;
  /** Per-card or per-model suitability scores */
  cardScores: Record<string, number>;
  /** Rationalization for the classification */
  reasoning: string;
  /** Suggested cost tier */
  suggestedTier: CostTier;
  /** Suggested model name */
  suggestedModel: string;
  /** Model that performed classification */
  classifierModel: string;
  /** Raw completion output if LLM backend was used */
  rawOutput?: string;
  /** Selected model alias */
  selectedModel?: string;
  /** Tier alias */
  tier?: CostTier;
  /** Card scores alias */
  scores?: Record<string, number>;
}

/**
 * Contextual input provided to classifier backends
 */
export interface ClassificationContext {
  taskId?: string;
  config?: RoutingConfig;
  capabilityCards?: CapabilityCard[];
  threshold?: number;
  request?: ChatCompletionRequest;
}

/**
 * Pluggable backend interface for classification
 */
export interface ClassifierBackend {
  readonly name: string;
  classify(task: string, context?: ClassificationContext): Promise<ClassifierResult>;
}

/**
 * Re-export of RoutingConfig under router alias
 */
export type ModelRouterConfig = RoutingConfig;

/**
 * Aggregate routing statistics
 */
export interface RoutingStats {
  totalRouted: number;
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number;
  modelDistribution: Record<string, number>;
  estimatedCostSavings: number;
  bypassed?: number;
  bypasses?: number;
}

/**
 * Structured log record emitted as NDJSON
 */
export interface RoutingLogEntry {
  taskId: string;
  classifierModel: string;
  scores: Record<string, number>;
  selectedModel: string;
  cacheStatus: CacheStatus;
  timestamp: string;
  level?: RoutingLogLevel;
  reasoning?: string;
  tier?: CostTier;
  confidence?: number;
  promptSnippet?: string;
  promptLength?: number;
  latencyMs?: number;
  threshold?: number;
  forceModel?: string;
}

/**
 * Route options for ModelRouter.route
 */
export interface RouteOptions {
  taskId?: string;
  forceModel?: string;
  threshold?: number;
}

/**
 * Options for configuring ModelRouter instance
 */
export interface ModelRouterOptions {
  /** Pluggable classifier backend instance */
  classifier?: ClassifierBackend | any;
  /** Cache instance */
  cache?: any;
  /** Logger instance */
  logger?: any;
  /** Custom logger / log event subscriber */
  onLog?: (entry: RoutingLogEntry) => void | Promise<void>;
  /** Custom cost model overrides */
  costModel?: { cheapCost?: number; premiumCost?: number };
  /** Custom base directory for config persistence */
  projectRoot?: string;
  /** Upstream completion executor for shim forwarding */
  upstreamExecutor?: (req: ChatCompletionRequest, decision: RoutingDecision) => Promise<ChatCompletionResponse>;
  /** Executor alias */
  executor?: (req: ChatCompletionRequest, decision?: RoutingDecision) => Promise<ChatCompletionResponse>;
}

/**
 * Options for configuring CodexShim instance
 */
export interface CodexShimOptions {
  upstreamExecutor?: (req: ChatCompletionRequest, decision: RoutingDecision) => Promise<ChatCompletionResponse>;
  executor?: (req: ChatCompletionRequest, decision?: RoutingDecision) => Promise<ChatCompletionResponse>;
}

/**
 * Options for dispatching mock/socket HTTP requests in shim server
 */
export interface HttpDispatchOptions {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

/**
 * Response handle returned from dispatch
 */
export interface HttpResponseHandle {
  status: number;
  json: () => Promise<any>;
  text: () => Promise<string>;
}

/**
 * Server handle returned from startHttpServer
 */
export interface HttpServerHandle {
  server: any;
  port: number;
  dispatch: (opts: HttpDispatchOptions) => Promise<HttpResponseHandle>;
  close: () => Promise<void>;
}
