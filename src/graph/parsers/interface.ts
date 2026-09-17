import path from "node:path";
import type { SymbolId } from "../symbol-identity.js";
import { createSymbolId, formatSymbolUri } from "../symbol-identity.js";

export type CanonicalSymbolKind =
  | "symbol"
  | "file"
  | "module"
  | "package"
  | "type"
  | "function"
  | "class"
  | "method"
  | "route"
  | "endpoint"
  | "service"
  | "database_entity"
  | "event"
  | "test";

export type CanonicalRelationKind =
  | "IMPORTS"
  | "EXPORTS"
  | "CALLS"
  | "EXTENDS"
  | "IMPLEMENTS"
  | "OVERRIDES"
  | "USES_TYPE"
  | "ROUTES_TO"
  | "CALLS_ENDPOINT"
  | "EMITS"
  | "CONSUMES"
  | "QUERIES"
  | "TESTS"
  | "GENERATES"
  | "OBSERVED_CALL";

export interface ParsedSymbol {
  name: string;
  kind: CanonicalSymbolKind;
  line: number;
  column?: number;
  bodyStart?: number;
  bodyEnd?: number;
  signature?: string;
  declarationHash?: string;
  isExported?: boolean;
  docstring?: string;
}

export interface ParsedCall {
  fromSymbol: string; // enclosing symbol qualified name or id
  calleeName: string;
  line: number;
  column?: number;
  isDynamic?: boolean;
  rawExpression?: string;
}

export interface ParsedImport {
  source: string;
  specifiers: string[];
  defaultImport?: string;
  namespaceImport?: string;
  isTypeOnly?: boolean;
  line?: number;
}

export interface ParsedExport {
  name: string;
  kind: string;
  isDefault?: boolean;
  source?: string;
  line?: number;
}

export interface ParseDiagnostic {
  message: string;
  line: number;
  severity: "error" | "warning" | "info";
}

export interface ParseResult {
  language: string;
  filePath: string;
  symbols: ParsedSymbol[];
  calls: ParsedCall[];
  imports: ParsedImport[];
  exports: ParsedExport[];
  diagnostics?: ParseDiagnostic[];
}

export interface LanguageParser {
  name: string;
  supportedExtensions: string[];
  canParse(filePath: string): boolean;
  parse(filePath: string, content: string): Promise<ParseResult>;
}

// ---------------------------------------------------------------------------
// SCIP (Source Code Intelligence Protocol) Bridge Compatibility
// ---------------------------------------------------------------------------

export interface ScipOccurrence {
  range: [number, number, number, number]; // [startLine, startCol, endLine, endCol]
  symbol: string;
  symbolRoles: number; // 1 = definition, 2 = read, 4 = write, etc.
}

export interface ScipDocument {
  language: string;
  relative_path: string;
  occurrences: ScipOccurrence[];
  symbols: Array<{
    symbol: string;
    documentation?: string[];
  }>;
}

export function toScipSymbol(symbolId: SymbolId): string {
  const repo = symbolId.repository || "workspace";
  const pkg = symbolId.package || "root";
  const desc = `${symbolId.qualifiedName}${symbolId.signature ? `(${symbolId.signature})` : ""}`;
  return `scip-graphward ${repo} ${pkg} ${symbolId.path} ${desc}#`;
}

// ---------------------------------------------------------------------------
// Canonical Built-in Parsers
// ---------------------------------------------------------------------------

export class TypeScriptLanguageParser implements LanguageParser {
  name = "typescript";
  supportedExtensions = [".ts", ".tsx", ".mts", ".cts"];

  canParse(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return this.supportedExtensions.includes(ext);
  }

  async parse(filePath: string, content: string): Promise<ParseResult> {
    const symbols: ParsedSymbol[] = [];
    const calls: ParsedCall[] = [];
    const imports: ParsedImport[] = [];
    const exports: ParsedExport[] = [];

    // Extract imports
    const importRe = /(?:^|\n)\s*import\s+(?:type\s+)?(?:([A-Za-z0-9_$]+)\s*,?\s*)?(?:\{([^}]+)\})?(?:\*\s+as\s+([A-Za-z0-9_$]+))?\s*from\s*['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(content)) !== null) {
      const defaultImport = m[1]?.trim();
      const specifiers = m[2] ? m[2].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean) : [];
      const namespaceImport = m[3]?.trim();
      const source = m[4];
      imports.push({
        source,
        specifiers,
        defaultImport,
        namespaceImport,
        isTypeOnly: m[0].includes("import type"),
      });
    }

    // Top-level functions & methods
    const fnRe = /(?:^|\n)\s*(export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g;
    while ((m = fnRe.exec(content)) !== null) {
      const isExported = !!m[1];
      const name = m[2];
      const params = m[3];
      const line = content.slice(0, m.index + 1).split("\n").length;
      symbols.push({
        name,
        kind: "function",
        line,
        signature: `(${params})`,
        isExported,
      });
    }

    // Classes
    const classRe = /(?:^|\n)\s*(export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g;
    while ((m = classRe.exec(content)) !== null) {
      const isExported = !!m[1];
      const name = m[2];
      const line = content.slice(0, m.index + 1).split("\n").length;
      symbols.push({
        name,
        kind: "class",
        line,
        isExported,
      });
    }

    // Calls inside content
    const callRe = /\b([A-Za-z_$][\w$]*)\s*\(/g;
    const dynamicCallRe = /\b([A-Za-z_$][\w$]*)\[([^\]]+)\]\s*\(/g;
    const ignoredCallees = new Set([
      "if", "for", "while", "switch", "catch", "return", "function", "await",
      "typeof", "instanceof", "new", "super", "this", "void", "delete",
      "require", "import", "console", "Promise", "Array", "Object", "String",
    ]);

    const findEnclosingSymbol = (callLine: number): string => {
      let candidate = "file";
      for (const sym of symbols) {
        if (sym.line <= callLine) {
          candidate = sym.name;
        }
      }
      return candidate;
    };

    while ((m = callRe.exec(content)) !== null) {
      const callee = m[1];
      if (ignoredCallees.has(callee)) continue;
      const line = content.slice(0, m.index).split("\n").length;
      calls.push({
        fromSymbol: findEnclosingSymbol(line),
        calleeName: callee,
        line,
      });
    }

    while ((m = dynamicCallRe.exec(content)) !== null) {
      const obj = m[1];
      const expr = m[2];
      const line = content.slice(0, m.index).split("\n").length;
      calls.push({
        fromSymbol: findEnclosingSymbol(line),
        calleeName: `${obj}[${expr}]`,
        line,
        isDynamic: true,
        rawExpression: m[0].trim(),
      });
    }

    return {
      language: "typescript",
      filePath,
      symbols,
      calls,
      imports,
      exports,
    };
  }
}

export class JavaScriptLanguageParser extends TypeScriptLanguageParser {
  override name = "javascript";
  override supportedExtensions = [".js", ".jsx", ".mjs", ".cjs"];
}

export class PythonLanguageParser implements LanguageParser {
  name = "python";
  supportedExtensions = [".py"];

  canParse(filePath: string): boolean {
    return filePath.toLowerCase().endsWith(".py");
  }

  async parse(filePath: string, content: string): Promise<ParseResult> {
    const symbols: ParsedSymbol[] = [];
    const calls: ParsedCall[] = [];
    const imports: ParsedImport[] = [];
    const exports: ParsedExport[] = [];

    const lines = content.split("\n");
    const defRe = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/;
    const classRe = /^(\s*)class\s+([A-Za-z_]\w*)/;
    const importRe = /^(?:from\s+([A-Za-z0-9_.]+)\s+import\s+([A-Za-z0-9_,\s*]+)|import\s+([A-Za-z0-9_.,\s]+))/;

    let currentClass = "";
    let classIndent = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const indent = line.search(/\S/);
      if (currentClass && indent <= classIndent && !trimmed.startsWith("#")) {
        currentClass = "";
      }

      const im = trimmed.match(importRe);
      if (im) {
        if (im[1]) {
          const specifiers = im[2].split(",").map((s) => s.trim()).filter(Boolean);
          imports.push({ source: im[1], specifiers, line: i + 1 });
        } else if (im[3]) {
          const pkgs = im[3].split(",").map((s) => s.trim()).filter(Boolean);
          for (const pkg of pkgs) {
            imports.push({ source: pkg, specifiers: [pkg], line: i + 1 });
          }
        }
      }

      const cm = line.match(classRe);
      if (cm) {
        currentClass = cm[2];
        classIndent = indent >= 0 ? indent : 0;
        symbols.push({
          name: currentClass,
          kind: "class",
          line: i + 1,
        });
        continue;
      }

      const dm = line.match(defRe);
      if (dm) {
        const fnName = dm[2];
        const params = dm[3];
        const isMethod = !!currentClass && dm[1].length > classIndent;
        const qName = isMethod ? `${currentClass}.${fnName}` : fnName;
        symbols.push({
          name: qName,
          kind: isMethod ? "method" : "function",
          line: i + 1,
          signature: `(${params})`,
        });
      }
    }

    const findEnclosingSymbol = (callLine: number): string => {
      let candidate = "module";
      for (const sym of symbols) {
        if (sym.line <= callLine) {
          candidate = sym.name;
        }
      }
      return candidate;
    };

    // Call extraction
    const callRe = /\b([A-Za-z_]\w*)\s*\(/g;
    const pyIgnored = new Set([
      "if", "for", "while", "with", "elif", "else", "try", "except", "finally",
      "return", "yield", "raise", "assert", "lambda", "print", "len", "range",
      "str", "int", "float", "bool", "list", "dict", "set", "tuple",
    ]);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith("#")) continue;
      let m: RegExpExecArray | null;
      while ((m = callRe.exec(line)) !== null) {
        const callee = m[1];
        if (pyIgnored.has(callee)) continue;
        calls.push({
          fromSymbol: findEnclosingSymbol(i + 1),
          calleeName: callee,
          line: i + 1,
        });
      }
    }

    return {
      language: "python",
      filePath,
      symbols,
      calls,
      imports,
      exports,
    };
  }
}

export class GoLanguageParser implements LanguageParser {
  name = "go";
  supportedExtensions = [".go"];

  canParse(filePath: string): boolean {
    return filePath.toLowerCase().endsWith(".go");
  }

  async parse(filePath: string, content: string): Promise<ParseResult> {
    const symbols: ParsedSymbol[] = [];
    const calls: ParsedCall[] = [];
    const imports: ParsedImport[] = [];
    const exports: ParsedExport[] = [];

    const lines = content.split("\n");
    const fnRe = /^func\s+(?:\((?:[A-Za-z0-9_*]+)\s+([*A-Za-z0-9_]+)\)\s+)?([A-Za-z0-9_]+)\s*\(([^)]*)\)/;
    const typeRe = /^type\s+([A-Za-z0-9_]+)\s+(struct|interface)/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const tm = line.match(typeRe);
      if (tm) {
        symbols.push({
          name: tm[1],
          kind: tm[2] === "struct" ? "class" : "type",
          line: i + 1,
          isExported: tm[1][0] === tm[1][0].toUpperCase(),
        });
        continue;
      }

      const fm = line.match(fnRe);
      if (fm) {
        const receiver = fm[1]?.replace("*", "");
        const name = fm[2];
        const params = fm[3];
        const qName = receiver ? `${receiver}.${name}` : name;
        symbols.push({
          name: qName,
          kind: receiver ? "method" : "function",
          line: i + 1,
          signature: `(${params})`,
          isExported: name[0] === name[0].toUpperCase(),
        });
      }
    }

    const findEnclosingSymbol = (callLine: number): string => {
      let candidate = "package";
      for (const sym of symbols) {
        if (sym.line <= callLine) {
          candidate = sym.name;
        }
      }
      return candidate;
    };

    // Call extraction
    const callRe = /\b([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)?)\s*\(/g;
    const goIgnored = new Set(["if", "for", "switch", "select", "defer", "go", "return", "make", "new", "len", "cap", "append", "panic", "recover"]);
    for (let i = 0; i < lines.length; i++) {
      let m: RegExpExecArray | null;
      while ((m = callRe.exec(lines[i])) !== null) {
        const callee = m[1];
        if (goIgnored.has(callee)) continue;
        calls.push({
          fromSymbol: findEnclosingSymbol(i + 1),
          calleeName: callee,
          line: i + 1,
        });
      }
    }

    return {
      language: "go",
      filePath,
      symbols,
      calls,
      imports,
      exports,
    };
  }
}

export class RustLanguageParser implements LanguageParser {
  name = "rust";
  supportedExtensions = [".rs"];

  canParse(filePath: string): boolean {
    return filePath.toLowerCase().endsWith(".rs");
  }

  async parse(filePath: string, content: string): Promise<ParseResult> {
    const symbols: ParsedSymbol[] = [];
    const calls: ParsedCall[] = [];
    const imports: ParsedImport[] = [];
    const exports: ParsedExport[] = [];

    const lines = content.split("\n");
    const fnRe = /^(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/;
    const structRe = /^(?:pub(?:\([^)]+\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z0-9_]+)/;
    const implRe = /^impl(?:<[^>]+>)?(?:\s+[A-Za-z0-9_]+\s+for)?\s+([A-Za-z0-9_]+)/;

    let currentImpl = "";
    let implDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const im = line.match(implRe);
      if (im) {
        currentImpl = im[1];
        implDepth = 0;
      }

      if (currentImpl) {
        for (const ch of line) {
          if (ch === "{") implDepth++;
          else if (ch === "}") {
            implDepth--;
            if (implDepth <= 0) {
              currentImpl = "";
              implDepth = 0;
            }
          }
        }
      }

      const sm = line.match(structRe);
      if (sm) {
        symbols.push({
          name: sm[1],
          kind: "class",
          line: i + 1,
          isExported: line.startsWith("pub"),
        });
        continue;
      }

      const fm = line.match(fnRe);
      if (fm) {
        const name = fm[1];
        const params = fm[2];
        const qName = currentImpl ? `${currentImpl}::${name}` : name;
        symbols.push({
          name: qName,
          kind: currentImpl ? "method" : "function",
          line: i + 1,
          signature: `(${params})`,
          isExported: line.startsWith("pub"),
        });
      }
    }

    const findEnclosingSymbol = (callLine: number): string => {
      let candidate = "crate";
      for (const sym of symbols) {
        if (sym.line <= callLine) {
          candidate = sym.name;
        }
      }
      return candidate;
    };

    const callRe = /\b([A-Za-z0-9_]+(?:::[A-Za-z0-9_]+)?)\s*\(/g;
    const rustIgnored = new Set(["if", "while", "match", "for", "return", "println", "eprintln", "format", "vec", "panic", "assert", "assert_eq"]);
    for (let i = 0; i < lines.length; i++) {
      let m: RegExpExecArray | null;
      while ((m = callRe.exec(lines[i])) !== null) {
        const callee = m[1];
        if (rustIgnored.has(callee)) continue;
        calls.push({
          fromSymbol: findEnclosingSymbol(i + 1),
          calleeName: callee,
          line: i + 1,
        });
      }
    }

    return {
      language: "rust",
      filePath,
      symbols,
      calls,
      imports,
      exports,
    };
  }
}

// ---------------------------------------------------------------------------
// Composite Parser Registry
// ---------------------------------------------------------------------------

export class CompositeLanguageParser implements LanguageParser {
  name = "composite";
  supportedExtensions: string[];
  private parsers: LanguageParser[] = [];

  constructor() {
    this.parsers = [
      new TypeScriptLanguageParser(),
      new JavaScriptLanguageParser(),
      new PythonLanguageParser(),
      new GoLanguageParser(),
      new RustLanguageParser(),
    ];
    this.supportedExtensions = this.parsers.flatMap((p) => p.supportedExtensions);
  }

  register(parser: LanguageParser): void {
    this.parsers.unshift(parser); // highest priority first
    this.supportedExtensions = Array.from(new Set(this.parsers.flatMap((p) => p.supportedExtensions)));
  }

  canParse(filePath: string): boolean {
    return this.parsers.some((p) => p.canParse(filePath));
  }

  async parse(filePath: string, content: string): Promise<ParseResult> {
    const parser = this.parsers.find((p) => p.canParse(filePath));
    if (!parser) {
      return {
        language: "unknown",
        filePath,
        symbols: [],
        calls: [],
        imports: [],
        exports: [],
      };
    }
    return parser.parse(filePath, content);
  }
}

export const defaultParserRegistry = new CompositeLanguageParser();
