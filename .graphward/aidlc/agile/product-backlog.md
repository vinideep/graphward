# Product Backlog
<!-- freshness: last_checked=2026-07-13 -->

## Status

EPIC-001 is approved and in progress. Its five approved feature slices and ten implementation tickets are indexed under `agile/backlog/`.

## Active Epic

- EPIC-001 — EI-owned provider-backed context (P0, in progress)

## Candidate Epics (surfaced as observations during initialization, not yet decomposed or prioritized)

These are **not commitments** — they are candidates worth considering, drawn from `open-questions.md` and `12-technical-debt.md`. A human should prioritize before any of these becomes an active epic.

| Candidate | Source | Rationale |
|---|---|---|
| MCP server version drift fix | `open-questions.md` #3 | Read version from `package.json` instead of hardcoding `"2.3.0"` in `src/mcp/index.ts:117` |
| Skill catalog sync check | `open-questions.md` #4, `12-technical-debt.md` | Add an automated check that `SKILL_CATALOG` (visualizer) stays in sync with `SKILL_NAMES` (templates.ts) |
| User-profile test coverage | `open-questions.md` #6 | No dedicated test file exists for `src/user-profile/index.ts` |
| Dogfooded IDE directory cleanup | `open-questions.md` #1 | Clarify/consolidate `.agent/`, `.agents/`, `.commandcode/` at repo root |

## Unknowns

- N/A — this backlog is intentionally empty pending explicit prioritization by a human or a `decompose-backlog` invocation.
