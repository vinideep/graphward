/**
 * Verification receipts.
 *
 * The Stop hook previously decided "was this change validated?" by regex-matching
 * the agent's shell history. That was defeatable to the point of being theatre:
 * `rm -rf build`, `ls build`, `cat x.test.mjs` and `git commit -m "add tests"`
 * all matched, so an agent satisfied the gate within its first few tool calls,
 * permanently, for the whole session. It also credited FAILING commands, because
 * the host's Bash payload carries no success flag.
 *
 * A receipt replaces belief with evidence. `runVerification` actually executes
 * the project's own check commands, records their real exit codes, and binds the
 * result to the exact bytes it verified — a sha256 per changed file. A receipt
 * only satisfies the gate while every one of those files still hashes the same,
 * so editing a file after validating it invalidates the receipt automatically.
 *
 * Changed files come from `git status --porcelain` rather than the hook's own
 * bookkeeping, so edits made via `sed -i`, `patch`, a subagent, or any tool the
 * PostToolUse matcher never saw are still covered.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { runProcess } from "../process/index.js";

export const RECEIPT_SCHEMA_VERSION = 1;
const RECEIPT_DIR = ".graphward/.verify";
const RECORD_FILE = "verification-records.json";
const LEGACY_RECEIPT_FILE = "receipts.json";
const MAX_RECEIPTS = 20;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export interface CommandRun {
  command: string;
  exitCode: number;
  durationMs: number;
  /** Tail of combined output, for the failure message. Truncated. */
  outputTail?: string;
}

export interface VerificationRecord {
  schemaVersion: number;
  createdAt: string;
  /** git HEAD at verification time, or null outside a repo. */
  head: string | null;
  commands: CommandRun[];
  /** relative path -> sha256 of the bytes that were verified. */
  files: Record<string, { hash: string; provenance?: 'human' | 'agent' | 'unknown' } | string>; // updated in task 5 later, keep compat string
  /**
   * False when git could not enumerate the change set, so `files` is not a
   * complete record of what was verified. Coverage then degrades to an mtime
   * comparison — weaker than hashing, and labelled as such rather than pretending.
   */
  gitAvailable: boolean;
  verdict: "pass" | "fail";
  verificationHash?: string;
  provenance?: 'human' | 'agent' | 'unknown';
}

/** @deprecated Use VerificationRecord instead */
export type Receipt = VerificationRecord;

export interface VerifyOptions {
  /** Explicit commands to run. Overrides detection. */
  commands?: string[];
  timeoutMs?: number;
  impactOnly?: boolean;
  changedFiles?: string[];
  provenance?: 'human' | 'agent' | 'unknown';
}

// ---------------------------------------------------------------------------
// Hashing and change detection
// ---------------------------------------------------------------------------

export function hashContent(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function hashFile(root: string, relPath: string): Promise<string | null> {
  try {
    return hashContent(await readFile(path.join(root, relPath)));
  } catch {
    return null; // deleted between detection and hashing
  }
}

async function fileMtime(root: string, relPath: string): Promise<number | null> {
  try {
    const { stat } = await import("node:fs/promises");
    return (await stat(path.join(root, relPath))).mtimeMs;
  } catch {
    return null;
  }
}

async function git(root: string, args: string[]): Promise<string | null> {
  const result = await runProcess({ command: "git", args, cwd: root, maxBuffer: 10 * 1024 * 1024 });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/**
 * Files modified relative to HEAD, including untracked. Porcelain v1 format:
 * `XY path` (rename entries carry ` -> `, where the post-rename path is what exists).
 *
 * `-uall` is essential: the default collapses an untracked directory to a single
 * `src/` entry, so a brand-new source file would never be seen — and the gate
 * would pass a change it never verified.
 */
export async function changedFiles(root: string): Promise<string[]> {
  const out = await git(root, ["status", "--porcelain", "-uall"]);
  if (out === null) return [];
  const files: string[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    let p = line.slice(3).trim();
    const arrow = p.indexOf(" -> ");
    if (arrow >= 0) p = p.slice(arrow + 4);
    if (p.startsWith('"') && p.endsWith('"')) {
      try { p = JSON.parse(p) as string; } catch { /* keep raw */ }
    }
    // Never record our own state in a receipt — it would invalidate itself.
    if (p.startsWith(".graphward/")) continue;
    files.push(p);
  }
  return files;
}

// ---------------------------------------------------------------------------
// Command discovery
// ---------------------------------------------------------------------------

/** The project's own check commands, in the order they should run. */
export async function detectCheckCommands(root: string): Promise<string[]> {
  const commands: string[] = [];
  try {
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    // Prefer a single aggregate check when the project defines one.
    for (const key of ["check", "ci"]) {
      if (scripts[key]) return [`npm run ${key}`];
    }
    for (const key of ["typecheck", "type-check", "lint", "test"]) {
      if (scripts[key]) commands.push(key === "test" ? "npm test" : `npm run ${key}`);
    }
    if (commands.length > 0) return commands;
  } catch { /* not a node project */ }

  for (const [marker, cmd] of [
    ["pyproject.toml", "pytest"],
    ["setup.cfg", "pytest"],
    ["tox.ini", "pytest"],
    ["Cargo.toml", "cargo test"],
    ["go.mod", "go test ./..."],
    ["Gemfile", "bundle exec rspec"],
  ] as const) {
    try { await readFile(path.join(root, marker), "utf8"); return [cmd]; } catch { /* next */ }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Receipt storage
// ---------------------------------------------------------------------------

function recordPath(root: string): string {
  return path.join(root, RECEIPT_DIR, RECORD_FILE);
}

function legacyReceiptPath(root: string): string {
  return path.join(root, RECEIPT_DIR, LEGACY_RECEIPT_FILE);
}

export async function readRecords(root: string): Promise<VerificationRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(recordPath(root), "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as VerificationRecord[]) : [];
  } catch {
    try {
      const parsed = JSON.parse(await readFile(legacyReceiptPath(root), "utf8")) as unknown;
      return Array.isArray(parsed) ? (parsed as VerificationRecord[]) : [];
    } catch {
      return [];
    }
  }
}

/** @deprecated Use readRecords instead */
export const readReceipts = readRecords;

async function ensureGitignored(root: string): Promise<void> {
  const gitignorePath = path.join(root, ".graphward", ".gitignore");
  let existing = "";
  try { existing = await readFile(gitignorePath, "utf8"); } catch { /* new file */ }
  if (!existing.includes(".verify/")) {
    await mkdir(path.dirname(gitignorePath), { recursive: true });
    const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
    await writeFile(gitignorePath, `${existing}${prefix}.verify/\n`, "utf8");
  }
}

export async function writeRecord(root: string, record: VerificationRecord): Promise<void> {
  await ensureGitignored(root);
  const all = [record, ...(await readRecords(root))].slice(0, MAX_RECEIPTS);
  const { writeProtectedFile } = await import("../manifest/lock.js");
  await writeProtectedFile(root, recordPath(root), JSON.stringify(all, null, 2));
}

/** @deprecated Use writeRecord instead */
export const writeReceipt = writeRecord;

// ---------------------------------------------------------------------------
// Coverage check — the question the Stop gate actually asks
// ---------------------------------------------------------------------------

export interface CoverageResult {
  covered: boolean;
  /** Files with no passing receipt matching their current bytes. */
  uncovered: string[];
  agentOnly?: boolean;
  record?: VerificationRecord;
  /** @deprecated Use record instead */
  receipt?: VerificationRecord;
}

/**
 * Is there a passing receipt whose recorded digests still match the CURRENT bytes
 * of every file in `files`? Hash equality is the whole point: a receipt earned
 * before an edit cannot vouch for the file after it.
 */
export async function coverageFor(root: string, files: string[]): Promise<CoverageResult> {
  if (files.length === 0) return { covered: true, uncovered: [] };

  const current = new Map<string, string>();
  for (const f of files) {
    const h = await hashFile(root, f);
    if (h) current.set(f, h);
  }
  if (current.size === 0) return { covered: true, uncovered: [] };

  const records = await readRecords(root);
  for (const record of records) {
    if (record.verdict !== "pass") continue;

    if (record.gitAvailable === false) {
      const verifiedAt = Date.parse(record.createdAt);
      const mtimes = await Promise.all(files.map((f) => fileMtime(root, f)));
      if (Number.isFinite(verifiedAt) && mtimes.every((m) => m !== null && m <= verifiedAt)) {
        let agentOnly = false;
        if (record.provenance === "agent") {
          agentOnly = true;
          for (const other of records) {
            if (other !== record && other.verdict === "pass" && other.provenance === "human" && other.gitAvailable === false) {
              const otherVerifiedAt = Date.parse(other.createdAt);
              if (Number.isFinite(otherVerifiedAt) && mtimes.every((m) => m !== null && m <= otherVerifiedAt)) {
                agentOnly = false;
                break;
              }
            }
          }
        }
        return { covered: true, uncovered: [], agentOnly, record, receipt: record };
      }
      continue;
    }

    const missing = [...current.entries()].filter(([f, h]) => {
      const fData = record.files[f];
      const hData = typeof fData === 'string' ? fData : fData?.hash;
      return hData !== h;
    }).map(([f]) => f);
    
    if (missing.length === 0) {
      let agentOnly = false;
      if (record.provenance === "agent") {
        agentOnly = true;
        for (const other of records) {
          if (other !== record && other.verdict === "pass" && other.provenance === "human") {
            let otherMissing = false;
            for (const [f, h] of current.entries()) {
              const fData = other.files[f];
              const hData = typeof fData === 'string' ? fData : fData?.hash;
              if (hData !== h) {
                otherMissing = true;
                break;
              }
            }
            if (!otherMissing) {
              agentOnly = false;
              break;
            }
          }
        }
      }
      return { covered: true, uncovered: [], agentOnly, record, receipt: record };
    }
  }

  // Report against the most recent passing receipt for a useful message.
  const latestPass = (await readRecords(root)).find((r) => r.verdict === "pass");
  const uncovered = [...current.entries()]
    .filter(([f, h]) => {
      if (!latestPass) return true;
      const fData = latestPass.files[f];
      const hData = typeof fData === 'string' ? fData : fData?.hash;
      return hData !== h;
    })
    .map(([f]) => f);
  return { covered: false, uncovered };
}

// ---------------------------------------------------------------------------
// Running verification
// ---------------------------------------------------------------------------

async function runOne(root: string, command: string, timeoutMs: number): Promise<CommandRun> {
  const started = Date.now();
  // Verification commands are explicitly configured project commands. Invoke
  // the platform shell as an argument-array process so all subprocesses still
  // flow through the shared timeout/output/error contract.
  const shell = process.platform === "win32"
    ? { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", command], windowsVerbatimArguments: true }
    : { command: "/bin/sh", args: ["-c", command] };
  const result = await runProcess({ ...shell, cwd: root, timeoutMs, maxBuffer: 20 * 1024 * 1024 });
  return {
    command,
    exitCode: result.exitCode,
    durationMs: Date.now() - started,
    outputTail: `${result.stdout}${result.stderr}`.slice(-800) || undefined,
  };
}

export interface VerifyResult {
  record: VerificationRecord;
  /** @deprecated Use record instead */
  receipt: VerificationRecord;
  /** True when there was nothing to verify (no commands discovered). */
  noCommands: boolean;
}

/**
 * Execute the project's checks and write a receipt binding the outcome to the
 * exact bytes verified. Hashes are captured AFTER the commands run, so a receipt
 * always describes the tree the checks actually saw.
 */
export async function runVerification(root: string, options: VerifyOptions = {}): Promise<VerifyResult> {
  let commands = options.commands?.length ? options.commands : await detectCheckCommands(root);
  const originalCommandsLength = commands.length;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const impactOnly = options.impactOnly ?? true;

  if (impactOnly && options.changedFiles) {
    try {
      const graphData = await readFile(path.join(root, ".graphward", "graph", "dependency-graph.json"), "utf8");
      const graph = JSON.parse(graphData);
      const { computeTestImpact } = await import("./impact.js");
      const impact = computeTestImpact(options.changedFiles, graph);
      if (impact.affectedTests.length > 0) {
        // Replace npm test with direct node --test invocation using only
        // affected files. npm test in many projects hardcodes a file list
        // that can't be overridden via --, so we bypass it entirely.
        commands = commands.map(cmd => {
          if (cmd === "npm test" || cmd.startsWith("npm test ")) {
            return `node --test ${impact.affectedTests.join(" ")}`;
          }
          return cmd;
        });
      } else {
        commands = commands.filter(cmd => cmd !== "npm test");
      }
    } catch {
      // ignore graph load failures
    }
  }

  const runs: CommandRun[] = [];
  for (const command of commands) {
    const run = await runOne(root, command, timeoutMs);
    runs.push(run);
    if (run.exitCode !== 0) break; // stop at first failure — the tree is not verified
  }

  const inGitRepo = (await git(root, ["rev-parse", "--is-inside-work-tree"])) === "true";
  const files: Record<string, string> = {};
  for (const rel of await changedFiles(root)) {
    const h = await hashFile(root, rel);
    if (h) files[rel] = h;
  }

  const head = await git(root, ["rev-parse", "HEAD"]);
  
  try {
    const graphData = await readFile(path.join(root, ".graphward", "graph", "dependency-graph.json"), "utf8");
    const graph = JSON.parse(graphData);
    const { detectCoverageGaps, generateCharacterizationTests } = await import("../coverage-gap/index.js");
    const changedFileList = Object.keys(files);
    const gaps = detectCoverageGaps(changedFileList, graph);
    if (gaps.length > 0) {
      console.warn(`[Coverage Gap] Found ${gaps.length} uncovered exported symbols in verified files.`);
      const tests = generateCharacterizationTests(gaps, root);
      for (const test of tests) {
        if (!process.env.TEST_ENV) {
          try {
             await readFile(path.join(root, test.testFile), "utf8");
          } catch {
             const { writeProtectedFile } = await import("../manifest/lock.js");
             await writeProtectedFile(root, path.join(root, test.testFile), test.content);
             console.warn(`[Coverage Gap] Generated characterization test: ${test.testFile}`);
          }
        }
      }
    }
  } catch {
    // ignore
  }

  const verificationHash = hashContent(JSON.stringify({
    commands: runs.map(r => ({command: r.command, exitCode: r.exitCode})),
    head
  }));

  let verdict: "pass" | "fail" = (originalCommandsLength > 0 && runs.every((r) => r.exitCode === 0)) ? "pass" : "fail";

  if (verdict === "pass" && (options.provenance === "agent" || options.provenance == null)) {
    const currentFiles = Object.keys(files);
    if (currentFiles.length > 0) {
      let isAgentOnly = true;
      const records = await readRecords(root);
      for (const other of records) {
        if (other.verdict === "pass" && other.provenance === "human") {
          let otherMissing = false;
          for (const [f, h] of Object.entries(files)) {
            const fData = other.files[f];
            const hData = typeof fData === 'string' ? fData : fData?.hash;
            if (hData !== h) {
              otherMissing = true;
              break;
            }
          }
          if (!otherMissing) {
            isAgentOnly = false;
            break;
          }
        }
      }
      if (isAgentOnly) {
        verdict = "fail";
        runs.push({ command: "agent-provenance", exitCode: 1, durationMs: 0, outputTail: "GraphWard: The verification record was generated solely by an agent (agentOnly). Agent-generated checks require human review/verification before proceeding." });
      }
    }
  }

  const record: VerificationRecord = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    head,
    commands: runs,
    files,
    gitAvailable: inGitRepo,
    verdict,
    verificationHash,
    provenance: options.provenance ?? "agent"
  };

  await writeRecord(root, record);
  return { record, receipt: record, noCommands: originalCommandsLength === 0 };
}

// ---------------------------------------------------------------------------
// Knowledge-base reference verification
// ---------------------------------------------------------------------------

export interface KnowledgeVerificationReport {
  filesScanned: number;
  referencesChecked: number;
  drift: number;
  details: Array<{ file: string; reference: string; exists: boolean }>;
}

export async function verifyKnowledge(root: string): Promise<KnowledgeVerificationReport> {
  const kb = path.join(root, ".graphward", "knowledge-base");
  let files: string[] = [];
  try {
    const entries = await readdir(kb);
    files = entries.filter((e) => e.endsWith(".md")).map((e) => path.join(kb, e));
  } catch {
    return { filesScanned: 0, referencesChecked: 0, drift: 0, details: [] };
  }

  const refRegex = /\`([\w./\-]+\.(?:ts|tsx|js|mjs|cjs|py|go|rs|rb|java|kt|json|md|toml|yml|yaml))(?::\d+)?\`/g;
  let referencesChecked = 0;
  let drift = 0;
  const details: Array<{ file: string; reference: string; exists: boolean }> = [];
  const checkedRefs = new Set<string>();

  for (const f of files) {
    try {
      const content = await readFile(f, "utf8");
      let match: RegExpExecArray | null;
      refRegex.lastIndex = 0;
      while ((match = refRegex.exec(content)) !== null) {
        const refPath = match[1];
        if (checkedRefs.has(refPath)) continue;
        checkedRefs.add(refPath);
        referencesChecked++;
        const targetPath = path.resolve(root, refPath);
        let exists = false;
        try {
          await readFile(targetPath);
          exists = true;
        } catch {
          exists = false;
        }
        if (!exists) {
          drift++;
          details.push({ file: path.relative(root, f), reference: refPath, exists: false });
        }
      }
    } catch {
      // ignore
    }
  }

  return {
    filesScanned: files.length,
    referencesChecked,
    drift,
    details,
  };
}

export function renderVerifyReport(report: KnowledgeVerificationReport): string {
  const lines: string[] = ["Knowledge base reference verification", ""];
  lines.push(`Scanned ${report.filesScanned} file(s), checked ${report.referencesChecked} reference(s).`);
  if (report.drift === 0) {
    lines.push("✓ All knowledge-base file citations resolve to existing files on disk.");
  } else {
    lines.push(`✗ Found ${report.drift} drifted reference(s):`);
    for (const d of report.details) {
      lines.push(`  - In ${d.file}: missing \`${d.reference}\``);
    }
  }
  return lines.join("\n") + "\n";
}
