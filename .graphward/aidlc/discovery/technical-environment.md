# Technical Environment
<!-- freshness: last_checked=2026-07-13 -->

## Runtime

- Node.js >= 20.11, ESM-only (`"type": "module"`), compiled from TypeScript (`strict: true`) via `tsc` — no bundler. See `00-project-overview.md`, `technology-decisions.md`.

## Deployment

- **Distribution channel**: npm registry, package name `graphward` (also `ei-mcp` bin alias). No hosted service, no container image, no cloud deployment.
- **Installation model**: consumer repos run `npx gw install` which writes files into *their* repo — this package's own "deployment" is simply npm publish.

## Integrations

- Model Context Protocol (`@modelcontextprotocol/sdk` 1.29.0) — stdio transport only.
- Local `git` binary, shelled out to — soft dependency, degrades gracefully if absent.
- 9 AI IDE file-format targets (see `04-api-documentation.md`'s per-IDE table) — file-generation integration, not network API integration.

## Data Stores

**Not detected.** No database. All state is JSON/JSONL/Markdown files under `.graphward/` in the target repo (see `05-database.md`).

## Auth

**Not detected.** No login/session system (see `06-authentication.md`). Developer identity is resolved from local git config solely to seed a gitignored personal profile.

## Constraints

- Zero runtime dependencies beyond the MCP SDK (see `project-constraints.md`).
- No network calls of any kind — fully local tool.
- Managed-file/block hashing contracts must remain stable across versions (breaking this invalidates every previously-installed consumer repo's conflict-detection state).

## CI/CD

- GitHub Actions, Node 20 & 22 matrix, `npm test` + `npm run test:integration` on push/PR to `main` (see `09-infrastructure.md`).

## Unknowns

- **Unclear from evidence**: npm publish automation (see `open-questions.md` #2).
