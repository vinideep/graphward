# Critical Paths
<!-- freshness: last_checked=2026-09-03 -->

1. **Install/update safety** — canonical render, manifest hash comparison, conflict preservation and doctor parity. (evidence: src/installer/index.ts, src/validation/index.ts)
2. **Project scope** — one incorrect inclusion can pollute graph, claims, CCE and gates; path/symlink/secret exclusions are mandatory. (evidence: src/project-files/index.ts)
3. **Provider activation** — staged install, handshake, fingerprint and atomic current-pointer switch must stay transactional. (evidence: src/providers/manager.ts)
4. **Graph reconciliation** — only current, scoped evidence can corroborate GraphWard edges; contested/provider-only evidence remains non-authoritative. (evidence: src/graph/provider-evidence.ts)
5. **Context assembly** — verified GraphWard knowledge and trusted graph scope precede CCE retrieval; stale spans are rejected. (evidence: src/context/orchestrator.ts, src/providers/cce.ts)
6. **Post-edit trust** — reindex, re-derive claims, validate gates and synchronize durable knowledge. (evidence: src/orchestrators/change.ts)
