import { readFileSync, realpathSync, statSync } from "node:fs";
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
}

/** Resolve only this identified installation. Never search PATH or invoke npm/npx. */
export function resolveRuntimeInvocation(options: { packageRoot?: string; projectRoot?: string; kind?: "cli" | "mcp" } = {}): RuntimeInvocation {
  const packageRoot = realpathSync(options.packageRoot ?? fileURLToPath(new URL("../../", import.meta.url)));
  const pkg = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  const identity = JSON.parse(readFileSync(path.join(packageRoot, "dist/runtime-identity.json"), "utf8"));
  if (pkg.name !== "graphward" || identity.name !== pkg.name || identity.version !== pkg.version || identity.schemaVersion !== 1) {
    throw new Error("GraphWard runtime identity is stale or invalid; rebuild this source checkout or reinstall the identified package.");
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
  return { command: realpathSync(process.execPath), args, packageRoot, version: pkg.version, entrypoint, entrypointHash };
}
