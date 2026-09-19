import { SKILL_NAMES, WORKFLOW_NAMES } from "../templates.js";

export type WorkflowName = (typeof WORKFLOW_NAMES)[number];
export type SkillName = (typeof SKILL_NAMES)[number];

export interface WorkflowRoute {
  kind: "entrypoint";
  mutatesProduct: boolean;
  triggers: string[];
  excludes: string[];
  primary: SkillName[];
  optional: SkillName[];
  requiredGates: string[];
}

export interface SkillInvocationPolicy {
  kind: "engine";
  triggers: string[];
  excludes: string[];
  modelInvocable: false;
}

const IMPLEMENTATION_GATES = [
  "env-vars", "dead-exports", "api-diff", "migration-lint", "api-snapshot",
  "security-audit", "rollback-readiness", "conventions",
];

export const WORKFLOW_CATALOG: Record<WorkflowName, WorkflowRoute> = {
  graphward: { kind: "entrypoint", mutatesProduct: true, triggers: ["implement", "fix", "change", "refactor"], excludes: ["read-only review", "impact analysis only", "architecture map only"], primary: ["graphward-skill", "socratic-clarification-gate", "aidlc-lifecycle-engine", "impact-analysis-engine", "context-budget-optimizer"], optional: ["security-audit-engine", "database-migration-safety-engine", "api-backward-compatibility-engine", "testing-intelligence-engine", "environmental-backpressure-engine", "type-safety-engine", "convention-detector", "operations-readiness-engine", "incremental-sync-engine", "change-history-engine", "adr-compliance-checker", "llm-prompt-injection-guard", "vertical-tdd-engine", "interface-design-explorer", "debugging-engine", "refactoring-planner", "session-handoff-engine", "socratic-stress-tester", "graph-guided-autoresearch", "question-file-engine", "user-intelligence-engine", "change-detection-engine"], requiredGates: IMPLEMENTATION_GATES },
  "initialize-graphward": { kind: "entrypoint", mutatesProduct: false, triggers: ["initialize GraphWard", "bootstrap project intelligence"], excludes: ["implement feature", "create product scaffold"], primary: ["initialize-intelligence-skill"], optional: ["deep-project-knowledge-extractor", "knowledge-base-validator", "graph-engine", "change-history-engine"], requiredGates: [] },
  "decompose-backlog": { kind: "entrypoint", mutatesProduct: false, triggers: ["decompose epic", "create backlog"], excludes: ["implement backlog"], primary: ["backlog-decomposition-engine", "context-budget-optimizer"], optional: ["issue-tracker-sync-engine", "aidlc-lifecycle-engine", "question-file-engine"], requiredGates: [] },
  "deliver-backlog": { kind: "entrypoint", mutatesProduct: true, triggers: ["deliver backlog", "implement feature from backlog"], excludes: ["decompose only", "review only"], primary: ["aidlc-lifecycle-engine", "graphward-skill"], optional: ["backlog-decomposition-engine", "issue-tracker-sync-engine", "incremental-sync-engine"], requiredGates: IMPLEMENTATION_GATES },
  "map-architecture": { kind: "entrypoint", mutatesProduct: false, triggers: ["map architecture", "refresh architecture graph"], excludes: ["implement architecture change"], primary: ["graph-engine"], optional: ["codebase-discovery-engine", "git-intelligence-engine"], requiredGates: [] },
  "analyze-impact": { kind: "entrypoint", mutatesProduct: false, triggers: ["analyze impact", "what will this change affect"], excludes: ["implement the change"], primary: ["change-detection-engine", "impact-analysis-engine"], optional: ["graph-engine"], requiredGates: [] },
  "sync-graphward": { kind: "entrypoint", mutatesProduct: false, triggers: ["sync GraphWard", "refresh engineering intelligence"], excludes: ["implement product code"], primary: ["change-detection-engine", "incremental-sync-engine"], optional: ["staleness-detector", "ongoing-learning-engine", "knowledge-base-validator", "graph-engine"], requiredGates: [] },
  "review-engineering-change": { kind: "entrypoint", mutatesProduct: false, triggers: ["review change", "audit engineering diff"], excludes: ["apply fixes", "implement changes"], primary: ["change-detection-engine", "engineering-change-review"], optional: ["impact-analysis-engine", "security-audit-engine"], requiredGates: [] },
  "scope-requirement": { kind: "entrypoint", mutatesProduct: false, triggers: ["scope requirement", "clarify product request"], excludes: ["implement requirement"], primary: ["requirement-scoper"], optional: ["context-budget-optimizer", "aidlc-lifecycle-engine", "question-file-engine"], requiredGates: [] },
  "discover-codebase": { kind: "entrypoint", mutatesProduct: false, triggers: ["discover codebase", "understand repository"], excludes: ["implement feature", "review diff"], primary: ["codebase-discovery-engine", "convention-detector", "graph-engine"], optional: [], requiredGates: [] },
  "create-project": { kind: "entrypoint", mutatesProduct: true, triggers: ["create project", "scaffold greenfield application"], excludes: ["initialize GraphWard in existing project"], primary: ["greenfield-architect", "initialize-intelligence-skill"], optional: [], requiredGates: IMPLEMENTATION_GATES },
  "grill-me": { kind: "entrypoint", mutatesProduct: false, triggers: ["grill this plan", "stress-test proposal"], excludes: ["implement proposal"], primary: ["socratic-stress-tester"], optional: ["requirement-scoper", "architecture-review-engine", "nfr-adr-governor"], requiredGates: [] },
  handoff: { kind: "entrypoint", mutatesProduct: false, triggers: ["handoff", "serialize session"], excludes: ["continue implementation"], primary: ["session-handoff-engine"], optional: ["context-budget-optimizer", "incremental-sync-engine"], requiredGates: [] },
  tdd: { kind: "entrypoint", mutatesProduct: true, triggers: ["implement with TDD", "red green refactor"], excludes: ["testing strategy only", "review tests"], primary: ["vertical-tdd-engine", "testing-intelligence-engine"], optional: ["type-safety-engine", "environmental-backpressure-engine"], requiredGates: IMPLEMENTATION_GATES },
  "design-an-interface": { kind: "entrypoint", mutatesProduct: false, triggers: ["design interface", "compare API contracts"], excludes: ["implement chosen interface"], primary: ["interface-design-explorer"], optional: ["type-safety-engine", "architecture-review-engine"], requiredGates: [] },
};

export const WORKFLOW_SKILL_ROUTING: Record<WorkflowName, { primary: SkillName[]; optional: SkillName[] }> =
  Object.fromEntries(Object.entries(WORKFLOW_CATALOG).map(([name, route]) => [name, { primary: route.primary, optional: route.optional }])) as Record<WorkflowName, { primary: SkillName[]; optional: SkillName[] }>;

const SPECIALIZED: Partial<Record<SkillName, Pick<SkillInvocationPolicy, "triggers" | "excludes">>> = {
  "graphward-skill": { triggers: ["an entry workflow delegates implementation orchestration"], excludes: ["read-only audit, review, discovery, or impact analysis"] },
  "change-detection-engine": { triggers: ["a route needs the exact changed-file scope"], excludes: ["direct or indirect impact computation"] },
  "impact-analysis-engine": { triggers: ["a route needs dependency, runtime, API, schema, or test blast radius"], excludes: ["changed-file detection only"] },
  "testing-intelligence-engine": { triggers: ["a route needs risk-based test selection or gap analysis"], excludes: ["executing the vertical TDD loop"] },
  "vertical-tdd-engine": { triggers: ["a route explicitly requires red-green-refactor implementation"], excludes: ["test planning or review only"] },
  "incremental-sync-engine": { triggers: ["validated changes must be promoted into canonical intelligence"], excludes: ["proposing an unreviewed learned pattern"] },
  "security-audit-engine": { triggers: ["auth, authorization, secrets, untrusted input, dependencies, LLM, MCP, or trust boundaries changed"], excludes: ["general code quality review without a security surface"] },
  "operations-readiness-engine": { triggers: ["a medium or high risk change needs rollback or operational evidence"], excludes: ["low-risk documentation-only work"] },
  "convention-detector": { triggers: ["repository conventions must be discovered or changed code evaluated"], excludes: ["generic lint or formatting only"] },
};

export const SKILL_INVOCATION_POLICIES: Record<SkillName, SkillInvocationPolicy> =
  Object.fromEntries(SKILL_NAMES.map((name) => [name, { kind: "engine", modelInvocable: false, triggers: SPECIALIZED[name]?.triggers ?? [`the selected entry workflow explicitly routes to ${name}`], excludes: SPECIALIZED[name]?.excludes ?? ["direct selection from an unclassified user request"] }])) as Record<SkillName, SkillInvocationPolicy>;

export function invocationPolicyMarkdown(name: SkillName): string {
  const policy = SKILL_INVOCATION_POLICIES[name];
  return `## Invocation Policy\n\n- **Use when:** ${policy.triggers.join("; ")}.\n- **Do not use when:** ${policy.excludes.join("; ")}.\n- This is an internal engine. An entry workflow must select it; do not compete with entry workflows for the user request.`;
}

export function invocationPolicyDescription(name: SkillName): string {
  const policy = SKILL_INVOCATION_POLICIES[name];
  return `Internal GraphWard engine. Use only when ${policy.triggers.join("; ")}. Do not use for ${policy.excludes.join("; ")}.`;
}

export function workflowCatalogErrors(): string[] {
  const errors: string[] = [];
  const known = new Set(SKILL_NAMES);
  for (const [name, route] of Object.entries(WORKFLOW_CATALOG)) {
    if (!route.triggers.length || !route.excludes.length) errors.push(`${name} needs triggers and exclusions`);
    for (const skill of [...route.primary, ...route.optional]) if (!known.has(skill)) errors.push(`${name} routes to missing skill ${skill}`);
  }
  return errors;
}

const ROUTE_PATTERNS: Array<[WorkflowName, RegExp]> = [
  ["initialize-graphward", /\b(initialize|bootstrap)\b.*\b(graphward|intelligence)\b/i],
  ["decompose-backlog", /\b(decompose|break down|plan)\b.*\b(backlog|epic|initiative)\b/i],
  ["deliver-backlog", /\b(deliver|implement|build)\b.*\b(backlog|feature\s+feat-\d+)/i],
  ["map-architecture", /\b(map|refresh)\b.*\barchitecture|architecture\s+map/i],
  ["analyze-impact", /\b(analy[sz]e|assess|what)\b.*\bimpact|what will .* affect/i],
  ["sync-graphward", /\b(sync|refresh)\b.*\b(graphward|engineering intelligence|knowledge)/i],
  ["review-engineering-change", /\b(review|audit)\b.*\b(change|diff|pull request|repository|system)/i],
  ["scope-requirement", /\b(scope|clarify)\b.*\b(requirement|request|feature)/i],
  ["discover-codebase", /\b(discover|understand|explore)\b.*\b(codebase|repository|project)/i],
  ["create-project", /\b(create|scaffold|start)\b.*\b(new project|greenfield|application)/i],
  ["grill-me", /\b(grill|stress[- ]test|challenge)\b.*\b(plan|proposal|prd)/i],
  ["handoff", /\b(handoff|hand off|serialize session|save context)/i],
  ["tdd", /\b(tdd|red[- ]green[- ]refactor|tests? first)/i],
  ["design-an-interface", /\b(design|compare|explore)\b.*\b(interface|api signature|contract|type definition)/i],
];

export function routeRequest(prompt: string): WorkflowName {
  const readOnly = /\b(read[- ]only|do not (?:edit|modify|change)|no changes|analysis only|review only)\b/i.test(prompt);
  for (const [name, pattern] of ROUTE_PATTERNS) {
    if (!pattern.test(prompt)) continue;
    if (readOnly && WORKFLOW_CATALOG[name].mutatesProduct) {
      if (/\bimpact\b/i.test(prompt)) return "analyze-impact";
      return "review-engineering-change";
    }
    return name;
  }
  return readOnly ? "review-engineering-change" : "graphward";
}
