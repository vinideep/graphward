# Architecture Decisions
<!-- freshness: last_checked=2026-09-03 -->

## AD-1: GraphWard owns canonical knowledge

Repository truth outranks GraphWard artifacts; verified GraphWard knowledge outranks provider evidence. Graphify extracts structure and CCE retrieves current spans, but neither provider writes canonical prose. Provider-only and contested graph relationships retain their trust labels. (evidence: src/orchestrators/initialize.ts, src/graph/provider-evidence.ts, src/context/orchestrator.ts)

## AD-2: One orchestrated MCP surface

Agents discover five consolidated GraphWard tools by default. Legacy calls stay compatible but hidden; raw provider tools require explicit expert mode. This keeps provider selection, scope and fallback deterministic. (evidence: src/mcp/index.ts, src/mcp/consolidated.ts)

## AD-3: One project-file policy

Graphing, retrieval, claims and gates share `ProjectFilePolicy`, including monorepo roots, explainable precedence, secret exclusions and escape prevention. (evidence: src/project-files/index.ts)

## AD-4: Providers are optional, pinned and transactional

Provider absence activates native fallback unless the project requires providers. Managed binaries use pinned compatibility tuples, staged installation, health checks, fingerprints, atomic activation and rollback. (evidence: src/providers/compatibility.ts, src/providers/manager.ts)

## AD-5: Canonical templates render adapters

Skills, agents and workflows are authored under `templates/canonical/` and rendered to each selected IDE. `.agent` and `.agents` are distinct adapter outputs. (evidence: src/templates.ts, src/adapters/index.ts)
