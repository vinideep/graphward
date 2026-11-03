import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { GateOptions, GateResult } from "./index.js";
import { validateCompletedReview } from "./review-evidence.js";

interface SecurityReview { status?: string; findings?: Array<{ severity?: string; message?: string; waiver?: { reviewer?: string; rationale?: string; expiresAt?: string } }>; }

export async function securityAuditGate(root: string, options: GateOptions = {}): Promise<GateResult> {
  const changed = options.changedFiles ?? [];
  const securityFiles = changed.filter((file) => options.risk === "high" || options.risk === "critical" || /(auth|security|secret|crypto|session|permission|mcp|llm|prompt|dependency|package\.json|lock|(?:^|\/)(?:hooks|aidlc|verify|gates|project-files|process|providers|installer|learning|runtime|experiment|visualizer|manifest|claims|evidence|context|config|routing)(?:\/|\.)|(?:^|\/)graph\/trust\.)/i.test(file));
  if (!securityFiles.length) return { gate: "security-audit", status: "skipped", summary: "No security-sensitive surface changed.", findings: [], applicable: false, required: false, reason: "no security classifier matched" };
  const rel = ".graphward/reports/security-review.json";
  const target = path.join(root, rel);
  if (!existsSync(target)) return { gate: "security-audit", status: "unavailable", summary: "Security-sensitive changes require a security review artifact.", findings: [{ severity: "error", message: `Missing ${rel}; affected: ${securityFiles.join(", ")}` }], applicable: true, required: true };
  let review: SecurityReview;
  try { review = JSON.parse(await readFile(target, "utf8")) as SecurityReview; }
  catch { return { gate: "security-audit", status: "unavailable", summary: "Security review artifact is invalid JSON.", findings: [{ severity: "error", message: `Invalid ${rel}` }], applicable: true, required: true, artifact: rel }; }
  const invalid = await validateCompletedReview(root, review, securityFiles);
  if (invalid || !review.findings!.every(finding => finding && /^(critical|high|medium|low|info)$/i.test(finding.severity ?? "") && typeof finding.message === "string" && finding.message.trim())) return { gate: "security-audit", status: "unavailable", summary: invalid ?? "Security finding schema is invalid.", findings: [{severity:"error",message:invalid ?? "Invalid finding schema"}], applicable:true,required:true,artifact:rel };
  const waived = (finding: NonNullable<SecurityReview["findings"]>[number]) => !!finding.waiver?.reviewer?.trim() && !!finding.waiver.rationale?.trim() && !!finding.waiver.expiresAt && Date.parse(finding.waiver.expiresAt) > Date.now();
  const blocking = review.findings!.filter((finding) => !waived(finding) && /^(critical|high)$/i.test(finding.severity ?? ""));
  return { gate: "security-audit", status: blocking.length ? "fail" : "pass", summary: blocking.length ? `${blocking.length} unwaived high/critical security finding(s).` : "Security review contains no unwaived high/critical findings.", findings: blocking.map((finding) => ({ severity: "error", message: finding.message ?? "Unwaived security finding" })), applicable: true, required: true, artifact: rel };
}
