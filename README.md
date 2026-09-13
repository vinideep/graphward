# GraphWard

GraphWard gives AI coding assistants a living blueprint of your codebase so they stop guessing, hallucinating, and breaking working code.

---

## What is GraphWard? (In Simple Terms)

When you ask standard AI to write code, it often guesses how your project works. It might change a button and accidentally break your database, or delete code it didn't understand.

**GraphWard acts like an automated lead architect and project manager:**
1. **Maps your project** — Scans your entire app to understand how every file and function connects.
2. **Clarifies before coding** — If your request is vague, it stops and asks you simple multiple-choice questions instead of guessing.
3. **Runs your project's checks automatically** — Executes your compiler, linter, type-checker, and test suite on every change. If checks fail, the change is reverted so you can review what went wrong. Protection is only as strong as your test coverage.
4. **Remembers past mistakes** — Keeps a record of failed attempts so the AI never repeats the same mistake twice.

---

## Quick Start: 3-Step Process

You do not need to be an engineer to use this. Here is the step-by-step guide:

### Step 1: Initialize Your Project (Run Once)

Open your terminal in your project folder and run:

```bash
npx graphward initialize . --providers auto
```

This auto-detects your AI IDEs (Antigravity, Cursor, Claude Code, GitHub Copilot, etc.), configures providers, maps dependencies, and bootstraps `.graphward/`.

> **Upgrading from an earlier setup?**
> If you have existing configuration files, the CLI will prompt on conflicts:
> `Conflict: <file> has been modified locally. Overwrite? (y/N/a/s) [a=all, s=skip all]:`
> Enter `a` to **Accept all** remaining updates at once, or run with `--force` to overwrite automatically without prompting.

You can also target specific AI IDEs directly:

```bash
npx graphward install . --ide <your-editor> --yes
```

Replace `<your-editor>` with your AI IDE:

| Editor | `--ide` value |
|--------|---------------|
| Google Antigravity | `antigravity` |
| Cursor | `cursor` |
| Claude Code | `claude-code` |
| GitHub Copilot | `github-copilot` |
| Gemini CLI | `gemini-cli` |
| Codex | `codex` |
| Command Code | `commandcode` |
| Cline | `cline` |
| Roo Code | `roo-code` |
| Other / Generic | `generic` |

Multiple editors? Pass `--ide` more than once:
```bash
npx graphward install . --ide cursor --ide claude-code --yes
```

If you skip `--ide`, GraphWard defaults to generic adapter mode.

This creates a hidden `.graphward/` folder that holds the blueprint, memory, and dependency graphs of your application.

---

### Step 2: Open Your AI Editor

Open your project in any supported AI editor:
- **Google Antigravity**
- **Cursor**
- **Claude Code**
- **GitHub Copilot**
- **Gemini CLI**
- **Command Code** / **Cline** / **Roo Code** / **Codex**

---

### Step 3: Run with `/graphward`

In your AI chat window, invoke the `/graphward` workflow shortcut followed by your request in plain English:

- **To fix a problem:**
  ```text
  /graphward The checkout submit button isn't giving any feedback or loading spinner when clicked.
  ```
- **To add a feature:**
  ```text
  /graphward Add an export-to-PDF button on the customer invoice page.
  ```
- **To optimize or refactor:**
  ```text
  /graphward Optimize the order total calculation to handle large baskets faster.
  ```

> **How it works:** Calling `/graphward <prompt>` triggers the full engineering pipeline. The `engineering-orchestrator` automatically coordinates the next steps — clarifying requirements, checking dependencies, generating impact reports, executing changes with specialist agents, verifying tests, and syncing the living blueprint. In editors supporting agent mentions (like Antigravity or Claude Code), you can also tag `@engineering-orchestrator /graphward <prompt>`.

#### Available Workflows

| Shortcut | What it does | When to use |
|----------|--------------|-------------|
| `/graphward <prompt>` | Full implement → test → sync pipeline | **Default choice for any feature, bugfix, or refactor** |
| `/scope-requirement <prompt>` | Scope & clarify before implementing | For ambiguous features needing product analysis first |
| `/decompose-backlog <prompt>` | Break initiatives into Epics & Tickets | For multi-day projects before writing code |
| `/deliver-backlog` | Implement decomposed backlog feature-by-feature | Enforces human approval per feature before execution |
| `/map-architecture` | Rebuild architecture & dependency graph | After major structural refactors |
| `/sync-graphward` | Refresh intelligence after manual edits | When you made manual edits outside AI workflows |

---

## What Happens Automatically When You Prompt It

```mermaid
flowchart TD
    User["Your Prompt: /graphward <request>"] --> Orchestrator["engineering-orchestrator"]
    Orchestrator --> Clarity{"Is the prompt clear?"}
    Clarity -->|Vague / Missing Details| Gate["Socratic Gate: Asks 2-3 multiple-choice questions"]
    Gate --> Freezing["Freezes decisions in requirements"]
    Clarity -->|Clear| Blueprint["Reads Dependency Graph & Negative Constraints"]
    Freezing --> Blueprint
    Blueprint --> Impact["Writes Impact Report (IMP-XXX)"]
    Impact --> Implement["Implements with Specialist Agents"]
    Implement --> Verify["Runs Project Tests & Verification Receipts"]
    Verify --> Verification{"Did all checks pass?"}
    Verification -->|Yes| Sync["Updates living blueprint (.graphward/) & Change History"]
    Verification -->|No| Revert["Reverts failed change for review"]
```

1. **Clarification Gate**: If your prompt is missing details (e.g., "fix the button"), the AI pauses and presents 2–3 multiple-choice options. It will never blindly change code on an assumption.
2. **Context Retrieval**: Pulls in only the exact code needed, plus "Negative Constraints" (patterns that previously failed).
3. **Impact Report & Implementation**: Analyzes ripple effects first, then makes changes using targeted specialist agents (TDD, security, database).
4. **Safe Execution**: Executes project test suites and compiles verification receipts. If anything breaks, it rolls back cleanly.
5. **Blueprint Synchronization**: Updates `.graphward/` documentation, dependency graphs, and change records so project intelligence stays fresh.


---

## Security & Permissions

GraphWard operates entirely on your local machine:

| What GraphWard reads | What GraphWard writes | What GraphWard executes |
|--------------|----------------|------------------|
| Source files in your project | `.graphward/` directory only | Your project's configured check commands (test, lint, typecheck) |
| `package.json`, config files | IDE-specific config (e.g., `.cursor/rules/`) | Nothing else — no network calls, no telemetry |
| Git history (local) | — | — |

> **No telemetry. No cloud sync. No data leaves your machine.** All intelligence artifacts are plain markdown and JSON files you can inspect, edit, or delete at any time.

For full details, see [SECURITY.md](SECURITY.md).

---

## Keeping Intelligence Fresh

When changes go through the GraphWard pipeline (via `/graphward`), intelligence syncs automatically.

For edits made outside GraphWard — direct IDE edits, git merges, or other tools — you have two options:

1. **Git hooks (recommended):** Install automatic sync hooks during setup:
   ```bash
   npx graphward install . --ide <your-editor> --hooks --yes
   ```
   This adds `post-commit` and `post-merge` hooks that incrementally sync affected intelligence artifacts.

2. **Manual sync:** Run when needed:
   ```text
   /sync-graphward
   ```

GraphWard includes staleness detection — it scores artifact freshness and warns when intelligence is stale. But sync is not magic: it requires either the hooks or an explicit command.

---

## Advanced Options & CLI Reference (For Developers)

### Initialization Modes

| Command | Best For |
|---|---|
| `npx graphward initialize . --providers auto` | Default recommended setup with auto-detected providers |
| `npx graphward initialize . --providers native --yes` | Offline, zero-download deterministic setup using built-in parser |
| `npx graphward initialize . --ide cursor --yes` | Explicitly targets a specific editor adapter |
| `npx graphward initialize . --force` | Overwrites existing template files without prompting |

### Health & Diagnostic Commands

> You can use `npx graphward <cmd>` anywhere, or install globally (`npm i -g graphward`) to use the shorter `gw <cmd>`.

```bash
# Check if your project intelligence is healthy and up-to-date
npx graphward health . --strict

# Diagnose installation and tool dependencies
npx graphward doctor .

# Run test receipts and verify code safety gates
npx graphward verify .

# Fast update of the dependency graph after manual file edits
npx graphward sync . --files src/index.ts

# Prune expired negative constraints and failed attempt records (default: 30 days)
npx graphward prune . --ttl-days 30
```

### What GraphWard Stores in Your Repository

All intelligence lives safely under `.graphward/`:
- `knowledge-base/` — Verified documentation and architecture maps.
- `graph/` — `dependency-graph.json` tracking connections between all modules and symbols.
- `aidlc/` — Project state, requirements, open questions, and backlog tickets.
- `memory/` — Conventions, past decisions, and negative constraints (failed attempt records with 30-day TTL expiry to keep context lean).
- `reports/` — Impact and safety audit records.

---

## Why Not Just Use Cursor / Claude Code / Copilot Alone?

**Your intelligence is portable.** GraphWard writes everything to `.graphward/` — a plain directory of markdown and JSON that works across **any** AI IDE. Switch from Cursor to Claude Code to Copilot? Your architecture graph, memory, and project context follow you. No vendor lock-in.

**Supported AI IDEs:**
- **Tier 1 (Core / Actively Maintained):** Google Antigravity, Cursor, Claude Code (end-to-end integration tested, native hook lifecycle integration, automated verification receipts).
- **Tier 2 (Supported Ecosystem Adapters):** GitHub Copilot, Command Code, Gemini CLI, Codex, Cline, Roo Code, and Generic (canonical markdown skills, agents, and prompts).

**Cost-aware by design.** Every request gets a dynamic token budget based on task risk — trivial fixes use ~2,000 tokens of context, critical architecture changes scale up to 15,000. No uncapped context loading.

**What the platforms won't do:**
- Carry your project memory across IDE switches
- Give you a portable, version-controlled architecture graph
- Let you inspect and edit every piece of AI context as plain files
- Stay tool-agnostic instead of locking you into one ecosystem

---

## Development

```bash
npm ci
npm test               # Runs all 337 automated tests
npm run test:integration
npm run build
```

Full technical architecture documentation is available in [WORKFLOW_GUIDE.md](WORKFLOW_GUIDE.md) and [graphward-blueprint.md](graphward-blueprint.md).
