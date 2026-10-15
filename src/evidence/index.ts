import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

// ---------------------------------------------------------------------------
// Evidence hashing — self-invalidating knowledge ("memory with records").
//
// Every `file:line` citation in the knowledge base points at a specific line of
// code. We hash the content of that line when the knowledge is written; on the
// next check, if the underlying line no longer hashes the same, the citation is
// flagged as *stale* — the knowledge may now be describing code that changed.
// The first AI memory that can tell you when it's out of date, mechanically.
// ---------------------------------------------------------------------------

const REF_EXT = "(?:ts|tsx|js|jsx|mts|cts|mjs|cjs|py|go|rs|rb|java|kt|json|ya?ml|md|sh|toml)";
const CITE_RE = new RegExp("`([^`\\n]+\\." + REF_EXT + "):(\\d+)`", "g");

export interface EvidenceHash {
  citation: string; // "file:line"
  file: string;
  line: number;
  hash: string; // hash of the trimmed line content, or "" if out of range
}

export interface EvidenceSnapshot {
  schemaVersion: 1;
  recordedAt: string;
  hashes: EvidenceHash[];
  documents?: Array<{ path: string; hash: string; citations: string[]; sourceHashes?: Record<string, string> }>;
  sourceHashes?: Record<string, string>;
  /** Per intelligence document: sha256 of each `(evidence: path)` source when the document was last recorded. */
  annotationHashes?: Record<string, Record<string, string>>;
}

const ANNOTATION_RE = /\(evidence:\s*([^)]+)\)/g;
// Model-authored graph JSON cites sources as "evidence": ["src/a.ts:12-40", ...].
const JSON_EVIDENCE_RE = /"evidence"\s*:\s*\[([^\]]*)\]/g;
/** Paths cited by `(evidence: a.ts, b/c.ts:12-40, prose)` annotations or JSON `"evidence"` arrays; prose fragments are ignored. */
export function extractAnnotatedPaths(content: string): string[] {
  const paths = new Set<string>();
  const add = (raw: string) => {
    const token = raw.trim().replace(/[`"]/g, "").replace(/:L?\d[\d,-]*$/, "").trim();
    if (!token || /\s/.test(token)) return;
    if (!token.includes("/") && !/\.\w+$/.test(token)) return;
    paths.add(token);
  };
  for (const match of content.matchAll(new RegExp(ANNOTATION_RE.source, "g"))) for (const raw of match[1].split(",")) add(raw);
  for (const match of content.matchAll(new RegExp(JSON_EVIDENCE_RE.source, "g"))) for (const item of match[1].matchAll(/"([^"]*)"/g)) add(item[1]);
  return [...paths];
}

/**
 * Machine-maintained state, not documentation: each has its own validity check
 * (evidence snapshot, preparation generation, graph workspaceHash), so it is neither
 * scored for freshness nor hash-recorded as a document.
 */
export const MACHINE_ARTIFACTS = new Set(["preparation.json", "initialization-evidence.json", "KNOWLEDGE-GENERATION-BRIEF.md", "dependency-graph.json"]);

/** Intelligence documents (.md and model-authored .json) directly inside one directory. */
export async function listIntelligenceDocuments(dir: string): Promise<string[]> {
  let entries: string[];
  try { entries = await readdir(dir); } catch { return []; }
  return entries
    .filter((name) => !name.startsWith(".") && !MACHINE_ARTIFACTS.has(name) && (name.endsWith(".md") || name.endsWith(".json")))
    .map((name) => path.join(dir, name));
}

/** Intelligence directories whose `(evidence: ...)` sources are hash-recorded for freshness. */
export const ANNOTATED_DOC_DIRS = ["knowledge-base", "memory", "context", "graph"];

export async function readEvidenceSnapshot(root: string): Promise<EvidenceSnapshot | undefined> {
  try { return JSON.parse(await readFile(snapshotPath(root), "utf8")) as EvidenceSnapshot; } catch { return undefined; }
}

export async function hashSourceFile(root: string, file: string): Promise<string | undefined> {
  const relative = path.relative(root, path.resolve(root, file));
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  try { return createHash("sha256").update(await readFile(path.resolve(root, file))).digest("hex"); } catch { return undefined; }
}

async function recordAnnotationHashes(root: string, onlyDocuments?: string[]): Promise<Record<string, Record<string, string>>> {
  const result: Record<string, Record<string, string>> = {};
  for (const dir of ANNOTATED_DOC_DIRS) {
    for (const file of await listIntelligenceDocuments(path.join(root, ".graphward", dir))) {
      const relative = path.relative(root, file).replace(/\\/g, "/");
      if (onlyDocuments && !onlyDocuments.includes(relative)) continue;
      let content: string;
      try { content = await readFile(file, "utf8"); } catch { continue; }
      const hashes: Record<string, string> = {};
      for (const source of extractAnnotatedPaths(content)) {
        const hash = await hashSourceFile(root, source);
        if (hash) hashes[source] = hash;
      }
      result[relative] = hashes;
    }
  }
  return result;
}

export type StaleStatus = "ok" | "stale" | "missing-line" | "missing-file" | "relocated" | "unrecorded";

export interface EvidenceCheck {
  citation: string;
  file: string;
  line: number;
  status: StaleStatus;
  relocatedLine?: number;
  confidence?: number;
}

export interface EvidenceReport {
  checked: number;
  ok: number;
  stale: number;
  relocated?: number;
  results: EvidenceCheck[];
  documents?: Array<{ path: string; verified: boolean; reason?: string }>;
  documentDrift?: number;
}

function kbDir(root: string): string {
  return path.join(root, ".graphward", "knowledge-base");
}

function snapshotPath(root: string): string {
  return path.join(kbDir(root), ".evidence-hashes.json");
}

async function walkMarkdown(dir: string, out: string[] = []): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let s;
    try { s = await stat(full); } catch { continue; }
    if (s.isDirectory()) await walkMarkdown(full, out);
    else if (entry.endsWith(".md")) out.push(full);
  }
  return out;
}

// Hash a specific 1-based line of a file. Returns null if file/line is absent.
async function hashLine(root: string, file: string, line: number, cache: Map<string, string[] | null>): Promise<string | null> {
  let lines = cache.get(file);
  if (lines === undefined) {
    try {
      const content = await readFile(path.resolve(root, file), "utf8");
      lines = content.split("\n");
    } catch {
      lines = null;
    }
    cache.set(file, lines);
  }
  if (lines === null) return null; // missing file
  if (line < 1 || line > lines.length) return ""; // missing line (sentinel)
  return createHash("sha1").update(lines[line - 1].trim()).digest("hex").slice(0, 16);
}

async function collectCitations(root: string, selectedFiles?: string[]): Promise<Array<{ citation: string; file: string; line: number }>> {
  const files = selectedFiles ?? await walkMarkdown(kbDir(root));
  const seen = new Set<string>();
  const out: Array<{ citation: string; file: string; line: number }> = [];
  for (const md of files) {
    let content: string;
    try { content = await readFile(md, "utf8"); } catch { continue; }
    let m: RegExpExecArray | null;
    CITE_RE.lastIndex = 0;
    while ((m = CITE_RE.exec(content)) !== null) {
      const file = m[1].replace(/\\/g, "/");
      const line = parseInt(m[2], 10);
      const citation = `${file}:${line}`;
      if (seen.has(citation)) continue;
      seen.add(citation);
      out.push({ citation, file, line });
    }
  }
  return out;
}

// Record the current hash of every citation's underlying line to a sidecar.
export async function recordEvidenceHashes(root: string, options: { documents?: string[] } = {}): Promise<EvidenceSnapshot> {
  const allFiles = await walkMarkdown(kbDir(root));
  const selected = options.documents ? allFiles.filter(file => options.documents!.includes(path.relative(root, file).replace(/\\/g, "/"))) : allFiles;
  if (options.documents?.some(file => !selected.some(candidate => path.relative(root, candidate).replace(/\\/g, "/") === file))) throw new Error("Evidence recording requires existing canonical knowledge documents.");
  let previous: EvidenceSnapshot | undefined;
  if (options.documents) try { previous = JSON.parse(await readFile(snapshotPath(root), "utf8")); } catch {}
  const citations = await collectCitations(root, selected);
  const cache = new Map<string, string[] | null>();
  const hashes: EvidenceHash[] = [];
  for (const c of citations) {
    const h = await hashLine(root, c.file, c.line, cache);
    hashes.push({ citation: c.citation, file: c.file, line: c.line, hash: h ?? "\u0000" });
  }
  const documents = [];
  for (const file of selected) {
    const content = await readFile(file, "utf8"); CITE_RE.lastIndex = 0;
    documents.push({ path: path.relative(root, file).replace(/\\/g, "/"), hash: createHash("sha256").update(content).digest("hex"), citations: [...content.matchAll(CITE_RE)].map(match => `${match[1].replace(/\\/g, "/")}:${match[2]}`) });
  }
  const sourceHashes: Record<string, string> = {};
  for (const citation of citations) {
    const relative = path.relative(root, path.resolve(root, citation.file));
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    try { sourceHashes[citation.file] = createHash("sha256").update(await readFile(path.resolve(root, citation.file))).digest("hex"); } catch {}
  }
  for (const document of documents) {
    Object.assign(document, { sourceHashes: Object.fromEntries(document.citations.map(citation => { const file = citation.slice(0, citation.lastIndexOf(":")); return [file, sourceHashes[file]]; }).filter((entry): entry is [string, string] => typeof entry[1] === "string")) });
  }
  const selectedPaths = new Set(documents.map(document => document.path));
  const currentCitations = new Set(hashes.map(hash => hash.citation));
  const annotationHashes = { ...previous?.annotationHashes, ...await recordAnnotationHashes(root, options.documents) };
  const snapshot: EvidenceSnapshot = { schemaVersion: 1, recordedAt: new Date().toISOString(), hashes: [...(previous?.hashes ?? []).filter(hash => !currentCitations.has(hash.citation)), ...hashes], documents: [...(previous?.documents ?? []).filter(document => !selectedPaths.has(document.path)), ...documents], sourceHashes: { ...previous?.sourceHashes, ...sourceHashes }, annotationHashes };
  await writeFile(snapshotPath(root), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return snapshot;
}

// Search nearby lines within window for an expected hash.
export function findRelocatedLine(
  lines: string[],
  expectedHash: string,
  originalLine: number,
  window: number = 25,
): { newLine: number; confidence: number } | null {
  if (!lines || lines.length === 0 || !expectedHash) return null;
  const start = Math.max(1, originalLine - window);
  const end = Math.min(lines.length, originalLine + window);

  let bestMatch: { newLine: number; distance: number } | null = null;

  for (let l = start; l <= end; l++) {
    const raw = lines[l - 1];
    const trimmed = raw.trim();
    const isMatch =
      createHash("sha1").update(trimmed).digest("hex").slice(0, 16) === expectedHash ||
      createHash("sha1").update(raw).digest("hex").slice(0, 16) === expectedHash ||
      createHash("sha256").update(trimmed).digest("hex") === expectedHash ||
      createHash("sha256").update(raw).digest("hex") === expectedHash ||
      createHash("sha1").update(trimmed).digest("hex") === expectedHash;

    if (isMatch) {
      const distance = Math.abs(l - originalLine);
      if (!bestMatch || distance < bestMatch.distance) {
        bestMatch = { newLine: l, distance };
        if (distance === 0) break; // Perfect match at original position
      }
    }
  }

  if (!bestMatch) return null;

  const confidence = bestMatch.distance === 0
    ? 1.0
    : Number(Math.max(0.1, 1.0 - (bestMatch.distance / (window + 1)) * 0.3).toFixed(2));

  return { newLine: bestMatch.newLine, confidence };
}

// Re-hash every citation and compare against the recorded snapshot. Citations
// whose underlying line changed are flagged `stale` or `relocated`.
export async function checkEvidenceHashes(root: string): Promise<EvidenceReport> {
  let snapshot: EvidenceSnapshot | null = null;
  try {
    snapshot = JSON.parse(await readFile(snapshotPath(root), "utf8")) as EvidenceSnapshot;
  } catch {
    snapshot = null;
  }
  const recorded = new Map<string, string>();
  if (snapshot) for (const h of snapshot.hashes) recorded.set(h.citation, h.hash);

  const citations = await collectCitations(root);
  const cache = new Map<string, string[] | null>();
  const results: EvidenceCheck[] = [];

  for (const c of citations) {
    const current = await hashLine(root, c.file, c.line, cache);
    let status: StaleStatus;
    let relocatedLine: number | undefined;
    let confidence: number | undefined;

    if (current === null) {
      status = "missing-file";
    } else if (current === "") {
      status = "missing-line";
    } else {
      const prev = recorded.get(c.citation);
      if (prev === undefined) {
        status = "unrecorded";
      } else if (prev === current) {
        status = "ok";
      } else {
        const lines = cache.get(c.file);
        const match = lines ? findRelocatedLine(lines, prev, c.line, 25) : null;
        if (match) {
          status = "relocated";
          relocatedLine = match.newLine;
          confidence = match.confidence;
        } else {
          status = "stale";
        }
      }
    }
    results.push({ citation: c.citation, file: c.file, line: c.line, status, relocatedLine, confidence });
  }

  const ok = results.filter((r) => r.status === "ok").length;
  const relocated = results.filter((r) => r.status === "relocated").length;
  const stale = results.length - ok - relocated;
  const documents = [];
  let documentDrift = 0;
  for (const file of await walkMarkdown(kbDir(root))) {
    const relative = path.relative(root, file).replace(/\\/g, "/");
    const recordedDoc = snapshot?.documents?.find(item => item.path === relative);
    // The first failing check names the reason, so the fix is obvious: record, cite, or re-verify.
    let reason: string | undefined;
    if (!recordedDoc) reason = "Document has no evidence snapshot; run `gw evidence-record .` after verifying it.";
    else if (recordedDoc.citations.length === 0) reason = "Document cites no source lines, so nothing can verify it.";
    else if (recordedDoc.hash !== createHash("sha256").update(await readFile(file)).digest("hex")) reason = "Document changed since its snapshot; re-verify it and run `gw evidence-record .`.";
    if (recordedDoc && !reason) for (const citation of recordedDoc.citations) {
      const result = results.find(item => item.citation === citation);
      if (!result || result.status !== "ok") { reason = `Citation ${citation} is ${result?.status ?? "missing"}.`; break; }
      if (!recordedDoc.sourceHashes?.[result.file]) { reason = `Snapshot lacks a hash for cited source ${result.file}; run \`gw evidence-record .\`.`; break; }
      let current: string | undefined;
      try { current = createHash("sha256").update(await readFile(path.resolve(root, result.file))).digest("hex"); } catch {}
      if (recordedDoc.sourceHashes[result.file] !== current) { reason = `Cited source ${result.file} changed since the snapshot.`; break; }
    }
    const verified = !reason;
    if (recordedDoc && recordedDoc.citations.length > 0 && !verified) documentDrift++;
    documents.push({ path: relative, verified, ...(reason ? { reason } : {}) });
  }
  return { checked: results.length, ok, stale, relocated, results, documents, documentDrift };
}

export function renderEvidenceReport(report: EvidenceReport): string {
  const lines: string[] = [];
  lines.push("Evidence freshness (self-invalidating knowledge)");
  const relStr = report.relocated ? `, ${report.relocated} relocated` : "";
  lines.push(`  Checked ${report.checked} citation(s): ${report.ok} ok${relStr}, ${report.stale} stale/broken.`);
  for (const r of report.results) {
    if (r.status === "ok") continue;
    const label =
      r.status === "relocated"
        ? `relocated to line ${r.relocatedLine} (confidence ${r.confidence})`
        : r.status === "stale"
          ? "line content changed"
          : r.status === "missing-line"
            ? "line no longer exists"
            : "file removed";
    lines.push(`    ${r.status === "relocated" ? "~" : "✗"} \`${r.citation}\` — ${label}`);
  }
  if (report.stale === 0) lines.push("  ✓ Every cited line still matches what the knowledge base recorded.");
  return lines.join("\n") + "\n";
}
