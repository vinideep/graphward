/**
 * Lossless token optimization for rendered toolkit files.
 *
 * Techniques used:
 * 1. Skills index — compact 1-line-per-skill routing table (saves ~10,000t vs reading all skills)
 * 2. Workflow routing — pre-computed primary/optional skill map per command (saves ~2,000t)
 * 3. Tiered skill format — SKILL-BRIEF.md (~150t) read upfront; SKILL.md loaded at execution time
 * 4. KV-cache pinning — routing artifacts sort first so they form a stable context prefix
 *
 * Inspired by Headroom's ContentRouter + CacheAligner + CCR patterns:
 * - Routing table = CacheAligner: stable prefix, KV-cache hits across all invocations
 * - Skills index = ContentRouter: relevance ranking, route to the right 2-3 skills
 * - SKILL-BRIEF.md = CCR tier 2: understand without executing; SKILL.md = CCR tier 3 retrieval
 */

import { readTemplate } from "./templates.js";
import {
  SKILL_INVOCATION_POLICIES,
  WORKFLOW_CATALOG,
  WORKFLOW_SKILL_ROUTING,
  type SkillName,
} from "./routing/catalog.js";

export { WORKFLOW_SKILL_ROUTING } from "./routing/catalog.js";

// --- Rendered-file preparation ------------------------------------------------

/**
 * Path aliasing was removed deliberately. It prepended an expansion preamble
 * above the YAML frontmatter fence, so rendered files no longer started with
 * `---` at byte 0 — which means hosts that parse frontmatter (Claude Code,
 * Copilot, Codex, anything following the Agent Skills spec) could not read
 * `name`, `description` or `argument-hint`, disabling model-driven skill
 * invocation for every skill and every command.
 *
 * The aliases also produced 240 glued identifiers across 47 distinct tokens
 * (`$EIknowledge-base/`, `$EIreports/IMP-XXX-`, `$EImemory/users/`), because
 * `$EI` expanded to a directory prefix that was immediately followed by more
 * path. Those are exactly the strings a small model mis-expands, silently
 * writing artifacts to paths nothing reads. ~955 saved tokens did not justify
 * breaking host parsing and inventing a whole failure class.
 *
 * `prepareRendered` is the single place rendered content is normalized, so the
 * frontmatter-at-byte-0 invariant has one owner.
 */
export function prepareRendered(content: string): string {
  return smartCrush(content);
}

// --- Workflow → skill routing table ------------------------------------------

/**
 * Pre-computed map from workflow command name to the skills it needs.
 *
 * primary   — always load these before executing the workflow
 * optional  — load only when the request explicitly involves that capability
 *
 * Saving: replaces LLM inference of "which skills apply?" with a deterministic
 * lookup. This is the CacheAligner benefit: the same stable prefix every time.
 */
export const SKILLS_INDEX_FILENAME = "SKILLS-INDEX.md";
export const WORKFLOW_ROUTING_FILENAME = "WORKFLOW-ROUTING.md";

export function generateWorkflowRouting(skillsDir = ".claude/skills", briefsAvailable = true): string {
  const rows = (Object.entries(WORKFLOW_SKILL_ROUTING) as [string, { primary: string[]; optional: string[] }][])
    .map(([cmd, r]) => {
      const primary = r.primary.map((s) => `\`${s}\``).join(", ");
      const optional = r.optional.length ? r.optional.map((s) => `\`${s}\``).join(", ") : "—";
      const route = WORKFLOW_CATALOG[cmd as keyof typeof WORKFLOW_CATALOG];
      return `| \`${cmd}\` | ${route.mutatesProduct ? "yes" : "no"} | ${primary} | ${optional} |`;
    });

  return [
    "# Workflow Routing Table",
    "",
    "> **Read this before loading any skill files.**",
    briefsAvailable
      ? "> For each primary skill: load `SKILL-BRIEF.md` to understand it (~150t), then `SKILL.md` to execute."
      : "> Load each primary `SKILL.md` only after the entry workflow selects it; brief files are not installed for this provider.",
    "> Load **optional** skills only when the request explicitly requires that capability.",
    `> Skill files are in \`${skillsDir}/<name>/\` (${briefsAvailable ? "SKILL-BRIEF.md and SKILL.md" : "SKILL.md"}).`,
    "",
    "| Command | Mutates product | Primary Skills — load first | Optional Skills — load if needed |",
    "|---|---:|---|---|",
    ...rows,
    "",
  ].join("\n");
}

// --- Skills index ------------------------------------------------------------

/**
 * Generate a compact discriminator-first skill index. Raw template
 * descriptions are intentionally not used here: several describe adjacent
 * capabilities in generic terms, which recreates the model-selection
 * ambiguity that the routing catalog is designed to eliminate.
 */
export async function generateSkillsIndex(
  skillNames: ReadonlyArray<string>,
  skillsDir = ".claude/skills",
  activeWorkflow?: string,
  briefsAvailable = true,
): Promise<string> {
  let relevantSkills = skillNames;
  if (activeWorkflow && activeWorkflow in WORKFLOW_SKILL_ROUTING) {
    const route = WORKFLOW_SKILL_ROUTING[activeWorkflow as keyof typeof WORKFLOW_SKILL_ROUTING];
    const allowed = new Set<string>([...route.primary, ...route.optional]);
    relevantSkills = skillNames.filter((name) => allowed.has(name));
  }

  const compact = (value: string, max = 76): string => value.length > max ? `${value.slice(0, max - 1)}…` : value;
  const rows = relevantSkills.map((name) => {
    const policy = SKILL_INVOCATION_POLICIES[name as SkillName];
    return `| \`${name}\` | ${compact(policy.triggers.join("; "))} | ${compact(policy.excludes.join("; "))} |`;
  });

  return [
    "# Skills Index",
    "",
    "> **Token-saving routing layer.** Read this index first.",
    "> Identify the 1-3 skills relevant to the request.",
    briefsAvailable
      ? "> Tiered loading: `SKILL-BRIEF.md` (~150t) → understand the skill. `SKILL.md` → execute the procedure."
      : "> Entry workflows select internal engines. Load only the selected `SKILL.md`; brief files are not installed for this provider.",
    `> ${briefsAvailable ? "Both files live" : "Skill files live"} at \`${skillsDir}/<name>/\`.`,
    "",
    "| Internal engine | Use only when routed for | Do not select for |",
    "|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

// --- Tiered skill briefs (CCR tier 2) ----------------------------------------

/**
 * Extract a compact brief from a full SKILL.md.
 *
 * The brief is the CCR tier-2 layer: ~150 tokens vs ~1,200 for the full skill.
 * AI reads the brief to understand what the skill does and confirm it's relevant;
 * reads the full SKILL.md only at execution time (CCR tier-3 retrieval).
 *
 * Extraction rules:
 * - Frontmatter preserved (name, description, version)
 * - Title + first body paragraph (overview sentence)
 * - First 6 non-empty lines of the `## Inputs` section (mode table or bullet list)
 * - Hard loading notice enforcing tier-3 retrieval before execution
 */
export function generateSkillBrief(content: string, name: string): string {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
  const frontmatter = fmMatch ? fmMatch[1] : "";
  const body = fmMatch ? content.slice(fmMatch[0].length) : content;

  // Title (first `# Heading` line in body, which may be preceded by a newline)
  const titleMatch = body.match(/^[\n]*(# [^\n]+)/m);
  const title = titleMatch ? titleMatch[1].replace(/^# /, "") : name;

  // First paragraph: text between the title and the next section heading or blank+heading
  const afterTitle = titleMatch
    ? body.slice(body.indexOf(titleMatch[1]) + titleMatch[1].length).replace(/^\n+/, "")
    : body.replace(/^\n+/, "");
  const firstParaMatch = afterTitle.match(/^([^#\n][^\n]*(?:\n(?![\n#])[^\n]*)*)/);
  const overview = firstParaMatch ? firstParaMatch[1].trim() : "";

  // Inputs section — first 6 non-empty lines (handles both table and bullet formats)
  const inputsMatch = body.match(/## Inputs?\n\n?([\s\S]*?)(?=\n## |\n# |$)/i);
  const inputLines = inputsMatch
    ? inputsMatch[1].split("\n").filter((l) => l.trim()).slice(0, 6)
    : [];

  const parts: string[] = [];
  if (frontmatter) parts.push(`---\n${frontmatter}\n---`, "");
  parts.push(`# ${title}`, "");
  if (overview) parts.push(overview, "");
  if (inputLines.length > 0) parts.push("## Inputs", "", ...inputLines, "");
  parts.push("> **Load `SKILL.md` from this directory before executing this skill's procedure.**");

  return parts.join("\n") + "\n";
}

/**
 * Generate SKILL-BRIEF.md content for every skill.
 * Returns a map of skill name → brief content. Briefs preserve the source
 * frontmatter, so they must also start with `---` at byte 0.
 */
export async function generateAllSkillBriefs(
  skillNames: ReadonlyArray<string>,
): Promise<Map<string, string>> {
  const entries = await Promise.all(
    skillNames.map(async (name) => {
      const full = await readTemplate("skills", name).catch(() => "");
      return [name, prepareRendered(generateSkillBrief(full, name))] as const;
    }),
  );
  return new Map(entries);
}

// --- SmartCrusher (Technique 5) -----------------------------------------------

/**
 * Phase 1 structural compression — zero semantic risk.
 *
 * Rules applied:
 * - Strip `version:` from YAML frontmatter — installer metadata, irrelevant to the AI
 * - Remove HTML/markdown comments <!-- ... -->
 * - Strip trailing whitespace per line
 * - Collapse 3+ consecutive blank lines to 2
 *
 * Phase 1 saving: ~330t per full install (version stripping from skills + briefs) + ~76t structural.
 *
 * Phase 2 (deferred — requires behavioral regression tests before landing):
 * - Convert verbose bullet lists to keyword-dense tables
 * - Remove filler phrases ("Please note that", "Make sure to", "It is important to")
 * - Collapse repeated boilerplate sections across files into a single shared definition
 */
export function smartCrush(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .replace(/^(---\n(?:(?!---)[^\n]*\n)*)version:[^\n]*\n/m, "$1")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/[Pp]lease note that\s*/g, "")
    .replace(/([Mm])ake sure to\s*/g, (match, p1) => (p1 === "M" ? "Ensure " : "ensure "))
    .replace(/([Ii])t is important to\s*/g, (match, p1) => (p1 === "I" ? "Must " : "must "))
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd() + "\n";
}

// --- Token savings estimator (used in tests) ---------------------------------

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
