# Product Rules
<!-- freshness: last_checked=2026-10-27 -->

- Current source, tests, manifests and Git always outrank stale documentation or provider indexes. (evidence: src/orchestrators/initialize.ts)
- Contested, stale, missing and unverifiable structural evidence cannot enter a trusted ContextPackV2 neighborhood. (evidence: src/context/orchestrator.ts)
- CCE results must resolve inside the GraphWard-approved scope and match current source hashes. (evidence: src/providers/cce.ts)
- Provider failure must be explicit and actionable; native fallback is permanent. `--require-providers` turns degradation into failure. (evidence: src/providers/manager.ts)
- Locally modified managed adapter content is not overwritten without force or explicit approval. (evidence: src/installer/index.ts)
- A non-empty source graph requires derived claims, and strict health rejects drift, stale evidence, untrusted claims or scope leakage. (evidence: src/orchestrators/health.ts)
- Raw provider MCP tools remain hidden unless expert mode is explicitly enabled. (evidence: src/config/index.ts, src/mcp/consolidated.ts)
- Only the user can approve a task contract, and only for the exact revision shown; a changed contract is a new revision needing new confirmation. (evidence: src/aidlc/task-contract.ts)
- Completion with changed source normally requires a current required-baseline `gw verify` record when `requireValidationOnStop` is enabled. An explicitly configured allow-unavailable policy can permit a source/check/session-bound unavailable outcome only after the scoped native user message; it never passes failed configured checks or becomes a passing receipt. (evidence: src/hooks/index.ts, src/verify/index.ts)
