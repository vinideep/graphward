import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadGwConfig } from "../config/index.js";
import { acquireLock } from "../manifest/lock.js";
import { buildGraph, ensureFreshGraph } from "../graph/index.js";
import { runProcess, type ProcessRunner } from "../process/index.js";
import { computeProviderSourceSnapshot, toCanonicalPath } from "../providers/workspace.js";
import { inspectProjectProviderRuns, type ProjectProviderRunStatus } from "../providers/project-status.js";
import { providerStatus } from "../providers/manager.js";
import { runGraphifyExtraction } from "../providers/graphify.js";
import { runCceIndex } from "../providers/cce.js";

export interface ContextPreparationReceipt {
  schemaVersion: 1;
  id: string;
  projectRoot: string;
  sourceGeneration: string;
  preparedAt: string;
  policy: string;
  requireProviders: boolean;
  status: "ready" | "degraded" | "blocked" | "cancelled";
  requiresDecision: boolean;
  actions: string[];
  providers: ProjectProviderRunStatus[];
  binaries: Awaited<ReturnType<typeof providerStatus>>[];
  unknowns: string[];
  /**
   * Files too large for provider indexing. They are a coverage note, not a degradation:
   * readiness asks for a decision only when one falls inside a task's confirmed scope.
   */
  excludedFiles?: string[];
}
export const CONTEXT_PREPARATION_PATH = ".graphward/context/preparation.json";
export async function readContextPreparation(root: string): Promise<ContextPreparationReceipt | undefined> {
  try { return JSON.parse(await readFile(path.join(root, CONTEXT_PREPARATION_PATH), "utf8")); } catch { return undefined; }
}

/** Explicit local preparation. Retrieval never calls this mutating service. */
export async function prepareTaskContext(root: string, options: {
  runner?: ProcessRunner; providerHome?: string; signal?: AbortSignal;
  timeoutMs?: number; retry?: boolean; onProgress?: (message: string) => void;
} = {}): Promise<ContextPreparationReceipt> {
  root = toCanonicalPath(root);
  const release = await acquireLock(root, { name: ".context-preparation.lock", timeoutMs: 1000 });
  try {
    const config = await loadGwConfig(root);
    const native = config.providers.policy === "native";
    const before = await computeProviderSourceSnapshot(root);
    const previous = await readContextPreparation(root);
    const initialRuns = await inspectProjectProviderRuns(root, { disabled: native });
    // Receipts written before `excludedFiles` existed counted oversized files as unknowns
    // (and so as degraded); regenerate them instead of reusing that verdict.
    if (!options.retry && previous?.excludedFiles && previous.projectRoot === root && previous.sourceGeneration === before.workspaceHash && previous.policy === (config.providers.policy ?? "auto") && previous.requireProviders === config.providers.requireProviders && JSON.stringify(previous.providers) === JSON.stringify(initialRuns)) return previous;
    const deadline = Date.now() + Math.max(100, Math.min(options.timeoutMs ?? 120_000, 900_000));
    const runner: ProcessRunner = async request => {
      if (options.signal?.aborted || Date.now() >= deadline) return { command: request.command, args: request.args ?? [], stdout: "", stderr: "Preparation cancelled or timed out", exitCode: options.signal?.aborted ? 130 : 124, timedOut: !options.signal?.aborted };
      return (options.runner ?? runProcess)({ ...request, signal: options.signal, timeoutMs: Math.max(1, Math.min(request.timeoutMs ?? 120_000, deadline - Date.now())) });
    };
    const receipt: ContextPreparationReceipt = {
      schemaVersion: 1, id: randomUUID(), projectRoot: root, sourceGeneration: before.workspaceHash,
      preparedAt: new Date().toISOString(), policy: config.providers.policy ?? "auto", requireProviders: config.providers.requireProviders === true, status: "ready", requiresDecision: false,
      actions: [], providers: [], binaries: [], unknowns: [], excludedFiles: [...before.skippedLarge].sort(),
    };
    const progress = (message: string) => { receipt.actions.push(message); options.onProgress?.(message); };
    const runs = initialRuns;
    let providerRefreshed = false;
    if (!native) {
      for (const name of ["graphify", "cce"] as const) {
        const binary = await providerStatus(name, { runner, providerHome: options.providerHome });
        receipt.binaries.push(binary);
        if (runs.find(run => run.name === name)?.health === "current") continue;
        if (binary.health !== "healthy") { receipt.unknowns.push(`${name}: ${binary.message}`); continue; }
        progress(`${name}: one bounded local refresh; pinned adapter requires a full rebuild, no dependency downloads.`);
        try {
          const result = await (name === "graphify" ? runGraphifyExtraction : runCceIndex)(root, { runner, providerHome: options.providerHome, onProgress: progress });
          if (result.ok) providerRefreshed = true;
          if (!result.ok) receipt.unknowns.push(`${name}: ${result.message}`);
        } catch (error) { receipt.unknowns.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
      }
    }
    if (!options.signal?.aborted) {
      progress("Refresh canonical native graph and reconcile available provider evidence.");
      try { if (native || providerRefreshed) await buildGraph(root, { providerEvidence: !native }); else { const graph = await ensureFreshGraph(root); if (graph.staleWarning) receipt.unknowns.push(graph.staleWarning); } }
      catch (error) { receipt.unknowns.push(`Graph preparation failed: ${String(error)}`); }
    }
    receipt.providers = await inspectProjectProviderRuns(root, { disabled: native });
    for (const run of receipt.providers) if (run.fallback) receipt.unknowns.push(`${run.name}: ${run.message}`);
    const generationChanged = (await computeProviderSourceSnapshot(root)).workspaceHash !== before.workspaceHash;
    if (generationChanged) receipt.unknowns.push("Source generation changed during preparation; prepare the new generation before implementation.");
    receipt.status = options.signal?.aborted ? "cancelled" : Date.now() >= deadline ? "blocked" : generationChanged ? "blocked" : receipt.unknowns.length ? config.providers.requireProviders ? "blocked" : "degraded" : "ready";
    receipt.requiresDecision = receipt.status === "degraded";
    const location = path.join(root, CONTEXT_PREPARATION_PATH);
    await mkdir(path.dirname(location), { recursive: true });
    const temporary = `${location}.tmp-${randomUUID()}`;
    await writeFile(temporary, JSON.stringify(receipt, null, 2) + "\n"); await rename(temporary, location);
    return receipt;
  } finally { await release(); }
}
