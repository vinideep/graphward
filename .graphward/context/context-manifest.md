# Context Manifest

## Scope
- Request: Make Antigravity Agent output the primary GraphWard integration while preserving existing Workflows and legacy adapter compatibility.
- Candidate modules: `src/adapters/index.ts`, `src/templates.ts`, `src/installer/index.ts`, `src/validation/index.ts`, `test/adapters.test.mjs`, `test/installer.test.mjs`.
- Risk: medium-high; managed adapter paths and file formats are host integration contracts.

## Ranked Context
| Rank | Artifact | Sections / Keys | Reason | Estimated Tokens | Load Mode |
|---:|---|---|---|---:|---|
| 1 | `.graphward/knowledge-base/10-integrations.md` | adapter inventory and provider boundary | Existing adapter contract and supported IDE scope | 250 | section |
| 2 | `.graphward/knowledge-base/01-repository-structure.md` | canonical templates and rendered adapters | Source-of-truth boundaries | 180 | section |
| 3 | `.graphward/context/dangerous-areas.md` | managed adapter files | Protect user edits during migration | 150 | section |
| 4 | `.graphward/memory/architecture-decisions.md` | AD-5 | Canonical template and adapter boundary | 120 | section |
| 5 | `.graphward/graph/dependency-graph.json` | adapters, installer, validation, tests | Direct and indirect dependencies | 300 | graph slice |
| 6 | `src/adapters/index.ts` | Antigravity rendering and agent helpers | Direct implementation scope | 600 | source slice |
| 7 | `src/templates.ts` | agent/workflow catalogs | Canonical inventory | 300 | source slice |
| 8 | `test/adapters.test.mjs`, `test/installer.test.mjs` | Antigravity and merge assertions | Regression coverage | 500 | test slice |

## Trust and Freshness
- ContextPackV2 classification returned a host-integration scope with healthy knowledge, current source hashes, and native retrieval fallback.
- Freshness decision: Proceed; scoped freshness scores were above the implementation threshold.
- Provider output is not used as canonical authority.
