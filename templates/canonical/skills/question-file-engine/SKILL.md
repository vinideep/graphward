---
name: question-file-engine
description: Prompts structured MCQ clarification questions interactively in the IDE chat using the ask_question tool. Creates durable decision artifacts after user responds. Use when a request has 3+ ambiguities or scope is unclear.
---

# Question File Engine

Prompt structured clarification questions interactively in the IDE chat using the `ask_question` tool. This pattern lets users answer immediately with selectable options in the IDE, eliminates the need to open separate files, and still produces durable decision artifacts for AI-DLC state.

## When to Use

- Request has clarity: Vague, Incomplete, or Contradictory
- 3 or more clarifications are needed before proceeding
- Questions involve trade-offs the user must decide (not resolvable from codebase alone)
- Starting a long workflow where misaligned assumptions cost significant rework

## Inputs

- Original request or initiative description
- Ambiguity analysis from calling skill (requirement-scoper, backlog-decomposition-engine)
- Optional: project architecture from `.graphward/knowledge-base/`, `.graphward/graph/`

## Procedure

### 1. Identify Ambiguities

Group unknowns into categories before prompting:

| Category | Examples |
|---|---|
| Scope | In/out of MVP, affected modules, integration boundaries |
| Strategy | Which implementation approach, library, or architecture pattern |
| Risk | Tolerance for breaking changes, migration complexity |
| Priority | Ship now vs. defer, dependency ordering |

Cap at 8 questions per prompt. If more are needed, prompt in batches (Multiple rounds are acceptable).

### 2. Prompt Questions Interactively

Use the `ask_question` tool to present questions directly in the IDE chat. The tool renders an interactive modal with selectable options and a write-in field.

**Format each question for `ask_question`:**

```
ask_question({
  questions: [
    {
      question: "{Question text}. Context: {1–2 sentences explaining why this matters.}",
      options: [
        "{Option A description}",
        "{Option B description}",
        "{Option C description}"
      ],
      is_multi_select: false
    },
    {
      question: "{Second question}. Context: {why this matters}",
      options: [
        "{Option A description}",
        "{Option B description}"
      ],
      is_multi_select: false
    }
  ]
})
```

Guidelines for good questions:
- Every question must have a concrete impact on the implementation plan
- Include 2–4 options with brief descriptions; the tool automatically provides a write-in "Other" option
- Order questions: scope first, then strategy, then risk
- State the default assumption in the first option if the user skips the question
- Include the context (why this matters) directly in the question text

### 3. Stop and Process Responses

The `ask_question` tool blocks execution until the user responds — you do not need to tell the user to signal readiness. Once responses arrive:

1. Re-read and map selected options to decision records. Never rely on stale in-context memory; always use the fresh response from `ask_question`.
2. If any critical question was skipped or unclear, ask a single follow-up inline.
3. Extract confirmed decisions and carry them forward.

### 4. Persist Decisions

After processing responses:

1. Call `freeze_clarified_requirements` with `topic` (the initiative slug) and `decisions` array (`[{ questionId: "Q1", selectedOptionId: "A", customText?: "..." }]`). This writes to `.graphward/aidlc/inception/requirements.md` where `check_aidlc_gate("inception")` expects them.
2. Mirror resolved question status in `.graphward/aidlc/open-questions.md` by marking items `status: resolved` so `check_aidlc_gate` no longer treats them as blockers.

## Output

- Interactive IDE prompts via `ask_question` (during execution)
- On completion: confirmed decision set persisted via `freeze_clarified_requirements`

## Rules

- Never write question files to `.graphward/aidlc/open-questions/` — always use the `ask_question` tool for interactive prompting.
- Never guess or assume answers to unresolved questions.
- Always use `ask_question` with selectable options rather than asking free-form questions in chat.
- Log confirmed decisions by calling `freeze_clarified_requirements` with `topic` and `decisions` array.
- Mirror resolved question status in `.graphward/aidlc/open-questions.md` by marking items `status: resolved` so `check_aidlc_gate` no longer treats them as blockers.

## Tools

- `ask_question`: Present interactive multiple-choice questions in the IDE chat with selectable options.
- `freeze_clarified_requirements`: Persist confirmed decisions to `inception/requirements.md` after user responds.
- `update_aidlc_state`: Transition lifecycle after requirements are frozen.

## Cross-References

- Used by: `socratic-clarification-gate` (delegates here for 3+ ambiguities), `requirement-scoper`, `backlog-decomposition-engine`
- Related: `aidlc-lifecycle-engine` (phase model and gate definitions)
