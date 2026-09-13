# Event: Schema Changed
<!-- freshness: last_checked=2026-07-13 -->

Trigger: the `DependencyGraph` schema (`src/graph/schema.ts`), the `ClaimStore`/`Claim` schema (`src/claims/index.ts`), or the `InstallManifest` schema (`src/types.ts`, `src/manifest/index.ts`) changes shape.

There is no SQL/NoSQL database in this package (see `05-database.md`) — "schema" here means these three JSON contracts, each already versioned with a literal `schemaVersion: 1`.

## What Counts As A Schema Change Here

- Adding/removing/renaming a field on `GraphNode`, `GraphEdge`, or `DependencyGraph` (src/graph/schema.ts:1-30).
- Adding/removing/renaming a field on `Claim`, `ClaimEvidence`, or `ClaimStore` (src/claims/index.ts:20-38).
- Adding/removing/renaming a field on `InstallManifest` or `ManagedFileEntry` (src/types.ts:25-41).

## Checklist On Change

1. **Bump `schemaVersion`** on the affected type if the change is not purely additive-and-optional. `validateGraph()` (src/graph/schema.ts:87-109) and `loadClaims()` (src/claims/index.ts:83-91) currently hard-check `schemaVersion === 1` — a version bump requires updating these checks to accept the new version (and decide whether to support reading old-version files).
2. Update `05-database.md`'s file-based storage table with the new field list.
3. Update the `graph-engine` skill's JSON Schema documentation block (`.claude/skills/graph-engine/SKILL.md`) if the dependency-graph envelope changed — this is the contract other skills read to know what to expect.
4. Re-run `graph.test.mjs` / `claims.test.mjs` and add coverage for the new field.
5. Consider whether existing `.graphward/graph/*.json` or `claims.json` files in consumer repos need a migration step — none currently exists (`12-technical-debt.md` notes no migration path is implemented).
6. If `InstallManifest` changed: existing consumer repos' `install-manifest.json` files were written under the old shape — `readManifest()` (src/manifest/index.ts:13-24) does a raw `JSON.parse` with no defensive field-presence checking, so a required-field addition could produce `undefined` values silently rather than an error. Add explicit handling for the old shape or a migration.

## Unknowns

- **Unclear from evidence**: no schema-migration precedent exists in this codebase to model a new migration after — the first real schema version bump will be setting precedent, not following one.
