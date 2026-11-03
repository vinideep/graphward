import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InstallManifest } from "../types.js";
import { IDE_IDS } from "../types.js";
import { containedManagedTarget } from "./paths.js";

export const MANIFEST_PATH = ".graphward/install-manifest.json";
export const TEMPLATE_VERSION = "5.0.0";

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function readManifest(root: string): Promise<InstallManifest | undefined> {
  try {
    const text = await readFile(await containedManagedTarget(root, MANIFEST_PATH), "utf8");
    const parsed = JSON.parse(text) as InstallManifest;
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.adapters) || parsed.adapters.some(adapter => !IDE_IDS.includes(adapter)) || !Array.isArray(parsed.files) || parsed.files.some(entry => !entry || typeof entry.path !== "string" || !["file", "block", "seed", "json-merge"].includes(entry.kind) || typeof entry.hash !== "string" || entry.kind === "block" && (typeof entry.blockId !== "string" || !entry.blockId.trim())) || new Set(parsed.files.map(entry => entry.path)).size !== parsed.files.length) throw new Error("Invalid installation manifest; original bytes preserved.");
    return parsed;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function writeManifest(root: string, manifest: InstallManifest): Promise<void> {
  await writeFile(await containedManagedTarget(root, MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
