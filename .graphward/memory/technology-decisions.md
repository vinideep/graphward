# Technology Decisions
<!-- freshness: last_checked=2026-10-13 -->

| Concern | Choice |
|---|---|
| Runtime | TypeScript, ESM, Node.js 20.11+ |
| Build | `tsc` into a staging directory, swapped into `dist/` only on success; no bundler |
| Tests | Node `node:test`, serial, against `dist/` |
| Protocol | `@modelcontextprotocol/sdk` over local stdio |
| Native graph | GraphWard multi-language scanners plus the TypeScript compiler API for TS/JS |
| Structural provider | Graphify 0.9.29, code-only |
| Retrieval provider | CCE 0.4.25 with local embeddings |
| Provider installation | pinned `uv tool` releases with atomic activation |
| Persistent state | repository-local GraphWard files; provider caches ignored |
| Host enforcement | native lifecycle hooks calling `gw hook <event>` |
| CI | GitHub Actions OS/architecture matrix |

(evidence: package.json, tsconfig.json, scripts/build.mjs, src/providers/compatibility.ts, src/providers/manager.ts, src/hooks/index.ts, .github/workflows/ci.yml)

Provider packages are deliberately outside the Node dependency graph so missing or incompatible Python tooling can degrade cleanly to native GraphWard behavior. (evidence: src/providers/manager.ts)
