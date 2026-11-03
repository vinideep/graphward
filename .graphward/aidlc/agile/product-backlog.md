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

## Agent reliability repair work (2026-10-10)

The user requests reverting the experimental autorouter and a complete repair plan. R0 is reverted locally. R1–R6 are planned in [PLAN-011-agent-reliability-repair.md](/Users/vinithr/personal/AI/engineering-intelligence-OS/.graphward/reports/PLAN-011-agent-reliability-repair.md), with explicit dependencies and acceptance IDs A0–A14. This entry records requested work; it does not change historical EPIC-001 approvals or mark repairs complete.

## CLI-UX-001 scoped candidate — 2026-10-11

Priority: P1, with U0 preservation fixes required before rollout. Human direction confirmed: guided home/setup/update wizard, current-project scope, both providers recommended with download review. U0–U4 and UX01–UX14 are defined in `reports/PLAN-013-guided-cli-onboarding.md`; implementation approval remains pending. No historical epic approval is reused for this new interface.

## IMP-012 delivery update — 2026-10-11

A–F runtime, provider freshness/provenance, requirements receipts, host configuration/edit checks, source-aware resolution/evidence/locks and honest evaluation gates are implemented locally. Final byte-bound verification: 488/488 pass. Claude Code exact candidate canary passes questions-before-edits, CCE/Graphify contribution and unapproved mutation denial. Codex checkout exact hooks are trusted and enabled following the approved native review. Current-candidate Codex/Antigravity, IDE, platform and held-out measurements remain open; these entries do not mark release qualification complete. Unit evidence and task trace are in reports/approved-repair-2026-10-11/IMPLEMENTATION-REPORT.md.

## EPIC-002 — 2026-10-18

FEAT-006 (Phase 0/1 baseline and trustworthy measurement) is approved through native task revision 2. TKT-011 through TKT-013 implement the foundation. Later workflow/context/verification/reuse/migration phases remain proposed. No historical approval is reused and no measured efficiency/accuracy gain is claimed.

FEAT-007 (Phase 2 opt-in concise workflow and safe routing/hooks) independently confirmed revision 2 on 2026-10-19. TKT-014–016 are indexed; IMP-017 and the current task receipt define scope and acceptance. Phases 3-5 and real experiments remain proposed.

## AUDIT-REPAIR-20261026 — approved repair programme

All F01-F45 in reports/ai-ide-audit-2026-10-26/findings.json are requested and approved for local repair. Units: authority/proof/integration; preservation/runtime; source/graph/context. Each finding needs changed-file/regression evidence and independent review. Status: in progress. Existing epic/feature history is preserved.

## AUDIT-REPAIR-20261026 — local completion, 2026-10-27

All45audited corrections applied as81owned product paths after frozen candidate validation. Candidate and original-root full suites658/658; integration16/16; replay36/36; deterministic validation and Construction exit pass.37affected canonical artifacts synchronized,152citations and603claims verified, freshness Proceed. Exact evidence/limits: `.graphward/reports/repairs-2026-10-26/DELIVERY.md`. Existing installedmanifest1.3.1/1.3.3drift and desktop MCP reconnect remain activation work; no native/remote/outcome claim.

AI-DLC: Construction -> Local repairs verified and synchronized -> Complete locally
