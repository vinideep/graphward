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

## IMP-002 Executable Criteria

| Criterion | Validation | Result |
|---|---|---|
| A new project can be initialized through the real CLI with an existing IDE marker | `test/shiplogic-integration.test.mjs` | ✅ Met |
| User-owned IDE settings survive installation and GraphWard hooks are merged | Shiplogic integration test | ✅ Met |
| Missing providers do not block default initialization; strict provider use remains opt-in | `test/initialize.test.mjs` plus strict-provider tests | ✅ Met |
| A source edit can refresh deterministic GraphWard artifacts without rewriting canonical prose | Shiplogic integration test invokes `sync --files` | ✅ Met |
| The documented commands are simple enough for an existing GraphWard project to update incrementally | README and workflow guide review plus CLI integration test | ✅ Met |
