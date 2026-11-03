# Module Map
<!-- freshness: last_checked=2026-10-27 -->

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
| `src/hooks/index.ts` | Effect-aware readiness, freshness and Stop verification; concise session fingerprints/fallback |
| `src/routing/catalog.ts` | Advisory request intent and dedicated workflow selection |
| `src/config/index.ts` | Strict-default workflow mode, provider and project configuration normalization |
| `src/token-optimizer.ts` | Mode branch selection before instruction parsing/compression and routing generation |
| `src/mcp/consolidated.ts` | Consolidated MCP tool registry advertised to agents |
| `src/orchestrators/change.ts` | Deterministic validation and post-edit synchronization |
| `src/orchestrators/health.ts` | Install, graph, knowledge, freshness, claims and provider trust sweep |
| `src/freshness/index.ts` | Citation/date-based document freshness scoring |
| `src/evidence/index.ts` | Line- and byte-hash evidence snapshots for knowledge citations |
| `src/templates.ts` | Canonical skill/agent/workflow inventory and validation |
| `src/adapters/index.ts` | Per-IDE rendering, including `CLAUDE.md`/`AGENTS.md` instructions and hook settings |
| `src/installer/index.ts` | Safe adapter installation/update/uninstall |
| `src/telemetry/index.ts` | Compatible usage recording, explicit accounting/completeness and linked-child reconciliation |

(evidence: src/orchestrators/initialize.ts, src/context/orchestrator.ts, src/context/preparation.ts, src/aidlc/task-contract.ts, src/hooks/index.ts, src/routing/catalog.ts, src/config/index.ts, src/token-optimizer.ts, src/mcp/consolidated.ts, src/freshness/index.ts, src/evidence/index.ts, src/templates.ts, src/adapters/index.ts, src/telemetry/index.ts)


## Initialization integrity repair — 2026-10-15

Provider relationships are admitted only when both normalized endpoints exist. Rejected raw relationships, available endpoints, trust/source hashes and run provenance are returned without side effects and written by graph-write paths to the quarantine report; write:false remains read-only. Contested/provider-only evidence is never upgraded into semantic proof. (evidence: src/graph/provider-evidence.ts, src/graph/index.ts, test/provider-context-reliability.test.mjs)

The shared citation parser handles annotated/backticked references, ranges, multi-spans, Source tables, grouped/bracketed routes and JSON evidence arrays. Source reads enforce shared policy, lexical/realpath containment and runtime/secret exclusions. Hash caches last for one operation; legacy hashes and newly unrecorded references remain fail-closed until reviewed. Health rejects graph duplicates/missing endpoints and unverified material documents; explicit directory-only navigation is narrowly classified. (evidence: src/evidence/index.ts, src/orchestrators/health.ts, test/evidence.test.mjs, test/orchestrators.test.mjs, test/shiplogic-integration.test.mjs)

## Audit repair boundaries

| Module | Responsibility |
|---|---|
| `src/graph/trust.ts` | Shared factual-edge admission for queries and context |
| `src/manifest/paths.ts` | Contained managed-path validation |
| `src/gates/review-evidence.ts` | Current source/scope/runtime review bindings |
| `src/runtime/invocation.ts` | Finalized module generation and loaded/disk identity |
| `src/experiment/baseline.ts` | Owned pre-edit bytes, modes and index for preservation |

(evidence: src/graph/trust.ts, src/manifest/paths.ts, src/gates/review-evidence.ts, src/runtime/invocation.ts, src/experiment/baseline.ts)
