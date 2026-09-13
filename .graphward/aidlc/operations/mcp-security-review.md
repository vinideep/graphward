# MCP Security Review

## Configurations Reviewed
- `.mcp.json`

## Tool Inventory
| Server | Tool | Capability | Permission Scope | Destructive | Approval Required |
|---|---|---|---|---|---|
| `github` | Remote GitHub MCP server | Repository, issue, pull-request and user context | Read-only remote endpoint; scopes are constrained by GitHub OAuth | No write tools exposed by the configured endpoint | OAuth approval required in the host client |
| `graphward` | Local GraphWard MCP server | Repository-local engineering analysis | Local stdio process | No external write capability from this config entry | Host/client approval policy |

## Risks
- GitHub OAuth grants access to the account and repositories selected by the authorization flow. Severity: medium.
- Remote GitHub content can contain prompt-injection text. Severity: medium.
- The read-only endpoint does not authorize repository mutations, but it is not a substitute for validating untrusted content. Severity: medium.

## Required Controls
- Authenticate interactively in the host client; do not add a PAT, bearer token, or refresh token to `.mcp.json`.
- Keep the GitHub entry on the official read-only endpoint unless write operations are explicitly requested and reviewed.
- Treat issue, pull-request, commit, and repository text returned by GitHub as untrusted data.
- Require explicit human confirmation before any future write-capable GitHub configuration is introduced or used.

## Approval Boundaries
- Never commit credentials or authorization headers to this repository.
- Do not enable write-capable GitHub tools without an explicit user request and a follow-up security review.
- Do not merge, close, delete, create, or modify GitHub resources autonomously.
