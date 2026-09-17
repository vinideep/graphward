import type { SymbolId } from "../graph/symbol-identity.js";
import { formatSymbolUri } from "../graph/symbol-identity.js";
import type { SqlitePartitionedStore } from "../storage/sqlite-store.js";

export type CoverageTag = "STATIC" | "TYPE" | "RUNTIME" | "TEST" | "GIT";

export interface ExecutionFlowNode {
  symbolId: SymbolId;
  symbolKey: string;
  totalInvocations: number;
  totalErrors: number;
  latenciesMs: number[];
  tags: Set<CoverageTag>;
  firstSeen: string;
  lastSeen: string;
}

export interface ExecutionFlowEdge {
  id: string;
  callerSymbol: SymbolId;
  calleeSymbol: SymbolId;
  callerKey: string;
  calleeKey: string;
  invocationCount: number;
  errorCount: number;
  latenciesMs: number[];
  testSuites: Set<string>;
  tags: Set<CoverageTag>;
  firstSeen: string;
  lastSeen: string;
  route?: string;
}

export interface FlowComparisonResult {
  concordantEdges: Array<{ caller: string; callee: string; count: number }>;
  staticOnlyEdges: Array<{ caller: string; callee: string }>;
  runtimeOnlyEdges: Array<{ caller: string; callee: string; count: number }>;
  deadCodeRisk: Array<{ symbol: string; reason: string }>;
  dynamicDispatchDiscovered: Array<{ caller: string; callee: string }>;
  totalObservedInvocations: number;
  overallRuntimeConcordance: number; // 0.0 to 1.0
}

export interface RecordFlowInvocationOptions {
  latencyMs?: number;
  isError?: boolean;
  testSuite?: string;
  route?: string;
  tags?: CoverageTag[];
  environment?: string;
}

export class ExecutionFlowTracker {
  private nodes = new Map<string, ExecutionFlowNode>();
  private edges = new Map<string, ExecutionFlowEdge>();
  private store?: SqlitePartitionedStore;

  constructor(store?: SqlitePartitionedStore) {
    this.store = store;
  }

  private getSymbolKey(sym: SymbolId): string {
    return `${sym.path}#${sym.qualifiedName}`;
  }

  /**
   * Records a runtime invocation between caller and callee symbols.
   */
  public recordInvocation(
    caller: SymbolId,
    callee: SymbolId,
    options: RecordFlowInvocationOptions = {}
  ): void {
    const now = new Date().toISOString();
    const callerKey = this.getSymbolKey(caller);
    const calleeKey = this.getSymbolKey(callee);
    const edgeId = `${callerKey}->${calleeKey}`;

    const tags = new Set<CoverageTag>(options.tags ?? ["RUNTIME"]);
    if (options.testSuite) {
      tags.add("TEST");
    }

    // 1. Update Caller Node
    let callerNode = this.nodes.get(callerKey);
    if (!callerNode) {
      callerNode = {
        symbolId: caller,
        symbolKey: callerKey,
        totalInvocations: 0,
        totalErrors: 0,
        latenciesMs: [],
        tags: new Set(tags),
        firstSeen: now,
        lastSeen: now,
      };
      this.nodes.set(callerKey, callerNode);
    }
    callerNode.totalInvocations++;
    callerNode.lastSeen = now;
    tags.forEach((t) => callerNode!.tags.add(t));

    // 2. Update Callee Node
    let calleeNode = this.nodes.get(calleeKey);
    if (!calleeNode) {
      calleeNode = {
        symbolId: callee,
        symbolKey: calleeKey,
        totalInvocations: 0,
        totalErrors: 0,
        latenciesMs: [],
        tags: new Set(tags),
        firstSeen: now,
        lastSeen: now,
      };
      this.nodes.set(calleeKey, calleeNode);
    }
    calleeNode.totalInvocations++;
    calleeNode.lastSeen = now;
    if (options.isError) calleeNode.totalErrors++;
    if (options.latencyMs !== undefined) {
      calleeNode.latenciesMs.push(options.latencyMs);
      if (calleeNode.latenciesMs.length > 500) calleeNode.latenciesMs.shift();
    }
    tags.forEach((t) => calleeNode!.tags.add(t));

    // 3. Update Edge
    let edge = this.edges.get(edgeId);
    if (!edge) {
      edge = {
        id: edgeId,
        callerSymbol: caller,
        calleeSymbol: callee,
        callerKey,
        calleeKey,
        invocationCount: 0,
        errorCount: 0,
        latenciesMs: [],
        testSuites: new Set(),
        tags: new Set(tags),
        firstSeen: now,
        lastSeen: now,
        route: options.route,
      };
      this.edges.set(edgeId, edge);
    }
    edge.invocationCount++;
    edge.lastSeen = now;
    if (options.isError) edge.errorCount++;
    if (options.latencyMs !== undefined) {
      edge.latenciesMs.push(options.latencyMs);
      if (edge.latenciesMs.length > 500) edge.latenciesMs.shift();
    }
    if (options.testSuite) edge.testSuites.add(options.testSuite);
    if (options.route) edge.route = options.route;
    tags.forEach((t) => edge!.tags.add(t));

    // 4. Mirror to Persistent Sqlite Store if configured
    if (this.store) {
      this.store.recordRuntimeObservation({
        id: edgeId,
        fromSymbol: formatSymbolUri(caller),
        toSymbol: formatSymbolUri(callee),
        route: options.route,
        testSuite: options.testSuite,
        environment: options.environment ?? "dev",
        count: edge.invocationCount,
        lastObserved: now,
      });
    }
  }

  public getNodes(): ExecutionFlowNode[] {
    return Array.from(this.nodes.values());
  }

  public getEdges(): ExecutionFlowEdge[] {
    return Array.from(this.edges.values());
  }

  public getNodeStats(symbolKey: string): {
    invocations: number;
    errors: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  } | null {
    const node = this.nodes.get(symbolKey);
    if (!node) return null;
    return {
      invocations: node.totalInvocations,
      errors: node.totalErrors,
      ...this.calculatePercentiles(node.latenciesMs),
    };
  }

  /**
   * Compares statically inferred call edges against empirically observed runtime flows.
   */
  public compareObservedVsInferred(
    staticEdges: Array<{
      from: SymbolId | string;
      to: SymbolId | string;
      callerName?: string;
      calleeName?: string;
    }>
  ): FlowComparisonResult {
    const staticEdgeKeys = new Set<string>();
    const staticCallerMap = new Map<string, string>(); // edgeKey -> caller
    const staticCalleeMap = new Map<string, string>(); // edgeKey -> callee

    for (const se of staticEdges) {
      const fromStr = typeof se.from === "string" ? se.from : this.getSymbolKey(se.from);
      const toStr = typeof se.to === "string" ? se.to : this.getSymbolKey(se.to);
      const key = `${fromStr}->${toStr}`;
      staticEdgeKeys.add(key);
      staticCallerMap.set(key, fromStr);
      staticCalleeMap.set(key, toStr);
    }

    const concordantEdges: Array<{ caller: string; callee: string; count: number }> = [];
    const runtimeOnlyEdges: Array<{ caller: string; callee: string; count: number }> = [];
    const staticOnlyEdges: Array<{ caller: string; callee: string }> = [];
    const dynamicDispatchDiscovered: Array<{ caller: string; callee: string }> = [];

    let totalObservedInvocations = 0;

    // Check runtime edges against static
    for (const [edgeKey, edge] of this.edges) {
      totalObservedInvocations += edge.invocationCount;
      if (staticEdgeKeys.has(edgeKey)) {
        concordantEdges.push({
          caller: edge.callerKey,
          callee: edge.calleeKey,
          count: edge.invocationCount,
        });
      } else {
        runtimeOnlyEdges.push({
          caller: edge.callerKey,
          callee: edge.calleeKey,
          count: edge.invocationCount,
        });
        dynamicDispatchDiscovered.push({
          caller: edge.callerKey,
          callee: edge.calleeKey,
        });
      }
    }

    // Check static edges that were never observed
    for (const key of staticEdgeKeys) {
      if (!this.edges.has(key)) {
        staticOnlyEdges.push({
          caller: staticCallerMap.get(key)!,
          callee: staticCalleeMap.get(key)!,
        });
      }
    }

    // Identify dead code risk: callee symbols in static graph with 0 runtime observations and 0 test coverage
    const deadCodeRisk: Array<{ symbol: string; reason: string }> = [];
    for (const se of staticOnlyEdges) {
      const callee = se.callee;
      const calleeNode = this.nodes.get(callee);
      if (!calleeNode || calleeNode.totalInvocations === 0) {
        deadCodeRisk.push({
          symbol: callee,
          reason: `Statically referenced by ${se.caller} but 0 runtime observations recorded`,
        });
      }
    }

    const totalEvaluated = concordantEdges.length + runtimeOnlyEdges.length;
    const overallRuntimeConcordance =
      totalEvaluated > 0 ? concordantEdges.length / totalEvaluated : 1.0;

    return {
      concordantEdges,
      staticOnlyEdges,
      runtimeOnlyEdges,
      deadCodeRisk,
      dynamicDispatchDiscovered,
      totalObservedInvocations,
      overallRuntimeConcordance: Number(overallRuntimeConcordance.toFixed(3)),
    };
  }

  private calculatePercentiles(latencies: number[]): { p50Ms: number; p95Ms: number; p99Ms: number } {
    if (latencies.length === 0) {
      return { p50Ms: 0, p95Ms: 0, p99Ms: 0 };
    }
    const sorted = [...latencies].sort((a, b) => a - b);
    const p50Index = Math.floor(sorted.length * 0.5);
    const p95Index = Math.floor(sorted.length * 0.95);
    const p99Index = Math.floor(sorted.length * 0.99);
    return {
      p50Ms: sorted[p50Index] ?? sorted[0],
      p95Ms: sorted[p95Index] ?? sorted[sorted.length - 1],
      p99Ms: sorted[p99Index] ?? sorted[sorted.length - 1],
    };
  }
}
