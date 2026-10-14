<!-- graphward:start -->
# GraphWard OS

This repository uses installed GraphWard workflows.

- When the .claude/agents/ directory is available, start non-trivial work with the engineering-orchestrator custom agent. It routes the request to the right specialist and keeps the workflow evidence-based.
- For initial understanding and documentation, invoke `initialize-graphward` or ask the agent to initialize GraphWard.
- For implementation work, invoke `graphward` with the request or ask the agent to apply the GraphWard workflow. This workflow embeds AI-DLC and Agile delivery modes internally.
- For epic-sized initiatives, invoke `decompose-backlog` to autonomously create an Epic → Feature → Ticket backlog under `.graphward/aidlc/agile/backlog/`, then `deliver-backlog` to implement it feature by feature. Each feature requires human approval before implementation; the local backlog is the source of truth and can optionally be mirrored to GitHub Issues.
- For architecture mapping, impact analysis, synchronization, or review, invoke `map-architecture`, `analyze-impact`, `sync-graphward`, or `review-engineering-change`; these workflows do not modify product code.
- Canonical generated outputs live in `.graphward/knowledge-base/`, `.graphward/aidlc/`, `.graphward/memory/`, `.graphward/context/`, `.graphward/events/`, `.graphward/graph/`, `.graphward/reports/`, `.graphward/flight/`, and `.graphward/changes/`.
- Before non-trivial edits, write an impact report; after edits, validate and incrementally synchronize only affected intelligence and graph artifacts.
- AI-DLC work must preserve durable state in `.graphward/aidlc/aidlc-state.md`, maintain Agile artifacts, use environmental backpressure, and end with an `AI-DLC: <phase> -> <stage> -> <status>` breadcrumb.
- Base documentation claims on repository evidence and identify unknowns explicitly.
- **Prefer persisted intelligence over re-exploration.** Before reading source files to understand the codebase, read the persisted knowledge base in `.graphward/knowledge-base/`, context maps in `.graphward/context/`, and architecture graphs in `.graphward/graph/`. Re-read source only for the specific files a task touches. Run `sync-graphward` to refresh these artifacts incrementally rather than re-deriving from scratch each session.
- **Route before loading skills.** Consult `.claude/WORKFLOW-ROUTING.md` and `.claude/skills/SKILLS-INDEX.md` before opening an internal `SKILL.md`. Entry workflows are model-invocable; internal engines are loaded only through the selected route.
- When Codex is the active provider and `.codex/agents/*.toml` is present, delegate non-trivial implementation work to the named `graphward` custom agent and wait for its result; use `engineering-orchestrator` for routing or decomposition. These are spawned agent sessions, not desktop slash commands.

## Tools (prefer these over reasoning by hand)

These run deterministically. Use them instead of inferring the answer from source — they are the difference between a computed fact and a guess. Available over MCP (server `graphward`) and as CLI commands:

- `get_engineering_context` — build ContextPackV2 from verified GraphWard knowledge, canonical structure, and current scoped code
- `analyze_change_impact` — compute direct and indirect impact, affected tests, risks, and unknowns
- `validate_change` — run impact, safety gates, claims, knowledge, and citation validation
- `sync_engineering_knowledge` — refresh affected graph, provider indexes, claims, and knowledge health after edits
- `provider_status` — report pinned provider health, versions, fallbacks, and remediation
- `simulate_change_intent` — simulate pre-edit change intent blast radius, routes, and tests
- `evaluate_counterfactual` — evaluate tentative patch overlay branch and detect introduced dependency cycles
- `assess_risk` — compute multi-dimensional risk profile and tiered verification plan
- `slice_graph` — hierarchically slice monorepo graph at global, package, community, or task level

CLI equivalents: `"/Users/vinithr/.nvm/versions/node/v22.16.0/bin/node" "/Users/vinithr/personal/AI/engineering-intelligence-OS/dist/cli/index.js" map|gate <name>|verify|freshness|context|claims verify|git-analysis .`. `gate` and `verify` exit non-zero on failure, so they work in CI too.

- Native hook integration is generated. Discovery, connection and enforcement require separate host qualification; hooks are guardrails with documented bypasses.
- **Task gate.** Until a task is confirmed, hooks allow only discovery: file reads, GraphWard read tools, and read-only shell commands (`ls`, `cat`, `rg`, `grep`, `find`, `git log/diff/show`, `sed -n 'N,Mp'`, pipelines of these). To edit: `propose_task_contract` (pass host and sessionId; scope accepts prefixes or globs) → follow its `howToConfirm` (Claude Code: `AskUserQuestion` containing the exact challenge with an `Approve scope` option) → `prepare_task_context` with taskId → `get_task_readiness`. Edits inside the confirmed scope keep context valid; file edits outside this project are not gated; finish with `gw verify .`.

## Token-Efficient Skill Loading (Claude Code)

**Three-tier loading protocol** — follow this order on every invocation:

**Tier 1 — Routing (load once, always pinned)**
1. `.claude/WORKFLOW-ROUTING.md` — primary/optional skill map per command (~400t)
2. `.claude/skills/SKILLS-INDEX.md` — one-line description of all 48 skills (~1,500t)

**Tier 2 — Brief (load per identified skill, ~150t each)**
Load `.claude/skills/<name>/SKILL-BRIEF.md` for each primary skill identified in the routing table.
The brief confirms relevance and summarises inputs — do not execute the skill from the brief alone.

**Tier 3 — Full skill (load at execution time only)**
Load `.claude/skills/<name>/SKILL.md` immediately before executing that skill's procedure.
Never skip this step — the brief does not contain the complete procedure.

Load **optional** skills only when the request explicitly requires that capability.

## Enforcement Hooks (Claude Code)

`.claude/settings.json` wires four lifecycle hooks to `gw hook <event>`:
- **SessionStart** injects the current intelligence freshness/drift summary.
- **PreToolUse** warns before editing source while documentation is stale.
- **PostToolUse** records changed source files and validation commands for the session.
- **Stop** can require that a validation command actually ran before finishing.

Tune behaviour in `.graphward/gw.config.json` (`hooks.blockStaleEdits`, `hooks.requireValidationOnStop`, `hooks.freshnessThreshold`). Hooks are fail-safe: with no intelligence installed they do nothing.
<!-- graphward:end -->
