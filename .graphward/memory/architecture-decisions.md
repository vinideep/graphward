# Architecture Decisions
<!-- freshness: last_checked=2026-10-13 -->

## AD-1: GraphWard owns canonical knowledge

Repository truth outranks GraphWard artifacts; verified GraphWard knowledge outranks provider evidence. Graphify extracts structure and CCE retrieves current spans, but neither provider writes canonical prose. Provider-only and contested graph relationships retain their trust labels. (evidence: src/orchestrators/initialize.ts, src/graph/provider-evidence.ts, src/context/orchestrator.ts)

## AD-2: One orchestrated MCP surface

MCP discovery lists only the consolidated GraphWard registry (task contract, context, impact, validation, sync, simulation, AI-DLC, flight, memory and graph tools — about thirty). Legacy tool names stay callable as hidden compatibility wrappers; raw provider tools require explicit expert mode. This keeps provider selection, scope and fallback deterministic. Context-producing tools must return budget-sized payloads; full packs are opt-in (`format: "full"`). (evidence: src/mcp/index.ts, src/mcp/consolidated.ts)

## AD-3: One project-file policy

Graphing, retrieval, claims, gates and the task source snapshot share `ProjectFilePolicy`, including monorepo roots, explainable precedence, secret exclusions and escape prevention. (evidence: src/project-files/index.ts, src/providers/workspace.ts)

## AD-4: Providers are optional, pinned and transactional

Provider absence activates native fallback unless the project requires providers. Managed binaries use pinned compatibility tuples, staged installation, health checks, fingerprints, atomic activation and rollback. (evidence: src/providers/compatibility.ts, src/providers/manager.ts)

## AD-5: Canonical templates render adapters

Skills, agents and workflows are authored under `templates/canonical/` and rendered to each selected IDE; host instruction files (`CLAUDE.md`, `AGENTS.md`) are rendered from `src/adapters/index.ts`. `.agent` and `.agents` are distinct adapter outputs. (evidence: src/templates.ts, src/adapters/index.ts)

## AD-6: Mutations require a user-confirmed task; discovery never does

Hooks deny non-discovery tool calls until a task contract is confirmed through a host-observed channel and context is prepared and bound. Discovery (reads, GraphWard read tools, provably read-only shell) is always allowed so agents can understand the code before proposing scope. Bound context survives the task's own in-scope edits and is invalidated by out-of-scope drift. (evidence: src/hooks/index.ts, src/aidlc/task-contract.ts)
