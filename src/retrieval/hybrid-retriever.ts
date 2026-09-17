import { randomUUID } from "node:crypto";
import type { SymbolId } from "../graph/symbol-identity.js";
import {
  CodeRankEmbedProvider,
  type EmbeddingProvider,
  cosineSimilarity,
} from "./embedding-provider.js";
import { RetrievalPolicy } from "./retrieval-policy.js";
import {
  GraphAwareReranker,
  type RankedRetrievalResult,
  type RetrievalCandidate,
} from "./graph-reranker.js";
import type { SqlitePartitionedStore } from "../storage/sqlite-store.js";

export interface SymbolIndexItem {
  symbolId: SymbolId;
  content: string; // tokenized representation or doc/code snippet
  embedding?: number[];
  graphCentrality?: number; // 0.0 to 1.0
  runtimeInvocations?: number;
  lastCommitTimestamp?: number;
}

export interface RetrievalEvent {
  id: string;
  timestamp: string;
  query: string;
  candidatesCount: number;
  returnedCount: number;
  topCandidates: Array<{
    symbolId: string;
    path: string;
    rank: number;
    score: number;
    features: Record<string, number>;
  }>;
  usedByAgent?: boolean;
  affectedByPatch?: boolean;
}

export interface HybridRetrieverOptions {
  embeddingProvider?: EmbeddingProvider;
  retrievalPolicy?: RetrievalPolicy;
  reranker?: GraphAwareReranker;
  store?: SqlitePartitionedStore;
}

export interface RetrievalQueryOptions {
  seeds?: string[]; // symbol URIs or paths
  topK?: number;
  fileScope?: string[];
}

export class HybridRetrieverV2 {
  private embeddingProvider: EmbeddingProvider;
  private retrievalPolicy: RetrievalPolicy;
  private reranker: GraphAwareReranker;
  private store?: SqlitePartitionedStore;

  private symbolIndex = new Map<string, SymbolIndexItem>(); // key: path#qualifiedName
  private adjacency = new Map<string, Set<string>>(); // symbolKey -> Set<neighborKey>
  private retrievalEvents: RetrievalEvent[] = [];

  constructor(options: HybridRetrieverOptions = {}) {
    this.embeddingProvider = options.embeddingProvider ?? new CodeRankEmbedProvider();
    this.retrievalPolicy = options.retrievalPolicy ?? new RetrievalPolicy();
    this.reranker = options.reranker ?? new GraphAwareReranker();
    this.store = options.store;
  }

  public getEmbeddingProvider(): EmbeddingProvider {
    return this.embeddingProvider;
  }

  public getRetrievalEvents(): RetrievalEvent[] {
    return [...this.retrievalEvents];
  }

  /**
   * Indexes a collection of symbols with their code content and semantic embeddings.
   */
  public async indexSymbols(
    symbols: Array<{
      symbolId: SymbolId;
      content: string;
      graphCentrality?: number;
      runtimeInvocations?: number;
      lastCommitTimestamp?: number;
    }>
  ): Promise<void> {
    const textsToEmbed: string[] = [];
    const symList: typeof symbols = [];

    for (const item of symbols) {
      if (!this.retrievalPolicy.isRetrievable(item.symbolId.path)) {
        continue;
      }
      textsToEmbed.push(`${item.symbolId.qualifiedName} ${item.symbolId.path} ${item.content}`);
      symList.push(item);
    }

    const embeddings = await this.embeddingProvider.embed(textsToEmbed);

    for (let i = 0; i < symList.length; i++) {
      const item = symList[i];
      const key = `${item.symbolId.path}#${item.symbolId.qualifiedName}`;
      this.symbolIndex.set(key, {
        symbolId: item.symbolId,
        content: item.content,
        embedding: embeddings[i],
        graphCentrality: item.graphCentrality ?? 0.5,
        runtimeInvocations: item.runtimeInvocations ?? 0,
        lastCommitTimestamp: item.lastCommitTimestamp ?? Date.now(),
      });
    }
  }

  /**
   * Registers directed graph edges for graph proximity calculation.
   */
  public registerGraphEdges(edges: Array<{ from: SymbolId; to: SymbolId }>): void {
    for (const e of edges) {
      const fromKey = `${e.from.path}#${e.from.qualifiedName}`;
      const toKey = `${e.to.path}#${e.to.qualifiedName}`;

      const fromNeighbors = this.adjacency.get(fromKey) ?? new Set();
      fromNeighbors.add(toKey);
      this.adjacency.set(fromKey, fromNeighbors);

      const toNeighbors = this.adjacency.get(toKey) ?? new Set();
      toNeighbors.add(fromKey);
      this.adjacency.set(toKey, toNeighbors);
    }
  }

  /**
   * Two-Stage Hybrid Retrieval:
   * 1. Multi-Modal Candidate Generation (Lexical + Vector + Graph)
   * 2. Normalization & Graph-Aware Reranking
   */
  public async retrieve(
    query: string,
    options: RetrievalQueryOptions = {}
  ): Promise<{ results: RankedRetrievalResult[]; event: RetrievalEvent }> {
    const topK = options.topK ?? 10;
    const queryVector = await this.embeddingProvider.embedQuery(query);
    const queryTerms = query.toLowerCase().split(/[^a-zA-Z0-9_$]+/).filter((t) => t.length >= 2);

    const seedNeighborKeys = new Set<string>();
    if (options.seeds) {
      for (const seed of options.seeds) {
        // Add direct 1-hop neighbors
        const neighbors = this.adjacency.get(seed);
        if (neighbors) {
          neighbors.forEach((n) => seedNeighborKeys.add(n));
        }
        seedNeighborKeys.add(seed);
      }
    }

    // Step 1: Candidate Scoring & Feature Extraction
    const candidates: RetrievalCandidate[] = [];

    let maxRuntimeInvocations = 1;
    for (const item of this.symbolIndex.values()) {
      if ((item.runtimeInvocations ?? 0) > maxRuntimeInvocations) {
        maxRuntimeInvocations = item.runtimeInvocations!;
      }
    }

    for (const [key, item] of this.symbolIndex) {
      // Scope filtering
      if (options.fileScope && options.fileScope.length > 0) {
        if (!options.fileScope.some((f) => item.symbolId.path.includes(f))) {
          continue;
        }
      }

      // Feature 1: Lexical match score
      let lexicalScore = 0;
      const lowerName = item.symbolId.qualifiedName.toLowerCase();
      const lowerContent = item.content.toLowerCase();
      const lowerPath = item.symbolId.path.toLowerCase();

      let matchedTerms = 0;
      for (const term of queryTerms) {
        if (lowerName.includes(term)) {
          lexicalScore += 0.6;
          matchedTerms++;
        } else if (lowerPath.includes(term)) {
          lexicalScore += 0.3;
          matchedTerms++;
        } else if (lowerContent.includes(term)) {
          lexicalScore += 0.2;
          matchedTerms++;
        }
      }
      if (queryTerms.length > 0) {
        lexicalScore = Math.min(1.0, lexicalScore / (queryTerms.length * 0.6));
      }

      // Feature 2: Vector similarity
      let vectorScore = 0;
      if (item.embedding && queryVector.length > 0) {
        vectorScore = cosineSimilarity(queryVector, item.embedding);
      }

      // Feature 3: Graph topology score
      const isDirectNeighbor = seedNeighborKeys.has(key);
      const graphScore = isDirectNeighbor
        ? 1.0
        : Math.min(1.0, item.graphCentrality ?? 0.5);

      // Feature 4: Runtime score
      const runtimeScore = Math.min(
        1.0,
        (item.runtimeInvocations ?? 0) / maxRuntimeInvocations
      );

      // Feature 5: Recency score
      const recencyScore = 0.8; // default normalized baseline

      // Include in candidate set if any modality has signal
      if (lexicalScore > 0.05 || vectorScore > 0.4 || isDirectNeighbor) {
        candidates.push({
          symbolId: item.symbolId,
          path: item.symbolId.path,
          qualifiedName: item.symbolId.qualifiedName,
          features: {
            lexical: Number(lexicalScore.toFixed(3)),
            vector: Number(vectorScore.toFixed(3)),
            graph: Number(graphScore.toFixed(3)),
            runtime: Number(runtimeScore.toFixed(3)),
            recency: Number(recencyScore.toFixed(3)),
          },
          isDirectNeighbor,
        });
      }
    }

    // Step 2: Rerank Candidates
    const ranked = this.reranker.rerank(candidates);
    const topResults = ranked.slice(0, topK);

    // Step 3: Log Retrieval Event
    const event: RetrievalEvent = {
      id: `ret_${randomUUID().slice(0, 8)}`,
      timestamp: new Date().toISOString(),
      query,
      candidatesCount: candidates.length,
      returnedCount: topResults.length,
      topCandidates: topResults.map((r) => ({
        symbolId: `${r.path}#${r.qualifiedName}`,
        path: r.path,
        rank: r.rank,
        score: r.score,
        features: { ...r.features },
      })),
      usedByAgent: false,
    };

    this.retrievalEvents.push(event);

    return {
      results: topResults,
      event,
    };
  }
}
