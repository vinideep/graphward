# Event: Auth Changed
<!-- freshness: last_checked=2026-07-13 -->

Trigger: changes to `resolveIdentity()` / CI detection (`src/user-profile/index.ts`) or the MCP server's trust model (`src/mcp/index.ts`).

There is no login/session/RBAC system in this package (see `06-authentication.md`). This event guidance covers the two auth-adjacent surfaces that do exist.

## What Counts As An "Auth" Change Here

- Changing how developer identity is resolved (`resolveIdentity`, src/user-profile/index.ts:106-123) — e.g. adding a new identity source beyond `git config user.email`.
- Changing the CI-detection env var list (`detectCI`, src/user-profile/index.ts:73-76) — affects whether a personal profile is written.
- Adding any authentication/authorization to the MCP server (currently none — stdio-trusted).
- Changing what data is written to the gitignored personal profile directory (`memory/users/<slug>/`).

## Checklist On Change

1. Update `06-authentication.md` to reflect the new identity-resolution or trust-model behavior.
2. If a new CI environment variable is added to `detectCI()`: verify it doesn't collide with a legitimate developer environment variable naming pattern (all current entries are well-known CI-platform-specific vars).
3. If MCP server auth is ever introduced: this is a significant trust-model change — update `10-integrations.md` and `06-authentication.md`'s "no authentication of its own" claim, and consider whether it affects the stdio transport assumption throughout `03-runtime-flow.md`.
4. If personal-profile data collection expands: verify `ensureEiGitignore()` (src/user-profile/index.ts:333-340) still correctly keeps the new data out of version control — this is the sole privacy control for personal data in this system.
5. Re-run tests covering identity resolution (check for coverage in the test suite; no dedicated `user-profile.test.mjs` was found in the file listing — consider whether this gap should be closed as part of the auth change).

## Unknowns

- **Not detected**: no `user-profile.test.mjs` or equivalent test file exists in `test/` (13 files listed, none named for user-profile) — changes to identity resolution currently have no dedicated automated test coverage found in this pass.
