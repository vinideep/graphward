import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type {
  ClarityAssessment,
  AmbiguityItem,
  ClarificationQuestion,
  UserDecision,
} from "./types.js";
import type { DependencyGraph } from "../graph/schema.js";
import type { MemoryQueryResult } from "../learning/index.js";

export interface GraphClarityConfig {
  maxDownstreamConsumers?: number; // default 5
}

export interface GraphClarityAssessment {
  mustClarify: boolean;
  reasons: Array<{ rule: string; detail: string }>;
}


const ARCHITECTURAL_PATTERNS = [
  {
    regex: /\b(auth|authentications?|login|signups?)\b/i,
    category: "architecture" as const,
    description: "Authentication mechanism and session management are unspecified.",
    whyItMatters: "Affects token storage, middleware, session invalidation, and security compliance.",
    question: "Which authentication strategy should be implemented?",
    options: [
      { id: "A", text: "Stateless JWT tokens with Authorization Bearer header", tradeoff: "Horizontal scalability, cannot revoke instantly without blacklist" },
      { id: "B", text: "Server-side sessions with secure HTTP-only cookies", tradeoff: "Instant revocation, requires stateful store or sticky sessions" },
      { id: "C", text: "OAuth2 / OIDC provider integration (e.g. GitHub, Google)", tradeoff: "Delegates credentials, adds external dependency" },
    ],
  },
  {
    regex: /\b(payments?|checkout|billings?|subscriptions?)\b/i,
    category: "scope" as const,
    description: "Payment gateway integration details and idempotency constraints are unspecified.",
    whyItMatters: "Directly impacts compliance (PCI-DSS), webhook retry handling, and transaction state machines.",
    question: "What is the primary target payment processor and transaction flow?",
    options: [
      { id: "A", text: "Stripe PaymentIntents with asynchronous webhook handling", tradeoff: "Industry standard, requires webhook endpoint & signature validation" },
      { id: "B", text: "Generic pluggable payment adapter interface (multi-provider)", tradeoff: "High flexibility, requires building abstract provider contracts" },
      { id: "C", text: "Simulated/mock payment service for local/test environments", tradeoff: "Zero external setup, cannot process real currency" },
    ],
  },
  {
    regex: /\b(caches?|caching|memoizes?|memoization)\b/i,
    category: "nfr" as const,
    description: "Cache tier, invalidation policy, and TTL strategy are unspecified.",
    whyItMatters: "Determines memory footprint, cache consistency risks, and distributed sync requirements.",
    question: "Which caching architecture should be used?",
    options: [
      { id: "A", text: "In-memory LRU / Map cache with TTL expiration", tradeoff: "Zero external dependencies, not shared across process instances" },
      { id: "B", text: "Distributed Redis / Key-Value store", tradeoff: "Shared across clustered instances, requires infrastructure dependency" },
      { id: "C", text: "HTTP Cache-Control headers with ETag validation", tradeoff: "Relies on edge/client caching, best for public read endpoints" },
    ],
  },
  {
    regex: /\b(db|databases?|schemas?|migrations?|models?)\b/i,
    category: "data_model" as const,
    description: "Data persistence strategy, migration rollback, and locking behavior are unspecified.",
    whyItMatters: "Unplanned schema alterations can cause table locks or breaking backward compatibility.",
    question: "How should the data schema evolution be handled?",
    options: [
      { id: "A", text: "Additive-only migration with backward compatibility and zero downtime", tradeoff: "Safe for production, requires multiple phased releases" },
      { id: "B", text: "Strict relational table creation with foreign keys and cascade rules", tradeoff: "Strict relational integrity, potential migration locking" },
      { id: "C", text: "Document-oriented JSON/JSONB column extension", tradeoff: "Fast schema evolution, weaker relational constraints" },
    ],
  },
  {
    regex: /\b(apis?|endpoints?|routes?|rest|graphql)\b/i,
    category: "api_contract" as const,
    description: "API contract format, versioning, and error response standards are unspecified.",
    whyItMatters: "Public signature alterations can break existing API consumers and client SDKs.",
    question: "What API design contract should this endpoint conform to?",
    options: [
      { id: "A", text: "RESTful JSON API under existing route versioning (e.g. /v1/...)", tradeoff: "Predictable, standard HTTP status codes and payloads" },
      { id: "B", text: "Internal RPC / service-to-service contract", tradeoff: "Optimized for internal calls, not meant for external consumption" },
      { id: "C", text: "Event-driven asynchronous messaging", tradeoff: "Decoupled execution, requires consumer worker/queue infrastructure" },
    ],
  },
];

export function assessPromptClarity(prompt: string, config?: { clarityThreshold?: number; knownDecisions?: Record<string, string> }): ClarityAssessment {
  const trimmed = prompt.trim();
  const ambiguities: AmbiguityItem[] = [];
  const questions: ClarificationQuestion[] = [];
  const feature = /\b(add|create|build|implement|introduce|new feature|enable)\b/i.test(trimmed) && !/\b(fix|repair|typo|regression)\b/i.test(trimmed);
  const preciseFix = /\b(fix|update|change|replace|remove|rename|correct)\b/i.test(trimmed) && /(?:[\w/-]+\.(?:tsx?|jsx?|py|go|rs|json|md|ya?ml)|\bJWT\b|\bfrom\s+.+\s+to\b)/i.test(trimmed);
  const specified = [ /\b(jwt|bearer|oauth|oidc|http.only|sessions?)\b/i, /\b(stripe|paymentintents?|mock|simulated|paypal)\b/i, /\b(redis|lru|etag|cache.control|ttl|in.memory)\b/i, /\b(additive|backward.compatib|zero.downtime|postgres|mysql|sqlite|jsonb)\b/i, /\b(rest|graphql|rpc|openapi|existing|\/v\d+)\b/i ];
  if (!preciseFix) {
    ARCHITECTURAL_PATTERNS.forEach((pattern, index) => {
      if (!pattern.regex.test(trimmed) || specified[index].test(trimmed) || config?.knownDecisions?.[pattern.category]) return;
      ambiguities.push({ category: pattern.category, description: pattern.description, whyItMatters: pattern.whyItMatters });
      questions.push({ id: `domain-${index}`, question: pattern.question, context: 'Inspect existing repository conventions first; ask only if this decision remains unresolved.', options: pattern.options });
    });
  }
  if (feature) {
    ambiguities.push({ category: 'scope', description: 'New feature scope needs a requirements discussion and user confirmation.', whyItMatters: 'Prompt length and keyword matches cannot authorize implementation.' });
    questions.push({ id: 'feature-scope', question: 'Confirm the intended users, behavior, non-goals, acceptance criteria and relevant failure cases for this feature.', context: 'Discover repository facts first. Reuse prior answers and already approved scope; ask only about unresolved decisions.', options: [{ id: 'confirm', text: 'Confirm the proposed scope' }, { id: 'revise', text: 'Revise the scope before implementation' }] });
  } else if (!preciseFix && !questions.length) {
    ambiguities.push({ category: 'scope', description: 'The desired behavior or affected component remains unresolved.', whyItMatters: 'Find the concrete failure and expected outcome before editing.' });
    questions.push({ id: 'fix-scope', question: 'What behavior is incorrect, and what should happen instead?', context: 'Use a reproduction and repository evidence to narrow the change.', options: [{ id: 'reproduce', text: 'Use the supplied reproduction' }, { id: 'describe', text: 'Describe the expected behavior' }] });
  }
  return { clarityScore: Math.max(0, 100 - ambiguities.length * 25), isClear: !ambiguities.length, prompt: trimmed, ambiguities, questions };
}

import { loadRequirements, saveRequirements } from "./state.js";

export async function freezeRequirements(
  root: string,
  topic: string,
  decisions: UserDecision[],
): Promise<string> {
  if (!topic.trim() || !decisions.length) throw new Error('Empty requirements cannot be frozen.');
  for (const decision of decisions) {
    if (!decision.question?.trim() || !decision.options?.length || !decision.options.some(option => option.id === decision.selectedOptionId)) throw new Error('Full question and matching options are required; an option letter is not a requirement.');
  }
  const reqs = await loadRequirements(root);
  const timestamp = new Date().toISOString();

  for (const d of decisions) {
    reqs.requirements.push({
      id: `req-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`,
      topic,
      questionId: d.questionId,
      decision: `${d.question}: ${d.options?.find(option => option.id === d.selectedOptionId)?.text}`,
      rationale: d.customText || "Standard trade-off accepted",
      confirmedAt: d.confirmedAt || timestamp,
    });
  }

  await saveRequirements(root, reqs);
  return path.join(root, ".graphward", "aidlc", "inception", "requirements.md");
}

export function assessGraphClarity(
  changedFiles: string[],
  graph: DependencyGraph,
  memory: MemoryQueryResult,
  config?: GraphClarityConfig
): GraphClarityAssessment {
  const maxDownstream = config?.maxDownstreamConsumers ?? 5;
  const reasons: Array<{ rule: string; detail: string }> = [];
  let mustClarify = false;

  // 1. Count downstream consumers
  for (const file of changedFiles) {
    const nodes = graph.nodes.filter(n => n.path === file || n.id === file);
    const consumers = new Set<string>();
    for (const node of nodes) {
      for (const edge of graph.edges.filter(e => e.to === node.id)) { const source = graph.nodes.find(item => item.id === edge.from); consumers.add(source?.path ?? edge.from); }
    }
    const totalConsumers = consumers.size;
    if (totalConsumers > maxDownstream) {
      mustClarify = true;
      reasons.push({ rule: "downstream-consumers", detail: `File ${file} has ${totalConsumers} downstream consumers, exceeding max of ${maxDownstream}` });
    }
  }

  // 2. Check architectural boundary crossing
  const directories = new Set<string>();
  for (const file of changedFiles) {
    // extract first path segment
    const parts = file.split(/[/\\]/);
    if (parts.length > 0 && parts[0]) {
      // Handle cases where the first segment is '.' or similar if paths are weird, but assume normalized
      if (!/^(test|tests|__tests__)$/.test(parts[0])) directories.add(["src", "lib", "packages", "apps"].includes(parts[0]) && parts.length > 2 ? parts.slice(0, 2).join("/") : parts[0]);
    }
  }
  if (directories.size > 1) {
    mustClarify = true;
    reasons.push({ rule: "boundary-crossing", detail: `Changes span multiple top-level directories: ${Array.from(directories).join(", ")}` });
  }

  // 3. Check negative constraints
  for (const file of changedFiles) {
    for (const constraint of memory.constraints) {
      if (constraint.includes(file)) {
        mustClarify = true;
        reasons.push({ rule: "negative-constraint", detail: `File ${file} matches negative constraint: ${constraint}` });
      }
    }
  }

  return { mustClarify, reasons };
}

export function shouldClarify(
  prompt: string,
  changedFiles: string[],
  graph: DependencyGraph,
  memory: MemoryQueryResult,
  config?: { clarityThreshold?: number; maxDownstreamConsumers?: number }
): { mustClarify: boolean; promptAssessment: ClarityAssessment; graphAssessment: GraphClarityAssessment } {
  const promptAssessment = assessPromptClarity(prompt, { clarityThreshold: config?.clarityThreshold });
  const graphAssessment = assessGraphClarity(changedFiles, graph, memory, { maxDownstreamConsumers: config?.maxDownstreamConsumers });

  return {
    mustClarify: !promptAssessment.isClear || graphAssessment.mustClarify,
    promptAssessment,
    graphAssessment
  };
}
