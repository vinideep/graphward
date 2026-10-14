# Critical Paths
<!-- freshness: last_checked=2026-10-13 -->

1. **Install/update safety** — canonical render, manifest hash comparison, conflict preservation and doctor parity. (evidence: src/installer/index.ts, src/validation/index.ts)
2. **Project scope** — one incorrect inclusion can pollute graph, claims, CCE and gates; path/symlink/secret exclusions are mandatory. (evidence: src/project-files/index.ts)
3. **Provider activation** — staged install, handshake, fingerprint and atomic current-pointer switch must stay transactional. (evidence: src/providers/manager.ts)
4. **Graph reconciliation** — only current, scoped evidence can corroborate GraphWard edges; contested/provider-only evidence remains non-authoritative. (evidence: src/graph/provider-evidence.ts)
5. **Context assembly** — verified GraphWard knowledge and trusted graph scope precede CCE retrieval; stale spans are rejected; every emitted section counts against the token budget. (evidence: src/context/orchestrator.ts, src/providers/cce.ts)
6. **Task gate** — every non-discovery hook call runs readiness (confirmation, scope, bound context, drift). A false deny stalls every agent session in an installed repo; a false allow bypasses user authorization. (evidence: src/hooks/index.ts, src/aidlc/task-contract.ts)
7. **Post-edit trust** — reindex, re-derive claims, validate gates, record `gw verify`, and synchronize durable knowledge. (evidence: src/orchestrators/change.ts, src/verify/index.ts)
