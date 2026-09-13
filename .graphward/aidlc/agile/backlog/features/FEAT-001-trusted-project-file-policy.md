# FEAT-001: Trusted project file policy

- Epic: EPIC-001
- Status: approved
- Approval: approved
- Priority: P0
- Depends On: none

## User Story
As an GraphWard user, I want every intelligence engine to use one explainable repository scope so generated, ignored, secret, and out-of-root files cannot pollute results.

## Acceptance Criteria
- Explicit configuration overrides `.eiignore`, which overrides `.gitignore`, which overrides built-in exclusions.
- Graph and retrieval candidates expose inclusion/exclusion reasons and reject path/symlink escapes.
- This repository's production graph excludes `dist/`, provider caches, and `benchmark/`.

## Tickets
- TKT-001 — Centralize repository scope policy
- TKT-002 — Apply scope policy to graph and gates

## Approval Gate
Approved by the user's 2026-09-02 implementation instruction; recorded in `audit.md`.
