# Dependency Map
<!-- freshness: last_checked=2026-10-13 -->

## Runtime dependencies

- Node runtime and standard library.
- `@modelcontextprotocol/sdk` 1.29.0 for MCP transport and schemas; `typescript` for the compiler-backed TS/JS parser. (evidence: package.json)

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

(evidence: src/cli/index.ts, src/mcp/consolidated.ts, src/hooks/index.ts, src/aidlc/task-contract.ts, src/orchestrators/initialize.ts, src/context/orchestrator.ts)
