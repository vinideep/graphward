import type { SymbolId } from "../graph/symbol-identity.js";

export interface CandidateFeatures {
  lexical: number; // 0.0 to 1.0
  vector: number; // 0.0 to 1.0
  graph: number; // 0.0 to 1.0
  runtime: number; // 0.0 to 1.0
  recency: number; // 0.0 to 1.0
}

export interface RetrievalCandidate {
  symbolId: SymbolId;
  path: string;
  qualifiedName: string;
  features: CandidateFeatures;
  isDirectNeighbor?: boolean;
}

export interface RankedRetrievalResult {
  symbolId: SymbolId;
  path: string;
  qualifiedName: string;
  score: number; // 0.0 to 1.0
  rank: number;
  features: CandidateFeatures;
  explanation: string;
}

export interface RerankerWeights {
  lexical: number;
  vector: number;
  graph: number;
  runtime: number;
  recency: number;
  directNeighborBoost: number;
}

export const DEFAULT_RERANKER_WEIGHTS: RerankerWeights = {
  lexical: 0.30,
  vector: 0.30,
  graph: 0.25,
  runtime: 0.10,
  recency: 0.05,
  directNeighborBoost: 0.15,
};

export class GraphAwareReranker {
  private weights: RerankerWeights;

  constructor(weights: Partial<RerankerWeights> = {}) {
    this.weights = { ...DEFAULT_RERANKER_WEIGHTS, ...weights };
  }

  /**
   * Reranks candidate symbols by combining normalized multi-modal features
   * and applying graph topology boosts.
   */
  public rerank(candidates: RetrievalCandidate[]): RankedRetrievalResult[] {
    const scored = candidates.map((cand) => {
      const f = cand.features;

      // Base linear combination
      let rawScore =
        this.weights.lexical * f.lexical +
        this.weights.vector * f.vector +
        this.weights.graph * f.graph +
        this.weights.runtime * f.runtime +
        this.weights.recency * f.recency;

      // Graph topology boost for direct neighbors
      if (cand.isDirectNeighbor) {
        rawScore += this.weights.directNeighborBoost;
      }

      const finalScore = Math.min(1.0, Math.max(0.0, rawScore));

      const reasons: string[] = [];
      if (f.vector > 0.7) reasons.push("high semantic match");
      if (f.lexical > 0.7) reasons.push("exact name match");
      if (cand.isDirectNeighbor) reasons.push("graph caller/callee neighbor");
      if (f.runtime > 0.5) reasons.push("frequent runtime path");

      return {
        symbolId: cand.symbolId,
        path: cand.path,
        qualifiedName: cand.qualifiedName,
        score: Number(finalScore.toFixed(4)),
        rank: 0,
        features: { ...f },
        explanation: reasons.join(", ") || "relevance score",
      };
    });

    // Sort descending by score
    scored.sort((a, b) => b.score - a.score);

    // Assign 1-indexed ranks
    return scored.map((item, idx) => ({
      ...item,
      rank: idx + 1,
    }));
  }
}
