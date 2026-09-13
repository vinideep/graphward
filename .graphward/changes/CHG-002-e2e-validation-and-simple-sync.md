# CHG-002: End-to-End Validation and Simple Incremental Sync

## Meta

- Date: 2026-09-03
- Type: bugfix, implementation, documentation, validation
- Status: locally validated; remote provider matrix pending
- Related impact report: `reports/IMP-002-e2e-validation-and-simple-sync.md`

## Problem

After the previous changes, default initialization could treat the `full`
provider path as implicitly required. A new project with unavailable providers
could therefore fail even though GraphWard has a complete native fallback. The update
path also lacked a simple deterministic CLI command for refreshing only the
changed intelligence artifacts.

## Changes

- Made provider requirement explicit through `--require-providers` and
  `providers.requireProviders`; missing optional providers remain visible as a
  degraded native fallback.
- Added the `sync` CLI command with explicit-file scoping and JSON output.
- Made source edits explicitly request model-assisted synchronization of only
  affected canonical prose sections.
- Fixed incremental graph merging to remove prior provider-only projections,
  keep unchanged targets whose evidence cites a changed importer, and resolve
  changed-file call edges against the unchanged symbol graph.
- Added a disposable Shiplogic-shaped real-CLI integration test.
- Simplified the README and documented the fast path in `WORKFLOW_GUIDE.md`.
- Repaired this checkout's stale install manifest through the supported
  `update` command; generated adapter content had zero changes or conflicts.

## Acceptance Matrix

| Requirement | Evidence | Result |
|---|---|---|
| Existing user settings are preserved | Shiplogic fixture retains permissions/model and receives merged GraphWard hooks | ✅ |
| Native initialization works without providers | Optional-provider regression test with unavailable runner | ✅ |
| Strict provider mode still fails on provider execution failure | Existing required-provider test suite | ✅ |
| Incremental sync updates deterministic artifacts only | Shiplogic `sync --files` test; graph contains new module | ✅ |
| Repeated/provider-backed incremental sync stays structurally complete | Graph merge regression tests and final incremental/full parity check: 754 nodes, 1,879 edges | ✅ |
| Canonical prose is not silently overwritten | Overview hash/content unchanged after sync | ✅ |
| Existing repository remains trustworthy after the change | Strict health, claims, evidence, verify, and provider smoke | ✅ locally |

## Affected Product Files

- `src/config/index.ts`
- `src/providers/manager.ts`
- `src/graph/index.ts`
- `src/graph/builders/dependency.ts`
- `src/orchestrators/initialize.ts`
- `src/orchestrators/change.ts`
- `src/cli/index.ts`
- `test/initialize.test.mjs`
- `test/shiplogic-integration.test.mjs`
- `test/graph.test.mjs`
- `test/graphify-evidence.test.mjs`
- `README.md`
- `WORKFLOW_GUIDE.md`
- `package.json`

## Intelligence Synchronization

The affected source scope was passed to the new deterministic sync path. The
current repository reports 277/277 derived claims verified, zero knowledge
drift, zero stale evidence citations, and no actionable freshness drift. The
install manifest was refreshed separately because it is managed adapter state.

## Remaining Risk and Rollback

The provider smoke passed locally on macOS arm64, including the 30-query corpus,
but cross-platform CI remains pending. The dead-export and environment-variable
gates are advisory warnings. Rollback is limited to reverting the listed source,
test, documentation, and package-script changes; no database, provider cache,
credential, or external project state was changed.
