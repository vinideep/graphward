# Repo Brief — engineering-intelligence-OS

<!-- Generated deterministically from the dependency graph. ~500-token orientation digest. -->
<!-- freshness derives from the current graph and package manifest evidence below. -->
(evidence: .graphward/graph/dependency-graph.json, package.json)

- **Scale**: 215 source modules, 1338 symbols, 13 external packages, 6084 edges.
- **Languages**: TypeScript (130), JavaScript (85).
- **Entry points**: bin `graphward`: `./dist/cli/index.js`; bin `gw-mcp`: `./dist/mcp/cli.js`; bin `gw`: `./dist/cli/index.js`.

## Most depended-on modules
These are the load-bearing files — changes here ripple widest.
- `src/config/index` (30 importers)
- `src/process/index` (27 importers)
- `src/project-files/index` (23 importers)
- `src/providers/workspace` (19 importers)
- `src/graph/index` (18 importers)
- `src/runtime/invocation` (16 importers)
- `src/gates/index` (15 importers)
- `src/manifest/lock` (15 importers)
- `src/graph/schema` (14 importers)
- `src/templates` (10 importers)

## Hotspots (highest churn, last 90 days)
- `src/cli/index.ts` (35 changes/90d)
- `src/adapters/index.ts` (28 changes/90d)
- `src/mcp/index.ts` (25 changes/90d)
- `test/adapters.test.mjs` (19 changes/90d)
- `src/hooks/index.ts` (16 changes/90d)
- `src/graph/index.ts` (16 changes/90d)
- `test/mcp.test.mjs` (15 changes/90d)
- `src/token-optimizer.ts` (14 changes/90d)

## Tests
80 test module(s), concentrated in: `test/` (80).

---
_Query deeper: `analyze_impact <file>` (what breaks), `who_calls <fn>` (callers), `find_symbol <name>` (locate). Graph auto-refreshes before each query._
