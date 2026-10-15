# Repo Brief — engineering-intelligence-OS

<!-- Generated deterministically from the dependency graph. ~500-token orientation digest. -->
<!-- freshness derives from the current graph and package manifest evidence below. -->
(evidence: .graphward/graph/dependency-graph.json, package.json)

- **Scale**: 202 source modules, 1222 symbols, 11 external packages, 4705 edges.
- **Languages**: TypeScript (126), JavaScript (76).
- **Entry points**: bin `graphward`: `./dist/cli/index.js`; bin `gw-mcp`: `./dist/mcp/cli.js`; bin `gw`: `./dist/cli/index.js`.

## Most depended-on modules
These are the load-bearing files — changes here ripple widest.
- `src/process/index` (22 importers)
- `src/config/index` (21 importers)
- `src/providers/workspace` (20 importers)
- `src/graph/index` (18 importers)
- `src/gates/index` (15 importers)
- `src/graph/schema` (13 importers)
- `src/evidence/index` (12 importers)
- `src/verify/index` (11 importers)
- `src/manifest/lock` (11 importers)
- `src/templates` (10 importers)

## Hotspots (highest churn, last 90 days)
- `src/cli/index.ts` (34 changes/90d)
- `src/adapters/index.ts` (26 changes/90d)
- `src/mcp/index.ts` (24 changes/90d)
- `test/adapters.test.mjs` (18 changes/90d)
- `src/graph/index.ts` (15 changes/90d)
- `test/mcp.test.mjs` (15 changes/90d)
- `src/hooks/index.ts` (14 changes/90d)
- `src/token-optimizer.ts` (13 changes/90d)

## Tests
71 test module(s), concentrated in: `test/` (71).

---
_Query deeper: `analyze_impact <file>` (what breaks), `who_calls <fn>` (callers), `find_symbol <name>` (locate). Graph auto-refreshes before each query._
