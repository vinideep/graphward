# Definition of Done
<!-- freshness: last_checked=2026-07-13 -->

A story/ticket is **Done** when:

- [ ] Implementation matches the recorded acceptance criteria.
- [ ] Required validation commands (per this repo: `npm run build`, `npm test`, `npm run test:integration` as applicable) ran and passed — environmental backpressure, not self-assessment.
- [ ] Relevant safety gates ran clean or findings were explicitly triaged (`env-vars`, `dead-exports`, `api-diff`, `migration-lint` as applicable to the change).
- [ ] Affected knowledge-base/memory/context/graph artifacts were incrementally synchronized (not left stale) via `sync-graphward`.
- [ ] A `CHG-XXX` change record was written per `change-history-engine`'s template.
- [ ] `aidlc-state.md` breadcrumb reflects completion: `AI-DLC: <phase> -> <stage> -> Complete`.
- [ ] Any new open questions or follow-ups were recorded rather than silently dropped.

## Status For This Repo

This checklist is currently unused — no story is in flight. It applies starting with the next `/graphward <request>` invocation. This initialization itself follows an analogous checklist tracked in `checkpoints.md`.

## Unknowns

- N/A
