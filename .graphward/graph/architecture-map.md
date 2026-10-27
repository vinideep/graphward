# Architecture Map
<!-- freshness: last_checked=2026-10-27 -->

This summary is derived from GraphWard's normalized dependency graph. Provider JSON/report files are evidence inputs and must not be edited into a competing canonical graph. (evidence: src/graph/provider-evidence.ts, src/graph/index.ts)

```mermaid
flowchart TD
    User[User or AI IDE] --> GW[GraphWard CLI / MCP control plane]
    User --> Hooks[Host lifecycle hooks]
    Hooks --> Gate[Task gate: confirmation and canonical scope]
    Gate --> Report[Reports: requirements readiness]
    Gate --> Product[Product: bound implementation context]
    Report --> GW
    Product --> GW
    GW --> Policy[ProjectFilePolicy]
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

Current reviews/required-baseline receipts bind scope/source/check/runtime identity. Fresh MCP processes expose loaded versus disk generation; pre-upgrade processes require a reconnect. Context response budgets count the complete estimated payload and report omissions/overflow. (evidence: src/gates/review-evidence.ts, src/verify/index.ts, src/runtime/invocation.ts, src/mcp/index.ts, src/context/orchestrator.ts)
