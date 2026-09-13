# Module Map
<!-- freshness: last_checked=2026-09-03 -->

| Module | Responsibility |
|---|---|
| `src/orchestrators/initialize.ts` | One-command install, provider bootstrap, graph/index/claims and deterministic knowledge |
| `src/project-files/index.ts` | Shared include/exclude and path-safety policy |
| `src/providers/manager.ts` | Provider lifecycle, locking, activation, rollback and status |
| `src/providers/graphify.ts` | Approved-scope Graphify extraction |
| `src/providers/cce.ts` | Approved-scope CCE indexing/retrieval and native fallback |
| `src/graph/provider-evidence.ts` | Provider normalization and reconciliation into GraphWard graph |
| `src/context/orchestrator.ts` | Knowledge-first ContextPackV2 assembly |
| `src/mcp/consolidated.ts` | Default five-tool MCP surface |
| `src/orchestrators/change.ts` | Deterministic validation and post-edit synchronization |
| `src/orchestrators/health.ts` | Install, graph, knowledge, freshness, claims and provider trust sweep |
| `src/templates.ts` | Canonical skill/agent/workflow inventory and validation |
| `src/installer/index.ts` | Safe adapter installation/update/uninstall |

(evidence: src/orchestrators/initialize.ts, src/context/orchestrator.ts, src/mcp/consolidated.ts, src/templates.ts)
