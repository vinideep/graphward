# Workflow Routing Table

> **Read this before loading any skill files.**
> Load each primary `SKILL.md` only after the entry workflow selects it; brief files are not installed for this provider.
> Load **optional** skills only when the request explicitly requires that capability.
> Skill files are in `.agents/skills/<name>/` (SKILL.md).

| Command | Mutates product | Primary Skills — load first | Optional Skills — load if needed |
|---|---:|---|---|
| `graphward` | yes | `graphward-skill`, `socratic-clarification-gate`, `aidlc-lifecycle-engine`, `impact-analysis-engine`, `context-budget-optimizer` | `security-audit-engine`, `database-migration-safety-engine`, `api-backward-compatibility-engine`, `testing-intelligence-engine`, `environmental-backpressure-engine`, `type-safety-engine`, `convention-detector`, `operations-readiness-engine`, `incremental-sync-engine`, `change-history-engine`, `adr-compliance-checker`, `llm-prompt-injection-guard`, `vertical-tdd-engine`, `interface-design-explorer`, `debugging-engine`, `refactoring-planner`, `session-handoff-engine`, `socratic-stress-tester`, `graph-guided-autoresearch`, `question-file-engine`, `user-intelligence-engine`, `change-detection-engine` |
| `initialize-graphward` | no | `initialize-intelligence-skill` | `deep-project-knowledge-extractor`, `knowledge-base-validator`, `graph-engine`, `change-history-engine` |
| `decompose-backlog` | no | `backlog-decomposition-engine`, `context-budget-optimizer` | `issue-tracker-sync-engine`, `aidlc-lifecycle-engine`, `question-file-engine` |
| `deliver-backlog` | yes | `aidlc-lifecycle-engine`, `graphward-skill` | `backlog-decomposition-engine`, `issue-tracker-sync-engine`, `incremental-sync-engine` |
| `map-architecture` | no | `graph-engine` | `codebase-discovery-engine`, `git-intelligence-engine` |
| `analyze-impact` | no | `change-detection-engine`, `impact-analysis-engine` | `graph-engine` |
| `sync-graphward` | no | `change-detection-engine`, `incremental-sync-engine` | `staleness-detector`, `ongoing-learning-engine`, `knowledge-base-validator`, `graph-engine` |
| `review-engineering-change` | no | `change-detection-engine`, `engineering-change-review` | `impact-analysis-engine`, `security-audit-engine` |
| `scope-requirement` | no | `requirement-scoper` | `context-budget-optimizer`, `aidlc-lifecycle-engine`, `question-file-engine` |
| `discover-codebase` | no | `codebase-discovery-engine`, `convention-detector`, `graph-engine` | — |
| `create-project` | yes | `greenfield-architect`, `initialize-intelligence-skill` | — |
| `grill-me` | no | `socratic-stress-tester` | `requirement-scoper`, `architecture-review-engine`, `nfr-adr-governor` |
| `handoff` | no | `session-handoff-engine` | `context-budget-optimizer`, `incremental-sync-engine` |
| `tdd` | yes | `vertical-tdd-engine`, `testing-intelligence-engine` | `type-safety-engine`, `environmental-backpressure-engine` |
| `design-an-interface` | no | `interface-design-explorer` | `type-safety-engine`, `architecture-review-engine` |
