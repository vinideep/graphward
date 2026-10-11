import { access, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { HOST_PROFILES } from "./capabilities.js";
import { toCanonicalPath } from "../providers/workspace.js";
import { resolveRuntimeInvocation } from "../runtime/invocation.js";
import { SKILL_NAMES } from "../templates.js";
import type { IdeId } from "../types.js";

/** File generation never establishes native discovery, connection or enforcement. */
export async function hostSupportStatus(root: string, host?: IdeId) {
  root = toCanonicalPath(root);
  const runtime = resolveRuntimeInvocation();
  const exists = async (file: string) => { try { await access(file); return true; } catch { return false; } };
  return Promise.all((host ? [host] : Object.keys(HOST_PROFILES) as IdeId[]).map(async id => {
    const profile = HOST_PROFILES[id];
    const generated = await exists(path.join(root, `.graphward/providers/hosts/${id}.json`));
    const configuration: Record<string, unknown> = { mcpPresent: !!profile.mcpPath && await exists(path.join(root, profile.mcpPath)), hooksPresent: !!profile.hookPath && await exists(path.join(root, profile.hookPath)) };
    if (profile.hookPath?.endsWith('.json')) {
      try { const settings = JSON.parse(await readFile(path.join(root, profile.hookPath), 'utf8')); configuration.explicitlyDisabled = settings.graphward?.enabled === false || settings.disableAllHooks === true; }
      catch { configuration.hookConfigurationUnparseable = configuration.hooksPresent; }
    }
    const collisions: string[] = [];
    for (const directory of [path.join(os.homedir(), '.agents/skills'), path.join(os.homedir(), '.codex/skills'), ...(id === 'claude-code' ? [path.join(os.homedir(), '.claude/skills')] : [])]) {
      for (const name of ['graphward', ...SKILL_NAMES]) if (await exists(path.join(directory, name, 'SKILL.md'))) collisions.push(path.join(directory, name, 'SKILL.md'));
    }
    return { profile, projectRoot: root, runtime: { version: runtime.version, entrypointHash: runtime.entrypointHash }, configuration, stages: { generated: generated ? 'present' : 'missing', discovered: 'unavailable', enabled: configuration.explicitlyDisabled ? 'disabled' : 'unverified', connected: 'unavailable', invoked: 'unavailable', 'enforcement-tested': 'unavailable' }, potentialGlobalSkillConflicts: collisions, note: 'Native stages require candidate-bound host canary evidence. Global engine discovery may override project routing; investigate conflicts before qualification.' };
  }));
}
