---
disable-model-invocation: true
name: contract-test-generator
description: "Internal GraphWard engine. Use only when the selected entry workflow explicitly routes to contract-test-generator. Do not use for direct selection from an unclassified user request."
---

# Contract Test Generator

Use this skill when service boundaries, API clients, webhooks, events, GraphQL schemas, or RPC contracts change.

## Procedure

1. Read `service-graph.json`, `.graphward/knowledge-base/04-api-documentation.md`, OpenAPI/GraphQL/protobuf schemas, and existing contract tests.
2. Detect the project’s contract-test framework if any: Pact, Spring Cloud Contract, protobuf conformance tests, schema snapshots, custom integration harness, or plain test framework.
3. Generate or recommend stubs matching the project’s exact test structure and assertion style.
4. Cover canonical scenarios:
   - happy path
   - auth failure
   - validation error
   - downstream timeout
   - unexpected response shape
5. Feed generated stubs and commands into `testing-intelligence-engine`.

## Output

Write `.graphward/aidlc/construction/<unit>/contract-test-plan.md`:

```markdown
# Contract Test Plan: <unit>

| Boundary | Consumer | Provider | Scenario | Stub/Test Path | Status |
|---|---|---|---|---|---|
```

## Quality Gates

- [ ] Changed service boundaries are identified
- [ ] Existing contract-test style is matched
- [ ] Canonical failure scenarios are covered or explicitly not applicable
- [ ] Contract tests are linked to acceptance criteria

## Invocation Policy

- **Use when:** the selected entry workflow explicitly routes to contract-test-generator.
- **Do not use when:** direct selection from an unclassified user request.
- This is an internal engine. An entry workflow must select it; do not compete with entry workflows for the user request.
