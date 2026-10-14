# Coding Patterns
<!-- freshness: last_checked=2026-10-13 -->

- Feature areas use focused TypeScript modules and export interfaces beside their operations. (evidence: src/providers/types.ts, src/context/orchestrator.ts)
- Potentially missing files are handled with explicit fallbacks; writes of critical state use a sibling temporary file followed by rename, under a named lock when concurrent writers exist. (evidence: src/config/index.ts, src/providers/manager.ts, src/aidlc/task-contract.ts)
- External processes receive an executable plus argument array through the shared runner; new code must not construct shell command strings. (evidence: src/process/index.ts)
- Persisted provider output is normalized at adapter boundaries before entering GraphWard schemas. (evidence: src/providers/graphify.ts, src/graph/provider-evidence.ts, src/providers/cce.ts)
- Tests use Node's built-in test runner against compiled `dist/` (run `npm run build` first) and temporary workspaces for mutating scenarios. (evidence: package.json, scripts/run-tests.mjs, test/task-contract-reliability.test.mjs)
- Public template changes are made in `templates/canonical/` or `src/adapters/`, validated canonically, then refreshed into installed adapters with `gw update .`. (evidence: src/templates.ts, src/adapters/index.ts, test/installer.test.mjs)
- Gate/guard changes ship with tests for both the allowed and the rejected path. (evidence: test/hooks.test.mjs, test/task-contract-reliability.test.mjs)
- Source files must stay plain text: write control characters as escapes (e.g. `"\u0000"`), never literally, or Git treats the file as binary and review/search tools skip it. (evidence: src/evidence/index.ts)
