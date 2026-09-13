# Technology Decisions
<!-- freshness: last_checked=2026-09-03 -->

| Concern | Choice |
|---|---|
| Runtime | TypeScript, ESM, Node.js 20.11+ |
| Build | `tsc` without a production bundler |
| Tests | Node `node:test` |
| Protocol | `@modelcontextprotocol/sdk` over local stdio |
| Native graph | GraphWard multi-language scanners with current-source evidence |
| Structural provider | Graphify 0.9.29, code-only |
| Retrieval provider | CCE 0.4.25 with local embeddings |
| Provider installation | pinned `uv tool` releases with atomic activation |
| Persistent state | repository-local GraphWard files; provider caches ignored |
| CI | GitHub Actions OS/architecture matrix |

(evidence: package.json, tsconfig.json, src/providers/compatibility.ts, src/providers/manager.ts, .github/workflows/ci.yml)

Provider packages are deliberately outside the Node dependency graph so missing or incompatible Python tooling can degrade cleanly to native GraphWard behavior. (evidence: src/providers/manager.ts)
