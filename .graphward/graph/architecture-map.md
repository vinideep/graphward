# Architecture Map
<!-- freshness: last_checked=2026-09-03 -->

This summary is derived from EI's normalized dependency graph. Provider JSON/report files are evidence inputs and must not be edited into a competing canonical graph. (evidence: .graphward/graph/dependency-graph.json, src/graph/provider-evidence.ts)

```mermaid
flowchart TD
    User[User or AI IDE] --> EI[GraphWard CLI / MCP control plane]
    GraphWard --> Policy[ProjectFilePolicy]
    Policy --> Native[GraphWard native graph]
    Policy --> Graphify[Graphify code-only evidence]
    Native --> Reconcile[GraphWard reconciliation]
    Graphify --> Reconcile
    Reconcile --> Canonical[GraphWard normalized graph]
    Canonical --> Scope[Architecture neighborhood]
    Scope --> CCE[CCE scoped retrieval]
    Scope --> NativeSearch[Native scoped retrieval fallback]
    CCE --> Pack[ContextPackV2]
    NativeSearch --> Pack
    Knowledge[Verified GraphWard knowledge and claims] --> Pack
    Pack --> Plan[Plan / implement / validate]
    Plan --> Sync[Graph, index, claim and knowledge sync]
    Sync --> Canonical
    Sync --> Knowledge
```

Provider health and fallback status are carried into every task context so degraded operation cannot look fully provider-backed. (evidence: src/context/orchestrator.ts, src/providers/manager.ts)
