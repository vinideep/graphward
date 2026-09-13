# Regression Patterns
<!-- freshness: last_checked=2026-09-03 -->

- **Version drift:** package, template and installed manifest versions can diverge. `doctor` must compare all three and canonical inventory. (evidence: src/validation/index.ts, test/installer.test.mjs)
- **Scope pollution:** ignored fixtures, `dist/` or provider caches can create false modules, routes and dependencies. All extractors must use `ProjectFilePolicy`. (evidence: src/project-files/index.ts, src/claims/derive.ts, src/gates/api-diff.ts)
- **False structural authority:** provider-only edges can look deterministic while being stale or ambiguous. Reconciliation must retain source hashes and trust state. (evidence: src/graph/provider-evidence.ts)
- **Unsafe provider activation:** moving a virtual environment or trusting a path without fingerprinting breaks tools or allows tampering. Releases must remain at their final immutable path before activation. (evidence: src/providers/manager.ts, test/providers.test.mjs)
- **Benchmark pollution:** mutating a repository fixture can make later runs non-deterministic. Benchmark runs use disposable temporary workspaces. (evidence: scripts/benchmark-runner.mjs)
- **Comment-shaped APIs:** route-like strings in comments/tests can become false endpoints unless comments and non-production paths are excluded. (evidence: src/gates/api-diff.ts, src/claims/derive.ts)
