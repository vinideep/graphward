import type { SymbolId } from "../symbol-identity.js";
import { formatSymbolUri, parseSymbolUri, inferLanguageFromPath } from "../symbol-identity.js";
import type { DependencyGraph, GraphNode, GraphEdge } from "../schema.js";

export interface ScipSymbolInformation {
  symbol: string;
  documentation?: string[];
  relationships?: Array<{
    symbol: string;
    is_reference?: boolean;
    is_implementation?: boolean;
    is_type_definition?: boolean;
    is_definition?: boolean;
  }>;
  kind?: number;
  display_name?: string;
}

export interface ScipOccurrence {
  range: [number, number, number, number]; // [startLine, startCol, endLine, endCol]
  symbol: string;
  symbol_roles?: number; // 1 = Definition, 2 = Read, 4 = Write, 8 = Generated, etc.
  override_documentation?: string[];
  syntax_kind?: number;
}

export interface ScipDocument {
  language: string;
  relative_path: string;
  occurrences: ScipOccurrence[];
  symbols: ScipSymbolInformation[];
}

export interface ScipMetadata {
  version: number;
  tool_info: {
    name: string;
    version: string;
    arguments?: string[];
  };
  project_root: string;
  text_document_encoding: number; // 1 = UTF-8
}

export interface ScipIndex {
  metadata: ScipMetadata;
  documents: ScipDocument[];
  external_symbols?: ScipSymbolInformation[];
}

/**
 * SCIP (Source Code Intelligence Protocol) Interoperability Bridge
 * Bidirectional translation between GraphWard's Evidence Graph and
 * the open Source Code Intelligence Protocol (SCIP) standard.
 */
export class ScipBridge {
  /**
   * Formats a GraphWard SymbolId as a canonical SCIP symbol string.
   * e.g. "scip-typescript npm @pkg 1.0.0 src/auth/jwt.ts#verifySessionToken."
   */
  public toScipSymbolString(sym: SymbolId): string {
    const lang = sym.language || "typescript";
    const pkg = sym.package || "root";
    const cleanPath = sym.path.replace(/\\/g, "/");
    return `scip-${lang} npm ${pkg} 1.0.0 ${cleanPath}#${sym.qualifiedName}.`;
  }

  /**
   * Parses a SCIP symbol string back into a GraphWard SymbolId.
   */
  public fromScipSymbolString(scipStr: string): SymbolId {
    const parts = scipStr.split(" ");
    let language = "typescript";
    let pkg = "root";
    let target = scipStr;

    if (parts.length >= 4) {
      language = parts[0].replace(/^scip-/, "");
      pkg = parts[2];
      target = parts.slice(4).join(" ");
    }

    const [rawPath, rawQual] = target.split("#");
    const path = rawPath ? rawPath.trim() : "unknown.ts";
    const qualifiedName = rawQual ? rawQual.replace(/\.$/, "").trim() : "anonymous";

    return {
      repository: "default",
      package: pkg,
      language: inferLanguageFromPath(path) || language,
      path,
      qualifiedName,
      declarationHash: "scip_imported",
      origin: "SOURCE",
    };
  }

  /**
   * Exports GraphWard Evidence Graph into standard SCIP Index format.
   */
  public exportToScip(
    graph: DependencyGraph,
    projectRoot: string = "file:///workspace"
  ): ScipIndex {
    const docsMap = new Map<string, ScipDocument>();

    // Index Nodes
    for (const node of graph.nodes) {
      const filePath = node.path || "src/unknown.ts";
      let doc = docsMap.get(filePath);
      if (!doc) {
        doc = {
          language: inferLanguageFromPath(filePath),
          relative_path: filePath,
          occurrences: [],
          symbols: [],
        };
        docsMap.set(filePath, doc);
      }

      const symStr = `scip-${doc.language} npm root 1.0.0 ${filePath}#${node.label}.`;
      doc.symbols.push({
        symbol: symStr,
        display_name: node.label,
        documentation: [`GraphWard node: ${node.kind}`],
      });

      doc.occurrences.push({
        range: [0, 0, 1, 0],
        symbol: symStr,
        symbol_roles: 1, // Definition
      });
    }

    // Index Edges
    for (const edge of graph.edges) {
      const fromPath = edge.from.includes("#") ? edge.from.split("#")[0] : edge.from;
      const fromDoc = docsMap.get(fromPath) || Array.from(docsMap.values())[0];
      if (fromDoc) {
        const targetSymbol = edge.to.startsWith("scip-")
          ? edge.to
          : this.formatNodeIdAsScip(edge.to, fromDoc.language);

        fromDoc.occurrences.push({
          range: [1, 0, 1, 10],
          symbol: targetSymbol,
          symbol_roles: 2, // Reference
        });
      }
    }

    return {
      metadata: {
        version: 1,
        tool_info: {
          name: "graphward-scip-bridge",
          version: "2.2.0",
        },
        project_root: projectRoot,
        text_document_encoding: 1,
      },
      documents: Array.from(docsMap.values()),
    };
  }

  /**
   * Imports a SCIP Index and converts it into GraphWard nodes and edges.
   */
  public importFromScip(scipIndex: ScipIndex): {
    nodes: GraphNode[];
    edges: GraphEdge[];
    symbols: SymbolId[];
  } {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const symbols: SymbolId[] = [];

    const nodeIds = new Set<string>();

    for (const doc of scipIndex.documents) {
      for (const symInfo of doc.symbols) {
        const sym = this.fromScipSymbolString(symInfo.symbol);
        symbols.push(sym);

        const nodeId = `${sym.path}#${sym.qualifiedName}`;
        if (!nodeIds.has(nodeId)) {
          nodeIds.add(nodeId);
          nodes.push({
            id: nodeId,
            kind: "module",
            label: sym.qualifiedName,
            path: sym.path,
            confidence: "verified",
            evidence: [],
            metadata: {},
          });
        }
      }

      // References from occurrences
      const defs = doc.occurrences.filter((o) => (o.symbol_roles ?? 0) & 1);
      const refs = doc.occurrences.filter((o) => !((o.symbol_roles ?? 0) & 1));

      if (defs.length > 0 && refs.length > 0) {
        const primaryDefSym = this.fromScipSymbolString(defs[0].symbol);
        const fromId = `${primaryDefSym.path}#${primaryDefSym.qualifiedName}`;

        for (const ref of refs) {
          const refSym = this.fromScipSymbolString(ref.symbol);
          const toId = `${refSym.path}#${refSym.qualifiedName}`;

          if (fromId !== toId) {
            edges.push({
              from: fromId,
              to: toId,
              relation: "calls",
              confidence: "inferred",
              evidence: [],
              metadata: {},
            });
          }
        }
      }
    }

    return { nodes, edges, symbols };
  }

  private formatNodeIdAsScip(nodeId: string, defaultLang: string = "typescript"): string {
    const [rawPath, rawQual] = nodeId.split("#");
    const filePath = rawPath || "unknown.ts";
    const qual = rawQual || "anonymous";
    const lang = inferLanguageFromPath(filePath) || defaultLang;
    return `scip-${lang} npm root 1.0.0 ${filePath}#${qual}.`;
  }
}
