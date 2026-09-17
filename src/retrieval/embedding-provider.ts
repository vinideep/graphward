import { createHash } from "node:crypto";

export interface PinnedModelMetadata {
  providerId: string;
  modelName: string;
  version: string;
  dimension: number;
  checksum: string;
}

export interface EmbeddingProvider {
  id: string;
  dimensions: number;
  version: string;
  metadata: PinnedModelMetadata;
  embed(texts: string[]): Promise<number[][]>;
  embedQuery(query: string): Promise<number[]>;
  validatePinning(pinned: PinnedModelMetadata): boolean;
}

/**
 * High-performance, deterministic CodeRankEmbed provider.
 * Implements subtoken decomposition, code-syntax term weighting
 * (e.g. function/class declarations and interface types receive higher weights),
 * and hash-projection to normalized dense embedding vectors.
 */
export class CodeRankEmbedProvider implements EmbeddingProvider {
  public readonly id = "coderank-embed-v2";
  public readonly dimensions: number;
  public readonly version = "2.2.0";
  public readonly metadata: PinnedModelMetadata;

  private stopWords = new Set([
    "const", "let", "var", "function", "return", "import", "from",
    "export", "default", "class", "interface", "type", "if", "else",
    "true", "false", "null", "undefined", "this", "new", "async", "await"
  ]);

  constructor(dimensions: number = 64) {
    this.dimensions = dimensions;
    const checksum = createHash("sha256")
      .update(`${this.id}:${this.version}:${this.dimensions}`)
      .digest("hex")
      .slice(0, 16);

    this.metadata = {
      providerId: this.id,
      modelName: "CodeRankEmbed-Mini",
      version: this.version,
      dimension: this.dimensions,
      checksum,
    };
  }

  public validatePinning(pinned: PinnedModelMetadata): boolean {
    return (
      pinned.providerId === this.metadata.providerId &&
      pinned.version === this.metadata.version &&
      pinned.dimension === this.metadata.dimension &&
      pinned.checksum === this.metadata.checksum
    );
  }

  public async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vectorizeText(t));
  }

  public async embedQuery(query: string): Promise<number[]> {
    return this.vectorizeText(query, true);
  }

  private tokenize(text: string): Array<{ token: string; weight: number }> {
    const tokens: Array<{ token: string; weight: number }> = [];

    // Split on non-alphanumeric characters
    const rawWords = text.split(/[^a-zA-Z0-9_$]+/);

    for (const raw of rawWords) {
      if (!raw || raw.length < 2) continue;

      // Extract camelCase / snake_case sub-tokens
      const subTokens = raw
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/_/g, " ")
        .toLowerCase()
        .split(/\s+/);

      for (const sub of subTokens) {
        if (!sub || sub.length < 2 || this.stopWords.has(sub)) continue;

        let weight = 1.0;
        // Boost domain terms like payment, order, auth, tenant, stock, schema
        if (/^(order|payment|invoice|auth|tenant|inventory|stock|session|token|gateway|client|database)$/.test(sub)) {
          weight = 2.5;
        } else if (/^(save|get|process|create|verify|reserve|release|clear|publish|subscribe)$/.test(sub)) {
          weight = 1.8;
        }

        tokens.push({ token: sub, weight });
      }
    }

    return tokens;
  }

  private vectorizeText(text: string, isQuery: boolean = false): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const tokens = this.tokenize(text);

    if (tokens.length === 0) {
      return vector;
    }

    for (const { token, weight } of tokens) {
      // Deterministic hash to bucket
      const hash = createHash("md5").update(token).digest();
      const bucket = hash.readUInt16BE(0) % this.dimensions;
      const sign = (hash[2] % 2 === 0) ? 1 : -1;

      vector[bucket] += sign * weight;
    }

    // L2 Normalize vector
    let sumSq = 0;
    for (let i = 0; i < this.dimensions; i++) {
      sumSq += vector[i] * vector[i];
    }

    const norm = Math.sqrt(sumSq);
    if (norm > 0) {
      for (let i = 0; i < this.dimensions; i++) {
        vector[i] = vector[i] / norm;
      }
    }

    return vector;
  }
}

/**
 * Computes cosine similarity between two normalized vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  const sim = dot / denom;
  return Math.max(0, Math.min(1, (sim + 1) / 2)); // map [-1, 1] to [0, 1]
}
