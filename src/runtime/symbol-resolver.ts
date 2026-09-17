import path from "node:path";
import type { SymbolId } from "../graph/symbol-identity.js";
import { inferLanguageFromPath } from "../graph/symbol-identity.js";

export type MatchType = "SOURCE_MAP_EXACT" | "SOURCE_MAP_LINE" | "EXPORT_MATCH" | "FUZZY_NAME";

export interface RuntimeMappingCandidate {
  symbolId: SymbolId;
  confidence: number; // 0.0 to 1.0
  matchType: MatchType;
}

export interface RuntimeFrame {
  file: string;
  line?: number;
  column?: number;
  functionName?: string;
  buildId?: string;
}

export interface RuntimeResolutionResult {
  runtimeFrame: RuntimeFrame;
  status: "RESOLVED" | "AMBIGUOUS" | "UNRESOLVED";
  resolvedSymbol?: SymbolId;
  candidates: RuntimeMappingCandidate[];
}

export interface SourceMapEntry {
  genLine: number;
  genColumn?: number;
  sourceFile: string;
  sourceLine: number;
  sourceColumn?: number;
  symbolName?: string;
}

export interface FileRemappingRule {
  fromPrefix: string;
  toPrefix: string;
  fromExt: string;
  toExt: string;
}

/**
 * Dedicated Runtime Identity Resolver
 * Resolves runtime execution frames (e.g. bundle.js:18492 or dist/orders/service.js:15)
 * back to verified source symbols with candidate ambiguity scoring.
 */
export class RuntimeSymbolResolver {
  private symbols = new Map<string, SymbolId>(); // key: file#qualifiedName -> SymbolId
  private symbolsByFile = new Map<string, SymbolId[]>(); // file -> SymbolId[]
  private symbolsByName = new Map<string, SymbolId[]>(); // qualifiedName or shortName -> SymbolId[]
  private sourceMaps = new Map<string, SourceMapEntry[]>(); // genFile -> entries
  private remappingRules: FileRemappingRule[] = [
    { fromPrefix: "dist/", toPrefix: "src/", fromExt: ".js", toExt: ".ts" },
    { fromPrefix: "dist/", toPrefix: "src/", fromExt: ".mjs", toExt: ".ts" },
    { fromPrefix: "build/", toPrefix: "src/", fromExt: ".js", toExt: ".ts" },
    { fromPrefix: "out/", toPrefix: "src/", fromExt: ".js", toExt: ".ts" },
  ];

  constructor(private projectRoot: string = "") {}

  /**
   * Registers a collection of known source symbols from the static graph or compiler.
   */
  public registerSymbols(symbols: SymbolId[]): void {
    for (const sym of symbols) {
      const normPath = this.normalizePath(sym.path);
      const key = `${normPath}#${sym.qualifiedName}`;
      this.symbols.set(key, sym);

      // Group by file
      const fileList = this.symbolsByFile.get(normPath) ?? [];
      fileList.push(sym);
      this.symbolsByFile.set(normPath, fileList);

      // Group by qualified name
      const qList = this.symbolsByName.get(sym.qualifiedName) ?? [];
      qList.push(sym);
      this.symbolsByName.set(sym.qualifiedName, qList);

      // Group by short name (e.g. method or class name)
      const parts = sym.qualifiedName.split(".");
      const shortName = parts[parts.length - 1];
      if (shortName && shortName !== sym.qualifiedName) {
        const sList = this.symbolsByName.get(shortName) ?? [];
        sList.push(sym);
        this.symbolsByName.set(shortName, sList);
      }
    }
  }

  /**
   * Registers source map entries for a generated file (e.g., bundle.js or dist/orders/service.js).
   */
  public registerSourceMap(genFile: string, entries: SourceMapEntry[]): void {
    const normGen = this.normalizePath(genFile);
    const existing = this.sourceMaps.get(normGen) ?? [];
    this.sourceMaps.set(normGen, [...existing, ...entries]);
  }

  /**
   * Adds a custom file remapping rule.
   */
  public addRemappingRule(rule: FileRemappingRule): void {
    this.remappingRules.unshift(rule);
  }

  /**
   * Resolves a runtime frame into source symbol candidates and evaluates ambiguity.
   */
  public resolve(frame: RuntimeFrame): RuntimeResolutionResult {
    const normFrameFile = this.normalizePath(frame.file);
    const candidates: RuntimeMappingCandidate[] = [];

    // 1. Check registered Source Maps
    const smEntries = this.sourceMaps.get(normFrameFile);
    if (smEntries && frame.line !== undefined) {
      const smCandidate = this.resolveViaSourceMap(smEntries, frame);
      if (smCandidate) {
        candidates.push(smCandidate);
      }
    }

    // 2. Check File Remapping (dist/foo.js -> src/foo.ts)
    const remappedSourceFile = this.remapGeneratedPath(normFrameFile);
    if (remappedSourceFile) {
      const fileSyms = this.symbolsByFile.get(remappedSourceFile);
      if (fileSyms && fileSyms.length > 0) {
        // If functionName is present in frame
        if (frame.functionName) {
          for (const sym of fileSyms) {
            if (this.symbolMatchesFunctionName(sym, frame.functionName)) {
              candidates.push({
                symbolId: sym,
                confidence: 0.94,
                matchType: "EXPORT_MATCH",
              });
            }
          }
        } else if (fileSyms.length === 1) {
          // Sole export in remapped file
          candidates.push({
            symbolId: fileSyms[0],
            confidence: 0.88,
            matchType: "EXPORT_MATCH",
          });
        }
      }
    }

    // 3. Direct Source File Check (if runtime frame already points directly to source file)
    const directSyms = this.symbolsByFile.get(normFrameFile);
    if (directSyms && directSyms.length > 0) {
      if (frame.functionName) {
        for (const sym of directSyms) {
          if (this.symbolMatchesFunctionName(sym, frame.functionName)) {
            candidates.push({
              symbolId: sym,
              confidence: 0.98,
              matchType: "EXPORT_MATCH",
            });
          }
        }
      }
    }

    // 4. Fuzzy Name Matching across Project
    if (frame.functionName && candidates.length === 0) {
      const nameMatches = this.symbolsByName.get(frame.functionName);
      if (nameMatches && nameMatches.length > 0) {
        if (nameMatches.length === 1) {
          candidates.push({
            symbolId: nameMatches[0],
            confidence: 0.75,
            matchType: "FUZZY_NAME",
          });
        } else {
          // Multiple candidates with same function name -> Ambiguity candidates
          for (const sym of nameMatches) {
            // Check if file path shares directory or basename with frame.file
            const frameBase = path.basename(normFrameFile, path.extname(normFrameFile));
            const symBase = path.basename(sym.path, path.extname(sym.path));
            const pathOverlap = frameBase === symBase ? 0.2 : 0;
            candidates.push({
              symbolId: sym,
              confidence: Math.min(0.65 + pathOverlap, 0.80),
              matchType: "FUZZY_NAME",
            });
          }
        }
      }
    }

    // Deduplicate candidates by symbolId URI, keeping highest confidence
    const uniqueCandidates = this.deduplicateCandidates(candidates);

    // Evaluate ambiguity scoring
    return this.scoreCandidates(frame, uniqueCandidates);
  }

  private resolveViaSourceMap(entries: SourceMapEntry[], frame: RuntimeFrame): RuntimeMappingCandidate | null {
    if (frame.line === undefined) return null;

    // Search for closest matching entry on genLine
    let bestEntry: SourceMapEntry | null = null;
    let minColDiff = Infinity;
    let exactColMatch = false;

    for (const e of entries) {
      if (e.genLine === frame.line) {
        if (frame.column !== undefined && e.genColumn !== undefined) {
          const diff = Math.abs(e.genColumn - frame.column);
          if (diff < minColDiff) {
            minColDiff = diff;
            bestEntry = e;
            if (diff === 0) {
              exactColMatch = true;
              break;
            }
          }
        } else if (!bestEntry) {
          bestEntry = e;
        }
      }
    }

    if (!bestEntry) return null;

    const normSourceFile = this.normalizePath(bestEntry.sourceFile);
    const fileSyms = this.symbolsByFile.get(normSourceFile) ?? [];

    // Find symbol in that source file matching bestEntry.symbolName or closest symbol
    let targetSym: SymbolId | undefined;
    if (bestEntry.symbolName) {
      targetSym = fileSyms.find((s) => this.symbolMatchesFunctionName(s, bestEntry!.symbolName!));
    }

    if (!targetSym && fileSyms.length > 0) {
      if (frame.functionName) {
        targetSym = fileSyms.find((s) => this.symbolMatchesFunctionName(s, frame.functionName!));
      }
      if (!targetSym) {
        targetSym = fileSyms[0];
      }
    }

    if (targetSym) {
      return {
        symbolId: targetSym,
        confidence: exactColMatch ? 1.0 : 0.97,
        matchType: exactColMatch ? "SOURCE_MAP_EXACT" : "SOURCE_MAP_LINE",
      };
    }

    // Synthesize source symbol if not found in registered static symbols
    const synthSym: SymbolId = {
      repository: "default",
      package: "root",
      language: inferLanguageFromPath(normSourceFile),
      path: normSourceFile,
      qualifiedName: bestEntry.symbolName || frame.functionName || "anonymous",
      declarationHash: "sourcemap_resolved",
      origin: "SOURCE",
    };

    return {
      symbolId: synthSym,
      confidence: exactColMatch ? 0.99 : 0.95,
      matchType: exactColMatch ? "SOURCE_MAP_EXACT" : "SOURCE_MAP_LINE",
    };
  }

  private remapGeneratedPath(filePath: string): string | null {
    for (const rule of this.remappingRules) {
      if (filePath.startsWith(rule.fromPrefix) && filePath.endsWith(rule.fromExt)) {
        const sub = filePath.slice(rule.fromPrefix.length, -rule.fromExt.length);
        return `${rule.toPrefix}${sub}${rule.toExt}`;
      }
    }
    return null;
  }

  private symbolMatchesFunctionName(sym: SymbolId, funcName: string): boolean {
    if (!funcName) return false;
    let clean = funcName.trim().replace(/^(?:async\s+|new\s+)+/, "").replace(/\.prototype\./g, ".");
    clean = clean.replace(/\(.*\)$/, "");

    if (sym.qualifiedName === clean) return true;
    if (sym.qualifiedName.endsWith(`.${clean}`)) return true;
    if (sym.qualifiedName.endsWith(`::${clean}`)) return true;
    if (clean.endsWith(`.${sym.qualifiedName}`)) return true;
    if (clean.endsWith(`::${sym.qualifiedName}`)) return true;

    const symShort = sym.qualifiedName.split(/[.:]/).pop();
    const funcShort = clean.split(/[.:]/).pop();
    if (symShort && funcShort && symShort === funcShort) return true;

    return false;
  }

  private deduplicateCandidates(candidates: RuntimeMappingCandidate[]): RuntimeMappingCandidate[] {
    const map = new Map<string, RuntimeMappingCandidate>();
    for (const c of candidates) {
      const key = `${c.symbolId.path}#${c.symbolId.qualifiedName}`;
      const existing = map.get(key);
      if (!existing || c.confidence > existing.confidence) {
        map.set(key, c);
      }
    }
    return Array.from(map.values()).sort((a, b) => b.confidence - a.confidence);
  }

  private scoreCandidates(frame: RuntimeFrame, candidates: RuntimeMappingCandidate[]): RuntimeResolutionResult {
    if (candidates.length === 0) {
      return {
        runtimeFrame: frame,
        status: "UNRESOLVED",
        candidates: [],
      };
    }

    const top = candidates[0];

    // Check if ambiguous: multiple candidates with close scores
    if (candidates.length > 1) {
      const second = candidates[1];
      const diff = top.confidence - second.confidence;
      if (diff < 0.12 && top.confidence < 0.95) {
        return {
          runtimeFrame: frame,
          status: "AMBIGUOUS",
          candidates,
        };
      }
    }

    // Single high confidence candidate
    if (top.confidence >= 0.70) {
      return {
        runtimeFrame: frame,
        status: "RESOLVED",
        resolvedSymbol: top.symbolId,
        candidates,
      };
    }

    if (top.confidence >= 0.40) {
      return {
        runtimeFrame: frame,
        status: "AMBIGUOUS",
        candidates,
      };
    }

    return {
      runtimeFrame: frame,
      status: "UNRESOLVED",
      candidates,
    };
  }

  private normalizePath(p: string): string {
    return p.replace(/\\/g, "/").replace(/^\.\//, "");
  }
}
