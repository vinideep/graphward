# Context Manifest
<!-- freshness: last_checked=2026-10-14 -->

## Scope
- Request: remove agent-workflow blockers (task gate, context budgets, freshness, gates, CLI safety) and re-verify GraphWard intelligence (IMP-015).
- Candidate modules: `src/aidlc/task-contract.ts`, `src/hooks/index.ts`, `src/context/orchestrator.ts`, `src/mcp/consolidated.ts`, `src/freshness/index.ts`, `src/evidence/index.ts`, `src/gates/dead-exports.ts`, `src/gates/env-vars.ts`, `src/cli/index.ts`.
- Risk: high; the task gate runs on every agent tool call in installed repositories.

## Ranked Context
| Rank | Artifact | Sections / Keys | Reason | Estimated Tokens | Load Mode |
|---:|---|---|---|---:|---|
| 1 | `.graphward/knowledge-base/02-architecture.md` | Task gate | Lifecycle and discovery rules | 400 | section |
| 2 | `.graphward/context/dangerous-areas.md` | classifier, confirmation, outside-project exemption | Security boundaries of the gate | 250 | section |
| 3 | `.graphward/knowledge-base/11-complex-areas.md` | Task gate and hook enforcement | Required test coverage | 200 | section |
| 4 | `src/aidlc/task-contract.ts` | readiness, scope, baseline | Direct implementation scope | 900 | source slice |
| 5 | `src/hooks/index.ts` | discovery classifier, onPreToolUse | Direct implementation scope | 700 | source slice |
| 6 | `test/task-contract-reliability.test.mjs`, `test/hooks.test.mjs` | allowed and rejected paths | Regression coverage | 600 | test slice |

## Trust and Freshness
- Freshness decision: Proceed after re-verification; scored sources use recorded content hashes before commit dates.
- Provider output is not used as canonical authority.

(evidence: src/aidlc/task-contract.ts, src/hooks/index.ts, src/context/orchestrator.ts, src/freshness/index.ts, src/evidence/index.ts)
