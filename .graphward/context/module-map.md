# Module Map
<!-- freshness: last_checked=2026-10-13 -->

| Module | Responsibility |
|---|---|
| `src/orchestrators/initialize.ts` | One-command install, provider bootstrap, graph/index/claims and deterministic knowledge |
| `src/project-files/index.ts` | Shared include/exclude and path-safety policy |
| `src/providers/manager.ts` | Provider lifecycle, locking, activation, rollback and status |
| `src/providers/graphify.ts` | Approved-scope Graphify extraction |
| `src/providers/cce.ts` | Approved-scope CCE indexing/retrieval and native fallback |
| `src/providers/workspace.ts` | Source snapshot (per-file hashes, workspace generation) and provider mirror |
| `src/graph/provider-evidence.ts` | Provider normalization and reconciliation into GraphWard graph |
| `src/context/orchestrator.ts` | Knowledge-first, token-budgeted ContextPackV2 assembly |
| `src/context/preparation.ts` | Explicit bounded provider/graph refresh producing a preparation receipt |
| `src/aidlc/task-contract.ts` | Task proposals, user confirmation, scope matching, context binding and readiness |
| `src/hooks/index.ts` | Host lifecycle hooks: discovery classification, readiness gating, freshness hints, stop-time verification |
| `src/mcp/consolidated.ts` | Consolidated MCP tool registry advertised to agents |
| `src/orchestrators/change.ts` | Deterministic validation and post-edit synchronization |
| `src/orchestrators/health.ts` | Install, graph, knowledge, freshness, claims and provider trust sweep |
| `src/freshness/index.ts` | Citation/date-based document freshness scoring |
| `src/evidence/index.ts` | Line- and byte-hash evidence snapshots for knowledge citations |
| `src/templates.ts` | Canonical skill/agent/workflow inventory and validation |
| `src/adapters/index.ts` | Per-IDE rendering, including `CLAUDE.md`/`AGENTS.md` instructions and hook settings |
| `src/installer/index.ts` | Safe adapter installation/update/uninstall |

(evidence: src/orchestrators/initialize.ts, src/context/orchestrator.ts, src/context/preparation.ts, src/aidlc/task-contract.ts, src/hooks/index.ts, src/mcp/consolidated.ts, src/freshness/index.ts, src/evidence/index.ts, src/templates.ts, src/adapters/index.ts)
