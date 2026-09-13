# Event: API Changed
<!-- freshness: last_checked=2026-07-13 -->

Trigger: a CLI subcommand's flags/behavior change, or an MCP tool's `inputSchema`/return shape changes.

## What Counts As An API Change Here

- Adding/removing/renaming a CLI command in `COMMANDS` (src/cli/index.ts:15) or a flag in `parseArgs()`.
- Adding/removing/renaming a tool in the MCP `TOOLS` array (src/mcp/index.ts:10-113) or changing its `inputSchema`/response shape.
- Changing the `usage()` help text (src/cli/index.ts:49-79) — this is the canonical documented contract for CLI consumers.

## Checklist On Change

1. Update `04-api-documentation.md` (this file's CLI/MCP tables) to match.
2. Update `usage()` in `src/cli/index.ts` if a flag or command changed — it must stay in sync with actual `parseArgs()` behavior.
3. If an MCP tool's `inputSchema` changed: verify `mcp.test.mjs` covers the new shape; consider whether this is a breaking change for existing MCP clients (removing a required field, changing a type) — if so, treat it like a breaking API change and consider versioning.
4. If a new CLI command was added: add it to `COMMANDS` (src/cli/index.ts:15) **and** the `Command` union type, add a dispatch branch in `main()`, and add usage text.
5. Re-run `gw gate api-diff` against this repo's own working tree if the CLI itself exposes anything resembling routes (it doesn't today — this gate is more relevant to consumer repos, but the discipline of checking "did I remove something someone depends on" still applies to CLI flags).
6. Update `README.md`'s command tables if user-facing.
7. Add/update tests in the relevant `test/*.test.mjs` file.

## Who To Check

- `mcp.test.mjs` (MCP contract), `templates.test.mjs` if the change affects what `validateCanonicalTemplates()` expects, `install-integration.test.mjs` if install-time behavior changed.

## Unknowns

- N/A — this event guidance is derived directly from the CLI/MCP surface documented in `04-api-documentation.md`.
