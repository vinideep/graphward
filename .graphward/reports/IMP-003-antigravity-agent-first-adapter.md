# IMP-003: Make Antigravity Agent output primary while preserving Workflows

## Classification
- Type: architecture
- Risk: medium-high
- Scope: Antigravity adapter rendering, managed-file manifest behavior, validation, adapter/installer tests, and user-facing adapter documentation.

## Analysis
- Mode: proposal
- Freshness gate: Proceed; scoped ContextPackV2 evidence is healthy and freshness scores are above threshold.
- Graph inputs consulted: `.graphward/graph/dependency-graph.json`, `.graphward/context/repo-brief.md`, `.graphward/context/dangerous-areas.md`, `.graphward/knowledge-base/01-repository-structure.md`, `.graphward/knowledge-base/10-integrations.md`, `.graphward/memory/architecture-decisions.md`.
- Directly affected: `src/adapters/index.ts`, `src/installer/index.ts` only if manifest migration needs a helper, `src/validation/index.ts` only if validation needs to recognize the modern format, Antigravity adapter tests, and README adapter documentation.
- Indirectly affected: install/update/uninstall conflict handling, adapter inventory validation, visualizer/template consumers, and existing Antigravity project upgrades.
- Risk factors: host-specific file-discovery contract; existing users may have edited managed files; duplicate agent/workflow outputs could create ambiguous discovery; the current GUI adapter and CLI adapter intentionally use different path conventions.

## Design Decision
- Add a native Markdown custom-agent renderer for Antigravity-compatible adapters.
- Keep existing Workflow rendering as a compatibility surface; do not delete or rename canonical Workflows.
- Preserve the current Antigravity CLI adapter contract unless tests and host documentation prove the same migration is safe for that surface.
- Make migration additive and conflict-aware: newly rendered modern files are managed, while existing legacy files remain untouched unless the user explicitly chooses a later migration cleanup.

## Validation Requirements
- [ ] Modern Antigravity adapter emits `.agents/agents/<name>/agent.md` with valid YAML frontmatter and the agent prompt body.
- [ ] Antigravity Workflows remain rendered and invokable through existing destinations.
- [ ] Other IDE adapter inventories remain unchanged.
- [ ] Installer update preserves user-edited legacy and modern managed files and reports conflicts.
- [ ] Uninstall removes only files recorded in the manifest and does not remove user-created files.
- [ ] TypeScript build and complete test suite pass.
- [ ] Existing integration journey remains green.
- [ ] `doctor` and `health --strict` remain green after synchronization.

## Intelligence Artifacts Affected
- `.graphward/graph/dependency-graph.json` — adapter rendering edges and template consumers may change.
- `.graphward/context/module-map.md` and `repo-brief.md` — adapter output behavior changes.
- `.graphward/knowledge-base/01-repository-structure.md` and `10-integrations.md` — modern Antigravity paths and compatibility behavior.
- `.graphward/changes/` — implementation and validation record.

## Evidence
- `src/adapters/index.ts` currently renders Antigravity GUI agents as JSON plus prompt files and renders workflows separately.
- `src/templates.ts` has independent canonical Agent and Workflow inventories.
- `src/installer/index.ts` tracks rendered files by path/hash and preserves conflicts.
- `test/adapters.test.mjs` asserts current Antigravity CLI agent paths and inventories.
- `test/installer.test.mjs` covers managed-file preservation and update behavior.

## Unknowns
- Whether every current Antigravity surface discovers `.agents/agents/<name>/agent.md` identically; the public docs explicitly document this for Antigravity 2.0 and CLI, while the GUI adapter's legacy path has backward-compatibility implications.
- Whether existing legacy `.agent/agents/` files should be copied, linked, or left in place; this change will leave them in place to avoid duplicate discovery and unintended overwrites.

---
*This impact analysis was completed before product code edits.*
