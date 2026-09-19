---
disable-model-invocation: true
name: adr-compliance-checker
description: "Internal GraphWard engine. Use only when the selected entry workflow explicitly routes to adr-compliance-checker. Do not use for direct selection from an unclassified user request."
---

# ADR Compliance Checker

Use this skill when a change touches architecture boundaries, service communication, persistence strategy, deployment topology, or any area governed by accepted ADRs.

## Procedure

1. Read accepted ADRs from `.graphward/aidlc/construction/**/decision-records/` and `.graphward/memory/architecture-decisions.md`.
2. Extract binding rules, such as dependency direction, allowed protocols, persistence ownership, eventing patterns, or security controls.
3. Compare the implementation diff against each applicable rule.
4. Produce findings using the same severity model as `engineering-change-review`.
5. Block completion on ADR violations unless a new ADR supersedes the old decision.

## Output

Write `.graphward/reports/ADR-COMPLIANCE-<slug>.md`:

```markdown
# ADR Compliance: <summary>

## ADRs Consulted
| ADR / Decision | Status | Binding Rule | Applies |
|---|---|---|---|

## Findings
| Severity | Rule | Location | Evidence | Recommendation |
|---|---|---|---|---|

## Verdict
- <compliant|changes required|superseding ADR required>
```

## Quality Gates

- [ ] Accepted ADRs and architecture memory were consulted
- [ ] Binding rules were extracted explicitly
- [ ] Diff was checked against applicable rules
- [ ] ADR violations are blockers unless superseded by a new accepted ADR

## Invocation Policy

- **Use when:** the selected entry workflow explicitly routes to adr-compliance-checker.
- **Do not use when:** direct selection from an unclassified user request.
- This is an internal engine. An entry workflow must select it; do not compete with entry workflows for the user request.
