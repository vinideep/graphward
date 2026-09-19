# Repo Brief — engineering-intelligence-OS

<!-- Generated deterministically from the dependency graph. ~500-token orientation digest. -->
<!-- freshness derives from the current graph and package manifest evidence below. -->
(evidence: .graphward/graph/dependency-graph.json, package.json)

- **Scale**: 189 source modules, 944 symbols, 11 external packages, 3137 edges.
- **Languages**: TypeScript (119), JavaScript (70).
- **Entry points**: bin `graphward`: `./dist/cli/index.js`; bin `gw-mcp`: `./dist/mcp/cli.js`; bin `gw`: `./dist/cli/index.js`.

## Most depended-on modules
These are the load-bearing files — changes here ripple widest.
- `src/process/index` (16 importers)
- `src/graph/index` (15 importers)
- `src/gates/index` (10 importers)
- `src/config/index` (9 importers)
- `src/project-files/index` (9 importers)
- `src/providers/manager` (8 importers)
- `src/claims/index` (7 importers)
- `src/templates` (6 importers)
- `src/evidence/index` (6 importers)
- `src/verify/index` (6 importers)

## Hotspots (highest churn, last 90 days)
- `src/cli/index.ts` (27 changes/90d)
- `src/adapters/index.ts` (20 changes/90d)
- `src/mcp/index.ts` (20 changes/90d)
- `src/graph/index.ts` (14 changes/90d)
- `test/adapters.test.mjs` (13 changes/90d)
- `src/token-optimizer.ts` (12 changes/90d)
- `test/mcp.test.mjs` (11 changes/90d)
- `test/install-integration.test.mjs` (10 changes/90d)

## Tests
65 test module(s), concentrated in: `test/` (65).

---
_Query deeper: `analyze_impact <file>` (what breaks), `who_calls <fn>` (callers), `find_symbol <name>` (locate). Graph auto-refreshes before each query._
