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

## Active unit: IMP-005 agent accuracy and enforcement remediation

Implement in dependency order:

1. One typed routing catalog and provider-capability profiles.
2. Dependency-closed adapter rendering and reference-closure tests.
3. One typed executable gate registry consumed by validation and AI-DLC exits.
4. API snapshot, security, rollback, and convention gate implementations.
5. Single-writer learned-pattern proposal and promotion flow with legacy migration.
6. Risk/orchestrator/rule alignment, hook enforcement, and strict doctor diagnostics.
7. Full build, unit/integration suite, disposable installs, synchronization, and change record.

Acceptance is defined in `.graphward/reports/IMP-005-agent-accuracy-enforcement.md`.

Status: complete locally. Evidence is recorded in
`.graphward/aidlc/construction/agent-accuracy-enforcement/build-and-test/build-and-test-summary.md`
and `.graphward/changes/CHG-004-agent-accuracy-enforcement.md`. Machine-global legacy
skill cleanup remains intentionally unexecuted because it is destructive and outside
the repository-managed bundle.

No product implementation unit remains open locally. A release cannot be called fully handled until action 1 passes in CI.
