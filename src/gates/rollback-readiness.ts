import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { GateOptions, GateResult, GateRisk } from "./index.js";

const REQUIRED = ["codeRevert", "stateCompensation", "disablePath", "externalEffects", "irreversibleSteps", "verification"] as const;
const RANK: Record<GateRisk, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export async function rollbackReadinessGate(root: string, options: GateOptions = {}): Promise<GateResult> {
  const risk = options.risk ?? "low";
  if (RANK[risk] < RANK.medium) return { gate: "rollback-readiness", status: "skipped", summary: "Rollback evidence is not required for low-risk work.", findings: [], applicable: false, required: false, reason: `risk=${risk}` };
  const rel = ".graphward/aidlc/operations/rollback-readiness.json";
  const target = path.join(root, rel);
  if (!existsSync(target)) return { gate: "rollback-readiness", status: "unavailable", summary: "Medium/high-risk work requires rollback evidence.", findings: [{ severity: "error", message: `Missing ${rel}` }], applicable: true, required: true };
  let artifact: Record<string, unknown>;
  try { artifact = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>; }
  catch { return { gate: "rollback-readiness", status: "unavailable", summary: "Rollback artifact is invalid JSON.", findings: [{ severity: "error", message: `Invalid ${rel}` }], applicable: true, required: true, artifact: rel }; }
  const missing = REQUIRED.filter((field) => typeof artifact[field] !== "string" || !(artifact[field] as string).trim());
  return { gate: "rollback-readiness", status: missing.length ? "fail" : "pass", summary: missing.length ? `Rollback artifact is missing ${missing.length} required field(s).` : "Rollback readiness evidence is complete.", findings: missing.map((field) => ({ severity: "error", message: `Rollback field '${field}' is required.` })), applicable: true, required: true, artifact: rel };
}
