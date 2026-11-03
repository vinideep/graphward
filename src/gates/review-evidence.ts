import { readFile, realpath, lstat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { containedFilePath } from "../project-files/index.js";
import { resolveRuntimeInvocation } from "../runtime/invocation.js";

export interface ReviewBinding {
  schemaVersion: 1;
  projectRoot: string;
  runtimeGeneration: string;
  files: Record<string, string>;
}

export async function createReviewBinding(root: string, files: string[]): Promise<ReviewBinding> {
  const hashes: Record<string, string> = {};
  const lexicalRoot = path.resolve(root);
  const canonicalRoot = await realpath(root);
  for (const file of [...new Set(files)].sort()) {
    const relative = path.relative(lexicalRoot, path.resolve(lexicalRoot, file)).replace(/\\/g, "/");
    if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) throw new Error(`Review evidence escapes project: ${file}`);
    try {
      const target = await containedFilePath(root, relative);
      hashes[relative] = createHash("sha256").update(await readFile(target)).digest("hex");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A deleted file is explicit evidence. Establish containment through the
      // nearest existing ancestor and reject dangling symlinks rather than following them.
      let ancestor = path.resolve(lexicalRoot, relative);
      for (;;) {
        try {
          const info = await lstat(ancestor);
          if (info.isSymbolicLink()) throw new Error(`Missing review target traverses a symlink: ${file}`);
          const canonical = await realpath(ancestor);
          const boundary = path.relative(canonicalRoot, canonical);
          if (path.isAbsolute(boundary) || boundary === ".." || boundary.startsWith(`..${path.sep}`)) throw new Error(`Review evidence escapes project: ${file}`);
          break;
        } catch (ancestorError) {
          if ((ancestorError as NodeJS.ErrnoException).code !== "ENOENT") throw ancestorError;
          const parent = path.dirname(ancestor);
          if (parent === ancestor) throw ancestorError;
          ancestor = parent;
        }
      }
      hashes[relative] = "missing";
    }
  }
  return { schemaVersion: 1, projectRoot: canonicalRoot, runtimeGeneration: resolveRuntimeInvocation().generation, files: hashes };
}

export async function validateReviewBinding(root: string, binding: unknown, requiredFiles: string[]): Promise<string | undefined> {
  if (!binding || typeof binding !== "object") return "Missing candidate binding; legacy evidence is advisory.";
  const value = binding as ReviewBinding;
  if (value.schemaVersion !== 1 || value.projectRoot !== await realpath(root) || value.runtimeGeneration !== resolveRuntimeInvocation().generation || !value.files || typeof value.files !== "object" || Array.isArray(value.files)) return "Review identity is invalid or belongs to a different project/runtime generation.";
  if (requiredFiles.some(file => typeof value.files[file] !== "string")) return "Review does not cover every required changed file.";
  try {
    const current = await createReviewBinding(root, Object.keys(value.files));
    if (Object.entries(current.files).some(([file, hash]) => value.files[file] !== hash)) return "Reviewed source bytes changed; review this candidate again.";
  } catch (error) { return `Review source evidence is unavailable: ${error instanceof Error ? error.message : String(error)}`; }
  return undefined;
}

export async function validateCompletedReview(root: string, review: unknown, requiredFiles: string[]): Promise<string | undefined> {
  if (!review || typeof review !== "object" || Array.isArray(review)) return "Invalid review artifact.";
  const value = review as Record<string, unknown>;
  if (value.schemaVersion !== 1 || value.status !== "complete" || typeof value.reviewer !== "string" || !value.reviewer.trim() || typeof value.reviewedAt !== "string" || !Number.isFinite(Date.parse(value.reviewedAt)) || Date.parse(value.reviewedAt) > Date.now() + 60_000 || !Array.isArray(value.findings)) return "Review must be completed, dated, attributed and contain findings plus candidate binding.";
  return validateReviewBinding(root, value.binding, requiredFiles);
}
