# Dependency Graph

```text
FEAT-001 -> FEAT-002 -> FEAT-003 -> FEAT-004 -> FEAT-005
```

## Execution Order
1. TKT-001, TKT-002
2. TKT-003, TKT-004
3. TKT-005, TKT-006
4. TKT-007, TKT-008
5. TKT-009, TKT-010

The feature slices overlap in CLI, setup, MCP, and canonical templates, so they execute sequentially in one construction unit.

## EPIC-002 approved foundation

Initial immutable snapshot and pre-edit verification precede all product edits. TKT-011 tooling, TKT-012 telemetry and TKT-013 evaluator can then be implemented in parallel because ownership does not overlap. TKT-013 final integration depends on TKT-012's accounting contract. Root integrates, reviews, synchronizes and performs full verification once the files are stable. Later features require separate approval.

## FEAT-007 confirmed Phase 2

FEAT-006 local measurement foundation -> source-verified knowledge repair and baseline verification -> TKT-014/TKT-015 -> TKT-016 final integration, independent review and deterministic validation. TKT-014 renderer work has disjoint ownership from core routing/hooks; the named graphward agent owns integration. Phase 3 and later units are outside this confirmed task.
