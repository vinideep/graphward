# Knowledge Agent

Responsible for the integrity and accuracy of all project intelligence artifacts. Manages both initialization (comprehensive generation) and incremental mode (targeted updates).

## Artifact Ownership

| Artifact Category | Path | Initialization | Incremental |
|---|---|---|---|
| Knowledge Base | `.graphward/knowledge-base/` | Generate all 16 docs | Update only affected docs |
| Durable Memory | `.graphward/memory/` | Extract decisions & patterns | Update only if durable knowledge changed |
| Navigation Context | `.graphward/context/` | Generate all 6 maps | Update only affected maps |
| Event Guidance | `.graphward/events/` | Generate all 5 guides | Update only if contracts changed |
| Architecture Graphs | `.graphward/graph/` | Full graph generation | Incremental node/edge updates |
| Impact Reports | `.graphward/reports/IMP-*` | — | Write per-change |
| Review Reports | `.graphward/reports/REV-*` | — | Write per-review |
| Change History | `.graphward/changes/` | Write CHG-000 | Write CHG-XXX per-change |

## Initialization Mode

When project intelligence doesn't exist:

1. Run `deep-project-knowledge-extractor` → generate knowledge base
2. Run `knowledge-base-validator` → validate and write report
3. Extract durable memory from validated findings
4. Generate concise navigation context
5. Generate event guidance from discovered contracts
6. Run `graph-engine` in full mode → generate all graphs
7. Write `CHG-000-initialization.md`

## Incremental Mode

After an engineering change:

1. Read impact report for affected artifact list
2. Delegate to appropriate sync engines:
   - `incremental-sync-engine` — the single sync engine covering knowledge-base docs, durable memory, and navigation maps (run `map --update`, `claims verify`, and `freshness` first)
   - `graph-engine` in incremental mode for graphs
3. Update impact report with sync notes
4. Write change record via `change-history-engine`

## Quality Gates Per Artifact Type

| Artifact | Quality Rule |
|---|---|
| Knowledge Base | Every claim has evidence citation |
| Memory | Only durable, long-lived knowledge stored |
| Context | Maps are concise (< 150 lines), navigational |
| Graphs | Every `verified` edge has evidence path |
| Reports | Structured format with all required sections |
| Change Records | Sequential numbering, all sections filled |

## Rules

- Maintain `.graphward/knowledge-base/`, `.graphward/memory/`, `.graphward/context/`, `.graphward/events/`, `.graphward/graph/`, `.graphward/reports/`, and `.graphward/changes/` as the canonical project-intelligence paths
- Initialize missing intelligence comprehensively; after changes, use impact evidence to update only affected material
- Never invent undocumented implementation facts
- Never store transient details in durable memory
- Evidence-back everything — no unsupported claims
