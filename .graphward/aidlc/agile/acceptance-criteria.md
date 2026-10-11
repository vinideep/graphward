# Acceptance Criteria
<!-- freshness: last_checked=2026-09-03 -->

## Status

EPIC-001 acceptance criteria are active. Detailed feature criteria live in `agile/backlog/features/`.

## EPIC-001 Executable Criteria

| Criterion | Validation |
|---|---|
| One explainable scope controls native graph and provider retrieval | Project file policy unit/integration tests |
| Ignored/generated/secret/out-of-root paths do not enter canonical intelligence | Negative-path policy and graph tests |
| Provider lifecycle degrades safely and strict mode fails deterministically | Fake-provider contract and CLI tests |
| Graphify data is evidence with provenance, never unverified authority | Normalization/reconciliation tests |
| ContextPackV2 is knowledge-first and source-verifies retrieved spans | Context orchestrator and MCP tests |
| Existing CLI/MCP callers remain compatible | Existing plus compatibility test suites |
| Canonical and installed skill/workflow inventories match | Installer/doctor/template tests |
| Fresh initialization produces verified GraphWard artifacts | End-to-end native fixture and opt-in provider smoke tests |

## Acceptance Criteria For This Initialization (retrospective, self-referential)

| Criterion | Executable Validation | Result |
|---|---|---|
| All 16 knowledge-base documents exist with evidence citations | `ls .graphward/knowledge-base/*.md \| wc -l` = 16 | ✅ Met |
| All 4 graph JSON files are schema-valid JSON | `node -e "JSON.parse(...)"` per file | ✅ Met (run and confirmed this session) |
| Dependency graph reflects real, deterministic analysis (not hand-authored) | `npx gw map .` output: "61 nodes, 63 edges (42 source files scanned)" | ✅ Met |
| No fabricated architecture/API/schema claims | Cross-checked in `15-validation-report.md` | ✅ Met |
| CHG-000 initialization record exists | Pending | ⏳ Pending final step |

## Unknowns

- N/A

## Autorouter rollback and agent reliability repair criteria (2026-10-10)

The current acceptance matrix is A0–A14 in [PLAN-011-agent-reliability-repair.md](/Users/vinithr/personal/AI/engineering-intelligence-OS/.graphward/reports/PLAN-011-agent-reliability-repair.md). A0/A10 concern the explicit rollback and are verified in its construction summary; A1–A9/A11–A14 remain pending repair evidence. Historical criteria below remain historical acceptance, not proof of this new work.

## IMP-002 Executable Criteria

| Criterion | Validation | Result |
|---|---|---|
| A new project can be initialized through the real CLI with an existing IDE marker | `test/shiplogic-integration.test.mjs` | ✅ Met |
| User-owned IDE settings survive installation and GraphWard hooks are merged | Shiplogic integration test | ✅ Met |
| Missing providers do not block default initialization; strict provider use remains opt-in | `test/initialize.test.mjs` plus strict-provider tests | ✅ Met |
| A source edit can refresh deterministic GraphWard artifacts without rewriting canonical prose | Shiplogic integration test invokes `sync --files` | ✅ Met |
| The documented commands are simple enough for an existing GraphWard project to update incrementally | README and workflow guide review plus CLI integration test | ✅ Met |

## CLI-UX-001 proposed criteria — 2026-10-11

UX01–UX14 in `reports/PLAN-013-guided-cli-onboarding.md` cover guided setup, noninteractive compatibility, reviewed downloads, byte-preserving updates, invalid configuration, repeat-update behavior, stale plans, cancellation/recovery, honest host readiness, provider freshness, unchanged product source, platforms/Node floor, shared execution and requirements gates. Status: proposed; no implementation result claimed. User answers are recorded in `knowledge-base/19-requirements.md`.

## IMP-012 delivery update — 2026-10-11

A–F runtime, provider freshness/provenance, requirements receipts, host configuration/edit checks, source-aware resolution/evidence/locks and honest evaluation gates are implemented locally. Final byte-bound verification: 488/488 pass. Claude Code exact candidate canary passes questions-before-edits, CCE/Graphify contribution and unapproved mutation denial. Codex checkout exact hooks are trusted and enabled following the approved native review. Current-candidate Codex/Antigravity, IDE, platform and held-out measurements remain open; these entries do not mark release qualification complete. Unit evidence and task trace are in reports/approved-repair-2026-10-11/IMPLEMENTATION-REPORT.md.
