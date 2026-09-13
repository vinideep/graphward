# Runtime Map
<!-- freshness: last_checked=2026-09-03 -->

## Initialization

```text
initialize
 -> adapter setup + config migration
 -> provider verification/install
 -> Graphify code evidence or native fallback
 -> GraphWard native graph + reconciliation
 -> CCE approved-scope index or native fallback
 -> derived claims
 -> deterministic GraphWard knowledge + evidence hashes
 -> optional model enrichment brief
```

## Task

```text
get_engineering_context
 -> verify GraphWard knowledge/claims
 -> trusted GraphWard graph neighborhood
 -> scoped CCE/native spans
 -> conflicts + unknowns + risk/gates/tests
 -> ContextPackV2
```

## Change

```text
edit -> validate_change -> targeted tests/gates -> sync_engineering_knowledge
```

(evidence: src/orchestrators/initialize.ts, src/context/orchestrator.ts, src/orchestrators/change.ts)
