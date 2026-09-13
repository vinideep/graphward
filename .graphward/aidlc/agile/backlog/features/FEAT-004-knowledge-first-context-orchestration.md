# FEAT-004: Knowledge-first context orchestration

- Epic: EPIC-001
- Status: approved
- Approval: approved
- Priority: P0
- Depends On: FEAT-001, FEAT-003

## User Story
As an engineering agent, I want one GraphWard context API that validates knowledge first, scopes through the canonical graph, and retrieves exact source evidence adaptively.

## Acceptance Criteria
- ContextPackV2 reports knowledge trust, provider health, provenance, conflicts, unknowns, budget, and confidence.
- CCE results are scope-filtered and source-span verified; native retrieval is the durable fallback.
- Consolidated GraphWard MCP tools are the default public surface and existing tools remain compatible.

## Tickets
- TKT-007 — Implement CCE scoped retrieval adapter
- TKT-008 — Build ContextPackV2 and MCP tools

## Approval Gate
Approved by the user's 2026-09-02 implementation instruction; recorded in `audit.md`.
