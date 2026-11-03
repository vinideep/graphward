# Regression Patterns
<!-- freshness: last_checked=2026-10-27 -->

- **Version drift:** package, template and installed manifest versions can diverge. `doctor` must compare all three and canonical inventory. (evidence: src/validation/index.ts, test/installer.test.mjs)
- **Scope pollution:** ignored fixtures, `dist/` or provider caches can create false modules, routes and dependencies. All extractors must use `ProjectFilePolicy`. (evidence: src/project-files/index.ts, src/claims/derive.ts, src/gates/api-diff.ts)
- **False structural authority:** provider-only edges can look deterministic while being stale or ambiguous. Reconciliation must retain source hashes and trust state. (evidence: src/graph/provider-evidence.ts)
- **Unsafe provider activation:** moving a virtual environment or trusting a path without fingerprinting breaks tools or allows tampering. Releases must remain at their final immutable path before activation. (evidence: src/providers/manager.ts, test/providers.test.mjs)
- **Benchmark pollution:** mutating a repository fixture can make later runs non-deterministic. Benchmark runs use disposable temporary workspaces. (evidence: test/evaluation-honesty.test.mjs, test/audit-release-evaluation.test.mjs)
- **Comment-shaped APIs:** route-like strings in comments/tests can become false endpoints unless comments and non-production paths are excluded. (evidence: src/gates/api-diff.ts, src/claims/derive.ts)
- **Self-locking gates:** a guard that treats the agent's own approved edits as drift (or an approved scope string it cannot parse) blocks the very work it authorized. Readiness must compare drift against the bound baseline and confirmed scope, and scope matching must accept the globs agents naturally write. (evidence: src/aidlc/task-contract.ts, test/task-contract-reliability.test.mjs)
- **Undiscoverable protocols:** a confirmation or tool protocol that exists only in source is effectively broken for agents. Tool responses must say how to proceed (`howToConfirm`, `next`). (evidence: src/aidlc/task-contract.ts, src/mcp/consolidated.ts)
- **Unbounded tool payloads:** context tools that return everything they computed overflow agent tool-result limits. Budgets must cover every emitted section. (evidence: src/context/orchestrator.ts, src/mcp/consolidated.ts)

- **Evidence-shaped inputs:** pending/empty reviews, response lists and custom passing commands cannot establish completed review or required baseline coverage. Bind identity and actual execution, and test stale/corrupt/legacy rejection. (evidence: test/audit-authority-regression.test.mjs, test/audit-review-schemas.test.mjs)
- **Source-shaped text:** comment/string imports, commented TOML dependencies and escaping symlinks cannot become verified graph facts. (evidence: test/audit-graph-repairs.test.mjs)
- **Preservation under failure:** missing baselines and candidate/index drift must refuse rollback/promotion; malformed configuration and user ignore lines must survive managed operations. (evidence: test/audit-preservation-regressions.test.mjs)
