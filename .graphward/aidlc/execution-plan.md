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

That historical unit has no remaining local implementation. A release cannot be called fully handled until action 1 passes in CI.

## Current unit: autorouter rollback and agent reliability repairs (2026-10-10)

User request: revert the last two commits and prepare a complete repair plan for launcher and coding-agent failures. Local history-preserving revert identities: `a602021` and `a4a0ba1`. Uncommitted package/CLI files and their full patch were saved separately; the router-dependent edits were not reapplied.

Implementation-ready design and acceptance matrix: [PLAN-011-agent-reliability-repair.md](/Users/vinithr/personal/AI/engineering-intelligence-OS/.graphward/reports/PLAN-011-agent-reliability-repair.md). R0 is rollback; The table below records the earlier plan; current implementation and remaining qualification are updated under IMP-012. Local checks are recorded in the rollback construction summary. Publication, global installation repair, external project updates and actual provider acceptance remain separate actions.

| Unit | Depends on | Scope | Status |
| --- | --- | --- | --- |
| R0 rollback | — | Exact two-commit scope; backups; clean output | Reverted locally |
| R1 launcher lifecycle | R0 | Package build/finalizer; installed/link tests | Implemented locally |
| R2 verification truth | R0 | Verification, change parsing, receipts/processes | Implemented locally |
| R3 runtime identity | R1 | Shared invocation contract, adapters/hooks/MCP | Implemented locally |
| R4 readiness | R1, R3 | Doctor/install/health and hook diagnostics | Implemented locally |
| R5 agent contracts | R2, R3, R4 | Canonical routes and provider loading | Implemented locally |
| R6 qualification | R1–R5 | Exact package/platform/host checks, CI/docs/sync | Local and Claude checks pass; remaining native/platform/held-out gates open |

## Approved implementation: IMP-012 (2026-10-11)

Documentation follow-up IMP-014 (2026-10-12): user requested the full README guide. Scope limited to text and affected onboarding/delivery records. Context and computed README impact inspected; unsupported guarantees/examples removed; source/profile checks, syntax/links, actual CLI help/version and independent review completed. No source implementation, provider rebuild, publication or external migration. A–F qualification and PLAN-013 approval status remain separate.

The user approved the full reliability/requirements/accuracy plan. Execute sequentially: A runtime and verification → B provider context → C task contracts → D native adapters/hooks → E/F integrated accuracy and release qualification. IMP-012 defines ownership, dependencies and acceptance. Baseline: 437/437. Native host/remote qualification remains separate from local evidence.

Final local verification passed 488/488 with unchanged bytes during checks. Claude native qualification passed against candidate 222cd268ee8202c93c8f272ee6aeb867b018aebfaf7aab00347f294dd51cad87. Codex checkout exact-hook trust is reviewed. Release-qualification.json fails closed on missing current-candidate Codex/Antigravity and held-out measurements.

## IMP-016: approved measurement foundation — 2026-10-18

Task quality-efficiency-foundation-2026-10-18 revision 2 is host-confirmed. FEAT-006/TKT-011–013 are the only new implementation scope. Prerequisites passed: current providers, readiness true, hashed 17-path archive, npm test PASS (169436 ms; 12 pre-existing source/test paths). Baseline tooling, telemetry and separate efficiency evaluation have disjoint ownership. Integrate contracts, preserve original product bytes/release files, run focused checks, sync affected intelligence and perform stable full verification. Later workflow changes and real model experiments remain excluded.

IMP-016 local implementation result: focused 44/44, full 578/578 and original-product preservation pass. Global knowledge gate remains open on 9 pre-existing documents; FEAT-006 in-review. Later units remain pending. Detailed evidence: reports/efficiency-foundation-2026-10-18/IMPLEMENTATION.md.

## IMP-017 / FEAT-007: confirmed Phase 2 — 2026-10-19

Native task quality-efficiency-concise-2026-10-18 revision 2 is host-observed and implementation-ready; both providers are current with no reduced-context decision. TKT-014 (strict-default opt-in mode, intent and rendering), TKT-015 (authority/tool/session boundaries), TKT-016 (preservation, verification, review and intelligence) deliver this feature. Clear the source-verified freshness gate and baseline full verify before product edits, then delegate the bounded source/test/template changes to the named graphward agent. Independent security review focuses on false read-only exemptions, session binding, canonical scope and tool attribution. Whole-response budgeting, receipt identity, cache reuse, downstream migration and real model experiments remain later units.

Local result: FEAT-007/TKT-014–016 done. Build, focused120/120, full594/594, independent final11/11, combined change validation and construction exit gate pass. Citations472/472 and claims560/560 current; freshness Proceed38artifacts.301unrelatedpaths and6foundationhashes preserved. FEAT-006 local knowledge review closed by this integrated proof. Precise limits and unchanged later-unit boundaries are in reports/concise-workflow-2026-10-19/IMPLEMENTATION.md.

## AUDIT-REPAIR-20261026 — 2026-10-26

User approved all45 findings under native task e5ad3bc6-7e7f-4a7e-96ff-3ba5d95ddb2b revision2. Three disjoint implementation owners; lead integrates CLI/MCP/contracts. Dependency order and preservation boundary: reports/IMP-20261026-ai-ide-repairs.md. Status: baseline/preflight; no product fixes yet. No per-feature gate or commits/publishing/global updates.

## AUDIT-REPAIR-20261026 — local completion, 2026-10-27

All45audited corrections applied as81owned product paths after frozen candidate validation. Candidate and original-root full suites658/658; integration16/16; replay36/36; deterministic validation and Construction exit pass.37affected canonical artifacts synchronized,152citations and603claims verified, freshness Proceed. Exact evidence/limits: `.graphward/reports/repairs-2026-10-26/DELIVERY.md`. Existing installedmanifest1.3.1/1.3.3drift and desktop MCP reconnect remain activation work; no native/remote/outcome claim.

AI-DLC: Construction -> Local repairs verified and synchronized -> Complete locally
