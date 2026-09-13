# Event: Infrastructure Changed
<!-- freshness: last_checked=2026-07-13 -->

Trigger: changes to `.github/workflows/`, `package.json` build/publish config, `tsconfig.json`, or `templates/canonical/ci/ei-drift-check.yml`.

## What Counts As Infrastructure Here

This package has minimal infrastructure (see `09-infrastructure.md`): no containers, no cloud deploy target. Infrastructure changes are limited to:
- CI workflow (`.github/workflows/*.yml`) — Node version matrix, test commands, triggers.
- Build/publish config (`package.json` `scripts`, `files`, `engines`).
- TypeScript compiler config (`tsconfig.json`).
- The CI template this package *ships* to consumer repos (`templates/canonical/ci/ei-drift-check.yml`).

## Checklist On Change

1. **Node engine range change** (`package.json` `engines.node`): update the CI matrix in `.github/workflows/*.yml` to match, and verify `@types/node`'s major version still aligns.
2. **New/removed npm script**: if it's a test script, update `09-infrastructure.md`'s build/release table and the CI workflow's `run:` steps.
3. **`tsconfig.json` change** (e.g. enabling a new strict flag): expect a wave of new compile errors across `src/` — run `npm run build` locally first and budget time to fix fallout before pushing, since CI will fail on both Node 20 and 22 simultaneously.
4. **`files` allowlist change** in `package.json`: verify the newly included/excluded paths are intentional — this directly controls what ships in the published npm tarball (currently `dist`, `templates`, `README.md`, `LICENSE`).
5. **`ei-drift-check.yml` template change**: this is consumer-facing infrastructure (installed into *their* CI), not this repo's own CI. Changes here should be validated against what it's meant to check (freshness/gates/claims in CI) — read the file in full before modifying, since this initialization did not read its complete contents (see `15-validation-report.md`).
6. Re-run `npm run test:integration` locally — this is the suite most likely to catch build/packaging regressions since it exercises the full install flow against a real filesystem.

## Unknowns

- **Unclear from evidence**: `ei-drift-check.yml`'s exact content/purpose was not read in this initialization pass — read it directly before making infrastructure changes that might interact with it.
