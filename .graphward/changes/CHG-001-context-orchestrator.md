# CHG-001: EI-Owned Context Orchestrator and Provider Integration

## Meta

- Date: 2026-09-03
- Type: architecture, implementation, validation
- Status: locally validated; remote release matrix pending

## Summary

Implemented the EI-owned knowledge architecture in which repository source is ground truth, GraphWard artifacts are canonical engineering intelligence, Graphify supplies structural evidence, and CCE supplies scoped code retrieval. Provider failures degrade to permanent native GraphWard fallbacks; raw provider tools remain hidden unless expert mode is explicitly enabled.

## Material Changes

- Added a shared `ProjectFilePolicy` used to exclude generated output, provider caches, vendored dependencies, secrets, and escaped paths.
- Added transactional, version-pinned Graphify and CCE management with locks, health checks, rollback, repair, upgrade, and offline/native fallback behavior.
- Added Graphify normalization and evidence reconciliation without promoting provider-only or contested relationships into GraphWard claims.
- Added CCE retrieval in an isolated project workspace with GraphWard scope filtering and current source-span hash verification.
- Added `ContextPackV2` and the consolidated default MCP tools for context, impact, validation, synchronization, and provider status.
- Added configuration schema migration, typed MCP registration, argument-safe subprocess execution, accurate installation drift detection, deterministic benchmarks, and cross-platform CI jobs.
- Refreshed canonical and installed skills/workflows to enforce GraphWard authority, provider health reporting, provenance, progressive disclosure, and post-edit synchronization.

## Validation Evidence

- Unit tests: 214 passed.
- Integration tests: 13 passed.
- Native deterministic benchmark: passed with zero scope leakage.
- Live provider smoke corpus: 30 queries, Recall@10 0.90, 136 current scoped spans, zero context conflicts.
- Strict intelligence health: 273 of 273 claims verified, zero citation drift, zero stale evidence, provider indexes current.
- Package dry-run: passed.
- Live production dependency audit: zero known vulnerabilities after lockfile remediation.

## Remaining Release Qualification

The implementation is not described as fully released until the GitHub Actions matrix completes on Linux x64/arm64, macOS x64/arm64, and Windows x64 with real pinned-provider smoke tests and the vulnerability gate.

