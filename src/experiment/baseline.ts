import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { containedManagedTarget } from "../manifest/paths.js";
import { runProcessSync } from "../process/index.js";

interface ExperimentBaseline {
  schemaVersion: 1;
  projectRoot: string;
  flightId: string;
  head: string | null;
  files: Record<string, { exists: boolean; bytes?: string; mode?: number; indexEntries: string }>;
  hash?: string;
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function baselinePath(root: string, flightId: string): string {
  if (!/^flt-[a-z0-9-]+$/.test(flightId)) throw new Error("Invalid experiment baseline owner.");
  return path.join(root, ".graphward/experiment-baselines", `${flightId}.json`);
}
const git = (root: string, args: string[], input?: string) => runProcessSync({ command: "git", args, cwd: root, input, timeoutMs: 15_000 });

export interface CandidateOwnership {
  projectRoot: string;
  head: string | null;
  files: Record<string, { hash: string; indexEntries: string }>;
}

/** Freeze candidate bytes, executable mode and staged ownership before running code. */
export async function captureCandidateOwnership(root: string, files: string[]): Promise<CandidateOwnership> {
  const ownership: CandidateOwnership = { projectRoot: await realpath(root), head: git(root, ["rev-parse", "HEAD"]).stdout.trim() || null, files: {} };
  for (const file of files) {
    const target = await containedManagedTarget(root, file);
    const index = git(root, ["ls-files", "--stage", "-z", "--", file]);
    if (index.exitCode !== 0) throw new Error("Cannot freeze candidate index ownership.");
    let hash = "missing";
    try {
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsupported candidate ownership target: ${file}`);
      hash = createHash("sha256").update(await readFile(target)).update(`:${info.mode & 0o777}`).digest("hex");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    ownership.files[file] = { hash, indexEntries: index.stdout };
  }
  return ownership;
}

export async function candidateOwnershipMatches(root: string, expected: CandidateOwnership): Promise<boolean> {
  try { return JSON.stringify(await captureCandidateOwnership(root, Object.keys(expected.files))) === JSON.stringify(expected); }
  catch { return false; }
}

/** Captured before candidate edits; includes staged state independently of worktree bytes. */
export async function captureExperimentBaseline(root: string, flightId: string, files: string[]): Promise<void> {
  const record: ExperimentBaseline = { schemaVersion: 1, projectRoot: await realpath(root), flightId, head: git(root, ["rev-parse", "HEAD"]).stdout.trim() || null, files: {} };
  for (const file of files) {
    const target = await containedManagedTarget(root, file);
    const index = git(root, ["ls-files", "--stage", "-z", "--", file]);
    if (index.exitCode !== 0) throw new Error("Cannot capture experiment index baseline.");
    try {
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsupported experiment baseline target: ${file}`);
      record.files[file] = { exists: true, bytes: (await readFile(target)).toString("base64"), mode: info.mode & 0o777, indexEntries: index.stdout };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      record.files[file] = { exists: false, indexEntries: index.stdout };
    }
  }
  record.hash = digest(JSON.stringify(record));
  const location = await containedManagedTarget(root, path.relative(root, baselinePath(root, flightId)).replace(/\\/g, "/"));
  const ignorePath = await containedManagedTarget(root, ".graphward/.gitignore");
  let ignore = "";
  try { ignore = await readFile(ignorePath, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!ignore.split(/\r?\n/).some(line => line.trim() === "experiment-baselines/")) {
    await mkdir(path.dirname(ignorePath), { recursive: true });
    await writeFile(ignorePath, `${ignore}${ignore && !ignore.endsWith("\n") ? "\n" : ""}experiment-baselines/\n`);
  }
  await mkdir(path.dirname(location), { recursive: true });
  await writeFile(location, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
}

export async function restoreExperimentBaseline(root: string, flightId: string, files: string[]): Promise<void> {
  let record: ExperimentBaseline;
  try { record = JSON.parse(await readFile(await containedManagedTarget(root, path.relative(root, baselinePath(root, flightId)).replace(/\\/g, "/")), "utf8")); }
  catch { throw new Error("Captured experiment baseline required; destructive rollback refused."); }
  const { hash, ...payload } = record;
  if (hash !== digest(JSON.stringify(payload)) || record.schemaVersion !== 1 || record.projectRoot !== await realpath(root) || record.flightId !== flightId || record.head !== (git(root, ["rev-parse", "HEAD"]).stdout.trim() || null) || files.some(file => !record.files[file])) throw new Error("Experiment baseline identity, ownership or snapshots are invalid; rollback refused.");
  // Validate the complete restoration set before the first effect.
  const targets = await Promise.all(files.map(async file => [file, await containedManagedTarget(root, file)] as const));
  for (const [file, target] of targets) {
    try { const current = await lstat(target); if (!current.isFile() || current.isSymbolicLink()) throw new Error(`Unsupported current rollback target: ${file}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const snapshot = record.files[file];
    if (snapshot.exists && (typeof snapshot.bytes !== "string" || typeof snapshot.mode !== "number")) throw new Error("Incomplete experiment baseline snapshot.");
    if (typeof snapshot.indexEntries !== "string" || snapshot.indexEntries.split("\0").filter(Boolean).some(entry => {
      const match = /^(\d{6}) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]*)$/.exec(entry);
      return !match || match[4] !== file;
    })) throw new Error("Experiment baseline index ownership is invalid.");
  }
  for (const [file, target] of targets) {
    const snapshot = record.files[file];
    if (snapshot.exists) {
      if (typeof snapshot.bytes !== "string" || typeof snapshot.mode !== "number") throw new Error("Incomplete experiment baseline snapshot.");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(snapshot.bytes, "base64"));
      await chmod(target, snapshot.mode);
    } else await unlink(target).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    const removed = git(root, ["update-index", "--force-remove", "--", file]);
    if (removed.exitCode !== 0) throw new Error(`Cannot restore experiment index: ${removed.stderr}`);
    if (snapshot.indexEntries) {
      const restored = git(root, ["update-index", "-z", "--index-info"], snapshot.indexEntries);
      if (restored.exitCode !== 0) throw new Error(`Cannot restore experiment index: ${restored.stderr}`);
    }
  }
}
