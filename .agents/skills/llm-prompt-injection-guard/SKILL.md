---
disable-model-invocation: true
name: llm-prompt-injection-guard
description: "Internal GraphWard engine. Use only when the selected entry workflow explicitly routes to llm-prompt-injection-guard. Do not use for direct selection from an unclassified user request."
---

# LLM Prompt Injection Guard

Use this skill for AI-augmented applications, RAG pipelines, agent tools, prompt builders, chat handlers, knowledge ingestion, or any code that sends user-controlled data to an LLM.

## Procedure

1. Detect LLM calls, prompt templates, tool outputs, embedding pipelines, document ingestion, and agent memory writes.
2. Trace user-controlled sources into prompts, system messages, tool descriptions, retrieval documents, logs, knowledge-base files, and memory files.
3. Flag missing controls:
   - no prompt boundary separation
   - no input sanitization or quoting
   - no output schema validation
   - tool results trusted without validation
   - externally sourced content written into durable memory without provenance
   - secrets or policies exposed to user-influenced context
4. Require adversarial tests for high-risk LLM paths.

## Output

Write `.graphward/reports/LLM-PROMPT-INJECTION-<slug>.md`:

```markdown
# LLM Prompt Injection Review: <summary>

## Data Paths
| Source | LLM / Memory Sink | Control Present | Risk | Evidence |
|---|---|---|---|---|

## Findings
- <prompt injection or output validation risk>

## Required Tests
- <adversarial test cases>
```

## Quality Gates

- [ ] LLM calls and memory/document ingestion paths were inventoried
- [ ] User-controlled sources were traced to LLM and durable-memory sinks
- [ ] Output validation was checked
- [ ] High-risk paths have adversarial tests or blocking findings

## Invocation Policy

- **Use when:** the selected entry workflow explicitly routes to llm-prompt-injection-guard.
- **Do not use when:** direct selection from an unclassified user request.
- This is an internal engine. An entry workflow must select it; do not compete with entry workflows for the user request.
