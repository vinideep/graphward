# Dependency Map
<!-- freshness: last_checked=2026-09-03 -->

## Runtime dependencies

- Node runtime and standard library.
- `@modelcontextprotocol/sdk` 1.29.0 for MCP transport and schemas. (evidence: package.json)

## Optional managed providers

- Graphify 0.9.29 for structural extraction.
- CCE 0.4.25 for local semantic/code retrieval. (evidence: src/providers/compatibility.ts)

## Core internal direction

```text
CLI/MCP -> orchestrators -> file policy
                    |-> providers -> safe process runner
                    |-> graph reconciliation -> claims
                    `-> ContextPackV2 -> gates/tests/knowledge
```

(evidence: src/cli/index.ts, src/mcp/consolidated.ts, src/orchestrators/initialize.ts, src/context/orchestrator.ts)
