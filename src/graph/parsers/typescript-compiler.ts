import { existsSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import type { Evidence, MultiEvidenceEdge } from "../schema.js";
import {
  calculateCalibratedConfidence,
  generateWhyExplanation,
  UNKNOWN_DYNAMIC_TARGET,
  UNKNOWN_DYNAMIC_CALL,
} from "../schema.js";
import type { SymbolId } from "../symbol-identity.js";
import { createSymbolId, formatSymbolUri } from "../symbol-identity.js";

export interface TsConfigInfo {
  configPath: string;
  options: any;
  fileNames: string[];
  projectReferences?: string[];
}

export interface ResolvedCompilerSymbol {
  name: string;
  qualifiedName: string;
  declarationFile?: string;
  declarationLine?: number;
  typeString: string;
  flags: string[];
  isInterface?: boolean;
  isClass?: boolean;
  isFunction?: boolean;
  isMethod?: boolean;
  isAlias?: boolean;
  aliasedSymbolName?: string;
  isExternal?: boolean;
  isBuiltin?: boolean;
}

export interface ResolvedCompilerCall {
  callerSymbol: string;
  calleeName: string;
  resolvedTarget?: ResolvedCompilerSymbol;
  isDynamic: boolean;
  typeSignature?: string;
  line: number;
  why: string[];
}

export interface TypeScriptCompilerFileAnalysis {
  filePath: string;
  compilerAvailable: boolean;
  symbols: ResolvedCompilerSymbol[];
  calls: ResolvedCompilerCall[];
  implementations: Array<{ className: string; interfaceName: string; line: number }>;
  dynamicCalls: Array<{ expression: string; line: number; reason: string }>;
  evidence: Evidence[];
}

let cachedTs: any = null;

/**
 * Dynamically loads the TypeScript compiler API from host node_modules or bundled dependency.
 */
export async function loadTypeScriptCompiler(projectRoot?: string): Promise<any> {
  if (cachedTs) return cachedTs;

  if (projectRoot) {
    try {
      const hostTsPath = path.resolve(projectRoot, "node_modules", "typescript", "lib", "typescript.js");
      if (existsSync(hostTsPath)) {
        const mod = await import(pathToFileURL(hostTsPath).href);
        cachedTs = mod.default ?? mod;
        return cachedTs;
      }
    } catch {}
  }

  try {
    const mod = await import("typescript");
    cachedTs = (mod as any).default ?? mod;
    return cachedTs;
  } catch {
    return null;
  }
}

/**
 * Discovers full tsconfig hierarchy and project references.
 */
export function discoverTsConfigs(projectRoot: string, ts: any): Map<string, TsConfigInfo> {
  const configs = new Map<string, TsConfigInfo>();
  if (!ts) return configs;

  const candidateNames = ["tsconfig.json", "tsconfig.build.json", "tsconfig.app.json", "tsconfig.test.json"];
  const queue: string[] = [];

  for (const name of candidateNames) {
    const p = path.resolve(projectRoot, name);
    if (existsSync(p)) {
      queue.push(p);
    }
  }

  const visited = new Set<string>();

  while (queue.length > 0) {
    const currentPath = queue.shift()!;
    if (visited.has(currentPath)) continue;
    visited.add(currentPath);

    try {
      const readResult = ts.readConfigFile(currentPath, ts.sys.readFile);
      if (readResult.error) continue;

      const parsed = ts.parseJsonConfigFileContent(
        readResult.config,
        ts.sys,
        path.dirname(currentPath),
      );

      const refPaths: string[] = [];
      if (parsed.projectReferences && Array.isArray(parsed.projectReferences)) {
        for (const ref of parsed.projectReferences) {
          const resolvedRef = path.resolve(path.dirname(currentPath), ref.path);
          const finalRefPath = existsSync(resolvedRef) && !resolvedRef.endsWith(".json")
            ? path.join(resolvedRef, "tsconfig.json")
            : resolvedRef;

          if (existsSync(finalRefPath)) {
            refPaths.push(finalRefPath);
            if (!visited.has(finalRefPath)) {
              queue.push(finalRefPath);
            }
          }
        }
      }

      configs.set(currentPath, {
        configPath: currentPath,
        options: parsed.options,
        fileNames: parsed.fileNames,
        projectReferences: refPaths,
      });
    } catch {}
  }

  return configs;
}

/**
 * Resolver for scoped neighborhood typechecking within project compiler configuration.
 */
export class TypeScriptCompilerResolver {
  private projectRoot: string;
  private ts: any = null;
  private configs: Map<string, TsConfigInfo> = new Map();
  private program: any = null;
  private checker: any = null;

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot);
  }

  async initialize(): Promise<boolean> {
    this.ts = await loadTypeScriptCompiler(this.projectRoot);
    if (!this.ts) return false;

    this.configs = discoverTsConfigs(this.projectRoot, this.ts);
    return true;
  }

  isAvailable(): boolean {
    return this.ts != null;
  }

  getDiscoveredConfigs(): string[] {
    return Array.from(this.configs.keys());
  }

  /**
   * Builds or returns a cached ts.Program for target neighborhood files.
   */
  getProgram(targetFiles?: string[]): any {
    if (!this.ts) return null;

    let primaryConfig: TsConfigInfo | undefined;
    for (const key of ["tsconfig.json", "tsconfig.build.json"]) {
      const full = path.resolve(this.projectRoot, key);
      if (this.configs.has(full)) {
        primaryConfig = this.configs.get(full);
        break;
      }
    }
    if (!primaryConfig && this.configs.size > 0) {
      primaryConfig = this.configs.values().next().value;
    }

    const options = primaryConfig?.options ?? {
      target: this.ts.ScriptTarget.ES2022,
      module: this.ts.ModuleKind.NodeNext,
      moduleResolution: this.ts.ModuleResolutionKind.NodeNext,
      strict: true,
      skipLibCheck: true,
    };

    const configFiles = primaryConfig?.fileNames ?? [];
    const rootSet = new Set<string>(configFiles.map((f: string) => path.resolve(this.projectRoot, f)));
    if (targetFiles) {
      for (const f of targetFiles) {
        rootSet.add(path.resolve(this.projectRoot, f));
      }
    }
    const rootFiles = Array.from(rootSet);

    if (!this.program && rootFiles.length > 0) {
      this.program = this.ts.createProgram({
        rootNames: rootFiles,
        options,
        projectReferences: primaryConfig?.projectReferences?.map((p) => ({ path: p })),
      });
      this.checker = this.program.getTypeChecker();
    } else if (this.program && targetFiles && targetFiles.length > 0) {
      const missing = targetFiles
        .map((f) => path.resolve(this.projectRoot, f))
        .filter((abs) => !this.program.getSourceFile(abs));
      if (missing.length > 0) {
        const existingRoots = this.program.getRootFileNames();
        this.program = this.ts.createProgram({
          rootNames: Array.from(new Set([...existingRoots, ...missing])),
          options,
          oldProgram: this.program,
          projectReferences: primaryConfig?.projectReferences?.map((p) => ({ path: p })),
        });
        this.checker = this.program.getTypeChecker();
      }
    }

    return this.program;
  }

  getTypeChecker(): any {
    if (!this.checker) {
      this.getProgram();
    }
    return this.checker;
  }

  /**
   * Analyzes a TypeScript file with compiler truth:
   * Identifies symbols, exact types, calls (distinguishing dynamic vs static),
   * interface implementations, and aliased imports.
   */
  async analyzeFile(filePath: string, content?: string): Promise<TypeScriptCompilerFileAnalysis> {
    const initialized = this.ts ? true : await this.initialize();
    const absPath = path.resolve(this.projectRoot, filePath);
    const relFile = path.relative(this.projectRoot, absPath).replace(/\\/g, "/");

    if (!initialized || !this.ts) {
      return {
        filePath: relFile,
        compilerAvailable: false,
        symbols: [],
        calls: [],
        implementations: [],
        dynamicCalls: [],
        evidence: [],
      };
    }

    const ts = this.ts;
    let host: any = undefined;
    if (content !== undefined) {
      host = ts.createCompilerHost({
        target: ts.ScriptTarget.Latest,
        module: ts.ModuleKind.NodeNext,
      }, true);
      const origReadFile = host.readFile.bind(host);
      host.readFile = (fileName: string) => {
        if (path.resolve(fileName) === absPath) {
          return content;
        }
        return origReadFile(fileName);
      };
      const origFileExists = host.fileExists.bind(host);
      host.fileExists = (fileName: string) => {
        if (path.resolve(fileName) === absPath) return true;
        return origFileExists(fileName);
      };
      const origGetSourceFile = host.getSourceFile.bind(host);
      host.getSourceFile = (fileName: string, langVer: any, onError?: any, shouldCreate?: any) => {
        if (path.resolve(fileName) === absPath) {
          return ts.createSourceFile(fileName, content, langVer, true);
        }
        return origGetSourceFile(fileName, langVer, onError, shouldCreate);
      };
    }

    let program = this.getProgram([absPath]);
    let checker = this.getTypeChecker();

    let sourceFile: any = null;
    if (content !== undefined && host) {
      // Build program with virtual host for accurate neighborhood typechecking
      program = ts.createProgram({
        rootNames: [absPath],
        options: {
          target: ts.ScriptTarget.Latest,
          module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          skipLibCheck: true,
        },
        host,
      });
      checker = program.getTypeChecker();
      sourceFile = program.getSourceFile(absPath);
    } else if (program) {
      sourceFile = program.getSourceFile(absPath);
    }
    if (!sourceFile) {
      const fileText = content ?? ts.sys.readFile(absPath) ?? "";
      sourceFile = ts.createSourceFile(absPath, fileText, ts.ScriptTarget.Latest, true);
    }

    const symbols: ResolvedCompilerSymbol[] = [];
    const calls: ResolvedCompilerCall[] = [];
    const implementations: Array<{ className: string; interfaceName: string; line: number }> = [];
    const dynamicCalls: Array<{ expression: string; line: number; reason: string }> = [];
    const evidence: Evidence[] = [];

    const projectRoot = this.projectRoot;
    const scopeStack: string[] = [];
    function currentScope(): string {
      return scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : "module";
    }

    function visit(node: any) {
      let pushedScope = false;

      // Function Declarations
      if (ts.isFunctionDeclaration(node) && node.name) {
        const name = node.name.text;
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        let typeStr = "unknown";
        if (checker) {
          try {
            const sym = checker.getSymbolAtLocation(node.name);
            if (sym) {
              const type = checker.getTypeOfSymbolAtLocation(sym, node);
              typeStr = checker.typeToString(type);
            }
          } catch {}
        }
        symbols.push({
          name,
          qualifiedName: name,
          declarationFile: relFile,
          declarationLine: line,
          typeString: typeStr,
          flags: ["function"],
          isFunction: true,
        });
        scopeStack.push(name);
        pushedScope = true;
      }

      // Variable Declarations (const / let arrow functions and expressions)
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
          const name = node.name.text;
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          let typeStr = "unknown";
          if (checker) {
            try {
              const sym = checker.getSymbolAtLocation(node.name);
              if (sym) {
                const type = checker.getTypeOfSymbolAtLocation(sym, node);
                typeStr = checker.typeToString(type);
              }
            } catch {}
          }
          symbols.push({
            name,
            qualifiedName: name,
            declarationFile: relFile,
            declarationLine: line,
            typeString: typeStr,
            flags: ["function"],
            isFunction: true,
          });
          scopeStack.push(name);
          pushedScope = true;
        }
      }

      // Class Declarations
      if (ts.isClassDeclaration(node) && node.name) {
        const className = node.name.text;
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        symbols.push({
          name: className,
          qualifiedName: className,
          declarationFile: relFile,
          declarationLine: line,
          typeString: className,
          flags: ["class"],
          isClass: true,
        });

        // Heritage clauses (implements / extends)
        if (node.heritageClauses) {
          for (const hc of node.heritageClauses) {
            if (hc.token === ts.SyntaxKind.ImplementsKeyword) {
              for (const typeNode of hc.types) {
                const ifaceName = typeNode.expression.getText(sourceFile);
                implementations.push({ className, interfaceName: ifaceName, line });
              }
            }
          }
        }

        scopeStack.push(className);
        pushedScope = true;
      }

      // Method Declarations & Accessors
      if ((ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) && node.name) {
        const methodName = node.name.getText(sourceFile);
        const parentScope = currentScope();
        const qualified = parentScope !== "module" ? `${parentScope}.${methodName}` : methodName;
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        symbols.push({
          name: qualified,
          qualifiedName: qualified,
          declarationFile: relFile,
          declarationLine: line,
          typeString: "method",
          flags: ["method"],
          isMethod: true,
        });
        scopeStack.push(qualified);
        pushedScope = true;
      }

      // Interface Declarations
      if (ts.isInterfaceDeclaration(node) && node.name) {
        const ifaceName = node.name.text;
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        symbols.push({
          name: ifaceName,
          qualifiedName: ifaceName,
          declarationFile: relFile,
          declarationLine: line,
          typeString: "interface",
          flags: ["interface"],
          isInterface: true,
        });
      }

      // Type Alias Declarations
      if (ts.isTypeAliasDeclaration(node) && node.name) {
        const typeName = node.name.text;
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        symbols.push({
          name: typeName,
          qualifiedName: typeName,
          declarationFile: relFile,
          declarationLine: line,
          typeString: "type",
          flags: ["type"],
        });
      }

      // Enum Declarations
      if (ts.isEnumDeclaration(node) && node.name) {
        const enumName = node.name.text;
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        symbols.push({
          name: enumName,
          qualifiedName: enumName,
          declarationFile: relFile,
          declarationLine: line,
          typeString: "enum",
          flags: ["enum"],
        });
      }

      // Call Expressions
      if (ts.isCallExpression(node)) {
        const expr = node.expression;
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        const caller = currentScope();

        // Check for dynamic element access: obj[expr]()
        if (ts.isElementAccessExpression(expr)) {
          const rawText = expr.getText(sourceFile);
          dynamicCalls.push({
            expression: rawText,
            line,
            reason: "dynamic property access",
          });
          calls.push({
            callerSymbol: caller,
            calleeName: rawText,
            isDynamic: true,
            line,
            why: ["dynamic property access", "no compiler-resolved target", "no runtime observation"],
          });
        } else {
          const calleeText = expr.getText(sourceFile);
          let resolvedTarget: ResolvedCompilerSymbol | undefined;
          let why: string[] = ["AST verified"];

          if (checker) {
            try {
              const sym = checker.getSymbolAtLocation(expr);
              if (sym) {
                let targetSym = sym;
                let isAlias = false;
                let aliasedSymbolName: string | undefined;
                if (sym.flags & ts.SymbolFlags.Alias) {
                  try {
                    const resolved = checker.getAliasedSymbol(sym);
                    if (resolved) {
                      targetSym = resolved;
                      isAlias = true;
                      aliasedSymbolName = resolved.getName();
                    }
                  } catch {}
                }

                const decl = targetSym.declarations?.[0];
                const declSource = decl?.getSourceFile();
                const isDeclaration = declSource ? declSource.isDeclarationFile : false;
                const declRawPath = declSource ? declSource.fileName.replace(/\\/g, "/") : "";
                const isExternal = isDeclaration || declRawPath.includes("/node_modules/") || declRawPath.includes("typescript/lib/");
                const isBuiltin = declSource ? (declSource.hasNoDefaultLib || declRawPath.includes("typescript/lib/lib.") || declRawPath.includes("@types/node")) : false;
                const declFile = decl ? path.relative(projectRoot, declSource.fileName).replace(/\\/g, "/") : undefined;
                const declLine = decl ? declSource.getLineAndCharacterOfPosition(decl.getStart()).line + 1 : undefined;
                const type = checker.getTypeOfSymbolAtLocation(targetSym, expr);
                const typeStr = checker.typeToString(type);

                let qualifiedName = targetSym.getName();
                if (ts.isPropertyAccessExpression(expr)) {
                  try {
                    const objType = checker.getTypeAtLocation(expr.expression);
                    if (objType) {
                      const recTypeStr = checker.typeToString(objType);
                      if (recTypeStr === "this" || recTypeStr.startsWith("typeof ")) {
                        const parentName = targetSym.parent?.getName() ?? (scopeStack.length > 0 ? scopeStack[0] : undefined);
                        if (parentName) {
                          qualifiedName = `${parentName}.${targetSym.getName()}`;
                        }
                      } else if (recTypeStr && recTypeStr !== "any" && !recTypeStr.startsWith("{")) {
                        qualifiedName = `${recTypeStr}.${targetSym.getName()}`;
                      }
                    }
                  } catch {}
                }

                resolvedTarget = {
                  name: targetSym.getName(),
                  qualifiedName,
                  declarationFile: declFile,
                  declarationLine: declLine,
                  typeString: typeStr,
                  flags: [],
                  isAlias,
                  aliasedSymbolName,
                  isExternal,
                  isBuiltin,
                };
                why.push("compiler confirmed type resolution");
              } else {
                why.push("no compiler-resolved target");
              }
            } catch {
              why.push("no compiler-resolved target");
            }
          }

          calls.push({
            callerSymbol: caller,
            calleeName: calleeText,
            resolvedTarget,
            isDynamic: false,
            line,
            why,
          });

          // Create compiler evidence
          evidence.push({
            id: `compiler-ev:${relFile}:${line}`,
            kind: "COMPILER",
            strength: resolvedTarget ? "SEMANTIC" : "STRUCTURAL",
            scope: "PROJECT",
            source: { type: "SOURCE", file: relFile, startLine: line },
            confidence: resolvedTarget ? 0.98 : 0.80,
            confidenceState: "CALIBRATED",
          });
        }
      }

      ts.forEachChild(node, visit);

      if (pushedScope) {
        scopeStack.pop();
      }
    }

    visit(sourceFile);

    return {
      filePath: relFile,
      compilerAvailable: true,
      symbols,
      calls,
      implementations,
      dynamicCalls,
      evidence,
    };
  }
}
