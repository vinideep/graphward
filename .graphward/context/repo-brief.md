# Repo Brief — engineering-intelligence-OS

<!-- Generated deterministically from the dependency graph. ~500-token orientation digest. -->
<!-- freshness derives from the current graph and package manifest evidence below. -->
(evidence: .graphward/graph/dependency-graph.json, package.json)
<!-- graphward:derived-from .graphward/graph/dependency-graph.json=12be82f553e8c8803d50fe30cf0e5e2cd07650c8a735f360419876be22459947 package.json=fafb2487ec1b8d414153bb151a7ce967b154553a494ab464874d80e4deb470c7 -->

- **Scale**: 217 source modules, 1350 symbols, 13 external packages, 6127 edges.
- **Languages**: TypeScript (130), JavaScript (87).
- **Entry points**: bin `graphward`: `./dist/cli/index.js`; bin `gw-mcp`: `./dist/mcp/cli.js`; bin `gw`: `./dist/cli/index.js`.

## Most depended-on modules
These are the load-bearing files — changes here ripple widest.
- `src/config/index` (31 importers)
- `src/process/index` (27 importers)
- `src/providers/workspace` (20 importers)
- `src/graph/index` (19 importers)
- `src/project-files/index` (19 importers)
- `src/runtime/invocation` (17 importers)
- `src/gates/index` (16 importers)
- `src/manifest/lock` (15 importers)
- `src/graph/schema` (15 importers)
- `src/evidence/index` (14 importers)

## Hotspots (highest churn, last 90 days)
- `src/cli/index.ts` (35 changes/90d)
- `src/adapters/index.ts` (29 changes/90d)
- `src/mcp/index.ts` (25 changes/90d)
- `test/adapters.test.mjs` (19 changes/90d)
- `src/hooks/index.ts` (17 changes/90d)
- `src/graph/index.ts` (16 changes/90d)
- `src/mcp/consolidated.ts` (15 changes/90d)
- `test/mcp.test.mjs` (15 changes/90d)

## Tests
82 test module(s), concentrated in: `test/` (82).

---
_Query deeper: `analyze_impact <file>` (what breaks), `who_calls <fn>` (callers), `find_symbol <name>` (locate). Graph auto-refreshes before each query._
