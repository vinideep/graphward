import type { SymbolId } from "./symbol-identity.js";
import type { DependencyGraph, GraphNode, GraphEdge } from "./schema.js";

export type PartitionLevel = "GLOBAL" | "PACKAGE" | "COMMUNITY" | "TASK";

export interface GlobalGraphSlice {
  level: "GLOBAL";
  packages: Array<{
    name: string;
    symbolCount: number;
    dependencies: string[]; // dependent package names
  }>;
}

export interface PackageGraphSlice {
  level: "PACKAGE";
  package: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface CommunityGraphSlice {
  level: "COMMUNITY";
  communityId: number;
  label: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface TaskGraphSlice {
  level: "TASK";
  seeds: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  hopRadius: number;
  estimatedTokens: number;
}

/**
 * Hierarchical Subgraph Slicing Engine
 * Provides multi-tier graph slicing (Global -> Package -> Community -> Task)
 * enabling sub-second traversals on monorepo graphs exceeding 100k+ symbols.
 */
export class HierarchicalGraphPartitioner {
  private adjacencyCache = new WeakMap<DependencyGraph, Map<string, string[]>>();
  private nodeMapCache = new WeakMap<DependencyGraph, Map<string, GraphNode>>();

  private getAdjacency(graph: DependencyGraph): Map<string, string[]> {
    let adj = this.adjacencyCache.get(graph);
    if (!adj) {
      adj = new Map<string, string[]>();
      for (const edge of graph.edges) {
        const list = adj.get(edge.from) ?? [];
        list.push(edge.to);
        adj.set(edge.from, list);

        const revList = adj.get(edge.to) ?? [];
        revList.push(edge.from);
        adj.set(edge.to, revList);
      }
      this.adjacencyCache.set(graph, adj);
    }
    return adj;
  }

  private getNodeMap(graph: DependencyGraph): Map<string, GraphNode> {
    let map = this.nodeMapCache.get(graph);
    if (!map) {
      map = new Map<string, GraphNode>();
      for (const node of graph.nodes) {
        map.set(node.id, node);
        if (node.path && !map.has(node.path)) {
          map.set(node.path, node);
        }
      }
      this.nodeMapCache.set(graph, map);
    }
    return map;
  }

  /**
   * Level 1: Global Service/Package dependency view
   */
  public sliceGlobal(graph: DependencyGraph): GlobalGraphSlice {
    const packageMap = new Map<string, { symbolCount: number; deps: Set<string> }>();

    for (const node of graph.nodes) {
      const pkg = this.extractPackage(node);
      const entry = packageMap.get(pkg) ?? { symbolCount: 0, deps: new Set() };
      entry.symbolCount++;
      packageMap.set(pkg, entry);
    }

    const nodeToPkg = new Map<string, string>();
    for (const node of graph.nodes) {
      nodeToPkg.set(node.id, this.extractPackage(node));
    }

    for (const edge of graph.edges) {
      const fromPkg = nodeToPkg.get(edge.from);
      const toPkg = nodeToPkg.get(edge.to);
      if (fromPkg && toPkg && fromPkg !== toPkg) {
        packageMap.get(fromPkg)?.deps.add(toPkg);
      }
    }

    const packages = Array.from(packageMap.entries()).map(([name, val]) => ({
      name,
      symbolCount: val.symbolCount,
      dependencies: Array.from(val.deps),
    }));

    return {
      level: "GLOBAL",
      packages,
    };
  }

  /**
   * Level 2: Intra-package symbol dependency graph
   */
  public slicePackage(graph: DependencyGraph, targetPackage: string): PackageGraphSlice {
    const packageNodeIds = new Set<string>();
    const nodes: GraphNode[] = [];

    for (const node of graph.nodes) {
      if (this.extractPackage(node) === targetPackage) {
        packageNodeIds.add(node.id);
        nodes.push(node);
      }
    }

    const edges: GraphEdge[] = [];
    for (const edge of graph.edges) {
      if (packageNodeIds.has(edge.from) && packageNodeIds.has(edge.to)) {
        edges.push(edge);
      }
    }

    return {
      level: "PACKAGE",
      package: targetPackage,
      nodes,
      edges,
    };
  }

  /**
   * Level 3: Community modularity clustering (Label Propagation)
   */
  public sliceCommunity(graph: DependencyGraph): CommunityGraphSlice[] {
    // Label propagation clustering
    const labels = new Map<string, number>();
    const nodeMap = new Map<string, GraphNode>();
    let initialLabel = 0;

    for (const node of graph.nodes) {
      labels.set(node.id, initialLabel++);
      nodeMap.set(node.id, node);
    }

    const neighbors = new Map<string, string[]>();
    for (const edge of graph.edges) {
      const fList = neighbors.get(edge.from) ?? [];
      fList.push(edge.to);
      neighbors.set(edge.from, fList);

      const tList = neighbors.get(edge.to) ?? [];
      tList.push(edge.from);
      neighbors.set(edge.to, tList);
    }

    // 3 iterations of label propagation
    for (let iter = 0; iter < 3; iter++) {
      for (const node of graph.nodes) {
        const nbs = neighbors.get(node.id) ?? [];
        if (nbs.length === 0) continue;

        const labelCounts = new Map<number, number>();
        for (const nb of nbs) {
          const l = labels.get(nb)!;
          labelCounts.set(l, (labelCounts.get(l) ?? 0) + 1);
        }

        let maxCount = -1;
        let bestLabel = labels.get(node.id)!;
        for (const [l, count] of labelCounts) {
          if (count > maxCount) {
            maxCount = count;
            bestLabel = l;
          }
        }
        labels.set(node.id, bestLabel);
      }
    }

    // Group by community label
    const communities = new Map<number, GraphNode[]>();
    for (const [id, label] of labels) {
      const list = communities.get(label) ?? [];
      const node = nodeMap.get(id);
      if (node) list.push(node);
      communities.set(label, list);
    }

    const slices: CommunityGraphSlice[] = [];
    let cId = 1;
    for (const [, cNodes] of communities) {
      const cNodeIds = new Set(cNodes.map((n) => n.id));
      const cEdges = graph.edges.filter((e) => cNodeIds.has(e.from) && cNodeIds.has(e.to));

      slices.push({
        level: "COMMUNITY",
        communityId: cId++,
        label: `Cluster of ${cNodes.length} symbols`,
        nodes: cNodes,
        edges: cEdges,
      });
    }

    return slices;
  }

  /**
   * Level 4: Sliced ego-network centered on task seeds/symbols bounded by token budget and hop radius.
   */
  public sliceTask(
    graph: DependencyGraph,
    seeds: string[],
    tokenBudget: number = 3000,
    maxHops: number = 2
  ): TaskGraphSlice {
    let resolvedBudget = 3000;
    let resolvedHops = 2;

    if (typeof tokenBudget === "number") {
      // Inversion guard: if arg3 <= 15 and arg4 > 15, caller swapped (maxHops, tokenBudget)
      if (tokenBudget <= 15 && typeof maxHops === "number" && maxHops > 15) {
        resolvedHops = tokenBudget;
        resolvedBudget = maxHops;
      } else {
        resolvedBudget = tokenBudget;
        if (typeof maxHops === "number") resolvedHops = maxHops;
      }
    } else if (typeof maxHops === "number") {
      resolvedHops = maxHops;
    }

    const selectedNodes = new Map<string, GraphNode>();
    const nodeMap = this.getNodeMap(graph);

    for (const seed of seeds) {
      const n = nodeMap.get(seed);
      if (n) selectedNodes.set(n.id, n);
    }

    // Forward and reverse adjacency
    const adj = this.getAdjacency(graph);

    // BFS hop expansion
    const visited = new Set<string>(selectedNodes.keys());
    const queue: Array<{ id: string; hop: number }> = Array.from(selectedNodes.keys()).map((id) => ({
      id,
      hop: 0,
    }));

    let estimatedTokens = selectedNodes.size * 35;

    while (queue.length > 0) {
      if (estimatedTokens >= resolvedBudget) break;
      const current = queue.shift()!;
      if (current.hop >= resolvedHops) continue;

      const nbs = adj.get(current.id) ?? [];
      for (const nb of nbs) {
        if (!visited.has(nb)) {
          visited.add(nb);
          const node = nodeMap.get(nb);
          if (node) {
            const addedTokens = 35;
            if (estimatedTokens + addedTokens > resolvedBudget) {
              break; // Token budget ceiling hit
            }
            selectedNodes.set(node.id, node);
            estimatedTokens += addedTokens;
            queue.push({ id: nb, hop: current.hop + 1 });
          }
        }
      }
    }

    const selectedIds = new Set(selectedNodes.keys());
    const safeEdges = Array.isArray(graph?.edges) ? graph.edges : [];
    const selectedEdges = safeEdges.filter(
      (e) => selectedIds.has(e.from) && selectedIds.has(e.to)
    );

    return {
      level: "TASK",
      seeds,
      nodes: Array.from(selectedNodes.values()),
      edges: selectedEdges,
      hopRadius: resolvedHops,
      estimatedTokens,
    };
  }

  private extractPackage(node: GraphNode): string {
    if (node.path) {
      const parts = node.path.split("/");
      if (parts[0] === "packages" && parts.length > 1) {
        return parts[1];
      }
      return parts[0];
    }
    return "root";
  }

  public static sliceGlobal(graph: DependencyGraph): GlobalGraphSlice {
    return new HierarchicalGraphPartitioner().sliceGlobal(graph);
  }

  public static slicePackage(graph: DependencyGraph, targetPackage: string): PackageGraphSlice {
    return new HierarchicalGraphPartitioner().slicePackage(graph, targetPackage);
  }

  public static sliceCommunity(graph: DependencyGraph): CommunityGraphSlice[] {
    return new HierarchicalGraphPartitioner().sliceCommunity(graph);
  }

  public static sliceTask(
    graph: DependencyGraph,
    seeds: string[],
    tokenBudget?: number,
    maxHops?: number
  ): TaskGraphSlice {
    return new HierarchicalGraphPartitioner().sliceTask(graph, seeds, tokenBudget, maxHops);
  }
}

export { HierarchicalGraphPartitioner as HierarchicalPartitioner };

