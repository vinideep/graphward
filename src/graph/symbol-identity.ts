import { createHash } from "node:crypto";

export type SymbolOrigin = "SOURCE" | "GENERATED" | "DEPENDENCY" | "VIRTUAL";

export interface SymbolId {
  repository: string;
  package: string;
  language: string;
  path: string;
  qualifiedName: string;
  signature?: string;
  declarationHash: string;
  origin: SymbolOrigin;
}

export interface RuntimeSymbolHint {
  buildId?: string;
  moduleId: string;
  runtimeSymbolHint: string;
  callsite?: {
    file: string;
    line: number;
    column?: number;
  };
}

export interface SourceMapMapping {
  sourceFile: string;
  sourceLine: number;
  sourceColumn?: number;
  sourceSymbol?: string;
}

export interface ResolvedRuntimeSymbol {
  symbolId?: SymbolId;
  uri?: string;
  file: string;
  qualifiedName: string;
  line?: number;
  column?: number;
  sourceMapped: boolean;
}

/**
 * Normalizes a signature string and computes its 16-character SHA-256 hash.
 */
export function computeSignatureHash(signature: string): string {
  const normalized = signature.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Computes a declaration fingerprint from qualified name, signature, and optional content/body.
 */
export function computeDeclarationHash(params: {
  qualifiedName: string;
  signature?: string;
  content?: string;
}): string {
  const hash = createHash("sha256");
  hash.update(`name:${params.qualifiedName.trim()}`);
  if (params.signature) {
    hash.update(`;sig:${params.signature.replace(/\s+/g, " ").trim()}`);
  }
  if (params.content) {
    hash.update(`;body:${params.content.replace(/\s+/g, " ").trim()}`);
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * Infers language identifier from file extension.
 */
export function inferLanguageFromPath(filePath: string): string {
  const ext = filePath.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "py":
      return "python";
    case "go":
      return "go";
    case "rs":
      return "rust";
    case "rb":
      return "ruby";
    case "java":
      return "java";
    case "kt":
      return "kotlin";
    default:
      return ext || "unknown";
  }
}

/**
 * Formats a disambiguated qualified name for method/function overloads using signature hash.
 */
export function getOverloadQualifiedName(qualifiedName: string, signature: string): string {
  const sigHash = computeSignatureHash(signature).slice(0, 8);
  return `${qualifiedName}@${sigHash}`;
}

/**
 * Normalizes file path to forward slashes without leading ./ or /.
 */
export function normalizeSymbolPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^(\.\/|\/)+/, "");
}

/**
 * Creates a fully validated SymbolId struct, automatically calculating hashes and language if omitted.
 */
export function createSymbolId(params: {
  repository?: string;
  package?: string;
  language?: string;
  path: string;
  qualifiedName: string;
  signature?: string;
  declarationHash?: string;
  content?: string;
  origin?: SymbolOrigin;
}): SymbolId {
  const normalizedPath = normalizeSymbolPath(params.path);
  const language = params.language ?? inferLanguageFromPath(normalizedPath);
  const repository = params.repository ?? "workspace";
  const pkg = params.package ?? "root";
  const declarationHash =
    params.declarationHash ??
    computeDeclarationHash({
      qualifiedName: params.qualifiedName,
      signature: params.signature,
      content: params.content,
    });

  return {
    repository,
    package: pkg,
    language,
    path: normalizedPath,
    qualifiedName: params.qualifiedName,
    ...(params.signature ? { signature: params.signature } : {}),
    declarationHash,
    origin: params.origin ?? "SOURCE",
  };
}

/**
 * Formats a SymbolId into a canonical GraphWard URI:
 * gw://repo/package/lang/path#qualifiedSymbol
 * If an overload signature is present, appends ?sig=<hash>.
 */
export function formatSymbolUri(symbol: SymbolId): string {
  const repo = encodeURIComponent(symbol.repository);
  const pkg = encodeURIComponent(symbol.package);
  const lang = encodeURIComponent(symbol.language);
  const pathPart = symbol.path.replace(/^\/+/, "");
  const namePart = encodeURIComponent(symbol.qualifiedName);

  let uri = `gw://${repo}/${pkg}/${lang}/${pathPart}#${namePart}`;
  const params = new URLSearchParams();
  if (symbol.signature) {
    params.set("sig", computeSignatureHash(symbol.signature));
  }
  if (symbol.declarationHash) {
    params.set("decl", symbol.declarationHash);
  }
  if (symbol.origin && symbol.origin !== "SOURCE") {
    params.set("origin", symbol.origin);
  }
  const qs = params.toString();
  if (qs) {
    uri += `?${qs}`;
  }
  return uri;
}

/**
 * Parses a canonical GraphWard URI back into a SymbolId.
 * Format: gw://repo/package/lang/path#qualifiedSymbol[?sig=...&decl=...]
 */
export function parseSymbolUri(uri: string): SymbolId {
  if (!uri.startsWith("gw://")) {
    throw new Error(`Invalid GraphWard symbol URI: must start with 'gw://', got '${uri}'`);
  }

  const withoutScheme = uri.slice(5);
  const hashIdx = withoutScheme.indexOf("#");
  if (hashIdx === -1) {
    throw new Error(`Invalid GraphWard symbol URI: missing '#' fragment for symbol name in '${uri}'`);
  }

  const pathComponent = withoutScheme.slice(0, hashIdx);
  const fragmentWithQuery = withoutScheme.slice(hashIdx + 1);

  let qualifiedName = fragmentWithQuery;
  let signatureHash: string | undefined;
  let declHash: string | undefined;
  let originParam: string | null = null;

  const queryIdx = fragmentWithQuery.indexOf("?");
  if (queryIdx !== -1) {
    qualifiedName = fragmentWithQuery.slice(0, queryIdx);
    const queryString = fragmentWithQuery.slice(queryIdx + 1);
    const params = new URLSearchParams(queryString);
    signatureHash = params.get("sig") ?? undefined;
    declHash = params.get("decl") ?? undefined;
    originParam = params.get("origin");
  }

  const parts = pathComponent.split("/");
  if (parts.length < 4) {
    throw new Error(
      `Invalid GraphWard symbol URI: path must contain repo/package/lang/path, got '${pathComponent}'`,
    );
  }

  const repository = decodeURIComponent(parts[0]);
  const pkg = decodeURIComponent(parts[1]);
  const language = decodeURIComponent(parts[2]);
  const filePath = parts.slice(3).join("/");
  const decodedName = decodeURIComponent(qualifiedName);

  const origin: SymbolOrigin =
    originParam === "GENERATED" || originParam === "DEPENDENCY" || originParam === "VIRTUAL"
      ? originParam
      : "SOURCE";

  return {
    repository,
    package: pkg,
    language,
    path: filePath,
    qualifiedName: decodedName,
    ...(signatureHash ? { signature: `/* hash:${signatureHash} */` } : {}),
    declarationHash: declHash ?? computeDeclarationHash({ qualifiedName: decodedName }),
    origin,
  };
}

/**
 * Bridges runtime observation symbols / sourcemaps back to canonical source symbols.
 */
export function resolveRuntimeSymbol(
  hint: RuntimeSymbolHint,
  sourceMapLookup?: (file: string, line: number, col?: number) => SourceMapMapping | null,
  repoContext?: { repository?: string; package?: string },
): ResolvedRuntimeSymbol {
  if (hint.callsite && sourceMapLookup) {
    const mapped = sourceMapLookup(hint.callsite.file, hint.callsite.line, hint.callsite.column);
    if (mapped) {
      const qName = mapped.sourceSymbol ?? hint.runtimeSymbolHint;
      const symId = createSymbolId({
        repository: repoContext?.repository,
        package: repoContext?.package,
        path: mapped.sourceFile,
        qualifiedName: qName,
      });
      return {
        symbolId: symId,
        uri: formatSymbolUri(symId),
        file: mapped.sourceFile,
        qualifiedName: qName,
        line: mapped.sourceLine,
        column: mapped.sourceColumn,
        sourceMapped: true,
      };
    }
  }

  // Fallback to raw runtime hint coordinates
  const cleanPath = normalizeSymbolPath(hint.moduleId || (hint.callsite ? hint.callsite.file : "unknown"));
  const symId = createSymbolId({
    repository: repoContext?.repository,
    package: repoContext?.package,
    path: cleanPath,
    qualifiedName: hint.runtimeSymbolHint,
  });

  return {
    symbolId: symId,
    uri: formatSymbolUri(symId),
    file: cleanPath,
    qualifiedName: hint.runtimeSymbolHint,
    line: hint.callsite?.line,
    column: hint.callsite?.column,
    sourceMapped: false,
  };
}
