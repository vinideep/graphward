import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { renderAdapters } from "../adapters/index.js";
import { readManagedBlock } from "../installer/blocks.js";
import { hasOurEntries } from "../installer/json-merge.js";
import { MANIFEST_PATH, TEMPLATE_VERSION, hashContent, readManifest } from "../manifest/index.js";
import { exists, validateCanonicalTemplates } from "../templates.js";
import type { FileAction, IdeId } from "../types.js";
import { packageVersion } from "../version.js";
import { homedir } from "node:os";
import { detectAllIdes } from "../orchestrators/setup.js";
import { SKILL_NAMES } from "../templates.js";

/**
 * Parse the YAML frontmatter a host reads from a Markdown command/agent/skill
 * file. Claude Code only reads frontmatter when the opening `---` is the file's
 * first line, and it silently skips (or hides) files that fail these rules, so
 * we check the shape ourselves and fail the install instead of shipping a file
 * the user will never see in their `/` menu.
 */
function frontmatterFields(content: string): Map<string, string> | undefined {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return undefined;
  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return fields;
}

function validateClaudeCodeSurface(rendered: { path: string; content: string }[]): string[] {
  const errors: string[] = [];
  for (const item of rendered) {
    const isCommand = item.path.startsWith(".claude/commands/") && item.path.endsWith(".md");
    const isAgent = item.path.startsWith(".claude/agents/") && item.path.endsWith(".md");
    const isSkill = item.path.startsWith(".claude/skills/") && item.path.endsWith("/SKILL.md");
    if (!isCommand && !isAgent && !isSkill) continue;
    const fields = frontmatterFields(item.content);
    if (!fields) {
      errors.push(`${item.path} does not start with YAML frontmatter at line 1; Claude Code would ignore its metadata and hide it from the slash menu`);
      continue;
    }
    if (isAgent) {
      const name = fields.get("name");
      if (!name) {
        errors.push(`${item.path} has no name; Claude Code treats it as documentation and skips it as a subagent`);
      } else if (name.includes(":") || name.startsWith("-")) {
        errors.push(`${item.path} has an invalid name "${name}"; Claude Code skips names containing ":" or starting with "-"`);
      }
      if (!fields.get("description")) {
        errors.push(`${item.path} has a name but no description; Claude Code skips it as a subagent`);
      }
    } else if (!fields.get("description")) {
      // Documented behavior: a missing description is not fatal — Claude Code
      // falls back to the first non-empty line of the body — but it weakens the
      // metadata the host uses to match the command to a request.
      errors.push(`${item.path} has no description; Claude Code falls back to the first non-empty line of the body, so the slash-menu hint and automatic matching are weakened`);
    }
  }
  return errors;
}

export async function validateRender(ides: IdeId[]): Promise<string[]> {
  const errors = await validateCanonicalTemplates();
  const rendered = await renderAdapters(ides);
  for (const item of rendered) {
    // Flag only the genuinely obsolete runtime output paths; both the legacy
    // `.agent/*` compatibility paths and current `.agents/agents/*.md` files
    // are legitimate adapter output.
    if (
      !item.path.endsWith(".json") &&
      (item.content.includes(".agent/memory") ||
        item.content.includes(".agent/context") ||
        item.content.includes(".agents/memory") ||
        item.content.includes(".agents/context"))
    ) {
      errors.push(`${item.path} references an obsolete or host-bound runtime output path`);
    }
  }
  if (ides.includes("claude-code")) {
    errors.push(...validateClaudeCodeSurface(rendered));
  }
  const allContent = rendered.map((item) => item.content).join("\n");
  for (const requiredPath of [
    ".graphward/aidlc/",
    ".graphward/graph/",
    ".graphward/reports/",
  ]) {
    if (!allContent.includes(requiredPath)) {
      errors.push(`Rendered templates do not describe required runtime path: ${requiredPath}`);
    }
  }
  return errors;
}

/**
 * Inspect the Claude Code files that actually exist on disk. This catches the
 * silent failure mode where the files are present but Claude Code refuses to
 * load them: a command whose metadata Claude Code can't read never appears in
 * the `/` menu, and a subagent without a name or description is skipped
 * entirely.
 */
async function validateClaudeCodeInstall(root: string): Promise<FileAction[]> {
  const actions: FileAction[] = [];
  const scan = async (directory: string, kind: "command" | "subagent"): Promise<void> => {
    const entries = await readdir(path.join(root, directory)).catch((): string[] => []);
    for (const entry of entries.filter((name) => name.endsWith(".md"))) {
      const relative = `${directory}/${entry}`;
      const content = await readFile(path.join(root, relative), "utf8").catch(() => "");
      const fields = frontmatterFields(content);
      const noun = kind === "command" ? "Command" : "Subagent";
      if (!fields) {
        actions.push({
          path: relative,
          status: "error",
          message: `${noun} has no YAML frontmatter on line 1; Claude Code ignores its metadata, so it will not appear in the slash menu.`,
        });
        continue;
      }
      if (kind === "subagent" && !fields.get("name")) {
        actions.push({
          path: relative,
          status: "error",
          message: "Subagent has no name; Claude Code treats the file as documentation and never delegates to it.",
        });
        continue;
      }
      if (kind === "subagent" && !fields.get("description")) {
        actions.push({
          path: relative,
          status: "error",
          message: "Subagent has a name but no description; Claude Code skips the file, so the subagent never loads.",
        });
        continue;
      }
      if (!fields.get("description")) {
        actions.push({
          path: relative,
          status: "warning",
          message: `${noun} has no description; Claude Code falls back to the first non-empty line, weakening slash-menu hints and automatic matching.`,
        });
      }
    }
  };
  await scan(".claude/commands", "command");
  await scan(".claude/agents", "subagent");
  return actions;
}

export async function doctor(root: string, expectedPackageVersion?: string, strict = false): Promise<FileAction[]> {
  const actions: FileAction[] = [];
  const manifest = await readManifest(root);
  if (!manifest) {
    actions.push({ path: MANIFEST_PATH, status: "error", message: "No installation manifest found." });
    return actions;
  }
  const expectedVersion = expectedPackageVersion ?? await packageVersion();
  if (manifest.packageVersion !== expectedVersion) {
    actions.push({ path: MANIFEST_PATH, status: "error", message: `Installed package version ${manifest.packageVersion} differs from canonical ${expectedVersion}; run graphward update.` });
  }
  if (manifest.templateVersion !== TEMPLATE_VERSION) {
    actions.push({ path: MANIFEST_PATH, status: "error", message: `Installed template version ${manifest.templateVersion} differs from canonical ${TEMPLATE_VERSION}; run graphward update.` });
  }
  const renderingErrors = await validateRender(manifest.adapters);
  // Needed to verify json-merge entries: we must know what we would write in
  // order to check that it is still present inside the user's own file.
  const desired = await renderAdapters(manifest.adapters);
  const desiredByPath = new Map(desired.map((f) => [f.path, f]));
  const manifestByPath = new Map(manifest.files.map((entry) => [entry.path, entry]));
  for (const rendered of desired) {
    if (!manifestByPath.has(rendered.path)) {
      actions.push({ path: rendered.path, status: "error", message: "Canonical managed artifact is missing from the install manifest; run graphward update." });
    }
  }
  for (const entry of manifest.files) {
    if (!desiredByPath.has(entry.path)) {
      actions.push({ path: entry.path, status: "warning", message: "Install manifest tracks an artifact that is no longer canonical; run graphward update." });
    }
  }
  for (const message of renderingErrors) {
    actions.push({ path: "templates", status: "error", message });
  }
  if (manifest.adapters.includes("claude-code")) {
    actions.push(...await validateClaudeCodeInstall(root));
  }
  if (await exists(path.join(root, ".agent")) && !manifest.adapters.includes("antigravity") && !manifest.adapters.includes("antigravity-cli")) {
    actions.push({
      path: ".agent",
      status: "warning",
      message: "Legacy .agent directory found; installed adapters use .agents.",
    });
  }
  // The most common silent failure: an earlier install fell back to the
  // generic adapter, so the developer's IDE has no slash commands at all.
  // Only diagnose that specific state — projects with a real adapter are
  // already wired up, and warning about every globally installed IDE would
  // be noise.
  if (manifest.adapters.length === 1 && manifest.adapters[0] === "generic") {
    const IDE_DIRS: Partial<Record<IdeId, string>> = {
      "claude-code": ".claude",
      cursor: ".cursor",
      codex: ".codex",
      "gemini-cli": ".gemini",
      "github-copilot": ".github",
      commandcode: ".commandcode",
      antigravity: ".agents",
      "antigravity-cli": ".agents",
    };
    for (const ide of detectAllIdes(root)) {
      const slashHint = ide === "claude-code" ? " (/graphward, /initialize-graphward)" : "";
      actions.push({
        path: IDE_DIRS[ide] ?? ".agents",
        status: "warning",
        message: `${ide} is installed on this machine but the generic adapter was installed instead; run \`graphward install --ide ${ide}\` to add its commands${slashHint}.`,
      });
    }
  }
  for (const entry of manifest.files) {
    const absolute = path.join(root, entry.path);
    if (!(await exists(absolute))) {
      actions.push({ path: entry.path, status: "error", message: "Managed file is missing." });
      continue;
    }
    const current = await readFile(absolute, "utf8");

    if (entry.kind === "seed") {
      // Seeded config is the user's to edit — that is how enforcement is turned
      // on — so a local change is expected, never a warning.
      actions.push({ path: entry.path, status: "unchanged" });
      continue;
    }

    if (entry.kind === "json-merge") {
      // We only own our own entries; the user's surrounding config is theirs.
      const rendered = desiredByPath.get(entry.path);
      const wired = rendered ? hasOurEntries(current, rendered.content) : true;
      actions.push(
        wired
          ? { path: entry.path, status: "unchanged" }
          : {
              path: entry.path,
              status: "warning",
              message: "Enforcement hook entries are missing. Run `graphward update` to re-merge them.",
            },
      );
      continue;
    }

    const tracked =
      entry.kind === "block" && entry.blockId
        ? readManagedBlock(current, entry.blockId)
        : current;
    if (tracked === undefined) {
      actions.push({ path: entry.path, status: "error", message: "Managed block is missing." });
    } else if (hashContent(tracked.trimEnd()) !== entry.hash) {
      actions.push({ path: entry.path, status: "warning", message: "Managed content was edited locally." });
    } else {
      actions.push({ path: entry.path, status: "unchanged" });
    }
  }

  if (strict) {
    const globalSkills = path.join(homedir(), ".agents", "skills");
    for (const name of SKILL_NAMES) {
      const globalSkill = path.join(globalSkills, name, "SKILL.md");
      if (!(await exists(globalSkill))) continue;
      const content = await readFile(globalSkill, "utf8").catch(() => "");
      if (content.includes(".engineering-intelligence/")) {
        actions.push({ path: globalSkill, status: "error", message: `Global skill '${name}' uses legacy .engineering-intelligence paths and can override the project skill. Migrate or remove it explicitly.` });
      } else {
        actions.push({ path: globalSkill, status: "warning", message: `Global skill '${name}' duplicates a project-managed skill; verify host precedence.` });
      }
    }
    for (const legacyName of ["engineering-intelligence-skill", "memory-sync-engine", "knowledge-sync-engine", "context-sync-engine", "api-snapshot-testing-engine"]) {
      const globalSkill = path.join(globalSkills, legacyName, "SKILL.md");
      if (await exists(globalSkill)) actions.push({ path: globalSkill, status: "error", message: `Legacy global skill '${legacyName}' remains model-selectable beside GraphWard. Migrate or remove it explicitly.` });
    }
    const globalEntries = await readdir(globalSkills, { withFileTypes: true }).catch(() => []);
    for (const entry of globalEntries.filter((item) => item.isDirectory() && item.name.startsWith("source-command-"))) {
      actions.push({ path: path.join(globalSkills, entry.name), status: "error", message: `Legacy wrapper skill '${entry.name}' remains model-selectable and duplicates an entry workflow. Migrate or remove it explicitly.` });
    }
  }

  return actions;
}
