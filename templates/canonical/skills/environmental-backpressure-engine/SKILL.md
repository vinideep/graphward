---
name: environmental-backpressure-engine
description: Drives compiler, linter, type-check, test, security, and architecture feedback loops until objective validation passes or blockers are recorded.
version: 1.0.0
---

# Environmental Backpressure Engine

Use this skill whenever code is generated or modified. The environment, not subjective inspection alone, supplies the feedback loop.

> [!IMPORTANT]
> This engine runs the project's configured check commands locally in the working directory. It does **not** provide container-level or VM-level isolation. Side effects from tests (API calls, database writes, webhook triggers) are not sandboxed or reversible. "Rollback" means reverting file changes only.

The verifier command `npx gw verify .` executes the project's own check commands, records their real exit codes, and writes a **record** binding the result to a sha256 of every changed file. Exit 1 means the tree is not verified.

The Stop gate requires a current verifier record. Changes to covered inputs invalidate an earlier record. During iteration, run focused checks and refresh the full record at the next verification point in the active workflow.

**If verify reports "No check commands detected"**, its own auto-detection only recognizes `package.json` scripts named `check`/`ci`/`typecheck`/`lint`/`test` and a handful of marker files. Do not leave this unresolved and do not proceed unverified:
1. Inspect `package.json` scripts, CI config (`.github/workflows/`, `.gitlab-ci.yml`, etc.), build files, and the README for the command(s) this project actually uses to check itself.
2. Write them into `hooks.verifyCommands` in `.graphward/gw.config.json` (array, run in order, stop at first failure). This file is seeded once and is yours to edit — it never causes a doctor warning or update conflict.
3. Re-run `npx gw verify .` and confirm it now executes real commands.
4. If no evidence of a check command exists anywhere in the repo, say so explicitly and ask the user rather than guessing one.

## Procedure

1. **Follow the active workflow's verification schedule.** Strict work requires a pre-edit baseline. Escalated work follows its lifecycle's baseline requirements. Run a required baseline once for the starting state or reuse the workflow's current baseline result. Record it separately from post-edit failures. Ordinary concise work schedules its full run at completion. For standalone use without an active workflow, follow the strict schedule.
2. Use focused checks during iteration:
   - formatter or static syntax check
   - type check or compile
   - targeted tests
   - linter
   - security or architecture scanner when relevant
3. Run the smallest relevant command that can expose the current risk.
4. Capture raw diagnostics in the active unit's `build-and-test/` artifact.
5. Fix failures and rerun the relevant check.
6. Run full verification once against the finished source and check inputs. Reuse an already recorded result from this task while those inputs match. Repeat when inputs change, a repair needs confirmation, or a separate run is required. Record failures, unavailable checks, and remaining blockers.

## Build And Test Summary

Write `.graphward/aidlc/construction/<unit>/build-and-test/build-and-test-summary.md`:

```markdown
# Build And Test Summary: <unit>

## Commands
- `<command>`: <passed|failed|unavailable|skipped> — <why>

## Failures And Corrections
- <diagnostic summary> -> <fix applied> -> <rerun result>

## Coverage / Performance
- <available metrics or Not detected>

## Residual Risk
- <remaining risks, blockers, or manual verification>
```

## Rules

- Never report validation as passed unless the command actually ran and passed.
- Do not hide failing output. Summarize it and keep enough detail for reproduction.
- Human review begins after local backpressure is exhausted, not before.
