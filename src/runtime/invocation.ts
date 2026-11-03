import { readFileSync, realpathSync, statSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

export interface RuntimeInvocation {
  command: string;
  args: string[];
  packageRoot: string;
  version: string;
  entrypoint: string;
  entrypointHash: string;
  generation: string;
}

/** Literal POSIX shell argument; unsupported cmd.exe expansion characters fail explicitly. */
export function quoteShellArgument(value: string, platform: NodeJS.Platform = process.platform): string {
  if (value.includes("\0")) throw new Error("Shell arguments cannot contain NUL.");
  if (platform === "win32") {
    if (/[%!"\r\n]/.test(value)) throw new Error("This runtime path contains unsupported cmd.exe expansion characters; choose a literal safe installation path.");
    return `"${value}"`;
  }
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

const PROCESS_STARTED_AT = new Date().toISOString();
const installationRoot = fileURLToPath(new URL("../../", import.meta.url));
// Captured at module load, before a later build can replace files on disk.
const loadedGeneration: string | undefined = (() => { try { return JSON.parse(readFileSync(path.join(installationRoot, "dist/runtime-identity.json"), "utf8")).generation; } catch { return undefined; } })();

export function runtimeIdentityStatus() {
  try {
    const current = resolveRuntimeInvocation();
    return { processId: process.pid, processStartedAt: PROCESS_STARTED_AT, loadedGeneration, diskGeneration: current.generation, current: loadedGeneration === current.generation, packageRoot: current.packageRoot, version: current.version };
  } catch (error) { return { processId: process.pid, processStartedAt: PROCESS_STARTED_AT, loadedGeneration, current: false, error: error instanceof Error ? error.message : String(error) }; }
}

/** Resolve only this identified installation. Never search PATH or invoke npm/npx. */
export function resolveRuntimeInvocation(options: { packageRoot?: string; projectRoot?: string; kind?: "cli" | "mcp" } = {}): RuntimeInvocation {
  const packageRoot = realpathSync(options.packageRoot ?? fileURLToPath(new URL("../../", import.meta.url)));
  const pkg = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  const identity = JSON.parse(readFileSync(path.join(packageRoot, "dist/runtime-identity.json"), "utf8"));
  if (pkg.name !== "graphward" || identity.name !== pkg.name || identity.version !== pkg.version || identity.schemaVersion !== 2 || !identity.modules || typeof identity.modules !== "object") {
    throw new Error("GraphWard runtime identity is stale or invalid; rebuild this source checkout or reinstall the identified package.");
  }
  if (identity.generation !== createHash("sha256").update(JSON.stringify(identity.modules)).digest("hex")) throw new Error("GraphWard implementation generation manifest is invalid; rebuild or reinstall it.");
  for (const [relative, expected] of Object.entries(identity.modules)) {
    const target = path.resolve(packageRoot, "dist", relative);
    if (path.isAbsolute(relative) || !target.startsWith(path.join(packageRoot, "dist") + path.sep) || !lstatSync(target).isFile() || realpathSync(target) !== target || createHash("sha256").update(readFileSync(target)).digest("hex") !== expected) throw new Error(`GraphWard implementation generation does not match finalized module ${relative}; rebuild or reinstall it.`);
  }
  const bin = options.kind === "mcp" ? "gw-mcp" : "graphward";
  const relative = pkg.bin?.[bin];
  if (typeof relative !== "string") throw new Error(`Missing GraphWard bin ${bin}.`);
  const entrypoint = realpathSync(path.resolve(packageRoot, relative));
  if (!entrypoint.startsWith(path.join(packageRoot, "dist") + path.sep) || !statSync(entrypoint).isFile()) {
    throw new Error("GraphWard entrypoint escapes the identified installation.");
  }
  const bytes = readFileSync(entrypoint);
  const entrypointHash = createHash("sha256").update(bytes).digest("hex");
  if (!bytes.toString("utf8").startsWith("#!/usr/bin/env node\n") || identity.bins?.[bin]?.sha256 !== entrypointHash || identity.bins?.[bin]?.path !== relative) {
    throw new Error("GraphWard entrypoint does not match its finalized build identity; rebuild or reinstall it.");
  }
  const args = [entrypoint];
  if (options.projectRoot !== undefined) {
    const projectRoot = realpathSync(path.resolve(options.projectRoot));
    if (!statSync(projectRoot).isDirectory()) throw new Error("GraphWard project root must be a directory.");
    if (options.kind !== "mcp") throw new Error("Pass CLI verb arguments explicitly; projectRoot binding is supported by the MCP invocation.");
    args.push(projectRoot);
  }
  return { command: realpathSync(process.execPath), args, packageRoot, version: pkg.version, entrypoint, entrypointHash, generation: identity.generation };
}
