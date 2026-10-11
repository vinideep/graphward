---
name: review-engineering-change
description: Review changed engineering work, tests, graphs, and synchronized intelligence without applying fixes.
---

# Review Engineering Change

Use `change-detection-engine` and `engineering-change-review`.

## Procedure

1. **Detect scope** — Identify the implementation diff or changed scope
2. **Read context** — Call `get_engineering_context`, then load the associated impact report, test evidence, and relevant GraphWard graph slices. Record provider health/fallback; exclude stale and out-of-scope provider evidence.
3. **Review** — Inspect across five dimensions:

| Dimension | What to Check |
|---|---|
| Implementation | Correctness, request fulfillment, error handling |
| Tests | Coverage, execution, results, gaps |
| Architecture | Boundary respect, pattern compliance, dependency direction |
| Graph consistency | New/changed nodes and edges reflected |
| Documentation sync | Knowledge, memory, context accuracy |
| Evidence trust | Current hashes, verified claims, provider provenance, conflicts/unknowns |

4. **Write report** — Generate `.graphward/reports/REV-XXX-<slug>.md` with:
   - Severity-ordered findings (🔴 Blocker → 🟢 Positive)
   - Evidence paths for each finding
   - Test gaps and coverage concerns
   - Stale-intelligence risks
   - Verdict: Approved / Approved with findings / Changes required

## Rules

- Do not modify product code
- Do not auto-fix findings — report only
- Include positive observations alongside issues
- Flag unrun validation honestly
- Call `validate_change` and include its deterministic verdict without auto-fixing findings


Read the active host capability profile under .graphward/providers/hosts/. Use its native question tool, or ask in the parent conversation. Subagents return unresolved questions to the parent. For every feature, discover repository facts, discuss requirements, confirm scope, prepare implementation context, then implement and validate. Prompt scores never authorize edits. Internal engines live in .graphward/engines. Preserve configured model and reasoning settings.
