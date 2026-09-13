# IMP-002 Build and Test Summary

## Scope

This unit validates the post-conversation changes through the real CLI, using a
disposable Shiplogic-shaped project, and makes the smallest safe update path
available to existing EI-enabled projects.

## Implemented

- Provider-backed initialization is optional by default. `--require-providers`
  is the explicit hard-failure switch.
- Added `gw sync [path] [--files a,b] [--json]` for
  deterministic graph, provider-index, and derived-claim refreshes.
- Source changes report that canonical prose needs an evidence-aware follow-up;
  deterministic sync never rewrites canonical knowledge prose.
- Added real CLI coverage for Shiplogic-style onboarding, IDE auto-detection,
  user settings preservation, ContextPackV2, verification receipts, strict
  health, and incremental sync.
- Corrected incremental graph merging so provider-only evidence is replaced,
  unchanged import targets are retained, and changed-file call edges resolve
  against unchanged symbols. The resulting incremental graph matches a full
  rebuild in the final parity check.
- Serialized the stateful Node test scripts with `--test-concurrency=1` so
  graph-rebuilding test files cannot race on the shared dogfooding artifacts.
- Replaced the dense README with a short user-oriented guide and documented the
  fast sync path in `WORKFLOW_GUIDE.md`.

## Validation Evidence

| Check | Result |
|---|---|
| `npm run build` | ✅ Passed |
| `npm test` | ✅ 219/219 passed, sequential run |
| `npm run test:integration` | ✅ 14/14 passed |
| `npm run test:provider-smoke -- --quick` | ✅ Passed; Graphify and CCE active; strict health passed |
| `npm run test:provider-smoke` | ✅ Passed; 30 queries, Recall@10 0.90, 135 current scoped spans |
| CLI `health . --strict` | ✅ Healthy; 277/277 claims verified, 10/10 evidence citations current |
| CLI `verify . --json` | ✅ Pass receipt at current HEAD |
| CLI `claims verify . --strict` | ✅ Passed |
| `gate api-diff` | ✅ Passed; no breaking endpoint changes |
| `gate migration-lint` | ✅ Passed; no migration files |
| `gate env-vars` | ⚠️ Advisory only; 8 referenced variables and no `.env.example` |
| `gate dead-exports` | ⚠️ Warning only; 118 conservative unused-export findings |
| `git diff --check` | ✅ Passed |

The final incremental graph parity check produced `754` nodes and `1,879`
edges, identical to a subsequent full rebuild; no provider-only node or edge
accumulation remained.

The provider smoke reported four contested Graphify relationships as explicit
unknowns; they were not promoted into claims, and strict health still passed.

Earlier concurrent validation recorded a transient 215/216 result because
stateful graph tests raced. With serialized scripts, isolated suites pass
219/219 and two consecutive verification receipts pass with no failing
subtest.

## Shiplogic Journey Proven

The disposable fixture contains a carrier capability provider and route-plan
module plus an existing `.claude/settings.json`. The test proves:

1. auto-detection chooses `claude-code`;
2. project-owned permissions and model settings survive installation;
3. graph, claims, ContextPackV2, receipt, and strict health are created;
4. adding a domain module and changing route planning updates the graph and
   claims incrementally;
5. the existing canonical overview remains byte-for-byte unchanged; and
6. final claims and health checks remain strict-green.

## Remaining Qualification

Local macOS arm64 provider execution is proven. The GitHub Actions matrix for
Linux x64/arm64, macOS x64/arm64, and Windows x64 remains external release
evidence and cannot be inferred from the workflow definition.
