# Repo Brief — engineering-intelligence-OS

<!-- Generated deterministically from the dependency graph. ~500-token orientation digest. -->
<!-- freshness derives from the current graph and package manifest evidence below. -->
(evidence: .graphward/graph/dependency-graph.json, package.json)

- **Scale**: 200 source modules, 1198 symbols, 11 external packages, 4610 edges.
- **Languages**: TypeScript (125), JavaScript (75).
- **Entry points**: bin `graphward`: `./dist/cli/index.js`; bin `gw-mcp`: `./dist/mcp/cli.js`; bin `gw`: `./dist/cli/index.js`.

## Most depended-on modules
These are the load-bearing files — changes here ripple widest.
- `src/process/index` (23 importers)
- `src/config/index` (21 importers)
- `src/providers/workspace` (20 importers)
- `src/graph/index` (18 importers)
- `src/gates/index` (15 importers)
- `src/manifest/lock` (15 importers)
- `src/graph/schema` (13 importers)
- `src/evidence/index` (12 importers)
- `src/templates` (10 importers)
- `src/token-optimizer` (9 importers)

## Hotspots (highest churn, last 90 days)
- `src/cli/index.ts` (33 changes/90d)
- `src/adapters/index.ts` (25 changes/90d)
- `src/mcp/index.ts` (24 changes/90d)
- `test/adapters.test.mjs` (18 changes/90d)
- `src/graph/index.ts` (15 changes/90d)
- `test/mcp.test.mjs` (15 changes/90d)
- `src/token-optimizer.ts` (13 changes/90d)
- `src/hooks/index.ts` (12 changes/90d)

## Tests
70 test module(s), concentrated in: `test/` (70).

---
_Query deeper: `analyze_impact <file>` (what breaks), `who_calls <fn>` (callers), `find_symbol <name>` (locate). Graph auto-refreshes before each query._
