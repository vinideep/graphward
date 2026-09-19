import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { GateOptions, GateResult } from "./index.js";

interface SecurityReview { status?: string; findings?: Array<{ severity?: string; message?: string; waived?: boolean }>; }

export async function securityAuditGate(root: string, options: GateOptions = {}): Promise<GateResult> {
  const changed = options.changedFiles ?? [];
  const securityFiles = changed.filter((file) => /(auth|security|secret|crypto|session|permission|mcp|llm|prompt|dependency|package\.json|lock)/i.test(file));
  if (!securityFiles.length) return { gate: "security-audit", status: "skipped", summary: "No security-sensitive surface changed.", findings: [], applicable: false, required: false, reason: "no security classifier matched" };
  const rel = ".graphward/reports/security-review.json";
  const target = path.join(root, rel);
  if (!existsSync(target)) return { gate: "security-audit", status: "unavailable", summary: "Security-sensitive changes require a security review artifact.", findings: [{ severity: "error", message: `Missing ${rel}; affected: ${securityFiles.join(", ")}` }], applicable: true, required: true };
  let review: SecurityReview;
  try { review = JSON.parse(await readFile(target, "utf8")) as SecurityReview; }
  catch { return { gate: "security-audit", status: "unavailable", summary: "Security review artifact is invalid JSON.", findings: [{ severity: "error", message: `Invalid ${rel}` }], applicable: true, required: true, artifact: rel }; }
  const blocking = (review.findings ?? []).filter((finding) => !finding.waived && /^(critical|high)$/i.test(finding.severity ?? ""));
  return { gate: "security-audit", status: blocking.length ? "fail" : "pass", summary: blocking.length ? `${blocking.length} unwaived high/critical security finding(s).` : "Security review contains no unwaived high/critical findings.", findings: blocking.map((finding) => ({ severity: "error", message: finding.message ?? "Unwaived security finding" })), applicable: true, required: true, artifact: rel };
}
