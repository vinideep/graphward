# Architecture Decisions
<!-- freshness: last_checked=2026-10-27 -->

## AD-1: GraphWard owns canonical knowledge

Repository truth outranks GraphWard artifacts; verified GraphWard knowledge outranks provider evidence. Graphify extracts structure and CCE retrieves current spans, but neither provider writes canonical prose. Provider-only and contested graph relationships retain their trust labels. (evidence: src/orchestrators/initialize.ts, src/graph/provider-evidence.ts, src/context/orchestrator.ts)

## AD-2: One orchestrated MCP surface

MCP discovery lists only the consolidated GraphWard registry (task contract, context, impact, validation, sync, simulation, AI-DLC, flight, memory and graph tools — about thirty). Legacy tool names stay callable as hidden compatibility wrappers; raw provider tools require explicit expert mode. This keeps provider selection, scope and fallback deterministic. Context-producing tools must return budget-sized payloads; full packs are opt-in (`format: "full"`). (evidence: src/mcp/index.ts, src/mcp/consolidated.ts)

Current qualification: JSON, Markdown and full packs account for complete serialized payloads using a characters/4 estimate. Optional content is reduced with omission accounting; a minimum identity/status envelope can explicitly overflow tiny budgets. Actual model/session token use remains unmeasured. (evidence: src/context/orchestrator.ts, src/mcp/consolidated.ts)

## AD-3: One project-file policy

Graphing, retrieval, claims, gates and the task source snapshot share `ProjectFilePolicy`, including monorepo roots, explainable precedence, secret exclusions and escape prevention. (evidence: src/project-files/index.ts, src/providers/workspace.ts)

The concise read-only Stop fingerprint is distinct from provider indexing: it covers Git's full verification candidate set, including provider-excluded source, and binds other inventory/configuration by metadata. It stores hashes/metadata rather than source content and does not authorize retrieval or canonical claims. Unsupported entries or incomplete coverage decline the exemption. (evidence: src/hooks/index.ts, src/verify/index.ts)

## AD-4: Providers are optional, pinned and transactional

Provider absence activates native fallback unless the project requires providers. Managed binaries use pinned compatibility tuples, staged installation, health checks, fingerprints, atomic activation and rollback. (evidence: src/providers/compatibility.ts, src/providers/manager.ts)

## AD-5: Canonical templates render adapters

Skills, agents and workflows are authored under `templates/canonical/` and rendered to each selected IDE; host instruction files (`CLAUDE.md`, `AGENTS.md`) are rendered from `src/adapters/index.ts`. `.agent` and `.agents` are distinct adapter outputs. (evidence: src/templates.ts, src/adapters/index.ts)

## AD-6: Mutations require a user-confirmed task; discovery never does

Hooks gate product mutations until a user-confirmed task has prepared, bound context. Confirmed report/handoff writes require requirements-stage readiness and canonical report targets without unrelated implementation-context preparation. Native prompt/question confirmation is host-observed; the interactive operator path retains conversational assurance. Tool identity and actual local effects govern discovery: a copied GraphWard/browser name alone cannot authorize writes. Bound context survives the task's own in-scope edits and is invalidated by out-of-scope drift. Advisory intent never grants authority. (evidence: src/hooks/index.ts, src/aidlc/task-contract.ts, src/routing/catalog.ts)

## AD-7: Current evidence and owned rollback

Version3 verification binds required checks, selected execution, configuration and runtime generation to source/root/HEAD. Reviews bind current candidate scope and reviewer completion. Explicit unavailable and legacy evidence remain non-passing. Rollback requires owned pre-edit state and refuses concurrent drift rather than guessing from HEAD. (evidence: src/verify/index.ts, src/gates/review-evidence.ts, src/experiment/baseline.ts, src/experiment/runner.ts)
