# IMP-001: GraphWard Context Orchestrator and provider-backed initialization

## Classification
- Depth: Comprehensive
- Type: architecture
- Risk: high
- Scope: repository file selection, graph construction, provider lifecycle, initialization, context retrieval, CLI/MCP contracts, validation, canonical skills/workflows, and release tests

## Analysis
- Mode: proposal based on the user-approved revised plan
- Freshness gate: stale risk accepted for this implementation only. The current freshness command returned `Block implementation`; relevant source is therefore re-read directly and stale generated intelligence is not treated as authority.
- Graph inputs consulted: `.graphward/graph/dependency-graph.json` and current `impact` output for setup, context, graph, installer, MCP, CLI, validation, and templates.
- Directly affected: `src/graph/**`, `src/context/**`, `src/installer/**`, `src/orchestrators/**`, `src/mcp/**`, `src/cli/**`, `src/validation/**`, `src/types.ts`, canonical workflow/skill templates, and tests.
- Indirectly affected: claims/evidence, brief generation, gates, adapter rendering, package contents, generated IDE artifacts, and the internal benchmark harness.
- Risk factors: third-party executable installation, cross-platform process execution, stale provider output, prompt/retrieval poisoning, public CLI/MCP changes, and existing user-owned worktree changes.

## Validation Requirements
- Unit, integration, package dry-run, native/offline fallback, provider contract, path-policy, graph normalization, context-pack, CLI, MCP, installer-manifest, and canonical-template tests.
- Type safety: required.
- API compatibility: required for CLI and MCP; existing tools remain compatible wrappers.
- Migration safety: required for GraphWard config/manifest files; no database migration applies.
- Dependency security: required if package dependencies change.
- LLM prompt injection: required because retrieved content is passed to agents.
- Acceptance mapping: required.

## Intelligence Artifacts Affected
- Knowledge base architecture/runtime/API/integration/technical-debt documents.
- Architecture decisions, coding patterns, context maps, graph artifacts, claims, provider manifest, AI-DLC state, backlog, and change history.

## Evidence
- `package.json` — package 3.5.0, Node 20.11+, published file boundaries.
- `src/orchestrators/setup.ts` — current initialization orchestration and native graph fallback.
- `src/context/index.ts` — current ContextPack v1 and verified-claim loading.
- `src/graph/index.ts` and `src/graph/builders/dependency.ts` — current graph construction/query boundary.
- `src/installer/index.ts` and `src/validation/index.ts` — install manifest and doctor behavior.
- `src/cli/index.ts` and `src/mcp/index.ts` — public command/tool surfaces.
- `src/templates.ts` and `templates/canonical/**` — canonical skill/workflow ownership.

## Unknowns
- Exact third-party Graphify and CCE install commands and output shapes can change upstream; compatibility is isolated behind versioned adapters and must be proven with opt-in real-provider smoke tests.
- A live npm vulnerability audit requires network authorization and is not represented as passed until CI or an approved local run succeeds.
- Windows and Linux behavior cannot be proven on this macOS host; CI matrix evidence is mandatory before default enablement.

## User Approval
- The user explicitly instructed: `PLEASE IMPLEMENT THIS PLAN` on 2026-09-02. This approves FEAT-001 through FEAT-005 as scoped below. Destructive public API removal and administrator-level prerequisite installation remain excluded.
