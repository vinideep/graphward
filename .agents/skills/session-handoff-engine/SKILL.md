---
disable-model-invocation: true
name: session-handoff-engine
description: "Internal GraphWard engine. Use only when the selected entry workflow explicitly routes to session-handoff-engine. Do not use for direct selection from an unclassified user request."
---

# Session Handoff Engine

Serialize active conversation state, in-flight task progress, verified facts, and unresolved blockers into a compact, durable handoff document to ensure flawless continuity across agents, subagents, or sessions.

## Inputs

- Active conversation context and task objective
- List of modified, created, or deleted files in the working tree
- Active claims from `.graphward/claims/`
- Current state in `.graphward/aidlc/aidlc-state.md`

## Procedure

1. **Capture In-Flight State**:
   - Identify the primary goal and current execution stage.
   - List all files modified, created, or inspected during the session.

2. **Categorize Evidence & Assumptions**:
   - **Verified Facts**: Statements supported by actual test runs, compiler output, or hashed line references (`[VERIFIED: path#lines]`).
   - **Unverified Assumptions**: Hypotheses or design choices not yet proven by execution (`[ASSUMPTION]`).
   - **Active Blockers / Open Questions**: Decisions waiting on human confirmation or upstream dependencies.

3. **Generate Handoff Packet**:
   Write `.graphward/handoffs/HO-<date>-<task-slug>.md` with the following structure:
   - **Task Context**: Objective and current status.
   - **Verified Ground Truth**: Direct repository facts and passing test records.
   - **Working Tree Diff Summary**: Modified paths and pending edits.
   - **Next Immediate Actions**: Exact commands and files for the next agent/session to run.

4. **Verify Resumeability**:
   - Ensure the handoff artifact contains all context necessary for a fresh agent instance to resume without re-asking questions or re-exploring the codebase.

## Invocation Policy

- **Use when:** the selected entry workflow explicitly routes to session-handoff-engine.
- **Do not use when:** direct selection from an unclassified user request.
- This is an internal engine. An entry workflow must select it; do not compete with entry workflows for the user request.
