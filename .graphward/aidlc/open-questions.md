# Open Questions
<!-- freshness: last_checked=2026-07-13 -->

| # | Question | Owner | Status |
|---|---|---|---|
| 1 | What is the intended relationship between `.agent/`, `.agents/`, and `.commandcode/` co-existing at the repo root — deliberate multi-IDE dogfooding, or accumulated cruft that should be pruned to one primary adapter? | Human (maintainer) | Open |
| 2 | What is the npm publish process (manual `npm publish` vs. an automated release workflow)? No publish-specific GitHub Actions workflow was found alongside `ci.yml`. | Human (maintainer) | Open |
| 3 | Should `src/mcp/index.ts`'s hardcoded `version: "2.3.0"` be read dynamically from `package.json` (like the CLI already does via `packageVersion()`) to prevent drift on future version bumps? | Human (maintainer) / next construction unit | Open |
| 4 | Is `SKILL_CATALOG` in `src/visualizer/index.ts` meant to be automatically validated for completeness against `SKILL_NAMES` in `src/templates.ts`, or is manual upkeep accepted? | Human (maintainer) | Open |
| 5 | What does `templates/canonical/ci/ei-drift-check.yml` actually check when installed into a consumer repo's CI? Not read in full this session. | Next sync / follow-up read | Open |
| 6 | Is there a dedicated test file for `src/user-profile/index.ts` (identity resolution, git-signal seeding)? None was found among the 13 files in `test/` — worth confirming this coverage gap is intentional or should be closed. | Human (maintainer) | Open |

## Resolved This Session

None — this was a first-pass initialization with no interactive Q&A; all six items above surfaced from evidence gaps rather than direct questions to the user.

## Unknowns

- N/A
