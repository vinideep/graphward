# Project Constraints
<!-- freshness: last_checked=2026-09-03 -->

- Node.js 20.11 or later and ESM are hard runtime constraints. (evidence: package.json)
- Template contract version 4.0.0 and npm package version 3.5.0 are independent compatibility dimensions. (evidence: src/manifest/index.ts, package.json)
- GraphWard keeps only the MCP SDK as a production npm dependency; Graphify/CCE are isolated managed tools. (evidence: package.json, src/providers/manager.ts)
- Provider versions are exact tested pins, not open ranges. (evidence: src/providers/compatibility.ts)
- Provider caches and generated output cannot enter canonical graph/retrieval scope. (evidence: src/project-files/index.ts, .eiignore)
- Network downloads are disabled with `--offline`; prerequisites requiring administrator action are diagnosed, not installed. (evidence: src/providers/manager.ts)
- Public export deletion remains out of scope without consumer-contract evidence. (evidence: src/gates/dead-exports.ts)
