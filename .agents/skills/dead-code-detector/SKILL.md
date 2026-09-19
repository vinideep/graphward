---
disable-model-invocation: true
name: dead-code-detector
description: "Internal GraphWard engine. Use only when the selected entry workflow explicitly routes to dead-code-detector. Do not use for direct selection from an unclassified user request."
---

# Dead Code Detector

Use this skill during initialization, major refactors, dependency cleanup, and technical-debt reviews.

**Run the deterministic gate first:** `npx gw gate dead-exports .` (add `--json`). It reports JS/TS exports that are never imported anywhere, conservatively (namespace, dynamic, and re-export usage are treated as live, entry points and tests are exempt). Use the steps below to extend detection to unreachable branches, zombie dependencies, and git-history staleness the gate does not cover.

## Procedure

1. Scan imports/exports, route registrations, job registrations, dependency injection containers, and public entry points.
2. Identify unused exports, unreferenced files, unreachable branches, feature flags that are always on/off, and manifest dependencies with no import/use evidence.
3. Cross-reference `git-intelligence-engine` for stale modules, low ownership, and no recent changes.
4. Avoid false positives for framework-discovered files, reflection, migrations, generated code, and public package exports.
5. Produce candidates, not automatic deletions.

## Output

Write or update `.graphward/knowledge-base/12-technical-debt.md`:

```markdown
## Dead Code Candidates
| Candidate | Type | Confidence | Evidence | Safe Removal Steps |
|---|---|---|---|---|
```

## Quality Gates

- [ ] Static references were checked
- [ ] Framework dynamic entry points were considered
- [ ] Git staleness was included
- [ ] Findings include confidence and safe-removal steps

## Invocation Policy

- **Use when:** the selected entry workflow explicitly routes to dead-code-detector.
- **Do not use when:** direct selection from an unclassified user request.
- This is an internal engine. An entry workflow must select it; do not compete with entry workflows for the user request.
