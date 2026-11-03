import path from "node:path";
import type { GraphEdge, GraphNode } from "./schema.js";
import { ProjectFilePolicy, containedFilePath } from "../project-files/index.js";

/** Confidence never overrides evidence trust. Provider-only/contested/stale
 * relationships may support exploration, but cannot enter factual traversals.
 */
export function factualEdge(edge: GraphEdge): boolean {
  const metadata = edge.metadata ?? {};
  if (metadata.trustState && metadata.trustState !== "fresh") return false;
  const providers = Array.isArray(metadata.providers) ? metadata.providers : [];
  if ((metadata.provider === "graphify" || providers.includes("graphify")) && metadata.corroborated !== true && !providers.includes("native")) return false;
  return edge.confidence !== "unknown";
}

/** Native symbol IDs are extensionless; executable paths must resolve to real
 * contained files rather than leaking that storage identity to callers.
 */
export async function nodeSourcePath(root: string, node: GraphNode, policy?: ProjectFilePolicy): Promise<string | undefined> {
  const active = policy ?? await ProjectFilePolicy.load(root);
  const raw = node.path ?? (node.id.startsWith("symbol:") ? node.id.slice(7).split("#")[0] : undefined);
  if (!raw) return undefined;
  const candidates = [raw, ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".rb", ".java", ".kt"].map(ext => raw + ext)];
  for (const candidate of candidates) {
    try {
      await containedFilePath(root, candidate);
      const decision = await active.explainExisting(candidate);
      if (decision.included) return path.relative(root, path.resolve(root, candidate)).replace(/\\/g, "/");
    } catch { /* try the next explicit adapter extension */ }
  }
  return undefined;
}
