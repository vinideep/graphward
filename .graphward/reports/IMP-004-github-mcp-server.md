# IMP-004: Add GitHub remote MCP server

## Classification
- Type: infrastructure
- Risk: medium
- Scope: `.mcp.json`; MCP security review artifact

## Analysis
- Mode: proposal
- Freshness gate: synced for `.mcp.json`; unrelated canonical prose remains stale and is out of scope
- Graph inputs consulted: `.graphward/context/service-map.md`, `.graphward/knowledge-base/06-authentication.md`, current `.mcp.json`
- Directly affected: repository MCP server configuration
- Indirectly affected: Codex/compatible MCP clients loading this repository configuration
- Risk factors: third-party network service, GitHub account authorization, remote tool capability and untrusted repository content

## Validation Requirements
- Parse `.mcp.json` as JSON
- Verify the GitHub server entry uses the official GitHub remote endpoint and contains no credential material
- Run the targeted MCP/configuration tests available in the repository
- Manual verification: authenticate the server in the host client and confirm the expected GitHub tools appear
- Type safety: not applicable; no typed product code changed
- API compatibility: not applicable; no repository API changed
- Migration safety: not applicable

## Intelligence Artifacts Affected
- `.graphward/aidlc/operations/mcp-security-review.md`
- This impact report and the corresponding change record

## Evidence
- `.mcp.json:1-7` — existing `mcpServers` configuration
- `.graphward/context/service-map.md` — MCP is configured as a local/client-facing integration surface
- `.graphward/knowledge-base/06-authentication.md` — existing project guidance keeps credentials out of repository configuration
- GitHub Docs — official remote MCP endpoint and OAuth setup

## Unknowns
- The host client may require an interactive OAuth step after reloading the configuration.
- The host client’s exact tool discovery behavior cannot be proven from repository-local tests.
