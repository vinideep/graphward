# FEAT-003: Graphify evidence normalization

- Epic: EPIC-001
- Status: approved
- Approval: approved
- Priority: P0
- Depends On: FEAT-001, FEAT-002

## User Story
As an GraphWard user, I want Graphify to bootstrap structural evidence while GraphWard retains a verified canonical graph and knowledge base.

## Acceptance Criteria
- Raw Graphify output is stored as ignored provider evidence and normalized into GraphWard schema with provenance, hashes, confidence, freshness, and trust state.
- Native and Graphify evidence is reconciled; conflicts are contested and never promoted as verified claims.
- Provider failure leaves a complete native initialization path.

## Tickets
- TKT-005 — Normalize and reconcile Graphify evidence
- TKT-006 — Bootstrap initialization evidence bundle

## Approval Gate
Approved by the user's 2026-09-02 implementation instruction; recorded in `audit.md`.
