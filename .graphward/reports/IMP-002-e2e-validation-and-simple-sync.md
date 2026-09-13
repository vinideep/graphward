# IMP-002: End-to-end project onboarding and incremental synchronization

## Classification
- Type: feature + bugfix + documentation
- Depth: comprehensive
- Risk: medium
- Scope: provider-policy defaults, initialization CLI/API, deterministic sync CLI and graph merging, Shiplogic-style integration coverage, and user documentation

## Analysis
- Mode: proposal validated against the current working tree and a disposable Shiplogic-style project
- Freshness gate: Proceed for checkable artifacts; seven generated JSON/brief artifacts are `unverifiable` and remain manual-review items. The ContextPackV2 trust state is healthy with native retrieval.
- Graph inputs consulted: `.graphward/context/repo-brief.md`, `module-map.md`, `runtime-map.md`, `critical-paths.md`, `dangerous-areas.md`, `graph/dependency-graph.json`, and ContextPackV2 for the CLI/initialization scope
- Directly affected: `src/config/index.ts`, `src/orchestrators/initialize.ts`, `src/cli/index.ts`, `src/graph/index.ts`, `src/graph/builders/dependency.ts`, tests for initialization/graph/integration, and `README.md`
- Indirectly affected: provider fallback behavior, generated adapter setup, claims/graph synchronization, health/doctor output, and users maintaining existing EI-enabled projects
- Risk factors: provider availability is optional by default; explicit `--require-providers` must remain strict; the sync command must never rewrite canonical prose or provider-owned evidence into GraphWard knowledge

## Reproduction evidence
- The existing full suite passed: `214/214` tests.
- The existing integration suite passed: `13/13` tests.
- A disposable Shiplogic-style project with `.claude`, TypeScript route/provider modules, and a user-owned settings file initialized successfully in native mode; graph, claims, knowledge, context, doctor, and verify all worked.
- Direct initialization with no provider policy and unavailable providers returned `policy: full`, `ok: false`, and `degraded: true`; this conflicts with the documented `auto` fallback contract.
- The current dogfooding checkout reports one doctor error because its install manifest records package version `3.5.0` while the canonical package is `4.2.0`.

## Validation Requirements
- Add a regression test proving omitted provider policy means `auto` with optional native fallback.
- Add a Shiplogic-style CLI integration test covering auto-detected IDE preservation, native initialization, ContextPackV2, strict claims, verification, health, and an explicit-file incremental sync.
- Add a user-facing `sync` CLI command that updates graph/provider indexes/derived claims and reports when model-assisted canonical prose synchronization is still required.
- Run build, focused tests, integration tests, full tests, strict claims/evidence/health checks, and deterministic verification.
- Type safety: required (TypeScript build).
- API compatibility: not applicable to an application API; CLI surface is additive and needs help/integration coverage.
- Migration safety: not applicable; config default normalization is backward-compatible for explicit settings.
- Acceptance mapping: required.

## Intelligence Artifacts Affected
- `.graphward/knowledge-base/01-repository-structure.md` and `.graphward/knowledge-base/13-onboarding.md` if their command/setup guidance changes.
- `.graphward/context/module-map.md` and `.graphward/context/runtime-map.md` for the new deterministic sync entry point.
- `.graphward/aidlc/checkpoints.md`, `aidlc-state.md`, and the active construction build/test summary.
- The normalized graph and derived claims after source changes; provider caches remain disposable.

## Evidence
- `src/config/index.ts`
- `src/orchestrators/initialize.ts`
- `src/orchestrators/change.ts`
- `src/cli/index.ts`
- `src/providers/manager.ts`
- `test/initialize.test.mjs`
- `test/install-integration.test.mjs`
- `README.md`

## Unknowns
- Remote cross-platform provider CI jobs cannot be proven from this local checkout.
- A live IDE agent following the generated workflow cannot be fully simulated by a CLI test; the integration test proves the deterministic filesystem/runtime path only.
- The current checkout's stale install manifest was repaired through the supported update path; the dry run and live update both reported zero adapter changes and zero conflicts.

---
*The pre-edit scope analysis above did not modify product code.*

## Post-implementation validation

- `npm run build` passed.
- `npm test` passed sequentially with `219/219` tests; `npm run test:integration` passed `14/14` tests.
- Full provider smoke passed on local macOS arm64: Graphify and CCE were active, the 30-query corpus reached Recall@10 `0.90`, and strict provider health passed.
- `health . --strict`, `claims verify . --strict`, and the current `verify` receipt passed with `277/277` derived claims verified, zero knowledge drift, and zero stale evidence citations.
- `api-diff` and `migration-lint` passed. `env-vars` remains advisory because no `.env.example` exists; `dead-exports` remains advisory with conservative warnings.
- The affected source scope was synchronized incrementally. Canonical prose was not rewritten; the Shiplogic test verifies that source edits raise the model-synchronization handoff.
- The final incremental graph matched a subsequent full rebuild at `754` nodes and `1,879` edges, proving that provider-only evidence and cross-file calls do not accumulate or disappear across updates.

The pre-edit analysis above remains the scope record; implementation and final evidence are recorded in `changes/CHG-002-e2e-validation-and-simple-sync.md`.
