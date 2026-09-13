# Definition of Ready
<!-- freshness: last_checked=2026-07-13 -->

A story/ticket is **Ready** for construction when:

- [ ] The request is scoped in `inception/requirements.md` with functional requirements and edge cases.
- [ ] Impact analysis has been run (`/analyze-impact` or `analyze_impact` MCP tool) against the current dependency graph.
- [ ] The freshness/drift decision is "Proceed" (see `.graphward/reports/FRESHNESS-report.md`) — if "Sync before implementation" or "Block implementation," run `sync-graphward` first.
- [ ] Acceptance criteria are recorded in `agile/acceptance-criteria.md` as executable validation targets, not vague prose.
- [ ] A delivery mode has been selected from `aidlc-lifecycle-engine`'s table (Standard Agile / Adversarial / TDD / Design-First / Hypothesis Debugging) appropriate to the change's risk profile.
- [ ] Any open question blocking implementation is recorded in `open-questions.md` and resolved (or explicitly accepted as a known risk).

## Status For This Repo

This checklist is currently unused — no story is in flight. It applies starting with the next `/graphward <request>` invocation.

## Unknowns

- N/A
