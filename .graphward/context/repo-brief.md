# Repo Brief — engineering-intelligence-OS

<!-- Generated deterministically from the dependency graph. ~500-token orientation digest. -->
<!-- freshness derives from the current graph and package manifest evidence below. -->
(evidence: .graphward/graph/dependency-graph.json, package.json)

- **Scale**: 199 source modules, 1177 symbols, 11 external packages, 4448 edges.
- **Languages**: TypeScript (125), JavaScript (74).
- **Entry points**: bin `graphward`: `./dist/cli/index.js`; bin `gw-mcp`: `./dist/mcp/cli.js`; bin `gw`: `./dist/cli/index.js`.

## Most depended-on modules
These are the load-bearing files — changes here ripple widest.
- `src/process/index` (24 importers)
- `src/config/index` (22 importers)
- `src/graph/schema` (18 importers)
- `src/graph/index` (16 importers)
- `src/gates/index` (14 importers)
- `src/project-files/index` (14 importers)
- `src/providers/workspace` (12 importers)
- `src/evidence/index` (10 importers)
- `src/providers/types` (10 importers)
- `src/manifest/secrets-scan` (10 importers)

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
69 test module(s), concentrated in: `test/` (69).

---
_Query deeper: `analyze_impact <file>` (what breaks), `who_calls <fn>` (callers), `find_symbol <name>` (locate). Graph auto-refreshes before each query._
