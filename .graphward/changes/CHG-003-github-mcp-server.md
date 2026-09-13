# CHG-003: Add GitHub remote MCP server

## Request
Add the GitHub MCP server.

## Classification
- Type: infrastructure | Risk: medium

## Implementation Summary
Added the official GitHub remote MCP endpoint to the repository MCP configuration using its read-only URL variant. No PAT, bearer token, refresh token, or other credential was added. Added the required impact and MCP security review artifacts.

## Files Changed
- `.mcp.json` — registers `github` at `https://api.githubcopilot.com/mcp/readonly`.
- `.graphward/reports/IMP-004-github-mcp-server.md` — records scope, risks, evidence, and validation requirements.
- `.graphward/aidlc/operations/mcp-security-review.md` — records OAuth, read-only, prompt-injection, and human-approval controls.

## Tests
- JSON parse and endpoint/credential assertion — passed.
- `git diff --check` — passed.
- `node --test test/mcp-registry.test.mjs` — 2 passed, 0 failed.
- `node dist/cli/index.js verify . --json` — passed; full `npm test` completed with 242 passed, 0 failed.
- Host-client OAuth/tool discovery — pending interactive verification.

## Acceptance Criteria Verification
| Criterion | Evidence Type | Evidence | Result | Open Item |
|---|---|---|---|---|
| GitHub MCP server is present in repository configuration | automated check | `.mcp.json` parse assertion | pass | — |
| Official endpoint is used | automated check + GitHub Docs | endpoint assertion and official documentation | pass | — |
| No credential is committed | automated check | credential-pattern assertion over GitHub config | pass | — |
| GitHub write operations are not enabled by default | configuration review | `/mcp/readonly` endpoint and MCP security review | pass | — |
| Host client authenticates and discovers tools | manual verification | reload MCP configuration and complete OAuth | pending | Requires host UI/account approval |

## Safety Gates
- Freshness gate: synchronized for `.mcp.json`; unrelated canonical prose remains stale and out of scope.
- Type safety: not applicable.
- API compatibility: not applicable.
- API snapshots: not applicable.
- Migration safety: not applicable.
- Dependency security: not applicable; no dependency changed.
- Environment variables: not applicable; no environment variable changed.
- ADR compliance: passed for the scoped configuration change.
- LLM prompt injection: reviewed; GitHub content remains untrusted input.

## Open Items
- The host client must complete GitHub OAuth interactively before the server can access account-scoped data.
- Write-capable GitHub tools require a separate explicit request and security review.
