# Coding Patterns
<!-- freshness: last_checked=2026-09-03 -->

- Feature areas use focused TypeScript modules and export interfaces beside their operations. (evidence: src/providers/types.ts, src/context/orchestrator.ts)
- Potentially missing files are handled with explicit fallbacks; writes of critical state use a sibling temporary file followed by rename. (evidence: src/config/index.ts, src/providers/manager.ts, src/orchestrators/initialize.ts)
- External processes receive an executable plus argument array through the shared runner; new code must not construct shell command strings. (evidence: src/process/index.ts)
- Persisted provider output is normalized at adapter boundaries before entering GraphWard schemas. (evidence: src/providers/graphify.ts, src/graph/provider-evidence.ts, src/providers/cce.ts)
- Tests use Node's built-in test runner and temporary workspaces for mutating scenarios. (evidence: package.json, test/providers.test.mjs, test/initialize.test.mjs)
- Public template changes are validated canonically and then refreshed into selected adapters. (evidence: src/templates.ts, test/installer.test.mjs)
