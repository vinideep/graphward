# Service Map
<!-- freshness: last_checked=2026-10-27 -->

GraphWard is a local package, not a network service topology.

| Process | Transport | State |
|---|---|---|
| `graphward` / `gw` | one-shot CLI/stdin/stdout | target repository and shared provider home |
| `gw hook <event>` | one process per host lifecycle event, JSON on stdin/stdout | `.graphward/aidlc/tasks/`, `.graphward/.hooks-state/` |
| `gw-mcp` | long-running local MCP over stdio, bound to one project root | target repository GraphWard state |
| Graphify | child process | ignored project evidence plus shared executable |
| CCE | child process | ignored project index plus shared executable/model cache |

No GraphWard component binds a TCP port or requires a cloud credential in the default provider configuration. (evidence: package.json, src/mcp/cli.ts, src/hooks/index.ts, src/providers/compatibility.ts, src/providers/manager.ts)
