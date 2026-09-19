import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { GateOptions, GateResult } from "./index.js";

interface ConventionFinding { id?: string; message?: string; severity?: "critical" | "major" | "minor"; category?: string; confidence?: number; adherence?: number; waiver?: { owner?: string; rationale?: string; expiresAt?: string }; }
const BLOCKING_MAJOR = new Set(["security", "data", "architecture", "api-contract", "test-contract"]);

function waived(finding: ConventionFinding): boolean {
  if (!finding.waiver?.owner || !finding.waiver.rationale) return false;
  if (!finding.waiver.expiresAt) return true;
  return Date.parse(finding.waiver.expiresAt) > Date.now();
}

export async function conventionsGate(root: string, options: GateOptions = {}): Promise<GateResult> {
  if (!(options.changedFiles ?? []).some((file) => /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|sql)$/i.test(file))) return { gate: "conventions", status: "skipped", summary: "No source files changed.", findings: [], applicable: false, required: false, reason: "no source files" };
  const rel = ".graphward/reports/convention-findings.json";
  const target = path.join(root, rel);
  if (!existsSync(target)) return { gate: "conventions", status: "unavailable", summary: "Changed source requires a convention findings artifact.", findings: [{ severity: "error", message: `Missing ${rel}` }], applicable: true, required: true };
  let parsed: { findings?: ConventionFinding[] };
  try { parsed = JSON.parse(await readFile(target, "utf8")) as { findings?: ConventionFinding[] }; }
  catch { return { gate: "conventions", status: "unavailable", summary: "Convention findings artifact is invalid JSON.", findings: [{ severity: "error", message: `Invalid ${rel}` }], applicable: true, required: true, artifact: rel }; }
  const enforceable = (parsed.findings ?? []).filter((finding) => (finding.confidence ?? 0) >= 0.8 && (finding.adherence ?? 0) >= 0.8 && !waived(finding));
  const critical = enforceable.filter((finding) => finding.severity === "critical");
  const categoryMajor = enforceable.filter((finding) => finding.severity === "major" && BLOCKING_MAJOR.has(finding.category ?? ""));
  const otherMajor = enforceable.filter((finding) => finding.severity === "major" && !BLOCKING_MAJOR.has(finding.category ?? ""));
  const blocking = [...critical, ...categoryMajor, ...(otherMajor.length >= 3 ? otherMajor : [])];
  return { gate: "conventions", status: blocking.length ? "fail" : enforceable.some((finding) => finding.severity === "minor" || finding.severity === "major") ? "warn" : "pass", summary: blocking.length ? `${blocking.length} convention finding(s) exceed blocking thresholds.` : "Convention thresholds passed.", findings: blocking.map((finding) => ({ severity: "error", message: finding.message ?? finding.id ?? "Convention violation" })), applicable: true, required: true, artifact: rel };
}
