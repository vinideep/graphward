# Runtime Map
<!-- freshness: last_checked=2026-10-13 -->

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

## Task (hook-enforced hosts)

```text
discovery (always allowed: reads, get_engineering_context, read-only shell)
 -> propose_task_contract            -> challenge + howToConfirm
 -> user confirms (prompt hook / AskUserQuestion / operator TTY)
 -> prepare_task_context(taskId)     -> preparation receipt + bound context + baseline
 -> get_task_readiness
 -> edits inside confirmed scope     (context stays valid)
 -> gw verify .                      (Stop hook requires a passing record)
```

## Context

```text
get_engineering_context
 -> verify GraphWard knowledge/claims
 -> trusted GraphWard graph neighborhood
 -> scoped CCE/native spans (+ budgeted skeleton outlines)
 -> conflicts + unknowns + risk/gates/tests
 -> ContextPackV2 (format json | markdown | full)
```

## Change

```text
edit -> validate_change -> targeted tests/gates -> sync_engineering_knowledge
```

(evidence: src/orchestrators/initialize.ts, src/aidlc/task-contract.ts, src/hooks/index.ts, src/context/orchestrator.ts, src/mcp/consolidated.ts, src/orchestrators/change.ts)
