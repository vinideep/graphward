import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

/** Resolve managed artifact targets through existing ancestors before every effect. */
export async function containedManagedTarget(root: string, relative: string): Promise<string> {
  if (typeof relative !== "string" || !relative || relative.includes("\u0000") || relative.includes("\\") || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || relative.split("/").some(part => part === ".." || part === "." || !part)) throw new Error(`Invalid managed artifact path: ${relative}`);
  const canonicalRoot = await realpath(root);
  const absolute = path.resolve(canonicalRoot, relative);
  let existing = absolute;
  for (;;) {
    try { await lstat(existing); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; const parent = path.dirname(existing); if (parent === existing) throw error; existing = parent; }
  }
  const resolved = await realpath(existing);
  const rel = path.relative(canonicalRoot, resolved);
  if (path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`)) throw new Error(`Managed artifact target escapes project: ${relative}`);
  return absolute;
}
