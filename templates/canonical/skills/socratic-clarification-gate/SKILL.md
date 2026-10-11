---
name: socratic-clarification-gate
description: Discover repository facts, resolve material requirement decisions, and confirm task scope before feature implementation; use proportional clarification for fixes.
---

# Socratic Clarification Gate

Use Discover → clarify → confirm scope → prepare implementation context → implement → validate.

1. Read relevant persisted intelligence and call `get_engineering_context`. Retrieval is read-only. If stale, explicitly call `prepare_task_context`; it performs one bounded local refresh without installing dependencies. A required-provider failure blocks implementation. Disclose reduced coverage and obtain a task-scoped decision before relying on fallback.
2. Discover existing users, contracts, configuration, callers, tests, conventions, and relevant decisions before asking about repository facts. Missing graph edges permit justified search expansion; retrieval scope does not grant edit permission.
3. Call `assess_prompt_clarity` as a diagnostic. Its result is `{mustClarify,promptAssessment:{clarityScore,isClear,questions,ambiguities},graphAssessment}`. A score cannot authorize edits. Every feature needs a requirements discussion and confirmed scope; precise fixes ask only about unresolved behavior, contradictions, or material risks. Reuse prior answers and already approved scope.
4. Establish intended users, behavior, non-goals, acceptance criteria, compatibility, and relevant failure cases. Use the active host's real question tool: Claude `AskUserQuestion`, Antigravity `ask_question`, Codex's available user-input tool, or ordinary parent chat. Subagents return unresolved questions to the parent. Never synthesize a human answer through tool input.
5. Call `propose_task_contract` with the full contract and native `host`/`sessionId`. Retain complete question text, options, and answer, not an option letter alone. Show the proposed scope and the exact returned confirmation challenge. Native prompt hooks bind the user's response to this project, task, and revision. Unsupported hosts require explicit conversational/operator evidence and must not claim certified native confirmation. Assistant assertions of approval are insufficient.
6. Call `get_task_readiness` with `stage:"requirements"` and `taskId`; resolve its `blockers`. Empty or old requirements documents do not satisfy readiness. If requirements change, propose a new revision and confirm it. Ordinary source edits do not revoke the user's approved intent.
7. Call `prepare_task_context` with `taskId` to prepare and retrieve current implementation context. Inspect actual provider contribution and unknowns. If degraded, surface the exact reduced-context challenge. Native policy invokes no providers.
8. Call `get_task_readiness` for implementation before preflight or edits. Lifecycle transitions, preflight, edit hooks and validation use this same service. `check_aidlc_gate` returns `missingPrerequisites` and `blockingQuestions`; inspect both.

Task decisions live independently under `.graphward/aidlc/tasks/`. Preserve human evidence and assurance honestly; hooks are guardrails with host-specific coverage limits. A declaration or generated file does not establish discovery, connectivity or enforcement.
