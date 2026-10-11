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
import { mkdir, readFile, writeFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { runProcess } from "../process/index.js";
import { parseGitStatusPaths } from "./git-paths.js";

export const RECEIPT_SCHEMA_VERSION = 2;
const MISSING_FILE_HASH = "missing";
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
  timedOut?: boolean;
  error?: string;
  executable?: string;
  args?: string[];
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
   * Git change set. Non-Git projects bind receipts to enumerated product files.
   */
  gitAvailable: boolean;
  verdict: "pass" | "fail";
  verificationHash?: string;
  provenance?: 'human' | 'agent' | 'unknown';
  provenanceAssurance?: "declared";
  mode?: "baseline" | "impact";
  plannedCommands?: string[];
  skippedCommands?: string[];
  selectionReason?: string;
  changedDuringChecks?: string[];
  projectRoot?: string;
}

/** @deprecated Use VerificationRecord instead */
export type Receipt = VerificationRecord;

export interface VerifyOptions {
  /** Explicit commands to run. Overrides detection. */
  commands?: string[];
  timeoutMs?: number;
  mode?: "baseline" | "impact";
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
    const canonicalRoot = await realpath(root);
    const target = await realpath(path.resolve(root, relPath));
    const relative = path.relative(canonicalRoot, target);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error(`Verification file resolves outside the project: ${relPath}`);
    return hashContent(await readFile(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function git(root: string, args: string[]): Promise<string | null> {
  const result = await runProcess({ command: "git", args, cwd: root, maxBuffer: 10 * 1024 * 1024 });
  return result.exitCode === 0 ? result.stdout : null;
}

/**
 * Files modified relative to HEAD, including untracked. NUL porcelain preserves
 * literal path bytes and includes both names in a rename.
 *
 * `-uall` is essential: the default collapses an untracked directory to a single
 * `src/` entry, so a brand-new source file would never be seen — and the gate
 * would pass a change it never verified.
 */
export async function changedFiles(root: string): Promise<string[]> {
  const porcelain = await git(root, ["status", "--porcelain=v1", "-z", "-uall"]);
  if (porcelain === null) return [];
  return parseGitStatusPaths(porcelain).filter((file) => file !== ".graphward" && !file.startsWith(".graphward/"));
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

function validRecord(value: unknown): value is VerificationRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as VerificationRecord;
  if (record.schemaVersion === RECEIPT_SCHEMA_VERSION) {
    const { verificationHash, ...payload } = record;
    if (typeof verificationHash !== "string" || verificationHash !== hashContent(JSON.stringify(payload))) return false;
    if (typeof record.projectRoot !== "string") return false;
  }
  return (record.schemaVersion === 1 || record.schemaVersion === RECEIPT_SCHEMA_VERSION)
    && (record.verdict === "pass" || record.verdict === "fail")
    && typeof record.createdAt === "string" && Number.isFinite(Date.parse(record.createdAt))
    && record.files !== null && typeof record.files === "object" && !Array.isArray(record.files)
    && Array.isArray(record.commands) && record.commands.every((run) => run && typeof run.command === "string" && Number.isInteger(run.exitCode))
    && (record.verdict !== "pass" || (record.commands.length > 0 && record.commands.every((run) => run.exitCode === 0 && !run.timedOut && !run.error)));
}

export async function readRecords(root: string): Promise<VerificationRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(recordPath(root), "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter(validRecord) : [];
  } catch {
    try {
      const parsed = JSON.parse(await readFile(legacyReceiptPath(root), "utf8")) as unknown;
      return Array.isArray(parsed) ? parsed.filter(validRecord) : [];
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
  for (const file of files) current.set(file, (await hashFile(root, file)) ?? MISSING_FILE_HASH);
  const records = await readRecords(root);
  const canonicalRoot = await realpath(root);
  const currentHead = (await git(root, ["rev-parse", "HEAD"]))?.trim() ?? null;
  const matches = (record: VerificationRecord) => record.verdict === "pass"
    && (record.schemaVersion !== RECEIPT_SCHEMA_VERSION || (record.projectRoot === canonicalRoot && record.head === currentHead))
    && [...current].every(([file, hash]) => {
    const value = record.files[file];
    return (typeof value === "string" ? value : value?.hash) === hash;
  });
  const covering = records.filter(matches);
  if (covering.length) {
    const record = covering[0];
    return { covered: true, uncovered: [], agentOnly: !covering.some((r) => r.provenance === "human"), record, receipt: record };
  }
  const latest = records.find((record) => record.verdict === "pass");
  const uncovered = [...current].filter(([file, hash]) => {
    const value = latest?.files[file];
    return (typeof value === "string" ? value : value?.hash) !== hash;
  }).map(([file]) => file);
  return { covered: false, uncovered };
}

// ---------------------------------------------------------------------------
// Running verification
// ---------------------------------------------------------------------------

async function runOne(root: string, command: string, timeoutMs: number, args?: string[]): Promise<CommandRun> {
  const started = Date.now();
  // Verification commands are explicitly configured project commands. Invoke
  // the platform shell as an argument-array process so all subprocesses still
  // flow through the shared timeout/output/error contract.
  const shell = process.platform === "win32"
    ? { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", command], windowsVerbatimArguments: true }
    : { command: "/bin/sh", args: ["-c", command] };
  const request = args ? { command: process.execPath, args } : shell;
  const result = await runProcess({ ...request, cwd: root, timeoutMs, maxBuffer: 20 * 1024 * 1024 });
  return {
    command,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    error: result.error,
    executable: result.command,
    args: result.args,
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
async function nonGitFiles(root: string, relative = ""): Promise<string[]> {
  const ignored = new Set([".git", ".graphward", "node_modules", "dist", "build", "coverage", ".venv", "__pycache__"]);
  const out: string[] = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory() && !ignored.has(entry.name)) out.push(...await nonGitFiles(root, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

export async function runVerification(root: string, options: VerifyOptions = {}): Promise<VerifyResult> {
  const plannedCommands = options.commands ?? await detectCheckCommands(root);
  let commands = [...plannedCommands];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Verification timeout must be positive and finite.");
  let mode = options.mode ?? (options.impactOnly === true ? "impact" : "baseline");
  if (mode !== "baseline" && mode !== "impact") throw new Error("Verification mode must be baseline or impact.");
  const skippedCommands: string[] = [];
  let selectedArgs: string[] | undefined;
  let selectionReason = mode === "baseline" ? "Full configured baseline" : "Explicit impact selection";
  if (mode === "impact") {
    try {
      const graph = JSON.parse(await readFile(path.join(root, ".graphward/graph/dependency-graph.json"), "utf8"));
      const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
      // Only the known Node test runner safely accepts graph-selected paths.
      if (!options.changedFiles || !/^node --test(?:\s|$)/.test(pkg.scripts?.test ?? "") || /[;&|]/.test(pkg.scripts.test)) throw new Error("No supported impact test adapter");
      const { computeTestImpact } = await import("./impact.js");
      const tests = computeTestImpact(options.changedFiles, graph).affectedTests;
      if (tests.some((file) => path.isAbsolute(file) || file.startsWith("-") || path.relative(root, path.resolve(root, file)).startsWith("..") || !/\.(?:[cm]?js)$/.test(file))) throw new Error("Unsupported or unsafe selected test path");
      if (commands.includes("npm test")) {
        if (tests.length) selectedArgs = ["--test", ...tests];
        else { commands = commands.filter((command) => command !== "npm test"); skippedCommands.push("npm test"); }
      }
      selectionReason = tests.length ? `Graph selected ${tests.length} Node test file(s)` : "Graph selected no tests; npm test skipped (no execution is not a pass)";
    } catch (error) {
      mode = "baseline";
      selectionReason = `Impact selection unavailable; full baseline retained: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const inGitRepo = (await git(root, ["rev-parse", "--is-inside-work-tree"]))?.trim() === "true";
  const scope = new Set([...(options.changedFiles ?? []), ...(inGitRepo ? await changedFiles(root) : await nonGitFiles(root))]);
  const snapshot = async (files: Iterable<string>) => {
    const hashes: Record<string, string> = {};
    for (const file of files) {
      const target = path.resolve(root, file);
      const relative = path.relative(root, target);
      if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`) || relative === ".graphward" || relative.startsWith(`.graphward${path.sep}`)) throw new Error(`Verification file escapes product scope: ${file}`);
      hashes[file] = (await hashFile(root, file)) ?? MISSING_FILE_HASH;
    }
    return hashes;
  };
  const before = await snapshot(scope);
  const head = (await git(root, ["rev-parse", "HEAD"]))?.trim() ?? null;
  const runs: CommandRun[] = [];
  for (const command of commands) {
    const args = command === "npm test" ? selectedArgs : undefined;
    const actualCommand = args ? `${process.execPath} ${args.map((arg) => JSON.stringify(arg)).join(" ")}` : command;
    const run = await runOne(root, actualCommand, timeoutMs, args);
    runs.push(run);
    if (run.exitCode !== 0 || run.timedOut || run.error) break;
  }
  const afterScope = inGitRepo ? await changedFiles(root) : await nonGitFiles(root);
  const files = await snapshot(new Set([...scope, ...afterScope]));
  const changedDuringChecks = Object.keys(files).filter((file) => before[file] !== files[file]);
  const headAfter = (await git(root, ["rev-parse", "HEAD"]))?.trim() ?? null;
  const verdict = runs.length > 0 && runs.length === commands.length && runs.every((run) => run.exitCode === 0 && !run.timedOut && !run.error) && changedDuringChecks.length === 0 && headAfter === head ? "pass" : "fail";
  const record: VerificationRecord = {
    schemaVersion: RECEIPT_SCHEMA_VERSION, createdAt: new Date().toISOString(), head, projectRoot: await realpath(root),
    commands: runs, plannedCommands, skippedCommands, files, gitAvailable: inGitRepo, verdict,
    mode, selectionReason, changedDuringChecks,
    provenance: options.provenance ?? "unknown", provenanceAssurance: "declared",
  };
  record.verificationHash = hashContent(JSON.stringify(record));
  await writeRecord(root, record);
  return { record, receipt: record, noCommands: runs.length === 0 };
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
