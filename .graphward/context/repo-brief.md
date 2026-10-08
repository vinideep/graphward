# Repo Brief — engineering-intelligence-OS

<!-- Generated deterministically from the dependency graph. ~500-token orientation digest. -->
<!-- freshness derives from the current graph and package manifest evidence below. -->
(evidence: .graphward/graph/dependency-graph.json, package.json)

- **Scale**: 209 source modules, 1069 symbols, 12 external packages, 3502 edges.
- **Languages**: TypeScript (126), JavaScript (83).
- **Entry points**: bin `graphward`: `./dist/cli/index.js`; bin `gw-mcp`: `./dist/mcp/cli.js`; bin `gw`: `./dist/cli/index.js`.

## Most depended-on modules
These are the load-bearing files — changes here ripple widest.
- `src/process/index` (16 importers)
- `src/graph/index` (15 importers)
- `src/config/index` (12 importers)
- `src/gates/index` (10 importers)
- `src/project-files/index` (9 importers)
- `src/providers/manager` (8 importers)
- `src/claims/index` (7 importers)
- `src/templates` (6 importers)
- `src/evidence/index` (6 importers)
- `src/verify/index` (6 importers)

## Hotspots (highest churn, last 90 days)
- `src/cli/index.ts` (30 changes/90d)
- `src/adapters/index.ts` (24 changes/90d)
- `src/mcp/index.ts` (21 changes/90d)
- `test/adapters.test.mjs` (17 changes/90d)
- `src/graph/index.ts` (14 changes/90d)
- `src/token-optimizer.ts` (13 changes/90d)
- `test/mcp.test.mjs` (12 changes/90d)
- `src/hooks/index.ts` (11 changes/90d)

## Tests
78 test module(s), concentrated in: `test/` (78).

---
_Query deeper: `analyze_impact <file>` (what breaks), `who_calls <fn>` (callers), `find_symbol <name>` (locate). Graph auto-refreshes before each query._
