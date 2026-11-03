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
3. **Establish Baseline** — Run `graphward verify .` after scope confirmation and before any implementation edit (use `environmental-backpressure-engine` to resolve "no check commands detected" by configuring `hooks.verifyCommands`, never by skipping). A failure here is pre-existing, not something this change caused — note it so the post-implementation result isn't misread as a regression.
4. **Adaptive Pre-Flight Gauntlet** — If the request is classified as `architecture`, `security`, cross-cutting (`high`/`critical` risk), or has 3+ ambiguities, invoke `socratic-stress-tester` to stress-test edge cases and resolve trade-offs before writing the impact report.
5. **Select Delivery Mode** — Choose standard Agile, adversarial, TDD, design-first, or hypothesis debugging based on risk
6. **Write Impact Report** — Create `.graphward/reports/IMP-XXX-<summary>.md` before any code edit. Call `analyze_change_impact` to compute programmatic impact data for the report.
7. **Plan Agile + AI-DLC Work** — Update backlog, acceptance criteria, Definition of Ready, `.graphward/aidlc/execution-plan.md`, and call `update_aidlc_state` to transition the lifecycle
8. **Adaptive Interface Exploration** — If introducing new public APIs, exported types, schema models, or SDK contracts, invoke `interface-design-explorer` to benchmark contrasting interface options before coding.
9. **Implement** — Make requested changes. When in TDD mode or implementing critical business logic/state machines, execute strict Red-Green-Refactor slices via `vertical-tdd-engine`.
10. **Test** — Add/update tests proportional to risk; execute and record results
11. **Safety Gates** — Run the shared executable registry for `env-vars`, `dead-exports`, `api-diff`, `migration-lint`, `api-snapshot`, `security-audit`, `rollback-readiness`, and `conventions`; each reports pass, warn, fail, skipped-with-reason, or unavailable, and required unavailable gates block medium/high-risk completion. Run freshness, type checks, acceptance mapping, dependency scanning, ADR review, and LLM prompt-injection review through their separately named deterministic commands or evidence artifacts; never imply the registry executed checks it does not contain.
12. **Validate** — Re-run `graphward verify .` (via `environmental-backpressure-engine`) against the finished change. This is the record the Stop gate and CI both check — it must pass, or the failure must be recorded as a residual risk, not silently dropped.
13. **Sync Intelligence & Session Continuity** — Call `sync_engineering_knowledge`, incrementally update only affected canonical knowledge/memory/context/event/graph artifacts and AI-DLC artifacts it flags, then call `validate_change`. Record provider health and native fallback. If the session is paused or context bounds approach, serialize state via `session-handoff-engine`.
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
4. Implement within scope, run applicable checks and `graphward verify .`, synchronize affected intelligence with `sync_engineering_knowledge`, then `validate_change`. Record actual results, unavailable checks and residual risks. A test-shaped command is not verification evidence.
5. Escalate to the full `aidlc-lifecycle-engine` for complex or high/critical-risk changes and explicit backlog delivery; retain per-feature human approval. Add a specialist only for a concrete risk or unresolved question, with explicit ownership. Preserve project/domain safeguards in every route.
6. Report outcome, evidence, risks and `AI-DLC: <phase> -> <stage> -> <status>`. Keep deployment, irreversible actions and external messages within their separate authorization.
<!-- /graphward:mode -->
