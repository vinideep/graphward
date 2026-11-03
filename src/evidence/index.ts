import { readFile, writeFile, readdir, stat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { ProjectFilePolicy, containedFilePath } from "../project-files/index.js";

// ---------------------------------------------------------------------------
// Evidence hashing — self-invalidating knowledge ("memory with records").
//
// Every `file:line` citation in the knowledge base points at a specific line of
// code. We hash the content of that line when the knowledge is written; on the
// next check, if the underlying line no longer hashes the same, the citation is
// flagged as *stale* — the knowledge may now be describing code that changed.
// The first AI memory that can tell you when it's out of date, mechanically.
// ---------------------------------------------------------------------------

// Recognize citations only inside explicit evidence/reference contexts. A bounded
// span is expanded to line citations so interior edits retain the legacy hashes.
const REF_PATH = /(?:[A-Za-z]:)?(?:[A-Za-z0-9_@.\/~+()[\]-]+\.(?:tsx?|jsx?|mts|cts|mjs|cjs|py|go|rs|rb|java|kt|jsonl?|ya?ml|md|sh|toml|txt|sql|xml|log|ini|cfg|conf|lock|c|cpp|cxx|h|hpp|hxx|cs|swift|scala|vue|svelte|tf)|(?:[A-Za-z0-9_@.\/~+()[\]-]+\/)?(?:Dockerfile|Makefile))(?![A-Za-z0-9_.])(?::[^\s`";|)\]]+(?:\s*,\s*L?\d+(?:-L?\d+)?)*)?/g;
// Runtime credentials are examples of excluded inputs, never admitted evidence.
function excludedEvidencePath(file: string): boolean {
  return /(?:^|\/)\.env(?:\.|$)|(?:^|\/)(?:id_rsa|id_ed25519|credentials)(?:\.[^/]*)?$|(?:^|\/)(?:secrets?|tokens?)(?:\.(?:json|jsonl|ya?ml|txt|env|db|sqlite|sqlite3))?$|\.(?:pem|key|p12|pfx|db|sqlite|sqlite3)$/i.test(file);
}

function annotationFragments(content: string): string[] {
  const fragments: string[] = [];
  for (const match of content.matchAll(/\(evidence:\s*/g)) {
    let depth = 1, end = match.index! + match[0].length;
    const start = end;
    for (; end < content.length && depth > 0; end++) {
      if (content[end] === "(") depth++;
      else if (content[end] === ")") depth--;
    }
    if (depth === 0) fragments.push(content.slice(start, end - 1));
  }
  return fragments;
}

const MAX_SPAN_LINES = 4096;
const MAX_DOCUMENT_LINES = 16384;
interface CitationReference { citation: string; file: string; line: number }

function parseReferences(content: string, annotationsOnly = false): CitationReference[] {
  const fragments = annotationFragments(content);
  const explicitFragments = new Set(fragments);
  for (const match of content.matchAll(/"evidence"\s*:\s*(\[(?:\s*"(?:\\.|[^"\\])*"\s*,?)*\s*\])/g)) {
    let values: unknown;
    try { values = JSON.parse(match[1]); } catch { continue; }
    if (Array.isArray(values)) for (const value of values) if (typeof value === "string") { fragments.push(value); explicitFragments.add(value); }
  }
  if (!annotationsOnly) {
    for (const match of content.matchAll(/`([^`\n]+)`/g)) fragments.push(match[1]);
    let referenceSection = false;
    let referenceColumns: number[] = [];
    for (const line of content.split("\n")) {
      if (/^#{1,6}\s+/.test(line)) referenceSection = /^#{1,6}\s+(?:Sources?|References?|Evidence)\b/i.test(line);
      if (!line.trim().startsWith("|")) referenceColumns = [];
      const cells = line.split("|").map(cell => cell.trim());
      const columns = cells.map((cell, index) => /^(?:Sources?|References?|Evidence)$/i.test(cell) ? index : -1).filter(index => index >= 0);
      if (columns.length) referenceColumns = columns;
      if (referenceColumns.length) {
        for (const index of referenceColumns) if (cells[index]) { fragments.push(cells[index]); explicitFragments.add(cells[index]); }
      } else if (referenceSection || /(?:^|\|)\s*(?:Sources?|References?|Evidence)\s*:/i.test(line)) { fragments.push(line); explicitFragments.add(line); }
    }
  }
  const references = new Map<string, CitationReference>();
  let expanded = 0;
  const seenTokens = new Set<string>();
  for (const fragment of fragments) {
    // URLs are external data, never repository citations.
    const text = fragment.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s`]+/gi, "");
    for (const match of text.matchAll(new RegExp(REF_PATH.source, "g"))) {
      const token = match[0].replace(/,+$/, "");
      if (seenTokens.has(token)) continue;
      seenTokens.add(token);
      const locator = token.match(/:(?![\\/])(.+)$/);
      const file = (locator ? token.slice(0, locator.index) : token).replace(/\\/g, "/");
      if (!file || file === "." || file.endsWith("/") || excludedEvidencePath(file)) continue;
      const add = (line: number, citation = line === 0 ? file : `${file}:${line}`) => references.set(citation, { citation, file, line });
      if (!locator) {
        if (!explicitFragments.has(fragment) && !file.includes("/") && !/^(?:package(?:-lock)?\.json|README\.md|tsconfig(?:\.[\w-]+)?\.json)$/i.test(file)) continue;
        add(0); continue;
      }
      const spans = locator[1].split(/\s*,\s*/);
      const parsed: Array<[number, number]> = [];
      let total = 0;
      let valid = true;
      for (const span of spans) {
        const numbers = span.match(/^L?(\d+)(?:-L?(\d+))?$/);
        if (!numbers) { valid = false; break; }
        const start = Number(numbers[1]), end = Number(numbers[2] ?? numbers[1]);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start + 1 > MAX_SPAN_LINES) { valid = false; break; }
        total += end - start + 1;
        parsed.push([start, end]);
      }
      if (!valid || expanded + total > MAX_DOCUMENT_LINES) { add(-1, `${file}:invalid:${locator[1]}`); continue; }
      expanded += total;
      for (const [start, end] of parsed) for (let line = start; line <= end; line++) add(line);
    }
  }
  return [...references.values()];
}

/** Only explicit, contained directory-pointer guides can be non-material. */
async function navigationOnly(root: string, content: string): Promise<boolean> {
  if (!content.includes("<!-- graphward: navigation-only -->")) return false;
  const pointers: string[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim() || /^\s*<!-- graphward: navigation-only -->\s*$/.test(line)) continue;
    if (/^\s*#{1,6}\s+(?:Navigation|Contents|Index|Directory (?:map|pointers)|Source navigation|Repository navigation)\s*$/i.test(line)) continue;
    const pointer = line.match(/^\s*[-*]\s+`([\w./-]+\/)`\s*$/);
    if (!pointer) return false;
    pointers.push(pointer[1]);
  }
  if (!pointers.length) return false;
  const canonicalRoot = await realpath(root);
  for (const pointer of pointers) {
    const lexical = path.relative(path.resolve(root), path.resolve(root, pointer));
    if (lexical === ".." || lexical.startsWith(`..${path.sep}`) || path.isAbsolute(lexical)) return false;
    try {
      const target = await realpath(path.resolve(root, pointer));
      const relative = path.relative(canonicalRoot, target);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !(await stat(target)).isDirectory()) return false;
    } catch { return false; }
  }
  return true;
}

export interface EvidenceHash {
  citation: string; // "file:line", or "file" for a whole-file source hash
  file: string;
  line: number; // 0 for whole-file evidence; negative for a rejected span
  hash: string; // legacy line hash or SHA256 whole-file hash; empty if out of range
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

/** Explicit annotation paths, parsed by the same grammar as citation recording. */
export function extractAnnotatedPaths(content: string): string[] {
  return [...new Set(parseReferences(content, true).map(reference => reference.file))];
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

async function containedSource(root: string, file: string, policy: ProjectFilePolicy): Promise<string | undefined> {
  const absolute = path.resolve(root, file);
  const relative = path.relative(path.resolve(root), absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  if (excludedEvidencePath(file)) return undefined;
  const decision = policy.explain(relative);
  // Canonical intelligence may cite its own validated reports. Provider caches,
  // generated adapters, dependency trees and explicit policy exclusions cannot.
  const canonicalArtifact = /^\.graphward\/(?:knowledge-base|memory|context|graph|reports|changes|aidlc)\/.+\.(?:md|json|jsonl|log|xml|txt)$/.test(relative.replace(/\\/g, "/"));
  if (!decision.included && !(canonicalArtifact && decision.source === "safety" && decision.pattern === ".graphward/")) return undefined;
  try {
    const [canonicalRoot, canonicalFile] = await Promise.all([realpath(root), realpath(absolute)]);
    const resolved = path.relative(canonicalRoot, canonicalFile);
    if (resolved === ".." || resolved.startsWith(`..${path.sep}`) || path.isAbsolute(resolved) || excludedEvidencePath(resolved.replace(/\\/g, "/"))) return undefined;
    const resolvedDecision = policy.explain(resolved);
    const resolvedArtifact = /^\.graphward\/(?:knowledge-base|memory|context|graph|reports|changes|aidlc)\/.+\.(?:md|json|jsonl|log|xml|txt)$/.test(resolved.replace(/\\/g, "/"));
    if (!resolvedDecision.included && !(resolvedArtifact && resolvedDecision.source === "safety" && resolvedDecision.pattern === ".graphward/")) return undefined;
    return canonicalFile;
  } catch { return undefined; }
}

// Per-operation caches: never reuse source trust across recording/check runs.
function sourceAccess(root: string) {
  const policy = ProjectFilePolicy.load(root);
  const sources = new Map<string, Promise<string | undefined>>();
  const hashes = new Map<string, Promise<string | undefined>>();
  const source = (file: string) => {
    if (!sources.has(file)) sources.set(file, policy.then(value => containedSource(root, file, value)));
    return sources.get(file)!;
  };
  const hash = (file: string) => {
    if (!hashes.has(file)) hashes.set(file, (async () => {
      const resolved = await source(file);
      if (!resolved) return undefined;
      try { return createHash("sha256").update(await readFile(resolved)).digest("hex"); } catch { return undefined; }
    })());
    return hashes.get(file)!;
  };
  return { source, hash };
}

export async function hashSourceFile(root: string, file: string): Promise<string | undefined> {
  return sourceAccess(root).hash(file);
}

async function recordAnnotationHashes(root: string, onlyDocuments?: string[], access = sourceAccess(root)): Promise<Record<string, Record<string, string>>> {
  const result: Record<string, Record<string, string>> = {};
  for (const dir of ANNOTATED_DOC_DIRS) {
    for (const file of await listIntelligenceDocuments(path.join(root, ".graphward", dir))) {
      const relative = path.relative(root, file).replace(/\\/g, "/");
      if (onlyDocuments && !onlyDocuments.includes(relative)) continue;
      let content: string;
      try { content = await readFile(file, "utf8"); } catch { continue; }
      const hashes: Record<string, string> = {};
      for (const source of extractAnnotatedPaths(content)) {
        const hash = await access.hash(source);
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
  documents?: Array<{ path: string; verified: boolean; reason?: string; navigationOnly?: boolean }>;
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
async function hashLine(root: string, file: string, line: number, cache: Map<string, string[] | null>, access = sourceAccess(root)): Promise<string | null> {
  let lines = cache.get(file);
  if (lines === undefined) {
    try {
      const source = await access.source(file);
      if (!source) { cache.set(file, null); return null; }
      const content = await readFile(source, "utf8");
      lines = content.split("\n");
    } catch {
      lines = null;
    }
    cache.set(file, lines);
  }
  if (lines === null) return null; // missing file
  if (line === 0) return await access.hash(file) ?? null;
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
    for (const reference of parseReferences(content)) {
      if (seen.has(reference.citation)) continue;
      seen.add(reference.citation);
      out.push(reference);
    }
  }
  return out;
}

// Record the current hash of every citation's underlying line to a sidecar.
export async function recordEvidenceHashes(root: string, options: { documents?: string[]; annotationDocuments?: string[] } = {}): Promise<EvidenceSnapshot> {
  const scoped = options.documents !== undefined || options.annotationDocuments !== undefined;
  const allFiles = await walkMarkdown(kbDir(root));
  const selected = options.documents ? allFiles.filter(file => options.documents!.includes(path.relative(root, file).replace(/\\/g, "/"))) : scoped ? [] : allFiles;
  if (options.documents?.some(file => !selected.some(candidate => path.relative(root, candidate).replace(/\\/g, "/") === file))) throw new Error("Evidence recording requires existing canonical knowledge documents.");
  const annotationDocuments = scoped ? [...new Set([...(options.documents ?? []), ...(options.annotationDocuments ?? [])])] : undefined;
  if (options.annotationDocuments) {
    const canonical = new Set<string>();
    for (const directory of ANNOTATED_DOC_DIRS) for (const file of await listIntelligenceDocuments(path.join(root, ".graphward", directory))) canonical.add(path.relative(root, file).replace(/\\/g, "/"));
    for (const document of options.annotationDocuments) {
      if (!canonical.has(document)) throw new Error(`Annotation recording requires an existing canonical intelligence document: ${document}`);
      await containedFilePath(root, document);
    }
  }
  let previous: EvidenceSnapshot | undefined;
  if (scoped) try { previous = JSON.parse(await readFile(snapshotPath(root), "utf8")); } catch {}
  const citations = await collectCitations(root, selected);
  const cache = new Map<string, string[] | null>();
  const access = sourceAccess(root);
  const hashes: EvidenceHash[] = [];
  for (const c of citations) {
    const h = await hashLine(root, c.file, c.line, cache, access);
    hashes.push({ citation: c.citation, file: c.file, line: c.line, hash: h ?? "\u0000" });
  }
  const documents = [];
  for (const file of selected) {
    const content = await readFile(file, "utf8");
    documents.push({ path: path.relative(root, file).replace(/\\/g, "/"), hash: createHash("sha256").update(content).digest("hex"), citations: parseReferences(content).map(reference => reference.citation) });
  }
  const sourceHashes: Record<string, string> = {};
  for (const citation of citations) {
    if (sourceHashes[citation.file]) continue;
    const hash = await access.hash(citation.file);
    if (hash) sourceHashes[citation.file] = hash;
  }
  for (const document of documents) {
    const documentCitations = new Set(document.citations);
    Object.assign(document, { sourceHashes: Object.fromEntries(citations.filter(citation => documentCitations.has(citation.citation) && sourceHashes[citation.file]).map(citation => [citation.file, sourceHashes[citation.file]])) });
  }
  const selectedPaths = new Set(documents.map(document => document.path));
  const currentCitations = new Set(hashes.map(hash => hash.citation));
  const annotationHashes = { ...previous?.annotationHashes, ...await recordAnnotationHashes(root, annotationDocuments, access) };
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
  const access = sourceAccess(root);
  const results: EvidenceCheck[] = [];

  for (const c of citations) {
    const current = await hashLine(root, c.file, c.line, cache, access);
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
        const match = c.line > 0 && lines ? findRelocatedLine(lines, prev, c.line, 25) : null;
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
  const resultsByCitation = new Map(results.map(result => [result.citation, result]));
  const checkedSourceHashes = new Map<string, string | undefined>();
  let documentDrift = 0;
  for (const file of await walkMarkdown(kbDir(root))) {
    const relative = path.relative(root, file).replace(/\\/g, "/");
    const content = await readFile(file, "utf8");
    if (await navigationOnly(root, content)) { documents.push({ path: relative, verified: true, navigationOnly: true, reason: "Explicit directory-pointer guide; no material source claims." }); continue; }
    const recordedDoc = snapshot?.documents?.find(item => item.path === relative);
    // The first failing check names the reason, so the fix is obvious: record, cite, or re-verify.
    let reason: string | undefined;
    if (!recordedDoc) reason = "Document has no evidence snapshot; run `gw evidence-record .` after verifying it.";
    else if (recordedDoc.citations.length === 0) reason = "Document cites no source evidence, so nothing can verify it.";
    else if (recordedDoc.hash !== createHash("sha256").update(await readFile(file)).digest("hex")) reason = "Document changed since its snapshot; re-verify it and run `gw evidence-record .`.";
    if (recordedDoc && !reason) for (const citation of recordedDoc.citations) {
      const result = resultsByCitation.get(citation);
      if (!result || result.status !== "ok") { reason = `Citation ${citation} is ${result?.status ?? "missing"}.`; break; }
      if (!recordedDoc.sourceHashes?.[result.file]) { reason = `Snapshot lacks a hash for cited source ${result.file}; run \`gw evidence-record .\`.`; break; }
      if (!checkedSourceHashes.has(result.file)) checkedSourceHashes.set(result.file, await access.hash(result.file));
      const current = checkedSourceHashes.get(result.file);
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
