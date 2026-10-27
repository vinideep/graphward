import { randomUUID } from "node:crypto";
import type { SymbolId } from "../graph/symbol-identity.js";
import type { Change } from "../graph/schema.js";
import type { DependencyGraph } from "../graph/schema.js";
import { factualEdge, nodeSourcePath } from "../graph/trust.js";
import { ProjectFilePolicy } from "../project-files/index.js";

export interface ChangeIntent {
  symbol?: SymbolId;
  filePath?: string;
  action: "create" | "modify" | "delete" | "rename" | "refactor";
  description: string;
}

export interface PredictedImpact {
  affectedFiles: string[];
  affectedSymbols: SymbolId[];
  affectedRoutes: string[];
  affectedExecutionPaths: string[];
  suggestedTests: string[];
  coverage?: SimulationCoverage;
}

export interface SimulationCoverage { symbols: "available" | "partial" | "unavailable"; routes: "available" | "unavailable"; tests: "validated-paths" | "caller-supplied"; limitations: string[] }

export interface GraphEdgeLike {
  from: string; // symbolKey or path
  to: string; // symbolKey or path
  relation?: string;
  route?: string;
  isTest?: boolean;
}

export interface GraphNodeLike {
  id: string;
  path: string;
  qualifiedName?: string;
  kind?: string;
  route?: string;
  symbolId?: SymbolId;
}

export interface GraphLike {
  nodes: GraphNodeLike[];
  edges: GraphEdgeLike[];
  coverage?: SimulationCoverage;
}

/** Adapt canonical graph metadata once, preserving trust and real file identity.
 * Missing SymbolId/route extraction is an explicit coverage limit, never proof
 * that a change affects zero symbols or routes.
 */
export async function repositorySimulationGraph(root: string, graph: DependencyGraph): Promise<GraphLike> {
  const policy = await ProjectFilePolicy.load(root);
  const nodes: GraphNodeLike[] = [];
  for (const node of graph.nodes) {
    const source = await nodeSourcePath(root, node, policy);
    if (!source) continue;
    const raw = node.metadata.symbolId;
    const symbolId = raw && typeof raw === "object" && (raw as Record<string, unknown>).path === source && ["repository", "package", "language", "path", "qualifiedName", "declarationHash", "origin"].every(key => typeof (raw as Record<string, unknown>)[key] === "string") ? raw as SymbolId : undefined;
    const route = typeof node.metadata.route === "string" ? node.metadata.route : undefined;
    nodes.push({ id: node.id, path: source, kind: node.kind, qualifiedName: node.label, ...(symbolId ? { symbolId } : {}), ...(route ? { route } : {}) });
  }
  const byId = new Map(nodes.map(node => [node.id, node]));
  const edges = graph.edges.filter(edge => factualEdge(edge) && byId.has(edge.from) && byId.has(edge.to)).map(edge => ({ from: edge.from, to: edge.to, relation: edge.relation, route: typeof edge.metadata.route === "string" ? edge.metadata.route : undefined, isTest: /(?:^|\/)(?:test|tests|__tests__|spec)\/|\.(?:test|spec)\./.test(byId.get(edge.from)?.path ?? "") }));
  const symbols = nodes.filter(node => node.kind === "symbol");
  const identified = symbols.filter(node => node.symbolId).length;
  const routes = nodes.some(node => node.route) || edges.some(edge => edge.route);
  const symbolCoverage = identified === 0 ? "unavailable" : identified < symbols.length ? "partial" : "available";
  return { nodes, edges, coverage: { symbols: symbolCoverage, routes: routes ? "available" : "unavailable", tests: "validated-paths", limitations: [...(symbolCoverage !== "available" ? ["Some or all native symbols lack a complete SymbolId; empty affectedSymbols does not establish no symbol impact."] : []), ...(!routes ? ["Route metadata is unavailable in this graph; empty affectedRoutes does not establish no route impact."] : []), "Topology prediction does not establish signature or behavioral compatibility."] } };
}

export class ChangeSimulator {
  /**
   * Creates a new first-class Change entity in the initial planned state.
   */
  public createChange(
    intent: ChangeIntent,
    snapshotBeforeId: string,
    predictedImpact: PredictedImpact,
    actor: "agent" | "human" = "agent"
  ): Change {
    const changedFiles = intent.filePath ? [intent.filePath] : intent.symbol ? [intent.symbol.path] : [];
    const changedSymbols = intent.symbol ? [intent.symbol] : [];

    return {
      id: `change_${randomUUID().slice(0, 8)}`,
      snapshotBefore: snapshotBeforeId,
      intent,
      actor,
      changedFiles,
      changedSymbols,
      predictedImpact: {
        affectedFiles: predictedImpact.affectedFiles,
        affectedSymbols: predictedImpact.affectedSymbols,
        affectedRoutes: predictedImpact.affectedRoutes,
        affectedExecutionPaths: predictedImpact.affectedExecutionPaths,
      },
    };
  }

  /**
   * Stage 1: Pre-Edit Intent Simulator
   * Traverses reverse dependency relationships from target symbol/file to predict
   * blast radius, exposed routes, execution paths, and suggested regression tests.
   */
  public static simulateChangeIntent(intent: ChangeIntent, graph: GraphLike, maxDepth: number = 5): PredictedImpact {
    return new ChangeSimulator().simulateChangeIntent(intent, graph, maxDepth);
  }

  public simulateChangeIntent(intent: ChangeIntent, graph: GraphLike, maxDepth: number = 5): PredictedImpact {
    const safeGraph: GraphLike = {
      nodes: Array.isArray(graph?.nodes) ? graph.nodes.filter(Boolean) : [],
      edges: Array.isArray(graph?.edges) ? graph.edges.filter(Boolean) : [],
    };
    const targetFile = intent?.filePath || intent?.symbol?.path;
    const targetSymbolKey = intent?.symbol ? `${intent.symbol.path}#${intent.symbol.qualifiedName}` : undefined;

    const affectedFilesSet = new Set<string>();
    const affectedSymbolsMap = new Map<string, SymbolId>();
    const affectedRoutesSet = new Set<string>();
    const affectedExecutionPaths: string[] = [];
    const suggestedTestsSet = new Set<string>();

    if (targetFile) affectedFilesSet.add(targetFile);
    if (intent?.symbol && targetSymbolKey) {
      affectedSymbolsMap.set(targetSymbolKey, intent.symbol);
    }

    // Build incoming reverse adjacency map (callee/target -> callers/sources)
    const reverseAdjacency = new Map<string, Array<{ from: string; route?: string; isTest?: boolean }>>();
    for (const edge of safeGraph.edges) {
      if (!edge || !edge.to) continue;
      const list = reverseAdjacency.get(edge.to) ?? [];
      list.push({ from: edge.from, route: edge.route, isTest: edge.isTest });
      reverseAdjacency.set(edge.to, list);
    }

    // Node lookup map
    const nodeMap = new Map<string, GraphNodeLike>();
    for (const node of safeGraph.nodes) {
      if (!node || !node.id) continue;
      nodeMap.set(node.id, node);
      if (node.path && !nodeMap.has(node.path)) {
        nodeMap.set(node.path, node);
      }
    }

    // Seed BFS queue
    const seeds: string[] = [];
    if (targetSymbolKey && nodeMap.has(targetSymbolKey)) {
      seeds.push(targetSymbolKey);
    }
    if (targetFile) {
      for (const node of graph.nodes) {
        if (node.path === targetFile || node.id === targetFile) {
          seeds.push(node.id);
        }
      }
    }
    if (seeds.length === 0 && targetFile) {
      seeds.push(targetFile);
    }

    const visited = new Set<string>(seeds);
    const queue: Array<{ id: string; depth: number; pathTrace: string[] }> = seeds.map((s) => ({
      id: s,
      depth: 0,
      pathTrace: [s],
    }));

    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentNode = nodeMap.get(current.id);

      if (currentNode) {
        if (currentNode.path) affectedFilesSet.add(currentNode.path);
        if (currentNode.symbolId) {
          const k = `${currentNode.symbolId.path}#${currentNode.symbolId.qualifiedName}`;
          affectedSymbolsMap.set(k, currentNode.symbolId);
        }
        if (currentNode.route) affectedRoutesSet.add(currentNode.route);

        // Check if node is a test file
        if (
          currentNode.path &&
          /(?:^|\/)(?:test|tests|__tests__|spec)\/|\.(?:test|spec)\./.test(currentNode.path)
        ) {
          suggestedTestsSet.add(currentNode.path);
        }
      }

      if (current.pathTrace.length > 1) {
        affectedExecutionPaths.push(current.pathTrace.join(" -> "));
      }

      if (current.depth >= maxDepth) continue;

      const incoming = reverseAdjacency.get(current.id) ?? [];
      for (const edge of incoming) {
        if (edge.route) affectedRoutesSet.add(edge.route);
        if (edge.isTest || /(?:^|\/)(?:test|tests|__tests__|spec)\/|\.(?:test|spec)\./.test(nodeMap.get(edge.from)?.path ?? "")) {
          const source = nodeMap.get(edge.from)?.path;
          if (source) suggestedTestsSet.add(source);
        }

        if (!visited.has(edge.from)) {
          visited.add(edge.from);
          queue.push({
            id: edge.from,
            depth: current.depth + 1,
            pathTrace: [edge.from, ...current.pathTrace],
          });
        }
      }
    }

    return {
      affectedFiles: Array.from(affectedFilesSet),
      affectedSymbols: Array.from(affectedSymbolsMap.values()),
      affectedRoutes: Array.from(affectedRoutesSet),
      affectedExecutionPaths,
      suggestedTests: Array.from(suggestedTestsSet),
      coverage: graph?.coverage ?? { symbols: "partial", routes: "unavailable", tests: "caller-supplied", limitations: ["Caller-supplied graph paths and metadata have not been verified against a repository."] },
    };
  }
}
