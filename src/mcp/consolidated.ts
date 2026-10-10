import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadGwConfig } from "../config/index.js";
import { getEngineeringContext } from "../context/orchestrator.js";
import { analyzeImpact, ensureFreshGraph, findSymbol, whoCalls, loadExistingGraph } from "../graph/index.js";
import type { DependencyGraph, Snapshot } from "../graph/schema.js";
import { ChangeSimulator, type ChangeIntent, type GraphLike } from "../simulation/change-simulator.js";
import { CounterfactualGraphBranch, type PatchDelta } from "../simulation/counterfactual-graph.js";
import { RiskEngine } from "../risk/risk-engine.js";
import { HierarchicalPartitioner } from "../graph/partitioning.js";
import { validateChange, syncEngineeringKnowledge } from "../orchestrators/change.js";
import { GRAPHIFY_GRAPH_PATH } from "../providers/graphify.js";
import { providerStatus } from "../providers/manager.js";
import { searchCodeContext } from "../providers/cce.js";
import { inspectProjectProviderRuns } from "../providers/project-status.js";
import { PROVIDER_NAMES } from "../providers/types.js";
import { generateExperimentCandidates, evaluateExperimentStep, loadExperiments, type EvaluateStepOptions } from "../experiment/index.js";
import { assessPromptClarity, checkPhaseGate, freezeRequirements, loadAidlcState, saveAidlcState, type Phase, type UserDecision, type AidlcState } from "../aidlc/index.js";
import { createSessionHandoff, getSessionHandoff, listActiveFlights } from "../flight/index.js";
import { migrateLegacyRegressionPatterns, promoteLearnedPattern, queryProjectMemory, recordLearnedPattern } from "../learning/index.js";
import { packRows } from "./shaper.js";
import { McpToolRegistry } from "./registry.js";

const rootProperty = { type: "string" as const };
const filesProperty = { type: "array" as const, items: { type: "string" as const } };

function rootOf(args: Record<string, unknown>, projectRoot: string): string {
  return typeof args.root === "string" ? path.resolve(args.root) : projectRoot;
}

export async function createConsolidatedRegistry(projectRoot: string): Promise<McpToolRegistry> {
  const registry = new McpToolRegistry();
  registry.register({
    name: "get_engineering_context",
    description: "Build ContextPackV2 from verified GraphWard knowledge, the canonical normalized graph, and current scoped code evidence. Use this before direct file exploration.",
    inputSchema: { type: "object", required: ["task"], additionalProperties: false, properties: { root: rootProperty, task: { type: "string" }, files: filesProperty, budget: { type: "number", minimum: 1 } } },
    handler: async (args) => getEngineeringContext(rootOf(args, projectRoot), { task: args.task as string, files: args.files as string[] | undefined, budget: args.budget as number | undefined }),
  });
  registry.register({
    name: "analyze_change_impact",
    description: "Refresh GraphWard's canonical graph and deterministically analyze direct/indirect impact, tests, risks, and unknowns for changed files.",
    inputSchema: { type: "object", required: ["changedFiles"], additionalProperties: false, properties: { root: rootProperty, changedFiles: filesProperty } },
    handler: async (args) => {
      const root = rootOf(args, projectRoot);
      const freshness = await ensureFreshGraph(root);
      return { freshness, ...(await analyzeImpact(root, args.changedFiles as string[])) };
    },
  });
  registry.register({
    name: "validate_change",
    description: "Run deterministic change validation: impact, all built-in safety gates, claims, knowledge references, and citation freshness.",
    inputSchema: { type: "object", additionalProperties: false, properties: { root: rootProperty, files: filesProperty, base: { type: "string" } } },
    handler: async (args) => validateChange(rootOf(args, projectRoot), args.files as string[] | undefined, typeof args.base === "string" ? args.base : "HEAD"),
  });
  registry.register({
    name: "sync_engineering_knowledge",
    description: "Post-edit synchronization for GraphWard's graph, provider indexes, derived claims, and knowledge health. Canonical prose is flagged for model synthesis rather than silently rewritten.",
    inputSchema: { type: "object", additionalProperties: false, properties: { root: rootProperty, files: filesProperty } },
    handler: async (args) => syncEngineeringKnowledge(rootOf(args, projectRoot), args.files as string[] | undefined),
  });
  registry.register({
    name: "provider_status",
    description: "Report pinned Graphify/CCE health, policy, versions, fallbacks, and remediation without installing anything.",
    inputSchema: { type: "object", additionalProperties: false, properties: { root: rootProperty } },
    handler: async (args) => {
      const root = rootOf(args, projectRoot);
      const providerConfig = await loadGwConfig(root);
      const disabled = providerConfig.providers.policy === "native";
      const [binaries, projectRuns] = await Promise.all([
        Promise.all(PROVIDER_NAMES.map((name) => providerStatus(name, { disabled }))),
        inspectProjectProviderRuns(root, { disabled }),
      ]);
      return { policy: providerConfig.providers.policy, requireProviders: providerConfig.providers.requireProviders, binaries, projectRuns };
    },
  });

  registry.register({
    name: "generate_experiment_candidates",
    description: "Autoresearch Candidate Generator: Identifies high-leverage optimization candidates (hotspots, fan-in bottlenecks, query boundaries) using code graph and git intelligence.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: rootProperty,
        focusFile: { type: "string", description: "Optional file to filter candidates by." },
        topN: { type: "number", minimum: 1, description: "Maximum number of candidate opportunities to return (default 10)." },
      },
    },
    handler: async (args) => {
      const root = rootOf(args, projectRoot);
      return generateExperimentCandidates(root, {
        focusFile: args.focusFile as string | undefined,
        topN: args.topN as number | undefined,
      });
    },
  });

  registry.register({
    name: "evaluate_experiment_step",
    description: "Autoresearch Step Evaluator: Executes 3-tier verification (safety gates, regression tests, mechanical metric comparison). Retains changes on improvement (KEEP) or safely rolls back on regression (REVERT).",
    inputSchema: {
      type: "object",
      required: ["goal", "hypothesis", "targetFile", "baselineValue", "metricConfig"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        flightId: { type: "string", description: "Flight id tracking the active modification cycle." },
        goal: { type: "string", description: "Target optimization goal." },
        hypothesis: { type: "string", description: "Specific hypothesis tested by this single change." },
        targetFile: { type: "string", description: "The single file modified during this iteration." },
        targetSymbol: { type: "string", description: "Optional symbol name within the target file." },
        baselineValue: { type: "number", description: "Baseline metric value measured prior to change." },
        metricConfig: {
          type: "object",
          required: ["name", "command", "goal"],
          properties: {
            name: { type: "string" },
            command: { type: "string" },
            parsePattern: { type: "string" },
            goal: { type: "string", enum: ["minimize", "maximize", "target"] },
            targetValue: { type: "number" },
            sampleRuns: { type: "number" },
            tolerancePercent: { type: "number" },
          },
        },
        testCommand: { type: "string", description: "Optional test command to run for Tier 2 verification." },
        skipGates: { type: "boolean", description: "Skip Tier 1 deterministic safety gates (default false)." },
        autoRollback: { type: "boolean", description: "Automatically rollback target files if verdict is REVERT (default true)." },
        commitOnKeep: { type: "boolean", description: "Automatically create a git commit if verdict is KEEP (default false)." },
        useWorktree: { type: "boolean", description: "Run experiment in an isolated git worktree instead of the main workspace. Eliminates risk to uncommitted work (default false)." },
      },
    },
    handler: async (args) => {
      const root = rootOf(args, projectRoot);
      return evaluateExperimentStep(root, args as unknown as EvaluateStepOptions);
    },
  });

  registry.register({
    name: "get_experiment_history",
    description: "Autoresearch Experiment History: Retrieves past experiment trials, metrics, and outcomes from the Experiment Graph ledger.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: rootProperty,
        targetFile: { type: "string", description: "Optional file path to filter historical experiments." },
      },
    },
    handler: async (args) => {
      const root = rootOf(args, projectRoot);
      return loadExperiments(root, { targetFile: args.targetFile as string | undefined });
    },
  });

  registry.register({
    name: "assess_prompt_clarity",
    description: "Socratic Clarification Gate: Assesses prompt ambiguity, missing non-functional requirements, and architectural trade-offs. Returns targeted multiple-choice options before coding.",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      additionalProperties: false,
      properties: {
        prompt: { type: "string", description: "The user's prompt or requirement statement." },
        changedFiles: filesProperty,
      },
    },
    handler: async (args) => {
      const root = rootOf(args, projectRoot);
      const config = await loadGwConfig(root);
      const { shouldClarify } = await import("../aidlc/clarification.js");
      
      let graph: any = { nodes: [], edges: [], schemaVersion: "1.0", graphType: "dependency", generatedAt: new Date().toISOString(), scope: "project", unknowns: [] };
      try {
        const graphData = await readFile(path.join(root, ".graphward", "graph", "dependency-graph.json"), "utf8");
        graph = JSON.parse(graphData);
      } catch {}
      const memory = await queryProjectMemory(root, {});
      
      return shouldClarify(args.prompt as string, (args.changedFiles as string[] || []), graph, memory, config);
    },
  });

  registry.register({
    name: "check_aidlc_gate",
    description: "AI-DLC Lifecycle Gate Checker: Programmatically validates whether the repository satisfies objective criteria to exit the current phase (discovery, inception, construction, operations).",
    inputSchema: {
      type: "object",
      required: ["phase"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        phase: {
          type: "string",
          enum: ["discovery", "inception", "construction", "operations"],
          description: "The phase boundary to evaluate.",
        },
      },
    },
    handler: async (args) => {
      const root = rootOf(args, projectRoot);
      return checkPhaseGate(root, args.phase as Phase);
    },
  });

  registry.register({
    name: "freeze_clarified_requirements",
    description: "AI-DLC Requirement Freeze: Commits user-selected multiple-choice decisions into .graphward/aidlc/inception/requirements.md before construction starts.",
    inputSchema: {
      type: "object",
      required: ["topic", "decisions"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        topic: { type: "string", description: "Feature or initiative topic." },
        decisions: { type: "array", description: "Array of user decisions with questionId and selectedOptionId." },
      },
    },
    handler: async (args) => {
      const root = rootOf(args, projectRoot);
      const reqPath = await freezeRequirements(root, args.topic as string, args.decisions as unknown as UserDecision[]);
      return { status: "frozen", path: reqPath };
    },
  });

  registry.register({
    name: "get_aidlc_state",
    description: "AI-DLC State Inspector: Returns the current structured AI-DLC lifecycle position, active unit, and breadcrumb.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: rootProperty,
      },
    },
    handler: async (args) => {
      const root = rootOf(args, projectRoot);
      return loadAidlcState(root);
    },
  });

  registry.register({
    name: "update_aidlc_state",
    description: "AI-DLC State Transition Engine: Updates active lifecycle phase, stage, workflow, active hat, and breadcrumb, writing aidlc-state.json and projecting aidlc-state.md.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: rootProperty,
        phase: { type: "string", description: "Current AI-DLC phase (discovery, inception, construction, operations, transition)." },
        stage: { type: "string", description: "Current stage description." },
        activeWorkflow: { type: "string", description: "Active workflow name." },
        activeHat: { type: "string", description: "Active agent hat / persona." },
        activeUnit: { type: "string", description: "Active work unit or ticket ID." },
        breadcrumb: { type: "string", description: "AI-DLC progress breadcrumb string." },
      },
    },
    handler: async (args) => {
      const root = rootOf(args, projectRoot);
      const state = await loadAidlcState(root);
      if (typeof args.phase === "string") state.position.phase = args.phase;
      if (typeof args.stage === "string") state.position.stage = args.stage;
      if (typeof args.activeWorkflow === "string") state.position.activeWorkflow = args.activeWorkflow;
      if (typeof args.activeHat === "string") state.position.activeHat = args.activeHat;
      if (typeof args.activeUnit === "string") state.position.activeUnit = args.activeUnit;
      if (typeof args.breadcrumb === "string") state.breadcrumb = args.breadcrumb;
      else if (args.phase || args.stage) {
        state.breadcrumb = `AI-DLC: ${state.position.phase} -> ${state.position.stage} -> in-progress`;
      }
      await saveAidlcState(root, state);
      return { status: "updated", state };
    },
  });

  registry.register({
    name: "find_symbol",
    description: "Find symbol definitions across the repository with exact file:line evidence using the deterministic graph.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: rootProperty,
        name: { type: "string" },
        query: { type: "string" },
        limit: { type: "number", minimum: 1 },
      },
    },
    handler: async (args) => {
      const root = rootOf(args, projectRoot);
      const symName = (typeof args.name === "string" ? args.name : "") || (typeof args.query === "string" ? args.query : "");
      if (!symName) return { matches: [], error: "name or query is required" };
      await ensureFreshGraph(root);
      const matches = await findSymbol(root, symName);
      const limit = typeof args.limit === "number" ? args.limit : 50;
      return { matches: matches.slice(0, limit) };
    },
  });

  registry.register({
    name: "who_calls",
    description: "Reverse-walk the call graph to find callers of a symbol with call-site file:line evidence and confidence.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: rootProperty,
        name: { type: "string" },
        symbol: { type: "string" },
        file: { type: "string" },
        transitive: { type: "boolean" },
        limit: { type: "number", minimum: 1 },
      },
    },
    handler: async (args) => {
      const root = rootOf(args, projectRoot);
      const symName = (typeof args.name === "string" ? args.name : "") || (typeof args.symbol === "string" ? args.symbol : "");
      if (!symName) return { callers: [], error: "name or symbol is required" };
      await ensureFreshGraph(root);
      const result = await whoCalls(root, symName, { transitive: args.transitive === true });
      let filteredCallers = result.callers;
      if (typeof args.file === "string") {
        const fileTarget = args.file;
        filteredCallers = filteredCallers.filter(
          (c) => c.path === fileTarget || c.evidence?.some((e) => e.startsWith(fileTarget)),
        );
      }
      const limit = typeof args.limit === "number" ? args.limit : 50;
      const callers = filteredCallers.slice(0, limit);
      return {
        ...result,
        callers,
        packed: packRows(callers as unknown as Array<Record<string, unknown>>, ["id", "label", "kind", "confidence", "evidence", "path"]),
      };
    },
  });

  registry.register({
    name: "create_session_handoff",
    description: "Package active flight predictions, uncommitted dirty files, test records, and AI-DLC state for cross-IDE session handoff.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: rootProperty,
        sessionId: { type: "string" },
        sourceIde: { type: "string" },
        targetIde: { type: "string" },
        note: { type: "string" },
        intent: { type: "string" },
        files: filesProperty,
      },
    },
    handler: async (args) => {
      const root = rootOf(args, projectRoot);
      return createSessionHandoff(root, {
        sessionId: typeof args.sessionId === "string" ? args.sessionId : undefined,
        sourceIde: typeof args.sourceIde === "string" ? args.sourceIde : undefined,
        targetIde: typeof args.targetIde === "string" ? args.targetIde : undefined,
        note: typeof args.note === "string" ? args.note : undefined,
        intent: typeof args.intent === "string" ? args.intent : undefined,
        files: Array.isArray(args.files) ? (args.files as string[]) : undefined,
      });
    },
  });

  registry.register({
    name: "get_session_handoff",
    description: "Retrieve the latest cross-IDE session handoff packet or a specific session by ID.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: rootProperty,
        sessionId: { type: "string" },
      },
    },
    handler: async (args) => {
      const root = rootOf(args, projectRoot);
      const packet = await getSessionHandoff(root, typeof args.sessionId === "string" ? args.sessionId : undefined);
      return packet ?? { found: false, message: "no session handoff found" };
    },
  });

  registry.register({
    name: "list_active_flights",
    description: "List all open agent flight records to identify active changes and detect potential multi-IDE edit conflicts.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: rootProperty,
      },
    },
    handler: async (args) => {
      const root = rootOf(args, projectRoot);
      const flights = await listActiveFlights(root);
      return { activeFlights: flights, count: flights.length };
    },
  });

  registry.register({
    name: "record_learned_pattern",
    description: "Deprecated compatibility alias: propose an evidence-backed learned pattern for incremental-sync review; does not write durable memory directly.",
    inputSchema: {
      type: "object",
      required: ["type", "title", "description", "rule", "targetFiles"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        type: { type: "string", enum: ["convention", "regression", "constraint"] },
        title: { type: "string" },
        description: { type: "string" },
        rule: { type: "string" },
        targetFiles: filesProperty,
      },
    },
    handler: async (args) => {
      const root = rootOf(args, projectRoot);
      return recordLearnedPattern(root, {
        type: args.type as "convention" | "regression" | "constraint",
        title: args.title as string,
        description: args.description as string,
        rule: args.rule as string,
        targetFiles: Array.isArray(args.targetFiles) ? (args.targetFiles as string[]) : undefined,
      });
    },
  });

  registry.register({
    name: "promote_learned_pattern",
    description: "Incremental-sync single-writer action: review and either promote or reject one evidence-backed learning proposal.",
    inputSchema: {
      type: "object",
      required: ["id", "reviewer", "rationale", "promote"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        id: { type: "string" },
        reviewer: { type: "string" },
        rationale: { type: "string" },
        promote: { type: "boolean" },
      },
    },
    handler: async (args) => promoteLearnedPattern(rootOf(args, projectRoot), args.id as string, {
      reviewer: args.reviewer as string,
      rationale: args.rationale as string,
      promote: args.promote as boolean,
    }),
  });

  registry.register({
    name: "migrate_legacy_regression_patterns",
    description: "One-time, non-destructive migration of legacy regression patterns. Preserves the source and marks imported entries unverified.",
    inputSchema: { type: "object", additionalProperties: false, properties: { root: rootProperty } },
    handler: async (args) => migrateLegacyRegressionPatterns(rootOf(args, projectRoot)),
  });

  registry.register({
    name: "query_project_memory",
    description: "Query durable project memory for coding conventions, negative constraints, and regression patterns.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: rootProperty,
        file: { type: "string" },
        topic: { type: "string" },
      },
    },
    handler: async (args) => {
      const root = rootOf(args, projectRoot);
      return queryProjectMemory(root, {
        file: typeof args.file === "string" ? args.file : undefined,
        topic: typeof args.topic === "string" ? args.topic : undefined,
      });
    },
  });

  registry.register({
    name: "simulate_change_intent",
    description: "Stage 1 Pre-Edit Intent Simulator: Traverses reverse dependencies from a proposed change intent to predict blast radius, affected routes, execution paths, and suggested regression tests.",
    inputSchema: {
      type: "object",
      required: ["intent"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        intent: {
          type: "object",
          required: ["action", "description"],
          properties: {
            action: { type: "string", enum: ["create", "modify", "delete", "rename", "refactor"] },
            description: { type: "string" },
            filePath: { type: "string" },
            symbol: { type: "object" },
          },
        },
        maxDepth: { type: "number", minimum: 1, description: "Max traversal depth for reverse blast radius (default 5)." },
        graph: { type: "object", description: "Optional in-memory graph to simulate against." },
      },
    },
    handler: async (args) => {
      const root = rootOf(args, projectRoot);
      const rawIntent = (typeof args.intent === "object" && args.intent !== null ? args.intent : {
        action: "modify",
        description: String(args.intent ?? ""),
      }) as ChangeIntent;

      let graph = args.graph as GraphLike | undefined;
      if (!graph) {
        await ensureFreshGraph(root);
        const depGraph = await loadExistingGraph(path.join(root, ".graphward", "graph", "dependency-graph.json"));
        graph = depGraph
          ? {
              nodes: depGraph.nodes.map((n) => ({ id: n.id, path: n.path ?? "", kind: n.kind, label: n.label })),
              edges: depGraph.edges.map((e) => ({ from: e.from, to: e.to, relation: e.relation })),
            }
          : { nodes: [], edges: [] };
      }

      const maxDepth = typeof args.maxDepth === "number" ? args.maxDepth : 5;
      return ChangeSimulator.simulateChangeIntent(rawIntent, graph, maxDepth);
    },
  });

  registry.register({
    name: "evaluate_counterfactual",
    description: "Stage 2 Post-Patch Counterfactual Graph Branch: Evaluates tentative in-memory patch overlays before committing, detecting newly introduced dependency cycles and broken call contracts with 100% precision.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: rootProperty,
        baseSnapshot: { type: "object", description: "Optional baseline Snapshot record." },
        delta: {
          type: "object",
          properties: {
            patchHash: { type: "string" },
            addedNodes: { type: "array", items: { type: "object" } },
            removedNodeIds: { type: "array", items: { type: "string" } },
            addedEdges: { type: "array", items: { type: "object" } },
            removedEdges: { type: "array", items: { type: "object" } },
          },
        },
        baseGraph: { type: "object", description: "Optional base graph to branch from." },
      },
    },
    handler: async (args) => {
      const root = rootOf(args, projectRoot);
      let baseGraph = args.baseGraph as GraphLike | undefined;
      if (!baseGraph) {
        await ensureFreshGraph(root);
        const depGraph = await loadExistingGraph(path.join(root, ".graphward", "graph", "dependency-graph.json"));
        baseGraph = depGraph
          ? {
              nodes: depGraph.nodes.map((n) => ({ id: n.id, path: n.path ?? "", kind: n.kind, label: n.label })),
              edges: depGraph.edges.map((e) => ({ from: e.from, to: e.to, relation: e.relation })),
            }
          : { nodes: [], edges: [] };
      }

      const baseSnapshot: Snapshot = (args.baseSnapshot as Snapshot) ?? {
        id: `snap_${Date.now()}`,
        repository: path.basename(root),
        commit: "HEAD",
        kind: "REAL",
        generatedAt: new Date().toISOString(),
        schemaVersion: "2.2",
      };

      const delta = (args.delta as PatchDelta) ?? {};
      return CounterfactualGraphBranch.evaluateClosureDelta(baseSnapshot, baseGraph, delta);
    },
  });

  registry.register({
    name: "assess_risk",
    description: "Adaptive Risk Engine: Assesses multi-dimensional risk profile (blast radius, runtime exposure, unknown dynamic boundaries, test coverage deficit, architectural purity) and generates tiered verification plans.",
    inputSchema: {
      type: "object",
      required: ["predictedImpact"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        predictedImpact: {
          type: "object",
          required: ["affectedFiles", "affectedSymbols"],
          properties: {
            affectedFiles: filesProperty,
            affectedSymbols: { type: "array", items: { type: "object" } },
            affectedRoutes: { type: "array", items: { type: "string" } },
            affectedExecutionPaths: { type: "array", items: { type: "string" } },
            suggestedTests: { type: "array", items: { type: "string" } },
          },
        },
        inboundRuntimeRequests: { type: "number", minimum: 0 },
        hasUnknownBoundaries: { type: "boolean" },
        existingTestCount: { type: "number", minimum: 0 },
        introducesCycle: { type: "boolean" },
        isPublicApi: { type: "boolean" },
        isFinancialOrDb: { type: "boolean" },
      },
    },
    handler: async (args) => {
      return RiskEngine.assessRisk({
        predictedImpact: args.predictedImpact as any,
        inboundRuntimeRequests: typeof args.inboundRuntimeRequests === "number" ? args.inboundRuntimeRequests : undefined,
        hasUnknownBoundaries: typeof args.hasUnknownBoundaries === "boolean" ? args.hasUnknownBoundaries : undefined,
        existingTestCount: typeof args.existingTestCount === "number" ? args.existingTestCount : undefined,
        introducesCycle: typeof args.introducesCycle === "boolean" ? args.introducesCycle : undefined,
        isPublicApi: typeof args.isPublicApi === "boolean" ? args.isPublicApi : undefined,
        isFinancialOrDb: typeof args.isFinancialOrDb === "boolean" ? args.isFinancialOrDb : undefined,
      });
    },
  });

  registry.register({
    name: "slice_graph",
    description: "Hierarchical Graph Partitioner: Extracts scoped subgraphs across 4 tiers (GLOBAL package architecture, PACKAGE intra-module closure, COMMUNITY modularity clustering, TASK seed-hop bounded view) for 100k+ symbol monorepos.",
    inputSchema: {
      type: "object",
      required: ["level"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        level: { type: "string", enum: ["GLOBAL", "PACKAGE", "COMMUNITY", "TASK"] },
        package: { type: "string", description: "Target package name (required when level is PACKAGE)." },
        seeds: { type: "array", items: { type: "string" }, description: "Seed symbol/file IDs (required when level is TASK)." },
        maxHops: { type: "number", minimum: 1, description: "Max BFS hop radius for TASK slice (default 2)." },
        tokenBudget: { type: "number", minimum: 1, description: "Token ceiling for TASK slice (default 2500)." },
        graph: { type: "object", description: "Optional in-memory DependencyGraph to slice." },
      },
    },
    handler: async (args) => {
      const root = rootOf(args, projectRoot);
      let graph = args.graph as DependencyGraph | undefined;
      if (!graph) {
        await ensureFreshGraph(root);
        const loaded = await loadExistingGraph(path.join(root, ".graphward", "graph", "dependency-graph.json"));
        if (!loaded) throw new Error("No dependency-graph.json found to slice");
        graph = loaded;
      }

      const partitioner = new HierarchicalPartitioner();
      const level = String(args.level ?? "GLOBAL").toUpperCase();
      switch (level) {
        case "GLOBAL":
          return partitioner.sliceGlobal(graph);
        case "PACKAGE":
          return partitioner.slicePackage(graph, String(args.package ?? ""));
        case "COMMUNITY":
          return partitioner.sliceCommunity(graph);
        case "TASK":
          return partitioner.sliceTask(
            graph,
            Array.isArray(args.seeds) ? (args.seeds as string[]) : [],
            typeof args.tokenBudget === "number" ? args.tokenBudget : undefined,
            typeof args.maxHops === "number" ? args.maxHops : undefined,
          );
        default:
          throw new Error(`Unknown slice level: ${level}. Must be GLOBAL, PACKAGE, COMMUNITY, or TASK.`);
      }
    },
  });

  const config = await loadGwConfig(projectRoot);
  if (config.providers.exposeRawMcp === true) {
    registry.register({
      name: "provider_graphify_evidence",
      description: "Expert mode: inspect capped raw Graphify provider evidence. GraphWard does not treat this output as canonical knowledge.",
      inputSchema: { type: "object", additionalProperties: false, properties: { root: rootProperty, limit: { type: "number", minimum: 1 } } },
      handler: async (args) => {
        const root = rootOf(args, projectRoot);
        const limit = typeof args.limit === "number" ? Math.min(1000, args.limit) : 100;
        const raw = JSON.parse(await readFile(path.join(root, GRAPHIFY_GRAPH_PATH), "utf8")) as { nodes?: unknown[]; edges?: unknown[]; links?: unknown[] };
        return { canonical: false, nodes: (raw.nodes ?? []).slice(0, limit), edges: (raw.edges ?? raw.links ?? []).slice(0, limit) };
      },
    });
    registry.register({
      name: "provider_cce_retrieval",
      description: "Expert mode: request CCE-backed retrieval through GraphWard's mandatory scope and freshness filters.",
      inputSchema: { type: "object", required: ["query"], additionalProperties: false, properties: { root: rootProperty, query: { type: "string" }, scope: filesProperty, topK: { type: "number", minimum: 1 } } },
      handler: async (args) => searchCodeContext(rootOf(args, projectRoot), args.query as string, args.scope as string[] | undefined ?? [], { topK: args.topK as number | undefined }),
    });
  }
  return registry;
}
