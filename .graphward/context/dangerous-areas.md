# Dangerous Areas
<!-- freshness: last_checked=2026-10-27 -->

- Regex-based native import/API scanning may silently under-detect syntax and should be treated as fallback evidence, not proof of completeness. (evidence: src/graph/parsers/imports.ts, src/gates/api-diff.ts)
- Provider CLI formats are upstream contracts; all output parsing must fail closed into explicit native fallback rather than fabricate evidence. (evidence: src/providers/graphify.ts, src/providers/cce.ts)
- CCE overfetch can leak unrelated chunks unless both path scope and current span hash are enforced. (evidence: src/providers/cce.ts)
- Provider virtual environments cannot be relocated after installation; activation must point to the immutable final release. (evidence: src/providers/manager.ts)
- Managed adapter files can contain user changes; broad overwrite or deletion requires explicit force and inventory proof. (evidence: src/installer/index.ts, src/validation/index.ts)
- Knowledge freshness based only on timestamps is insufficient; material statements also need claim/source hash verification. (evidence: src/freshness/index.ts, src/evidence/index.ts, src/claims/index.ts)
- The shell discovery classifier in the PreToolUse hook is a security boundary: adding a command to the read-only allowlist must consider every flag that writes or executes (`find -exec/-delete`, `sort -o`, `sed -i`/`w`, `git -c`, `rg --pre`). (evidence: src/hooks/index.ts)
- The outside-project exemption for file edits must compare canonical paths (nearest existing ancestor resolved through symlinks); a lexical check lets an aliased path such as `/var/...` vs `/private/var/...` escape the gate. Write-capable shell commands cannot gain an exemption solely from a foreign working directory. (evidence: src/hooks/index.ts)
- Task confirmation must come from supported native user input or the explicitly labelled interactive operator conversation, bound to the exact revision; never accept assistant text or MCP arguments as approval. (evidence: src/aidlc/task-contract.ts)


## Initialization integrity repair — 2026-10-15

Provider relationships are admitted only when both normalized endpoints exist. Rejected raw relationships, available endpoints, trust/source hashes and run provenance are returned without side effects and written by graph-write paths to the quarantine report; write:false remains read-only. Contested/provider-only evidence is never upgraded into semantic proof. (evidence: src/graph/provider-evidence.ts, src/graph/index.ts, test/provider-context-reliability.test.mjs)

The shared citation parser handles annotated/backticked references, ranges, multi-spans, Source tables, grouped/bracketed routes and JSON evidence arrays. Source reads enforce shared policy, lexical/realpath containment and runtime/secret exclusions. Hash caches last for one operation; legacy hashes and newly unrecorded references remain fail-closed until reviewed. Health rejects graph duplicates/missing endpoints and unverified material documents; explicit directory-only navigation is narrowly classified. (evidence: src/evidence/index.ts, src/orchestrators/health.ts, test/evidence.test.mjs, test/orchestrators.test.mjs, test/shiplogic-integration.test.mjs)

## Repair invariants

A lexical report path cannot downgrade a product write through a symlink. Completed reviews and receipts require current scope/source/runtime binding; pending or unbound artifacts cannot pass. Experiment rollback/promotion must refuse unknown baselines and concurrent source/index drift. Optional helpers must disclose missing or degraded capabilities. (evidence: src/hooks/index.ts, src/gates/review-evidence.ts, src/verify/index.ts, src/experiment/baseline.ts, src/experiment/runner.ts, src/storage/sqlite-store.ts)
