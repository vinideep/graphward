# Project Constraints
<!-- freshness: last_checked=2026-10-27 -->

- Node.js 20.11 or later and ESM are hard runtime constraints. (evidence: package.json)
- Template contract version (`TEMPLATE_VERSION`, currently 5.0.0) and the npm package version (`graphward`, currently 1.3.3) are independent compatibility dimensions. (evidence: src/manifest/index.ts, package.json)
- Production npm dependencies are limited to the MCP SDK and `typescript` (loaded at runtime by the compiler-backed TS/JS parser); tree-sitter grammars are optional peers; Graphify/CCE are isolated managed tools. (evidence: package.json, src/graph/parsers/typescript-compiler.ts, src/providers/manager.ts)
- Provider versions are exact tested pins, not open ranges. (evidence: src/providers/compatibility.ts)
- Provider caches, generated output and rendered adapter directories cannot enter canonical graph/retrieval scope. (evidence: src/project-files/index.ts)
- Managed provider downloads are disabled with `--offline`; npm, host tools and arbitrary validation commands have separate network behavior. Prerequisites requiring administrator action are diagnosed, not installed. (evidence: src/providers/manager.ts)
- Public export deletion remains out of scope without consumer-contract evidence. (evidence: src/gates/dead-exports.ts)
