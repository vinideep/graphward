import { createRequire } from "node:module";

export interface TreeSitterDefinition {
  name: string;
  kind: string;
  line: number;
  isExported?: boolean;
  bodyStart?: number;
  bodyEnd?: number;
}

export interface TreeSitterCall {
  from: string;
  callee: string;
  line: number;
  isDynamic?: boolean;
  rawExpression?: string;
}

export interface TreeSitterParseResult {
  imports: Array<{ source: string; specifiers: string[]; line?: number }>;
  exports: Array<{ name: string; kind: string; line?: number }>;
  definitions: TreeSitterDefinition[];
  calls: TreeSitterCall[];
}

let treeSitterCache: any = null;
const parserCache: Record<string, any> = {};

export function isTreeSitterAvailable(): boolean {
  try {
    const req = createRequire(import.meta.url);
    req.resolve("tree-sitter");
    return true;
  } catch {
    return false;
  }
}

async function getParser(language: string) {
  if (parserCache[language]) return parserCache[language];
  if (!treeSitterCache) {
    const Parser = (await import("tree-sitter" as any)).default;
    treeSitterCache = Parser;
  }
  const Parser = treeSitterCache;
  const parser = new Parser();

  let langModule;
  switch (language) {
    case "typescript":
      langModule = (await import("tree-sitter-typescript" as any)).default.typescript;
      break;
    case "python":
      langModule = (await import("tree-sitter-python" as any)).default;
      break;
    case "go":
      langModule = (await import("tree-sitter-go" as any)).default;
      break;
    case "rust":
      langModule = (await import("tree-sitter-rust" as any)).default;
      break;
    default:
      throw new Error(`Unsupported language: ${language}`);
  }
  parser.setLanguage(langModule);
  parserCache[language] = parser;
  return parser;
}

export function getLanguageForFile(filePath: string): string | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".ts") || lower.endsWith(".tsx") || lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return "typescript";
  }
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".rs")) return "rust";
  return null;
}

export async function parseWithTreeSitter(
  filePath: string,
  content: string,
): Promise<TreeSitterParseResult | null> {
  if (!isTreeSitterAvailable()) return null;

  const lang = getLanguageForFile(filePath);
  if (!lang) return null;

  try {
    const parser = await getParser(lang);
    const tree = parser.parse(content);

    const result: TreeSitterParseResult = {
      imports: [],
      exports: [],
      definitions: [],
      calls: [],
    };

    const scopeStack: string[] = [];

    function currentScope(): string {
      return scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : "file";
    }

    function traverse(node: any) {
      if (!node) return;
      let pushedScope = false;

      // -----------------------------------------------------------------------
      // TypeScript / JavaScript
      // -----------------------------------------------------------------------
      if (lang === "typescript") {
        if (node.type === "import_statement") {
          let source = "";
          const specifiers: string[] = [];
          for (const child of node.children) {
            if (child.type === "string" || child.type === "string_fragment") {
              source = child.text.replace(/['"]/g, "");
            }
            if (child.type === "import_clause") {
              specifiers.push(
                ...child.text
                  .replace(/[{}]/g, "")
                  .split(",")
                  .map((s: string) => s.trim())
                  .filter(Boolean),
              );
            }
          }
          if (source) result.imports.push({ source, specifiers, line: node.startPosition.row + 1 });
        }

        if (node.type === "export_statement") {
          for (const child of node.children) {
            if (
              child.type === "declaration" ||
              child.type === "lexical_declaration" ||
              child.type === "function_declaration" ||
              child.type === "class_declaration"
            ) {
              const nameNode = child.children.find(
                (c: any) =>
                  c.type === "identifier" ||
                  c.type === "type_identifier" ||
                  c.type === "variable_declarator",
              );
              if (nameNode) {
                const name =
                  nameNode.type === "variable_declarator"
                    ? nameNode.children[0]?.text
                    : nameNode.text;
                if (name) {
                  result.exports.push({ name, kind: child.type, line: node.startPosition.row + 1 });
                }
              }
            }
          }
        }

        if (node.type === "function_declaration" || node.type === "generator_function_declaration") {
          const idChild = node.children.find((c: any) => c.type === "identifier");
          if (idChild) {
            const name = idChild.text;
            result.definitions.push({
              name,
              kind: "function",
              line: node.startPosition.row + 1,
              bodyStart: node.startIndex,
              bodyEnd: node.endIndex,
            });
            scopeStack.push(name);
            pushedScope = true;
          }
        } else if (node.type === "class_declaration") {
          const idChild = node.children.find((c: any) => c.type === "type_identifier" || c.type === "identifier");
          if (idChild) {
            const name = idChild.text;
            result.definitions.push({
              name,
              kind: "class",
              line: node.startPosition.row + 1,
              bodyStart: node.startIndex,
              bodyEnd: node.endIndex,
            });
            scopeStack.push(name);
            pushedScope = true;
          }
        } else if (node.type === "method_definition") {
          const propChild = node.children.find((c: any) => c.type === "property_identifier");
          if (propChild) {
            const parentScope = currentScope();
            const methodName = propChild.text;
            const qualified = parentScope !== "file" ? `${parentScope}.${methodName}` : methodName;
            result.definitions.push({
              name: qualified,
              kind: "method",
              line: node.startPosition.row + 1,
              bodyStart: node.startIndex,
              bodyEnd: node.endIndex,
            });
            scopeStack.push(qualified);
            pushedScope = true;
          }
        } else if (node.type === "variable_declarator") {
          const idChild = node.children.find((c: any) => c.type === "identifier");
          const hasFnVal = node.children.some((c: any) => c.type === "arrow_function" || c.type === "function_expression");
          if (idChild && hasFnVal) {
            const name = idChild.text;
            result.definitions.push({
              name,
              kind: "function",
              line: node.startPosition.row + 1,
              bodyStart: node.startIndex,
              bodyEnd: node.endIndex,
            });
            scopeStack.push(name);
            pushedScope = true;
          }
        }

        if (node.type === "call_expression" || node.type === "new_expression") {
          const calleeChild = node.children[0];
          if (calleeChild) {
            if (calleeChild.type === "identifier") {
              result.calls.push({
                from: currentScope(),
                callee: calleeChild.text,
                line: node.startPosition.row + 1,
              });
            } else if (calleeChild.type === "subscript_expression") {
              result.calls.push({
                from: currentScope(),
                callee: calleeChild.text,
                line: node.startPosition.row + 1,
                isDynamic: true,
                rawExpression: calleeChild.text,
              });
            } else if (calleeChild.type === "member_expression") {
              const prop = calleeChild.children.find((c: any) => c.type === "property_identifier");
              const isComputed = calleeChild.children.some((c: any) => c.text === "[" || c.type === "computed_property_name");
              if (prop) {
                result.calls.push({
                  from: currentScope(),
                  callee: prop.text,
                  line: node.startPosition.row + 1,
                  isDynamic: isComputed,
                  rawExpression: calleeChild.text,
                });
              } else if (isComputed) {
                result.calls.push({
                  from: currentScope(),
                  callee: calleeChild.text,
                  line: node.startPosition.row + 1,
                  isDynamic: true,
                  rawExpression: calleeChild.text,
                });
              }
            }
          }
        }
      }

      // -----------------------------------------------------------------------
      // Python
      // -----------------------------------------------------------------------
      if (lang === "python") {
        if (node.type === "import_statement" || node.type === "import_from_statement") {
          result.imports.push({ source: node.text, specifiers: [], line: node.startPosition.row + 1 });
        }
        if (node.type === "function_definition") {
          const idChild = node.children.find((c: any) => c.type === "identifier");
          if (idChild) {
            const parentScope = currentScope();
            const fnName = idChild.text;
            const qualified = parentScope !== "file" ? `${parentScope}.${fnName}` : fnName;
            result.definitions.push({
              name: qualified,
              kind: parentScope !== "file" ? "method" : "function",
              line: node.startPosition.row + 1,
              bodyStart: node.startIndex,
              bodyEnd: node.endIndex,
            });
            scopeStack.push(qualified);
            pushedScope = true;
          }
        } else if (node.type === "class_definition") {
          const idChild = node.children.find((c: any) => c.type === "identifier");
          if (idChild) {
            const name = idChild.text;
            result.definitions.push({
              name,
              kind: "class",
              line: node.startPosition.row + 1,
              bodyStart: node.startIndex,
              bodyEnd: node.endIndex,
            });
            scopeStack.push(name);
            pushedScope = true;
          }
        } else if (node.type === "call") {
          const calleeChild = node.children[0];
          if (calleeChild) {
            let calleeName = calleeChild.text;
            if (calleeChild.type === "attribute") {
              const attrChild = calleeChild.children.find((c: any) => c.type === "identifier");
              if (attrChild) calleeName = attrChild.text;
            }
            result.calls.push({
              from: currentScope(),
              callee: calleeName,
              line: node.startPosition.row + 1,
              rawExpression: calleeChild.text,
            });
          }
        }
      }

      // -----------------------------------------------------------------------
      // Go
      // -----------------------------------------------------------------------
      if (lang === "go") {
        if (node.type === "import_declaration") {
          result.imports.push({ source: node.text, specifiers: [], line: node.startPosition.row + 1 });
        }
        if (node.type === "function_declaration" || node.type === "method_declaration") {
          const idChild = node.children.find((c: any) => c.type === "identifier");
          if (idChild) {
            const name = idChild.text;
            result.definitions.push({
              name,
              kind: node.type === "method_declaration" ? "method" : "function",
              line: node.startPosition.row + 1,
              bodyStart: node.startIndex,
              bodyEnd: node.endIndex,
            });
            scopeStack.push(name);
            pushedScope = true;
          }
        } else if (node.type === "call_expression") {
          const calleeChild = node.children[0];
          if (calleeChild) {
            result.calls.push({
              from: currentScope(),
              callee: calleeChild.text,
              line: node.startPosition.row + 1,
            });
          }
        }
      }

      // -----------------------------------------------------------------------
      // Rust
      // -----------------------------------------------------------------------
      if (lang === "rust") {
        if (node.type === "use_declaration") {
          result.imports.push({ source: node.text, specifiers: [], line: node.startPosition.row + 1 });
        }
        if (node.type === "function_item") {
          const idChild = node.children.find((c: any) => c.type === "identifier");
          if (idChild) {
            const parentScope = currentScope();
            const name = idChild.text;
            const qualified = parentScope !== "file" ? `${parentScope}::${name}` : name;
            result.definitions.push({
              name: qualified,
              kind: "function",
              line: node.startPosition.row + 1,
              bodyStart: node.startIndex,
              bodyEnd: node.endIndex,
            });
            scopeStack.push(qualified);
            pushedScope = true;
          }
        } else if (node.type === "struct_item" || node.type === "enum_item" || node.type === "impl_item") {
          const idChild = node.children.find((c: any) => c.type === "type_identifier");
          if (idChild) {
            const name = idChild.text;
            result.definitions.push({
              name,
              kind: "class",
              line: node.startPosition.row + 1,
              bodyStart: node.startIndex,
              bodyEnd: node.endIndex,
            });
            scopeStack.push(name);
            pushedScope = true;
          }
        } else if (node.type === "call_expression") {
          const calleeChild = node.children[0];
          if (calleeChild) {
            result.calls.push({
              from: currentScope(),
              callee: calleeChild.text,
              line: node.startPosition.row + 1,
            });
          }
        }
      }

      for (const child of node.children) {
        traverse(child);
      }

      if (pushedScope) {
        scopeStack.pop();
      }
    }

    traverse(tree.rootNode);

    return result;
  } catch {
    return null;
  }
}
