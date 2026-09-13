import type { DependencyGraph } from "../graph/schema.js";

export interface ImpactAnalysis {
  affectedTests: string[];
  reason: Map<string, string[]>;
}

export function computeTestImpact(
  changedFiles: string[],
  graph: DependencyGraph,
  testPattern?: RegExp
): ImpactAnalysis {
  const pattern = testPattern ?? /(?:\.test\.|^test[/\\])/;
  const affectedTests = new Set<string>();
  const reason = new Map<string, string[]>();

  // Build reverse adjacency list: to -> from
  const reverseEdges = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = reverseEdges.get(edge.to) || [];
    list.push(edge.from);
    reverseEdges.set(edge.to, list);
  }

  for (const file of changedFiles) {
    // Find initial nodes for the changed file
    const initialNodeIds = new Set<string>();
    for (const node of graph.nodes) {
      if (node.path === file || node.id === file) {
        initialNodeIds.add(node.id);
      }
    }

    const queue = Array.from(initialNodeIds);
    const visited = new Set<string>(queue);

    while (queue.length > 0) {
      const current = queue.shift()!;
      const dependents = reverseEdges.get(current) || [];
      for (const dep of dependents) {
        if (!visited.has(dep)) {
          visited.add(dep);
          queue.push(dep);
        }
      }
    }

    for (const nodeId of visited) {
      const node = graph.nodes.find(n => n.id === nodeId);
      if (node && node.path && pattern.test(node.path)) {
        affectedTests.add(node.path);
        const existingReasons = reason.get(node.path) || [];
        if (!existingReasons.includes(file)) {
          existingReasons.push(file);
        }
        reason.set(node.path, existingReasons);
      }
    }
  }

  return {
    affectedTests: Array.from(affectedTests),
    reason
  };
}
