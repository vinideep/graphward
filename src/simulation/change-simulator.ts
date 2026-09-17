import { randomUUID } from "node:crypto";
import type { SymbolId } from "../graph/symbol-identity.js";
import type { Change } from "../graph/schema.js";

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
}

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
          (currentNode.path.includes("test") || currentNode.path.includes("spec"))
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
        if (edge.isTest || edge.from.includes("test") || edge.from.includes("spec")) {
          suggestedTestsSet.add(edge.from);
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
    };
  }
}
