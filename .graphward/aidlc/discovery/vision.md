# Vision
<!-- freshness: last_checked=2026-07-13 -->

## Business Objective (as evidenced by the product itself)

`graphward` exists to make AI coding agents behave like a "disciplined engineering team" across any AI IDE: persist project knowledge across sessions, enforce impact analysis and safety gates before changes, and keep documentation honest via evidence hashing rather than trusting an LLM's self-report (evidence: README.md:4-6, 28-39).

## Personas (inferred from the product's design surface)

| Persona | Need | Evidence |
|---|---|---|
| Individual developer using an AI IDE | Wants the agent to stop re-learning the codebase every session and to stop skipping planning/testing discipline | README.md:32-39 (problem/solution table) |
| Team lead / engineering manager | Wants consistent process across a team using different AI IDEs, with a shared "team-preferences" consensus layer alongside per-developer profiles | README.md:39, src/user-profile/index.ts (personal profile) vs. team-preferences.md referenced in hooks/index.ts:435 |
| Package maintainer (this repo's own contributors) | Wants a single canonical source of skill/agent/workflow content that renders correctly to 9 different IDEs without manual duplication | src/adapters/index.ts, src/templates.ts |

## Value Proposition

- Persistent, evidence-backed knowledge base + architecture graphs instead of re-derivation every session.
- Deterministic (non-LLM) safety gates and claim verification, so trust doesn't depend entirely on model diligence.
- One canonical toolkit maintained once, installed natively into 9 IDEs.

## Success Metrics (as measured by the product itself)

- **Real token telemetry** (`src/telemetry/index.ts`) — the package explicitly moved away from a "synthetic" estimated token-reduction figure to measuring actual billed input/output tokens per session, comparing sessions that used `get_context` vs. those that didn't (evidence: src/telemetry/index.ts:1-14). This is the project's own definition of "is this working."
- **Claim verification rate** (`verified` vs. `stale`/`missing` in `claims verify`) as a proxy for how trustworthy the persisted knowledge base remains over time.

## Scope Boundary (explicitly stated)

"The installer does **not** inspect your source, call an AI model, or generate docs itself... the real work happens inside your IDE when you invoke them" (README.md:41). This package is infrastructure/tooling for the AI agent, not the agent itself.

## Unknowns

- **Unclear from evidence**: no formal product roadmap or success-metric target (e.g. "reduce re-exploration tokens by X%") was found — the telemetry mechanism measures but does not itself state a target.
