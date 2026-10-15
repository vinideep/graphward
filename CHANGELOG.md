# Changelog

## Unreleased - Agent workflow reliability (IMP-015)
- **Task gate**: proposals return `howToConfirm`; Claude `AskUserQuestion` approval accepts the challenge as the selected label or an `Approve scope (Recommended)` label; scope entries accept globs (`src/**`); in-scope edits keep bound context valid (per-file baseline), out-of-scope drift still blocks; file edits outside the project are not gated.
- **Discovery**: quote-aware read-only shell classifier allows pipelines/lists of `ls`, `cat`, `rg`, `grep`, `find`, `git log|diff|show`, `sed -n 'N,Mp'`; writing flags and substitution still require a task.
- **Context budgets**: `prepare_task_context` (MCP and `gw aidlc prepare-task`) returns a compact receipt; `get_engineering_context` gains `format` (`json` default, `markdown`, `full`); skeleton outlines and claims are charged to the token budget; per-node provenance badges removed (data already on nodes).
- **Freshness**: content-hash first (sources unchanged since `gw evidence-record` are not drift), backtick and JSON `"evidence"` citations checked, machine state excluded, edit hook scores only documents citing the edited file (~2.0s → ~0.3s per edit).
- **Gates**: dead-exports no longer misses `dir/index.js` namespace/dynamic imports and exempts npm-script entry files; env-vars ignores comments, platform variables and test fixtures and reads mixed-case names.
- **CLI**: a flag-only invocation implies `install` only for install options; `gw --json` and similar now fail without writing.
- **Hooks**: event log rotates at 1 MB; Stop no longer blocks on a clean Git tree after committing verified work, and explains HEAD-bound verification records.
- **Dependencies**: `@modelcontextprotocol/sdk` 1.32.1; `npm audit` clean.
- **Source hygiene**: removed a literal NUL byte from `src/evidence/index.ts`.
- **Brownfield / multi-repo adoption**:
  - Oversized files skipped by provider indexing are recorded as `excludedFiles` instead of unknowns, so they no longer degrade preparation. Readiness asks for a reduced-coverage decision only when one of them is inside the task's scope.
  - Codex namespaced tools (`collaborationspawn_agent`, `clocksleep`), agent orchestration and MCP resource listing pass the task gate.
  - `record_task_change_mapping` merges entries by criterion and returns `unmappedCriteria`; completeness is still enforced by `validate_change`.
  - The construction-exit gate runs safety gates against working-tree changes. An open flight opened before the task was confirmed becomes a recommendation instead of a blocker.
  - migration-lint honours `changedFiles`. It recognises migrations by directory (`migrations/`, `db/migrate/`, `alembic/versions/`) or file name, no longer by any path containing "migrat", and skips rollback bodies (`downgrade()`, `def down`, `exports.down`) and `#` comments.
  - dead-exports exempts Next.js convention exports and `*.config.*` files.
  - `validate_change` treats `.graphward/**` as low risk and leaves it out of impact analysis.
  - MCP `validate_change` and `sync_engineering_knowledge` default to `detail: "summary"`: all counts, with only non-passing claims, citations and documents listed, and gate findings and impact details capped at 25 (`detail: "full"` restores every row).
  - Knowledge references also resolve inside top-level child directories (child repos).
  - Unverified evidence documents state the specific reason.
- **Host hook contracts** (checked against the Claude Code, Codex, Cursor and Antigravity hook docs):
  - The PreToolUse gate classifies calls by what they can do instead of denying every tool it does not know. Only in-project file edits, non-read-only shell, `evaluate_experiment_step`, and third-party MCP tools that write project paths or run local code need a confirmed task. Reads, search, browser, agents, task lists and all other GraphWard MCP tools (under any server name, including Cursor `MCP:<tool>` and Antigravity `mcp_<server>_<tool>`) always pass.
  - Recognised host tool names: Cursor `Shell`/`Write`/`Delete`, Antigravity `write_to_file`/`replace_file_content`/`multi_replace_file_content`/`run_command`, Codex `apply_patch`/`Bash` and namespaced locals.
  - Read-only shell now also covers formatting env prefixes (`TZ=`, `LANG=`, `LC_*=`), `date`, `ps`, `df`, `--version` probes, `npm ls`, `docker ps/logs/inspect`, `kubectl get/describe/logs`, `git fetch`, list-only `git branch`/`remote`/`tag`/`stash`/`config --get`, and `curl` without output-file or upload flags.
  - A command `Cwd` inside the project (Antigravity `run_command` in `backend/`) is no longer denied as "another project"; a working directory outside the project is left to the host.
  - Claude Code's PreToolUse matcher is anchored, so `TodoWrite` and `BashOutput` no longer reach the gate. Context output uses the matching `hookEventName` for PostToolUse and Stop.
  - Cursor sessionStart/postToolUse context uses `additional_context`.
  - Antigravity PreToolUse always answers with a `decision`, PostToolUse answers `{}`, and session start is wired to `SessionStart`; `PreInvocation` fired every turn and reset session tracking.
  - Reinstalling removes GraphWard entries from hook events it no longer installs, keeping user entries.
- Note: entries for 1.1.0–1.3.1 were never recorded here.

## 1.0.4 - Hardening & Verification Release
- **Coverage-gap detector**: Automatically generates preflight characterization tests for un-tested code paths.
- **Clarification gate**: Deterministic graph-based boundary and consumer checks instead of LLM self-assessment.
- **Test-impact analysis**: `graphward verify` defaults to impact-filtered tests via BFS over reverse dependency edges (`--full` bypasses).
- **Secrets scan**: Embedded credentials detection on all `.graphward/` writes via `writeProtectedFile` with default gitignoring.
- **Provenance gate**: Explicitly blocks verification if approval is based solely on `agentOnly` (agent-generated) tests.
- **File locking**: Concurrent process safety for `.graphward/` via atomic hardlinks and stale-lock recovery.
- **Tree-sitter parser**: Safe `null` fallback logic to regex extractors for Python, Go, and Rust.
- **Benchmark harness**: 25-task evaluation suite with A/B comparison mode and published README metrics.
- **Records**: Verification records renamed from receipts, utilizing stable cryptographic hashes.
- **Schemas**: Published open JSON schemas for configuration elements.
- **README**: Divided into structured Quick Mode and Team Mode guides.

## 1.0.3
- Tree-sitter integration bug fixes and initial multi-language AST prep.

## 1.0.2
- Bug fixes and verification improvements.

## 1.0.1
- Minor patches for GraphWard initialization logic.

## 1.0.0 - Welcome to GraphWard
- Renamed project from `engineering-intelligence` to `GraphWard`.
- Foundational restructure for standalone agent tooling.

---

# Pre-rename History (engineering-intelligence)


## 4.1.0 — Antigravity custom agents

- Antigravity and Antigravity CLI now install native Markdown custom agents at
  `.agents/agents/<name>/agent.md`.
- Existing workflow, skill, rule, and locally edited legacy agent files are
  preserved during updates; workflows remain available as compatibility entry
  points.

## 3.0.0 — Correctness release

This release is mostly about **removing things that were not true**. Several
subsystems reported success they had not earned; each is now either enforced for
real or labelled honestly. Every claim below was reproduced before and after.

### Breaking

| Change | Why | What to do |
|---|---|---|
| Path aliases (`$EI`, `$AIDLC`) removed from all rendered files | The alias preamble sat **above** the YAML fence, so no host could parse `name` / `description` / `argument-hint` — skill auto-invocation was silently dead for every skill and command. Aliases also produced 240 glued tokens like `$EIknowledge-base/`. | Nothing, unless you wrote custom skills using the aliases — replace them with literal `.graphward/...` paths. |
| `claims add` requires `--author`, and never yields `verified` | Free text anchored to real code used to report `verified` forever. | Add `--author "you"`. Use `claims derive` for facts you want machine-checked. |
| `claims.json` gains `kind` (`derived` \| `asserted`) | Only re-computable statements may be called facts. | None — claims written before this are read as `asserted`, never promoted. |
| `.claude/settings.json` / `.cursor/hooks.json` are **merged**, not owned | A pre-existing settings file used to conflict, silently skipping the whole enforcement layer. | None. Your `permissions`, `model`, `env` and your own hooks are preserved; `uninstall` removes only our entries. |
| `gw.config.json` is seeded, not managed | Editing it — the documented way to enable enforcement — caused a permanent doctor warning and update conflicts. | None. It is yours after first write. |
| Stop hook requires a verification **record** | The old gate matched shell history, so `rm -rf build` satisfied it. | Run `gw verify .` (or let the agent). |
| API: `isValidationCommand` → `looksLikeValidationCommand`; `statusFromFindings(findings, failOn?)` | The old name implied it gated something. | Only affects direct library consumers. |

### Fixed

- **Frontmatter at byte 0** across all 9 adapters, with a render-time guard.
- **`analyzeImpact` returned confident empty answers** — multi-line imports were
  invisible and 5 of 7 languages were dropped. It now returns the real importers.
- **The graph asserted falsehoods**: edges fabricated from comments and string
  literals, 25 of 48 node paths that did not exist on disk, a structurally
  always-empty `unknowns`, and type-only imports double-counted as runtime
  dependencies. All now correct, with `unknown` emitted where resolution fails.
- **Freshness rewarded emptiness** — an uncited doc scored 100/"fresh", beating a
  conscientious one. Uncited docs are now `unverifiable`; a future "last updated"
  date no longer inflates a score above 100.
- **Two of four gates could never fail** (`env-vars`, `dead-exports` emit no
  `error` findings). Added `--fail-on warning` to make them blocking.
- **`api-diff` false positives**: HTTP client calls (`api.get(...)` in an axios
  wrapper) read as route registrations, and comparison was per-file so moving a
  route between files looked breaking. Now framework-anchored and repo-wide.
- **MCP tools were unreachable** — no adapter registered the server and 3 of 69
  templates named a tool. The server is now registered (`.mcp.json`) and all
  tools are named in the installed instructions.
- The dashboard skill catalog was 289 hand-maintained lines and had already
  drifted (one skill missing entirely); it is now derived from the templates.

### Added

- `gw verify` — runs the project's own checks and writes a
  record binding the result to a sha256 of every changed file.
- `gw claims derive` — computes module imports, package
  dependencies and HTTP routes from source as **derived** (re-computable) claims.
- `gw gate <name> --fail-on error|warning`.
- `derive_claims` MCP tool; `.mcp.json` / `.cursor/mcp.json` registration.
- `bench/replay.mjs` (`npm run bench`) — a zero-inference replay measuring
  whether the derived-fact layer notices real commits, and how noisy it is.

### Known limits, measured

Running `npm run bench` on this repository's own last 12 commits:

```
detection rate:                   0.417
median churn per detected commit: 3 (max 4)
```

The derived-fact layer sees **imports, package dependencies and HTTP routes**. It
is precise (low churn) but **narrow**: it does not notice changes made *inside*
functions, which is most of them. Treat derived facts as a reliable map of
structure, not as a change detector. This number is published because it is the
honest one, not because it flatters.
