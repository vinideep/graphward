import path from "node:path";
import os from "node:os";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { containedManagedTarget } from "../manifest/paths.js";
import { runProcess, runProcessSync } from "../process/index.js";

export interface WorktreeSession {
  worktreeDir: string;
  cleanup: () => Promise<void>;
  createPatch: () => Promise<string>;
  applyPatchToMain: () => Promise<void>;
  candidateHash?: string;
  candidateScope?: { includedFiles: number; omittedFiles: number; scope: string };
  candidateStillCurrent?: () => Promise<boolean>;
}

export interface IsolatedWorktreeOptions {
  id?: string;
  copyDirty?: boolean;
}

function gitSync(cwd: string, args: string[]): { exitCode: number; stdout: string; stderr: string } {
  return runProcessSync({ command: "git", args, cwd, timeoutMs: 30_000 });
}

async function gitAsync(cwd: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return runProcess({ command: "git", args, cwd, timeoutMs: 60_000 });
}

export async function createIsolatedWorktree(
  root: string,
  options: IsolatedWorktreeOptions = {},
): Promise<WorktreeSession> {
  const privateEntry = (file: string) => /^\.graphward\/(?:memory\/users|aidlc\/tasks|experiment-baselines|flight|handoffs|telemetry|providers|\.verify|\.hooks-state)(?:\/|$)/.test(file) || /(?:^|\/)(?:\.env(?:\.(?!example$|sample$)[^/]+)?|id_rsa|id_ed25519|credentials|secrets)(?:\/|$)/i.test(file);
  const tracked = gitSync(root, ["ls-files", "--cached", "-z"]);
  if (tracked.exitCode !== 0) throw new Error("Cannot establish experiment checkout privacy scope.");
  const trackedFiles = new Set(tracked.stdout.split("\0").filter(Boolean));
  // git worktree itself copies tracked files, before any overlay is applied.
  if ([...trackedFiles].some(privateEntry)) throw new Error("Experiment checkout contains tracked private/runtime state; isolated evaluation is unavailable until that state is excluded from the candidate.");
  const omitted = new Set<string>();
  const includeOverlay = (file: string) => {
    const include = file !== "node_modules" && !file.startsWith("node_modules/") && !privateEntry(file) && (!file.startsWith(".graphward/") || trackedFiles.has(file) || file === ".graphward/gw.config.json");
    if (!include) omitted.add(file);
    return include;
  };
  const prefix = options.id ? `gw-wt-${options.id}-` : "gw-wt-";
  const parentDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const worktreeDir = path.join(parentDir, "worktree");

  // Detached checkout of HEAD into worktree
  const addRes = await gitAsync(root, ["worktree", "add", "--detach", "--quiet", worktreeDir, "HEAD"]);
  if (addRes.exitCode !== 0) {
    await rm(parentDir, { recursive: true, force: true });
    throw new Error(`Failed to create git worktree: ${addRes.stderr || addRes.stdout}`);
  }

  // Symlink node_modules if present in root to avoid reinstall
  const rootNodeModules = path.join(root, "node_modules");
  const wtNodeModules = path.join(worktreeDir, "node_modules");
  if (existsSync(rootNodeModules) && !existsSync(wtNodeModules)) {
    try {
      await symlink(rootNodeModules, wtNodeModules, "dir");
    } catch {
      // Symlink non-fatal if cross-device or permission restricted
    }
  }

  let candidateHash: string | undefined;
  let candidateScope: WorktreeSession["candidateScope"];
  let candidateStillCurrent: WorktreeSession["candidateStillCurrent"];
  // Freeze the whole candidate, including binary diffs and untracked files.
  if (options.copyDirty) {
    const inventory = async (directory: string): Promise<Record<string, string>> => {
      const listed = await gitAsync(directory, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
      if (listed.exitCode !== 0) throw new Error(`Cannot freeze candidate inventory: ${listed.stderr}`);
      const hashes: Record<string, string> = {};
      for (const file of [...new Set(listed.stdout.split("\0").filter(Boolean).filter(includeOverlay))].sort()) {
        const target = await containedManagedTarget(directory, file);
        try {
          const info = await lstat(target);
          if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsupported candidate overlay entry: ${file}`);
          hashes[file] = createHash("sha256").update(await readFile(target)).update(`:${info.mode & 0o777}`).digest("hex");
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; hashes[file] = "missing"; }
      }
      return hashes;
    };
    try {
      const frozen = await inventory(root);
      const frozenHead = gitSync(root, ["rev-parse", "HEAD"]).stdout;
      const diffRes = await gitAsync(root, ["diff", "--binary", "HEAD"]);
      if (diffRes.exitCode !== 0) throw new Error(`Cannot freeze candidate patch: ${diffRes.stderr}`);
      if (diffRes.stdout.trim().length > 0) {
        const patchPath = path.join(parentDir, "dirty.patch");
        await writeFile(patchPath, diffRes.stdout, "utf8");
        const applied = await gitAsync(worktreeDir, ["apply", "--whitespace=nowarn", patchPath]);
        if (applied.exitCode !== 0) throw new Error(`Candidate overlay failed to apply: ${applied.stderr}`);
      }
      const untracked = await gitAsync(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
      if (untracked.exitCode !== 0) throw new Error("Cannot enumerate untracked candidate files.");
      for (const file of untracked.stdout.split("\0").filter(Boolean).filter(includeOverlay)) {
        const target = await containedManagedTarget(worktreeDir, file);
        await mkdir(path.dirname(target), { recursive: true });
        const source = await containedManagedTarget(root, file);
        await copyFile(source, target);
        await chmod(target, (await lstat(source)).mode & 0o777);
      }
      const canonical = (value: Record<string, string>) => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
      if (canonical(frozen) !== canonical(await inventory(root)) || canonical(frozen) !== canonical(await inventory(worktreeDir))) throw new Error("Candidate overlay identity changed or did not transfer exactly.");
      candidateScope = { includedFiles: Object.keys(frozen).length, omittedFiles: omitted.size, scope: "Git tracked candidate plus nonignored untracked regular inputs; private/runtime state excluded" };
      candidateHash = createHash("sha256").update(canonical(frozen)).update(JSON.stringify(candidateScope)).digest("hex");
      candidateStillCurrent = async () => {
        try { return gitSync(root, ["rev-parse", "HEAD"]).stdout === frozenHead && canonical(frozen) === canonical(await inventory(root)); }
        catch { return false; }
      };
    } catch (error) {
      await gitAsync(root, ["worktree", "remove", "--force", worktreeDir]);
      await rm(parentDir, { recursive: true, force: true });
      throw error;
    }
  }

  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      gitSync(root, ["worktree", "remove", "--force", worktreeDir]);
    } catch {
      // Best effort
    }
    try {
      await rm(parentDir, { recursive: true, force: true });
    } catch {
      // Best effort
    }
  };

  const createPatch = async (): Promise<string> => {
    const res = await gitAsync(worktreeDir, ["diff", "HEAD"]);
    if (res.exitCode !== 0) {
      throw new Error(`Failed to generate diff patch: ${res.stderr}`);
    }
    return res.stdout;
  };

  const applyPatchToMain = async (): Promise<void> => {
    const patch = await createPatch();
    if (!patch.trim()) return;
    const patchPath = path.join(parentDir, "export.patch");
    await writeFile(patchPath, patch, "utf8");
    const applyRes = await gitAsync(root, ["apply", "--whitespace=nowarn", patchPath]);
    if (applyRes.exitCode !== 0) {
      throw new Error(`Failed to apply worktree patch to root workspace: ${applyRes.stderr}`);
    }
  };

  return {
    worktreeDir,
    cleanup,
    createPatch,
    applyPatchToMain,
    candidateHash,
    candidateScope,
    candidateStillCurrent,
  };
}

export async function withIsolatedWorktree<T>(
  root: string,
  fn: (session: WorktreeSession) => Promise<T>,
  options?: IsolatedWorktreeOptions,
): Promise<T> {
  const session = await createIsolatedWorktree(root, options);
  try {
    return await fn(session);
  } finally {
    await session.cleanup();
  }
}
