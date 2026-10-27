/**
 * Subtree-scoped merging for JSON config the user also owns.
 *
 * `.claude/settings.json` and `.cursor/hooks.json` are the user's files — they
 * hold permissions, model choice, env vars. Treating them as whole managed files
 * meant the most likely adopter (an existing Claude Code user, who therefore
 * already has a settings.json) got a conflict and the entire enforcement layer
 * silently did not install.
 *
 * Markdown solves this with comment sentinels (see blocks.ts); JSON has no such
 * affordance, so ownership is established by VALUE instead: an entry is ours iff
 * its command invokes `gw hook`. That makes merge, verify
 * and uninstall all decidable without storing a side-channel manifest of array
 * indices, and it survives the user reordering or adding their own hooks.
 */

const OWNERSHIP_MARKER = "gw hook";

/** The key under which we register ourselves in an `mcpServers` map. */
export const MCP_SERVER_KEY = "graphward";

/**
 * Top-level key in `.claude/settings.json` that auto-approves project-scoped
 * MCP servers declared in `.mcp.json`. Without this, Claude Code leaves the
 * graphward server in "Pending approval" state and the `/mcp` panel won't show it.
 */
const ENABLED_MCP_JSON_KEY = "enabledMcpjsonServers";

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True for an ARRAY ELEMENT that is ours — a hook entry invoking our CLI.
 * Deliberately only applied to elements: testing a whole container would claim
 * (and on uninstall destroy) the user's own hooks sitting beside ours.
 */
function isOurs(value: unknown): boolean {
  const text = JSON.stringify(value ?? "");
  return text.includes(OWNERSHIP_MARKER) || /dist[\\/]cli[\\/]index\.js/.test(text) && /[\\"']hook[\\"']| hook /.test(text);
}

/** True for an OBJECT KEY that is ours: our entry inside an `mcpServers` map. */
function isOurKey(parentKey: string | undefined, key: string): boolean {
  return parentKey === "mcpServers" && key === MCP_SERVER_KEY;
}

export function parseJsonOrEmpty(source: string | undefined): Json {
  if (!source || !source.trim()) return {};
  try {
    const parsed = JSON.parse(source) as unknown;
    return isObject(parsed) ? parsed : {};
  } catch {
    // Unparseable user config: treat as empty so we never destroy it — the
    // caller writes our keys alongside and the user's original stays on disk.
    return {};
  }
}

/**
 * Merge our hook config into the user's. Within `hooks`, each event's array
 * keeps every entry the user owns and replaces only the entries that are ours,
 * so re-running install is idempotent and never duplicates.
 */
export function mergeHookConfig(existingSource: string | undefined, oursSource: string): string {
  if (existingSource?.trim()) {
    const value = JSON.parse(existingSource);
    if (!isObject(value)) throw new Error('Existing user configuration must be an object; preserved.');
  }
  const existing = parseJsonOrEmpty(existingSource);
  const ours = parseJsonOrEmpty(oursSource);
  if (isObject(existing.mcpServers) && isObject(ours.mcpServers) && existing.mcpServers.graphward && JSON.stringify(existing.mcpServers.graphward) !== JSON.stringify(ours.mcpServers.graphward)) {
    const registration = existing.mcpServers.graphward as Json;
    const args = Array.isArray(registration.args) ? registration.args.join(" ") : "";
    if (!/dist[/\\]mcp[/\\](?:cli|index)\.js|\bgw-mcp\b|\bgraphward\s+mcp\b/.test(args)) throw new Error("Existing user GraphWard MCP registration conflicts and was preserved.");
  }
  const merge = (theirs: unknown, incoming: unknown, key?: string): unknown => {
    if (key === ENABLED_MCP_JSON_KEY && Array.isArray(incoming)) return [...new Set([...(Array.isArray(theirs) ? theirs : []), ...incoming])];
    if (key === "args" && Array.isArray(incoming)) return incoming;
    if (Array.isArray(incoming)) return [...(Array.isArray(theirs) ? theirs.filter(item => !isOurs(item)) : []), ...incoming];
    if (isObject(incoming)) {
      const result: Json = isObject(theirs) ? { ...theirs } : {};
      for (const [name, value] of Object.entries(incoming)) result[name] = merge(result[name], value, name);
      // An event we no longer install (e.g. Antigravity PreInvocation, replaced by
      // SessionStart) would otherwise keep running our old entry forever.
      for (const [name, value] of Object.entries(result)) {
        if (name in incoming || !Array.isArray(value) || !value.some(isOurs)) continue;
        const kept = value.filter(item => !isOurs(item));
        if (kept.length) result[name] = kept; else delete result[name];
      }
      return result;
    }
    // Preserve user-disabled integration instead of silently enabling it again.
    if (key === 'enabled' && typeof theirs === 'boolean') return theirs;
    return incoming;
  };
  return JSON.stringify(merge(existing, ours), null, 2) + '\n';
}

/** Every entry we own is present in the file on disk. */
export function hasOurEntries(existingSource: string | undefined, oursSource: string): boolean {
  const existing = parseJsonOrEmpty(existingSource);
  const ours = parseJsonOrEmpty(oursSource);
  const contains = (theirs: unknown, incoming: unknown): boolean => {
    if (Array.isArray(incoming)) return Array.isArray(theirs) && incoming.every(entry => theirs.some(item => contains(item, entry)));
    if (isObject(incoming)) return isObject(theirs) && Object.entries(incoming).every(([key, value]) => contains(theirs[key], value));
    return theirs === incoming;
  };
  return contains(existing, ours);
}

/**
 * Remove every entry we own, wherever it sits. Because ownership is decided by
 * the marker rather than by position, uninstall needs no record of what we wrote
 * — it just drops what invokes our CLI and prunes containers left empty.
 *
 * Returns the remaining JSON, or null when nothing of the user's is left, so the
 * caller can delete the file instead of leaving an empty husk.
 */
export function removeOurEntries(existingSource: string | undefined): string | null {
  if (existingSource !== undefined) {
    const parsed = JSON.parse(existingSource);
    if (!isObject(parsed)) throw new Error("Existing shared hook configuration must be an object; preserved.");
  }
  const prune = (value: unknown, parentKey?: string, key?: string): unknown => {
    // enabledMcpjsonServers: remove only our server name, keep the rest.
    if (key === ENABLED_MCP_JSON_KEY && Array.isArray(value)) {
      const kept = value.filter((e) => e !== MCP_SERVER_KEY);
      return kept.length > 0 ? kept : undefined;
    }
    if (Array.isArray(value)) {
      // Ownership is decided per ELEMENT. Testing a whole container would drop
      // the user's own hooks whenever one of ours happened to sit beside them.
      const kept = value
        .filter((e) => !isOurs(e))
        .map((e) => prune(e, parentKey))
        .filter((e) => e !== undefined);
      return kept.length > 0 ? kept : undefined;
    }
    if (isObject(value)) {
      const out: Json = {};
      for (const [k, v] of Object.entries(value)) {
        if (isOurKey(parentKey, k)) continue; // our MCP server registration
        const pruned = prune(v, k, k);
        if (pruned !== undefined) out[k] = pruned;
      }
      return Object.keys(out).length > 0 ? out : undefined;
    }
    return value;
  };

  const remaining = prune(parseJsonOrEmpty(existingSource));
  if (remaining === undefined || !isObject(remaining)) return null;
  return `${JSON.stringify(remaining, null, 2)}\n`;
}
