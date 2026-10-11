---
name: grill-me
description: Stress-test a plan, proposal, or PRD through Socratic questioning to identify edge cases, failure modes, and trade-offs before implementation.
---

# Grill Me

Use the `socratic-stress-tester` capability to conduct a rigorous pre-flight alignment interview on a technical plan or PRD.

## Pipeline

1. **Read Proposal & Context** — Inspect the target proposal, relevant architecture docs in `.graphward/knowledge-base/`, and dependency graphs in `.graphward/graph/`.
2. **Execute Socratic Gauntlet** — Challenge the proposal across boundary conditions, failure/rollback modes, blast radius, NFRs, and complexity.
3. **Pose Targeted Options** — Present 2–4 high-impact questions with concrete multiple-choice trade-offs.
4. **Finalize Aligned Plan** — Update the technical plan with resolved decisions and confirmed assumptions before implementation starts.

## Completion Report

Finish with:
- Summary of resolved trade-offs and decisions
- List of confirmed assumptions vs. verified facts
- Next suggested action (e.g. `/graphward` or `/tdd`)

**Contract**: This workflow does not modify product code.


Read the active host capability profile under .graphward/providers/hosts/. Use its native question tool, or ask in the parent conversation. Subagents return unresolved questions to the parent. For every feature, discover repository facts, discuss requirements, confirm scope, prepare implementation context, then implement and validate. Prompt scores never authorize edits. Internal engines live in .graphward/engines. Preserve configured model and reasoning settings.
