import { mkdir, readFile, appendFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export interface LearnedPatternInput {
  type: "convention" | "regression" | "constraint";
  title: string;
  description: string;
  rule: string;
  targetFiles?: string[];
  provenance?: 'human' | 'agent' | 'unknown';
}

export interface LearnedPatternProposal extends LearnedPatternInput {
  schemaVersion: 1;
  id: string;
  deduplicationHash: string;
  proposedAt: string;
  status: "proposed" | "promoted" | "rejected";
}

export interface UncertaintyEventInput {
  trigger: string;
  area: string;
  description: string;
  severity?: "low" | "medium" | "high";
  observedReality?: string;
  resolution?: string;
}

export interface MemoryQueryResult {
  constraints: string[];
  conventions: string[];
  regressions: string[];
}

function memoryDir(root: string): string {
  return path.join(root, ".graphward", "memory");
}

function eventsDir(root: string): string {
  return path.join(root, ".graphward", "events");
}

function proposalDir(root: string): string {
  return path.join(eventsDir(root), "learning-proposals");
}

function patternHash(pattern: LearnedPatternInput): string {
  const normalized = JSON.stringify({
    type: pattern.type,
    title: pattern.title.trim().toLowerCase(),
    description: pattern.description.trim(),
    rule: pattern.rule.trim(),
    targetFiles: [...(pattern.targetFiles ?? [])].sort(),
  });
  return createHash("sha256").update(normalized).digest("hex");
}

function safeInline(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

export async function proposeLearnedPattern(root: string, pattern: LearnedPatternInput): Promise<LearnedPatternProposal & { path: string }> {
  const validTypes = ["convention", "regression", "constraint"] as const;
  if (!pattern || !validTypes.includes(pattern.type as any)) throw new Error(`Invalid pattern type "${pattern?.type}". Allowed types: ${validTypes.join(", ")}.`);
  if (!pattern.title?.trim() || !pattern.description?.trim() || !pattern.rule?.trim()) throw new Error("Learned-pattern proposals require title, description, and rule.");
  if (!pattern.targetFiles?.length) throw new Error("Learned-pattern proposals require at least one evidence path in targetFiles.");
  const hash = patternHash(pattern);
  const proposal: LearnedPatternProposal = {
    ...pattern,
    schemaVersion: 1,
    id: `pat-${hash.slice(0, 16)}`,
    deduplicationHash: hash,
    proposedAt: new Date().toISOString(),
    status: "proposed",
  };
  const dir = proposalDir(root);
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, `${proposal.id}.json`);
  await writeFile(target, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
  return { ...proposal, path: path.relative(root, target).replace(/\\/g, "/") };
}

export async function promoteLearnedPattern(
  root: string,
  id: string,
  decision: { reviewer: string; rationale: string; promote: boolean },
): Promise<{ saved: boolean; path: string; id: string; status: "promoted" | "rejected" | "duplicate" }> {
  if (!decision.reviewer.trim() || !decision.rationale.trim()) throw new Error("Promotion requires reviewer and rationale.");
  const proposalPath = path.join(proposalDir(root), `${id}.json`);
  const proposal = JSON.parse(await readFile(proposalPath, "utf8")) as LearnedPatternProposal;
  if (!decision.promote) {
    await writeFile(proposalPath, `${JSON.stringify({ ...proposal, status: "rejected", decision }, null, 2)}\n`, "utf8");
    return { saved: false, path: path.relative(root, proposalPath).replace(/\\/g, "/"), id, status: "rejected" };
  }

  const fileNameMap: Record<LearnedPatternInput["type"], { file: string; heading: string }> = {
    convention: { file: "coding-patterns.md", heading: "# Coding Patterns" },
    regression: { file: "regression-patterns.md", heading: "# Regression Patterns" },
    constraint: { file: "project-constraints.md", heading: "# Project Constraints" },
  };
  const info = fileNameMap[proposal.type];
  const dir = memoryDir(root);
  const filePath = path.join(dir, info.file);
  await mkdir(dir, { recursive: true });
  const existing = existsSync(filePath) ? await readFile(filePath, "utf8") : `${info.heading}\n<!-- freshness: last_checked=${new Date().toISOString().split("T")[0]} -->\n\n`;
  if (existing.includes(`[pattern-id:${proposal.id}]`)) return { saved: false, path: path.relative(root, filePath).replace(/\\/g, "/"), id, status: "duplicate" };
  const entry = `- **${safeInline(proposal.title)}:** ${safeInline(proposal.rule)} (${safeInline(proposal.description)}) (evidence: ${proposal.targetFiles!.map(safeInline).join(", ")}) [provenance: ${proposal.provenance ?? "unknown"}] [pattern-id:${proposal.id}] [reviewer:${safeInline(decision.reviewer)}]\n`;
  const { writeProtectedFile } = await import("../manifest/lock.js");
  await writeProtectedFile(root, filePath, existing + entry);
  await writeFile(proposalPath, `${JSON.stringify({ ...proposal, status: "promoted", decision }, null, 2)}\n`, "utf8");
  return { saved: true, path: path.relative(root, filePath).replace(/\\/g, "/"), id, status: "promoted" };
}

/**
 * Record a learned pattern, convention, or negative constraint to durable project memory.
 */
export async function recordLearnedPattern(
  root: string,
  pattern: LearnedPatternInput,
): Promise<{ saved: false; path: string; id: string; status: "proposed"; deprecated: true }> {
  const proposal = await proposeLearnedPattern(root, pattern);
  return { saved: false, path: proposal.path, id: proposal.id, status: "proposed", deprecated: true };
}

export async function migrateLegacyRegressionPatterns(root: string): Promise<{ migrated: number; conflicts: number; report?: string }> {
  const legacy = path.join(root, ".engineering-intelligence", "memory", "regression-patterns.md");
  if (!existsSync(legacy)) return { migrated: 0, conflicts: 0 };
  const current = path.join(memoryDir(root), "regression-patterns.md");
  const legacyLines = (await readFile(legacy, "utf8")).split("\n").filter((line) => /^[-*]\s+/.test(line));
  const currentText = existsSync(current) ? await readFile(current, "utf8") : "# Regression Patterns\n\n";
  const additions = legacyLines.filter((line) => !currentText.includes(line)).map((line) => `${line} [legacy-unverified; review before reuse]`);
  const conflicts = legacyLines.length - additions.length;
  await mkdir(path.dirname(current), { recursive: true });
  const { writeProtectedFile } = await import("../manifest/lock.js");
  await writeProtectedFile(root, current, currentText + (additions.length ? `${additions.join("\n")}\n` : ""));
  const reportPath = path.join(root, ".graphward", "reports", "legacy-regression-pattern-migration.json");
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify({ source: path.relative(root, legacy), destination: path.relative(root, current), migrated: additions.length, conflicts, legacyPreserved: true }, null, 2)}\n`, "utf8");
  return { migrated: additions.length, conflicts, report: path.relative(root, reportPath).replace(/\\/g, "/") };
}

/**
 * Log an uncertainty event or specification ambiguity to the durable events log.
 */
export async function logUncertaintyEvent(
  root: string,
  event: UncertaintyEventInput,
): Promise<{ logged: boolean; id: string }> {
  const dir = eventsDir(root);
  await mkdir(dir, { recursive: true });

  const id = `unc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const record = {
    id,
    timestamp: new Date().toISOString(),
    trigger: event.trigger,
    area: event.area,
    description: event.description,
    severity: event.severity ?? "medium",
    observedReality: event.observedReality,
    resolution: event.resolution,
  };

  const jsonlPath = path.join(dir, "uncertainty-log.jsonl");
  await appendFile(jsonlPath, `${JSON.stringify(record)}\n`, "utf8");

  const mdPath = path.join(dir, "uncertainty-log.md");
  const mdEntry = `\n### [${record.severity.toUpperCase()}] ${record.trigger} (${id})\n- **Area:** ${record.area}\n- **Description:** ${record.description}\n${record.observedReality ? `- **Observed reality:** ${record.observedReality}\n` : ""}${record.resolution ? `- **Resolution:** ${record.resolution}\n` : ""}`;

  if (!existsSync(mdPath)) {
    const initialMd = `# Uncertainty & Ambiguity Event Log\n${mdEntry}`;
    await appendFile(mdPath, initialMd, "utf8");
  } else {
    await appendFile(mdPath, mdEntry, "utf8");
  }

  return { logged: true, id };
}

function parseBullets(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- ") || line.startsWith("* "))
    .map((line) => line.replace(/^[-*]\s+/, ""));
}

function matchesQuery(item: string, queryWords: string[]): boolean {
  if (queryWords.length === 0) return true;
  const lower = item.toLowerCase();
  return queryWords.some((w) => lower.includes(w));
}

/**
 * Query project memory files for conventions, constraints, and regression patterns.
 */
export async function queryProjectMemory(
  root: string,
  query: { file?: string; topic?: string } = {},
): Promise<MemoryQueryResult> {
  const dir = memoryDir(root);
  const queryWords: string[] = [];
  if (query.file) {
    queryWords.push(...query.file.toLowerCase().split(/[\\/._-]+/).filter((w) => w.length > 2));
  }
  if (query.topic) {
    queryWords.push(...query.topic.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  }

  const readLines = async (fileName: string): Promise<string[]> => {
    const full = path.join(dir, fileName);
    try {
      if (!existsSync(full)) return [];
      const text = await readFile(full, "utf8");
      const bullets = parseBullets(text);
      if (queryWords.length === 0) return bullets;
      const matched = bullets.filter((b) => matchesQuery(b, queryWords));
      return matched;
    } catch {
      return [];
    }
  };

  const [conventions, regressions, constraints] = await Promise.all([
    readLines("coding-patterns.md"),
    readLines("regression-patterns.md"),
    readLines("project-constraints.md"),
  ]);

  return {
    constraints,
    conventions,
    regressions,
  };
}
