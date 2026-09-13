# Cross-Unit Discoveries
<!-- freshness: last_checked=2026-07-13 -->

Append-only log of shared discoveries from parallel or sequential construction units. Read this file before starting each new unit; append findings, impact, and action taken when new constraints appear.

## Log

_No construction units have run yet. This initialization was a single, non-parallel unit (documentation/analysis only, no product code touched) — nothing to log here._

### 2026-09-02 — Unit: EPIC-001 preflight
- **Finding**: The generated graph includes ignored `dist/`, external benchmark, and script paths because scanners use fixed exclusions and resolved imports may reintroduce generated targets.
- **Impact**: Graph, context, impact, dead-export, and provider scoping require one shared file policy.
- **Action taken**: FEAT-001 is a hard dependency for all provider and retrieval work.

### 2026-09-02 — Unit: EPIC-001 preflight
- **Finding**: Installed adapter manifests/copies are stale relative to canonical templates; `.agent` and `.agents` have distinct adapter ownership and are not safe deletion candidates.
- **Impact**: Doctor must compare desired output with the installed manifest; generated copies must be refreshed through the installer.
- **Action taken**: Preserve both adapters and include reconciliation under FEAT-005.

## Format For Future Entries

```markdown
### <date> — Unit: <unit-name>
- **Finding**: <what was discovered>
- **Impact**: <what other units/files are affected>
- **Action taken**: <how it was handled>
```

## Unknowns

- N/A
