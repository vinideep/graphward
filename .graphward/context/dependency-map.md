# Dependency Map
<!-- freshness: last_checked=2026-10-27 -->

## Runtime dependencies

- Node runtime and standard library.
- `@modelcontextprotocol/sdk` 1.32.1 for MCP transport and schemas; `typescript` for the compiler-backed TS/JS parser. (evidence: package.json)

## Optional managed providers

- Graphify 0.9.29 for structural extraction.
- CCE 0.4.25 for local semantic/code retrieval. (evidence: src/providers/compatibility.ts)

## Core internal direction

```text
CLI/MCP/hooks -> orchestrators -> file policy
                    |-> providers -> safe process runner
                    |-> graph reconciliation -> claims
                    |-> task contract -> context preparation -> ContextPackV2
                    `-> ContextPackV2 -> gates/tests/knowledge
```

Configuration supplies strict-default workflow mode to rendering/hooks; the routing catalog supplies advisory intent to context classification. Local effects and native task readiness remain separate from that advice. (evidence: src/config/index.ts, src/adapters/index.ts, src/token-optimizer.ts, src/routing/catalog.ts, src/hooks/index.ts, src/context/orchestrator.ts)

(evidence: src/cli/index.ts, src/mcp/consolidated.ts, src/hooks/index.ts, src/aidlc/task-contract.ts, src/orchestrators/initialize.ts, src/context/orchestrator.ts)
