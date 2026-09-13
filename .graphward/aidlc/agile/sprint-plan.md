# Sprint Plan
<!-- freshness: last_checked=2026-09-03 -->

## Status

Active construction sprint for EPIC-001.

## Sprint Goal

Deliver a compatible, provider-aware GraphWard initialization and context path whose canonical authority remains GraphWard and whose native fallback remains complete.

## Selected Stories

| Story | Points | Owner |
|---|---:|---|
| FEAT-001 | 8 | Engineering Orchestrator |
| FEAT-002 | 13 | Component Builder / Security Officer |
| FEAT-003 | 13 | System Architect / Knowledge Agent |
| FEAT-004 | 13 | Component Builder / Test Engineer |
| FEAT-005 | 8 | Quality Agent / Documentation Writer |

## Risks

- Upstream provider packaging and wire formats can drift.
- Cross-platform provider installation needs CI evidence unavailable on this host.
- Current intelligence is stale and must be regenerated after implementation.

## IMP-002 Completion

The local validation slice is complete. It added a real Shiplogic-shaped CLI
journey, optional-provider fallback coverage, deterministic incremental sync,
and a simplified README. The remaining qualification is the declared remote
provider matrix on Linux, macOS, and Windows.

## Template For Next Sprint

```markdown
## Sprint Goal
<one sentence>

## Selected Stories
| Story | Points | Owner |
|---|---|---|

## Capacity
<available capacity for this sprint>

## Risks
<known risks entering the sprint>

## Commitments
<what the team is committing to deliver>
```

## Unknowns

- N/A
