# Execution Plan
<!-- freshness: last_checked=2026-09-03 -->

## Scope

Implement EPIC-001: EI-owned knowledge with Graphify structural evidence, CCE scoped retrieval, native fallbacks, unified project scope, provider lifecycle, ContextPackV2, and release hardening.

## Delivered units

| Unit | Outcome | Status |
|---|---|---|
| `file-policy` | One explainable, escape-safe source policy used by graph, providers, claims, gates and benchmarks | Complete |
| `providers` | Pinned shared installs, fingerprints, locking, atomic activation, rollback, health, repair/upgrade/purge and native fallback | Complete locally |
| `graphify-evidence` | Code-only bootstrap evidence normalized into EI's canonical graph with freshness and contested-edge handling | Complete |
| `context-orchestrator` | Knowledge-first ContextPackV2, graph-scoped CCE retrieval, progressive expansion and consolidated MCP tools | Complete |
| `hardening` | Config migration, typed MCP registry, safe process runner, doctor accuracy, skill/workflow parity, golden corpus and CI matrix | Complete locally |

## Acceptance status

| Gate | Result |
|---|---|
| Build and maintained unit suite | 214/214 pass |
| Integration suite | 13/13 pass |
| Native benchmark and package dry run | Pass |
| Live provider installation and disposable-project initialization | Pass on macOS arm64 |
| Full live provider accuracy corpus | Recall@10 = 0.90; 136 valid current spans; zero scope leakage |
| Claims and citation hashes | 273/273 claims verified; 10/10 evidence hashes current; provider-only relationships excluded |
| Dependency vulnerability audit | Zero vulnerabilities after lockfile update |
| Current-repository Graphify and CCE state | Current and healthy |
| Cross-platform provider CI | Workflow implemented; remote execution still required |

Delivery mode: Design-First with adversarial checks for external process, retrieval, and MCP boundaries. See IMP-001 and the EPIC-001 dependency graph.

## Remaining release actions

1. Execute the provider smoke matrix on Linux x64/arm64, macOS x64/arm64 and Windows x64.
2. Keep provider support beta until every matrix job passes with the pinned compatibility tuple.
3. Review the 118 dead-export warnings against package consumers and Git history only as a separate major-version API exercise; do not mass-delete them.

No product implementation unit remains open locally. A release cannot be called fully handled until action 1 passes in CI.
