# Security Policy

## What GraphWard Accesses

### Filesystem
- **Reads:** Source files, configuration files, and git history within your project directory
- **Writes:** Only to the `.graphward/` directory and IDE-specific config directories (e.g., `.cursor/rules/`, `.gemini/`)
- **Does not:** Access files outside your project directory, read SSH keys, credentials files, or browser data

### Process Execution
- **Runs:** Your project's own check commands as configured in `gw.config.json` (`hooks.verifyCommands`) or auto-detected from `package.json` scripts (`check`, `test`, `lint`, `typecheck`)
- **Does not:** Start containers, VMs, or network services. Does not install global packages or modify system configuration

### Network
- **None.** GraphWard makes zero network requests. All processing is local. No telemetry, analytics, or cloud sync.

## What "Verification" Actually Means

When GraphWard says it "verifies" a change, it runs your project's configured check commands (compiler, linter, type-checker, test suite) locally in your working directory. This is **not** container-level isolation:

- Side effects from your tests (API calls, database writes, webhook triggers) are **not** sandboxed
- Protection is only as strong as your test coverage
- "Rollback" means reverting file changes — it cannot undo external side effects

## What "Rollback" Actually Means

If checks fail, GraphWard reverts the file changes it made. This is file-level `git checkout` of affected files — not a VM snapshot restore. External side effects (sent emails, API calls, database mutations triggered by tests) are not reversed.

## Inspecting Intelligence Artifacts

All GraphWard artifacts are plain markdown and JSON files in `.graphward/`. You can:
- Read every file to see exactly what context the AI receives
- Edit or delete any file to correct or remove intelligence
- Version control the entire directory alongside your code
- Audit the `ledger.jsonl` to see every experiment record

## Configuration Permissions

```json
// .graphward/gw.config.json
{
  "hooks": {
    "verifyCommands": ["npm test", "npm run lint"],
    "gitSync": false
  }
}
```

You control exactly which commands GraphWard is allowed to execute via `verifyCommands`. If this array is empty or the config file doesn't exist, GraphWard auto-detects commands from `package.json` scripts.

## Reporting Vulnerabilities

If you discover a security vulnerability, please report it responsibly:

1. **Do not** open a public issue
2. Email: [security contact — add your email here]
3. Include: description, reproduction steps, and potential impact
4. Expected response time: 48 hours

## Security Badges & Audits

This project is maintained by a single developer and has not undergone a formal third-party security audit. If your organization requires an audit before adoption, please open an issue to discuss your requirements.
