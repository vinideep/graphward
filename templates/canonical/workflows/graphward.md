---
name: graphward
description: Implement an engineering request with impact analysis, tests, validation, and intelligence synchronization.
---
<!-- graphward:mode strict -->

# GraphWard

Use the `graphward-skill` capability for the user's accompanying request. For non-trivial work, use `aidlc-lifecycle-engine` inside this workflow to merge Agile delivery with AI-DLC durable state.

## Pipeline

1. **Discover current context** — Call `get_engineering_context` before direct exploration. Honor ContextPackV2 knowledge trust, GraphWard graph retrieval scope, current hashes, provider fallback, conflicts, unknowns, budget, and stop reason; load only the relevant persisted GraphWard slices it identifies.
2. **Task contract** — Discover repository facts; discuss every feature and clarify fixes proportionally. Reuse earlier answers. Call `propose_task_contract` with users, behavior, non-goals, acceptance criteria, scope, constraints and complete questions/answers. Obtain user confirmation of the current revision through the active host's real interaction. Prompt scores cannot authorize implementation. Call `prepare_task_context` with the task ID, inspect actual provider contribution, and resolve `get_task_readiness` blockers before edits. Required-provider failure blocks; reduced coverage needs a task-scoped decision.
3. **Establish Baseline** — After scope confirmation and before the first implementation edit, run `graphward verify .` once for the starting state. Use `environmental-backpressure-engine` to resolve missing check commands and record any baseline failures separately from post-edit failures.
4. **Adaptive Pre-Flight Gauntlet** — If the request is classified as `architecture`, `security`, cross-cutting (`high`/`critical` risk), or has 3+ ambiguities, invoke `socratic-stress-tester` to stress-test edge cases and resolve trade-offs before writing the impact report.
5. **Select Delivery Mode** — Choose standard Agile, adversarial, TDD, design-first, or hypothesis debugging based on risk
6. **Write Impact Report** — Create `.graphward/reports/IMP-XXX-<summary>.md` before any code edit. Call `analyze_change_impact` to compute programmatic impact data for the report.
7. **Plan Agile + AI-DLC Work** — Update backlog, acceptance criteria, Definition of Ready, `.graphward/aidlc/execution-plan.md`, and call `update_aidlc_state` to transition the lifecycle
8. **Adaptive Interface Exploration** — If introducing new public APIs, exported types, schema models, or SDK contracts, invoke `interface-design-explorer` to benchmark contrasting interface options before coding.
9. **Implement** — Make requested changes. When in TDD mode or implementing critical business logic/state machines, execute strict Red-Green-Refactor slices via `vertical-tdd-engine`.
10. **Test** — Add or update tests proportional to risk. Use focused checks while editing and reserve full-suite runs for the baseline, final verification, or a separate run required by the project or delivery mode.
11. **Separate Safety Gates** — Collect applicable freshness, type, acceptance, dependency, ADR, and LLM prompt-injection evidence separately where final verification and the safety registry do not cover it. Run a gate before final verification when the project or delivery mode requires it.
12. **Validate** — Run `graphward verify .` once against the finished source and check inputs. Reuse the result within this task while those inputs match. Rerun after a relevant change or to confirm a repair. This record is required by the Stop gate and CI. Report any failure explicitly.
13. **Sync Intelligence & Session Continuity** — Reuse this task's existing sync and validation results when their inputs match. Call `sync_engineering_knowledge` if a current sync result is missing and update only affected intelligence, graph artifacts, and AI-DLC artifacts. Call `validate_change` once if final validation has yet to run for the current inputs. Use its results for `env-vars`, `dead-exports`, `api-diff`, `migration-lint`, `api-snapshot`, `security-audit`, `rollback-readiness`, and `conventions`. Rerun individual gates when their inputs change, when confirming a repair, or when a separate check is required. Required unavailable gates block medium/high-risk completion. Record provider health and fallback, and use `session-handoff-engine` when pausing or approaching the context limit.
14. **Record Change** — Write `.graphward/changes/CHG-XXX-<summary>.md` referencing related reports and acceptance verification
15. **Review Gate** — For high-risk changes, run engineering-change review before completion

## Completion Report

Finish with:
- Code changes made (files, what changed)
- Tests run and results (pass/fail counts)
- Affected systems and services
- Synchronized intelligence artifacts
- Related reports (IMP-XXX, REV-XXX)
- Agile artifacts updated (backlog, stories, acceptance criteria, Definition of Done)
- Safety gates run (freshness, type, API, snapshots, migration, dependency, env, ADR, LLM, acceptance mapping, rollback)
- Unresolved risks or follow-ups
- AI-DLC breadcrumb (`AI-DLC: <phase> -> <stage> -> <status>`)
<!-- /graphward:mode -->
<!-- graphward:mode concise -->

# GraphWard — Concise Workflow

Use `graphward-skill` for the user's implementation request. Concise mode is an explicit project opt-in; it changes workflow ceremony, never authority.

1. Retrieve scoped `get_engineering_context`; separate read/discuss/plan intent from requested mutation, domain and risk. Read-only work uses its dedicated route and does not modify product code. Classification never grants permission.
2. Before edits, retain native permissions, confirmed current task scope, `prepare_task_context`, `get_task_readiness`, freshness, ProjectFilePolicy and any required reduced-context decision. Reuse the user's existing answers and approvals without inventing confirmation.
3. For ordinary bounded work, use one working agent and a short impact/acceptance record: intended behavior, affected files, risks, required checks and unresolved facts. Call `analyze_change_impact`; a separate backlog, context manifest and change record are not mandatory for this routine path.
4. For ordinary bounded work, use focused checks while editing and schedule the full `graphward verify .` at completion. Reuse this task's existing sync and validation results when their inputs match. Call `sync_engineering_knowledge` for affected intelligence if a current sync result is missing. Call `validate_change` once if final validation has yet to run for the current inputs. Run separate checks where required coverage is missing or the project or delivery mode requires an earlier check. Rerun a check only when its inputs change, a repair needs confirmation, or a separate run is required. Record actual results, unavailable checks and residual risks.
5. Escalate to the full `aidlc-lifecycle-engine` for complex or high/critical-risk changes and explicit backlog delivery. Retain its required baselines and per-feature human approval. Add a specialist only for a concrete risk or unresolved question, with explicit ownership. Preserve project/domain safeguards in every route.
6. Report outcome, evidence, risks and `AI-DLC: <phase> -> <stage> -> <status>`. Keep deployment, irreversible actions and external messages within their separate authorization.
<!-- /graphward:mode -->
