# Service Map
<!-- freshness: last_checked=2026-09-03 -->

GraphWard is a local package, not a network service topology.

| Process | Transport | State |
|---|---|---|
| `graphward` | one-shot CLI/stdin/stdout | target repository and shared provider home |
| `ei-mcp` | local MCP over stdio | target repository GraphWard state |
| Graphify | child process | ignored project evidence plus shared executable |
| CCE | child process | ignored project index plus shared executable/model cache |

No GraphWard component binds a TCP port or requires a cloud credential in the default provider configuration. (evidence: src/mcp/cli.ts, src/providers/compatibility.ts, src/providers/manager.ts)
