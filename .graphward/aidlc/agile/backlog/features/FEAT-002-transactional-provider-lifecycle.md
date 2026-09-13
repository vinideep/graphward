# FEAT-002: Transactional provider lifecycle

- Epic: EPIC-001
- Status: approved
- Approval: approved
- Priority: P0
- Depends On: FEAT-001

## User Story
As an GraphWard user, I want Graphify and CCE detected, installed, checked, repaired, upgraded, and safely degraded without manually wiring independent MCPs.

## Acceptance Criteria
- Provider operations are typed, version-pinned, lock-safe, atomic, checksum-aware, and never silently install administrator prerequisites.
- `auto`, `full`, `native`, `offline`, and strict-provider policies have deterministic results.
- Raw provider MCPs remain hidden unless expert exposure is explicitly enabled.

## Tickets
- TKT-003 — Implement provider manager and manifest
- TKT-004 — Add provider CLI and setup integration

## Approval Gate
Approved by the user's 2026-09-02 implementation instruction; recorded in `audit.md`.
