import path from "node:path";

export interface RetrievalPolicyConfig {
  excludePatterns?: string[];
  maxCandidateCount?: number;
  allowTests?: boolean;
}

const DEFAULT_EXCLUDE_PATTERNS = [
  "node_modules/",
  "dist/",
  "build/",
  "out/",
  ".next/",
  ".turbo/",
  ".git/",
  "coverage/",
  "vendor/",
  "__snapshots__/",
  ".snapshot.",
  ".lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  ".min.js",
  ".min.css",
  ".map",
];

/**
 * Negative Retrieval Policy
 * Prevents non-source, generated, or non-actionable noise files from polluting
 * candidate generation and agent context packs.
 */
export class RetrievalPolicy {
  private excludePatterns: string[];
  private maxCandidateCount: number;
  private allowTests: boolean;

  constructor(config: RetrievalPolicyConfig = {}) {
    this.excludePatterns = [
      ...DEFAULT_EXCLUDE_PATTERNS,
      ...(config.excludePatterns ?? []),
    ];
    this.maxCandidateCount = config.maxCandidateCount ?? 100;
    this.allowTests = config.allowTests ?? true;
  }

  /**
   * Checks if a file path is eligible for retrieval.
   */
  public isRetrievable(filePath: string): boolean {
    const norm = filePath.replace(/\\/g, "/").replace(/^\.\//, "");

    for (const pattern of this.excludePatterns) {
      if (norm.includes(pattern) || norm.endsWith(pattern)) {
        return false;
      }
    }

    if (!this.allowTests) {
      if (
        norm.includes(".test.") ||
        norm.includes(".spec.") ||
        norm.startsWith("test/") ||
        norm.startsWith("tests/")
      ) {
        return false;
      }
    }

    return true;
  }

  /**
   * Filters an array of candidates that have a file path property.
   */
  public filterCandidates<T extends { path?: string; file?: string }>(candidates: T[]): T[] {
    const filtered = candidates.filter((item) => {
      const p = item.path || item.file;
      if (!p) return true;
      return this.isRetrievable(p);
    });

    if (filtered.length > this.maxCandidateCount) {
      return filtered.slice(0, this.maxCandidateCount);
    }

    return filtered;
  }
}
