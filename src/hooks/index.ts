/**
 * Hook engine — turns the prose "safety gates" and "environmental backpressure"
 * promises into enforced, deterministic behaviour driven by the host IDE's
 * lifecycle hooks (Claude Code today; the payload is host-agnostic).
 *
 * Four events, each mapped to one deterministic decision:
 *   session-start  → inject a compact freshness/drift summary into the session
 *   pre-tool-use   → warn (or, opt-in, deny) edits when intelligence is stale
 *   post-tool-use  → silently record changed source files + validation commands
 *   stop           → (opt-in) block "done" when code changed but nothing verified it
 *
 * Design contract: managed mutation readiness errors fail closed. Unmanaged discovery remains available. Legacy freshness hooks are fail-safe. Any error, missing intelligence, or
 * managed mutation errors deny the operation. Host-specific coverage limits remain explicit.
 */

import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { resolveRuntimeInvocation } from "../runtime/invocation.js";
import { checkTaskReadiness, observeUserPrompt, observeNativeQuestionResponse } from "../aidlc/task-contract.js";
import { computeFreshness } from "../freshness/index.js";
import { defaultGwConfig, loadGwConfig } from "../config/index.js";

export type HookEvent = "session-start" | "user-prompt-submit" | "pre-tool-use" | "post-tool-use" | "stop";

export const HOOK_EVENTS: readonly HookEvent[] = [
  "session-start",
  "user-prompt-submit",
  "pre-tool-use",
  "post-tool-use",
  "stop",
];

export function isHookEvent(value: string): value is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(value);
}

/** Subset of the Claude Code hook stdin payload we rely on. Extra keys are ignored. */
export interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; command?: string; [k: string]: unknown };
  tool_response?: { success?: boolean; [k: string]: unknown };
  stop_hook_active?: boolean;
  transcript_path?: string;
  [k: string]: unknown;
}

export interface HookResult {
  /** Process exit code. Always 0 for our hooks — decisions travel in stdout JSON. */
  exitCode: number;
  /** JSON to emit on stdout, or undefined to stay silent. */
  stdout?: string;
}

/** Hosts whose lifecycle-hook systems we can wire to. Everything else uses CI + MCP. */
export type HookHost = "claude-code" | "cursor" | "codex" | "antigravity" | "antigravity-cli";

export function isHookHost(value: string): value is HookHost {
  return ["claude-code", "cursor", "codex", "antigravity", "antigravity-cli"].includes(value);
}

// Handlers produce a host-NEUTRAL decision; it is formatted to each host's hook
// contract at the edge (formatDecision). This keeps one enforcement engine that
// serves any host with a hook API.
type DecisionKind = "allow" | "context" | "deny" | "block";
interface HookDecision { kind: DecisionKind; message?: string; }

const ALLOW: HookDecision = { kind: "allow" };

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface HookConfig {
  requireTaskReadiness: boolean;
  freshnessThreshold: number;
  /** When true, PreToolUse denies edits while any intelligence doc scores < 50. */
  blockStaleEdits: boolean;
  /** When true, Stop blocks completion unless a passing record covers the changes. */
  requireValidationOnStop: boolean;
  /** Explicit verification commands; empty means auto-detect from the project. */
  verifyCommands: string[];
}

export const DEFAULT_HOOK_CONFIG: HookConfig = {
  requireTaskReadiness: true,
  freshnessThreshold: 60,
  blockStaleEdits: false,
  requireValidationOnStop: true,
  verifyCommands: [],
};

const CONFIG_PATH = ".graphward/gw.config.json";

export async function loadHookConfig(root: string): Promise<HookConfig> {
  try {
    const config = await loadGwConfig(root);
    return { ...DEFAULT_HOOK_CONFIG, ...(config.hooks ?? {}) } as HookConfig;
  } catch {
    return { ...DEFAULT_HOOK_CONFIG };
  }
}

function runtimeCommand(): string {
  const invocation = resolveRuntimeInvocation();
  const quote = (value: string) => process.platform === 'win32' ? `"${value.replaceAll('"', '\\"')}"` : `'${value.replaceAll("'", "'\"'\"'")}'`;
  return [invocation.command, ...invocation.args].map(quote).join(' ');
}
/** Invoke the identified installed runtime without package-name resolution. */
export function hookCommand(event: HookEvent, host: HookHost = "claude-code"): string { return runtimeCommand() + ` hook ${event} --host ${host}`; }

/**
 * `.claude/settings.json` content wiring all four lifecycle hooks to the CLI
 * and auto-approving the graphward MCP server from the project `.mcp.json`.
 * Rendered as a whole managed file; if the user already owns settings.json the
 * installer preserves theirs and `doctor` surfaces this snippet to merge.
 */
export function claudeCodeHookSettings(): string {
  return JSON.stringify(
    {
      enabledMcpjsonServers: ["graphward"],
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: hookCommand("user-prompt-submit") }] }],
        SessionStart: [{ hooks: [{ type: "command", command: hookCommand("session-start") }] }],
        PreToolUse: [
          { matcher: "Edit|Write|NotebookEdit|MultiEdit|Bash|PowerShell|mcp__.*", hooks: [{ type: "command", command: hookCommand("pre-tool-use"), onFailure: "block" }] },
        ],
        PostToolUse: [
          { matcher: "Edit|Write|NotebookEdit|MultiEdit|Bash|PowerShell|AskUserQuestion|ExitPlanMode", hooks: [{ type: "command", command: hookCommand("post-tool-use") }] },
        ],
        Stop: [{ hooks: [{ type: "command", command: hookCommand("stop") }] }],
      },
    },
    null,
    2,
  ) + "\n";
}

/**
 * `.cursor/hooks.json` wiring the same enforcement to Cursor's agent-hooks system.
 * Cursor uses granular events — `afterFileEdit` / `afterShellExecution` stand in
 * for Claude's single PostToolUse — so both route to our `post-tool-use` handler,
 * which distinguishes them via the normalized tool name. `--host cursor` tells the
 * CLI to translate Cursor's input/output contract.
 */
export function cursorHookSettings(): string {
  const cmd = (event: HookEvent) => ({ command: hookCommand(event, "cursor") });
  return JSON.stringify(
    {
      version: 1,
      hooks: {
        sessionStart: [cmd("session-start")],
        preToolUse: [cmd("pre-tool-use")],
        afterFileEdit: [cmd("post-tool-use")],
        afterShellExecution: [cmd("post-tool-use")],
        stop: [cmd("stop")],
      },
    },
    null,
    2,
  ) + "\n";
}

export function codexHookSettings(): string {
  const handler = (event: HookEvent) => ({ type: "command", command: hookCommand(event, "codex"), timeout: 30 });
  return JSON.stringify({ hooks: { SessionStart: [{ hooks: [handler("session-start")] }], UserPromptSubmit: [{ hooks: [handler("user-prompt-submit")] }], PreToolUse: [{ matcher: ".*", hooks: [handler("pre-tool-use")] }], PostToolUse: [{ matcher: ".*", hooks: [handler("post-tool-use")] }], Stop: [{ hooks: [handler("stop")] }] } }, null, 2) + "\n";
}
export function antigravityHookSettings(host: "antigravity" | "antigravity-cli"): string {
  // Shared IDE/CLI directory must emit identical configuration when co-installed.
  const handler = (event: HookEvent) => ({ type: "command", command: hookCommand(event, "antigravity"), timeout: 30 });
  return JSON.stringify({ graphward: { enabled: true, PreInvocation: [handler("session-start")], PreToolUse: [{ matcher: ".*", hooks: [handler("pre-tool-use")] }], PostToolUse: [{ matcher: ".*", hooks: [handler("post-tool-use")] }], Stop: [handler("stop")] } }, null, 2) + "\n";
}

function editPaths(input: HookInput): string[] {
  const args = input.tool_input ?? {};
  const paths = [args.file_path, args.path, args.TargetFile].filter((value): value is string => typeof value === "string");
  if (Array.isArray(args.edits)) for (const edit of args.edits) if (edit && typeof edit === "object" && typeof (edit as any).file_path === "string") paths.push((edit as any).file_path);
  const patch = typeof args.command === "string" && input.tool_name === "apply_patch" ? args.command : typeof args.patch === "string" ? args.patch : "";
  for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) paths.push(match[1]);
  return [...new Set(paths)];
}
function isDiscoveryTool(input: HookInput): boolean {
  const tool = input.tool_name ?? "";
  if (/^(Read|Glob|Grep|AskUserQuestion|ExitPlanMode|request_user_input|request_user_input_async|ask_question|Agent|Task|spawn_agent|invoke_subagent|view_file|list_dir|find_by_name|grep_search|search_web|read_url_content)$/.test(tool)) return true;
  if (/^mcp__graphward__(get_engineering_context|prepare_task_context|propose_task_contract|get_task_readiness|record_task_change_mapping|host_support_status|provider_status|analyze_change_impact|check_aidlc_gate|assess_prompt_clarity|get_aidlc_state|find_symbol|who_calls|read_knowledge)$/.test(tool)) return true;
  if (!/^(Bash|PowerShell|run_command|exec_command)$/.test(tool)) return false;
  const command = input.tool_input?.command ?? input.tool_input?.cmd;
  if (typeof command !== "string" || /[;&|><`$\n\r]/.test(command)) return false;
  const runtime = runtimeCommand();
  if (command.startsWith(runtime + ' ')) return /^(?:verify|context|providers status|aidlc (?:prepare-task|assess|gate))\b/.test(command.slice(runtime.length + 1));
  if (/^(?:pwd|ls|cat|head|tail|wc)(?:\s|$)/.test(command)) return !/\s(?:--output|-o)\b/.test(command);
  if (/^rg(?:\s|$)/.test(command)) return !/\s--(?:pre|pre-glob|hostname-bin|no-ignore|hidden|follow)\b/.test(command);
  return /^git\s+(?:status|diff|log|show|ls-files|rev-parse)(?:\s|$)/.test(command) && !/--(?:output|ext-diff|textconv)|\s-c\b/.test(command);
}

/** The default config file the installer seeds. Exported so the adapter renders it. */
export function defaultConfigFile(): string {
  return JSON.stringify(defaultGwConfig({
    hooks: {
        requireTaskReadiness: true,
        freshnessThreshold: DEFAULT_HOOK_CONFIG.freshnessThreshold,
        blockStaleEdits: DEFAULT_HOOK_CONFIG.blockStaleEdits,
        requireValidationOnStop: DEFAULT_HOOK_CONFIG.requireValidationOnStop,
        // Empty = auto-detect the project's own check commands.
        verifyCommands: DEFAULT_HOOK_CONFIG.verifyCommands,
    },
  }), null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// Source / validation classification
// ---------------------------------------------------------------------------

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java",
  ".rb", ".php", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".swift", ".kt",
  ".scala", ".sql", ".vue", ".svelte",
]);

/** True for product/source files whose change should be verified — excludes the
 *  intelligence layer, IDE config, and vendored/build output. */
export function isSourceFile(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  if (
    normalized.startsWith(".graphward/") ||
    normalized.startsWith(".claude/") ||
    normalized.includes("node_modules/") ||
    normalized.startsWith("dist/") ||
    normalized.startsWith("build/")
  ) {
    return false;
  }
  return SOURCE_EXTENSIONS.has(path.extname(normalized).toLowerCase());
}

/**
 * Whether a shell command *looks* like a check. Retained only as a UX hint: when
 * the agent runs something test-shaped we remind it that a record is what the
 * gate accepts. It is deliberately NOT the gate — see src/verify. The previous
 * gate used exactly this pattern and was satisfied by `rm -rf build`.
 */
const VALIDATION_PATTERN =
  /\b(jest|vitest|mocha|pytest|tox|nox|unittest|eslint|ruff|flake8|pylint|tsc|typecheck|type-check|mypy|pyright|cargo\s+(test|check|clippy)|go\s+(test|vet)|gradle|mvn|rspec|phpunit|dotnet\s+test|npm\s+(test|run\s+\S+)|pnpm\s+\S+|yarn\s+\S+)\b/i;

export function looksLikeValidationCommand(command: string): boolean {
  return VALIDATION_PATTERN.test(command);
}

// ---------------------------------------------------------------------------
// Session-scoped state (pending changes + validation evidence)
// ---------------------------------------------------------------------------

interface SessionState {
  changedFiles: string[];
  validationCommands: string[];
}

const STATE_DIR = ".graphward/.hooks-state";

function sessionId(input: HookInput): string {
  const raw = input.session_id ?? "default";
  return raw.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "default";
}

function statePath(root: string, input: HookInput): string {
  return path.join(root, STATE_DIR, `${sessionId(input)}.json`);
}

async function readState(root: string, input: HookInput): Promise<SessionState> {
  try {
    const raw = await readFile(statePath(root, input), "utf8");
    const parsed = JSON.parse(raw) as Partial<SessionState>;
    return {
      changedFiles: Array.isArray(parsed.changedFiles) ? parsed.changedFiles : [],
      validationCommands: Array.isArray(parsed.validationCommands) ? parsed.validationCommands : [],
    };
  } catch {
    return { changedFiles: [], validationCommands: [] };
  }
}

async function writeState(root: string, input: HookInput, state: SessionState): Promise<void> {
  const dir = path.join(root, STATE_DIR);
  await mkdir(dir, { recursive: true });
  await ensureStateGitignored(root);
  await writeFile(statePath(root, input), JSON.stringify(state), "utf8");
}

/** Keep ephemeral session state out of version control in the target repo. */
async function ensureStateGitignored(root: string): Promise<void> {
  const gitignorePath = path.join(root, ".graphward", ".gitignore");
  let existing = "";
  try { existing = await readFile(gitignorePath, "utf8"); } catch { /* new file */ }
  if (!existing.includes(".hooks-state/")) {
    const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
    await writeFile(gitignorePath, existing + prefix + ".hooks-state/\n", "utf8");
  }
}

// ---------------------------------------------------------------------------
// Decision constructors + per-host output formatting
// ---------------------------------------------------------------------------

const context = (message: string): HookDecision => ({ kind: "context", message });
const deny = (message: string): HookDecision => ({ kind: "deny", message });
const block = (message: string): HookDecision => ({ kind: "block", message });

/** Translate a neutral decision into the concrete hook output contract of the host. */
function formatDecision(host: HookHost, event: HookEvent, decision: HookDecision): HookResult {
  if (decision.kind === "allow") return host === 'cursor' && event === 'pre-tool-use' ? { exitCode: 0, stdout: JSON.stringify({ permission: 'allow' }) } : { exitCode: 0 };
  if (host === 'antigravity' || host === 'antigravity-cli') {
    if (decision.kind === 'context') return { exitCode: 0, stdout: JSON.stringify(event === 'session-start' ? { injectSteps: [{ ephemeralMessage: decision.message }] } : {}) };
    return { exitCode: 0, stdout: JSON.stringify({ decision: decision.kind === 'block' ? 'continue' : 'deny', reason: decision.message }) };
  }
  const message = decision.message ?? "";

  if (host === "cursor") {
    // Cursor: permission hooks use { permission, agent_message }; stop uses followup_message.
    switch (decision.kind) {
      case "context":
        return {
          exitCode: 0,
          stdout: JSON.stringify(
            event === "pre-tool-use" ? { permission: "allow", agent_message: message } : { agent_message: message },
          ),
        };
      case "deny":
        return { exitCode: 0, stdout: JSON.stringify({ permission: "deny", agent_message: message }) };
      case "block":
        return { exitCode: 0, stdout: JSON.stringify({ followup_message: message }) };
    }
  }

  // Claude Code
  switch (decision.kind) {
    case "context":
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: event === "session-start" ? "SessionStart" : event === "user-prompt-submit" ? "UserPromptSubmit" : "PreToolUse",
            additionalContext: message,
          },
        }),
      };
    case "deny":
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: message },
        }),
      };
    case "block":
      return { exitCode: 0, stdout: JSON.stringify({ decision: "block", reason: message }) };
  }
  return { exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

async function onSessionStart(root: string, input: HookInput, config: HookConfig): Promise<HookDecision> {
  // Fresh session: clear any stale evidence from a previous session id collision.
  await writeState(root, input, { changedFiles: [], validationCommands: [] }).catch(() => {});

  const report = await computeFreshness(root, config.freshnessThreshold);
  if (report.scores.length === 0) {
    // No intelligence initialized — nudge, but never block.
    return context(
      "GraphWard: no persisted intelligence found. Run `initialize-graphward` to document this codebase so future work reuses it instead of re-exploring.",
    );
  }

  const stale = report.scores.filter((s) => s.action !== "none").sort((a, b) => a.score - b.score);
  const lines = [
    `GraphWard — freshness: ${report.driftDecision} (threshold ${report.threshold}).`,
    `${report.scores.length} intelligence docs; ${stale.length} need attention.`,
  ];
  if (stale.length > 0) {
    const top = stale.slice(0, 5).map((s) => `  - ${s.docPath} (score ${s.score}, ${s.action})`);
    lines.push("Stale artifacts:", ...top);
    lines.push("Run `sync-graphward` to refresh before relying on these.");
  } else {
    lines.push("All intelligence is fresh — prefer it over re-reading source.");
  }
  return context(lines.join("\n"));
}

async function onPreToolUse(root: string, input: HookInput, config: HookConfig, host: HookHost): Promise<HookDecision> {
  if (config.requireTaskReadiness && existsSync(path.join(root, '.graphward/install-manifest.json')) && !isDiscoveryTool(input)) {
    const { toCanonicalPath } = await import("../providers/workspace.js");
    const toolCwd = input.tool_input?.Cwd ?? input.tool_input?.cwd;
    if (input.cwd && toCanonicalPath(input.cwd) !== toCanonicalPath(root) || typeof toolCwd === "string" && toCanonicalPath(toolCwd) !== toCanonicalPath(root)) return deny("Hook payload belongs to another project; reconnect with the intended project root.");
    const paths = editPaths(input);
    const readiness = await checkTaskReadiness(root, { host, sessionId: input.session_id, files: paths });
    if (!readiness.ready) return deny(`GraphWard task readiness blocked this mutation: ${readiness.blockers.join(' ')}. Discover → clarify → confirm scope → prepare_task_context → implement → validate.`);
    if (!paths.length && !input.tool_input?.command && !input.tool_name?.startsWith('mcp__')) return deny('Mutation payload does not expose a supported target.');
  }

  const targetPath = input.tool_input?.file_path;
  if (!targetPath) return ALLOW;
  const rel = path.relative(root, path.resolve(root, targetPath)).replace(/\\/g, "/");
  if (!isSourceFile(rel)) return ALLOW; // editing docs/config/intelligence is always fine

  const report = await computeFreshness(root, config.freshnessThreshold);
  if (report.scores.length === 0 || report.driftDecision === "Proceed") return ALLOW;

  const stale = report.scores
    .filter((s) => s.action !== "none")
    .sort((a, b) => a.score - b.score)
    .slice(0, 5)
    .map((s) => `  - ${s.docPath} (score ${s.score})`);
  const detail = [
    `GraphWard flags stale documentation (${report.driftDecision}).`,
    "Affected artifacts:",
    ...stale,
    `Sync with \`sync-graphward\` (or \`${runtimeCommand()} freshness .\`) so this change is guided by accurate intelligence.`,
  ].join("\n");

  if (config.blockStaleEdits && report.driftDecision === "Block implementation") {
    return deny(detail);
  }
  return context(detail);
}

async function onPostToolUse(root: string, input: HookInput): Promise<HookDecision> {
  const tool = input.tool_name ?? "";
  const state = await readState(root, input);
  let dirty = false;

  // Edits are still recorded, but only as a hint for messaging. The Stop gate
  // derives the real change set from git, so edits this matcher never sees
  // (sed -i, patch, a subagent) are still covered.
  if (/^(Edit|Write|NotebookEdit|MultiEdit)$/.test(tool)) {
    const targetPath = input.tool_input?.file_path;
    if (targetPath) {
      const rel = path.relative(root, path.resolve(root, targetPath)).replace(/\\/g, "/");
      if (isSourceFile(rel) && !state.changedFiles.includes(rel)) {
        state.changedFiles.push(rel);
        dirty = true;
      }
    }
  } else if (tool === "Bash") {
    const command = input.tool_input?.command ?? "";
    if (command && looksLikeValidationCommand(command)) {
      const trimmed = command.slice(0, 200);
      if (!state.validationCommands.includes(trimmed)) {
        state.validationCommands.push(trimmed);
        dirty = true;
      }
    }
  }

  if (dirty) await writeState(root, input, state).catch(() => {});
  return ALLOW; // tracking is invisible
}

async function onStop(root: string, input: HookInput, config: HookConfig): Promise<HookDecision> {
  // Always record real token telemetry at session end (best-effort, never blocks).
  if (typeof input.transcript_path === "string" && input.transcript_path) {
    try {
      const { recordFromTranscript } = await import("../telemetry/index.js");
      await recordFromTranscript(root, input.transcript_path, sessionId(input));
    } catch { /* best-effort */ }
  }

  if (!config.requireValidationOnStop) return ALLOW;
  // A repeated Stop attempt is not validation evidence. The host may set
  // stop_hook_active after a block; keep evaluating the deterministic record.

  const { changedFiles, coverageFor, detectCheckCommands } = await import("../verify/index.js");

  // Derive the change set from git, not from what the tool matcher happened to see.
  // Fall back to hook-tracked edits when git is unavailable (e.g. no repo).
  const state = await readState(root, input);
  const fromGit = await changedFiles(root);
  const candidates = (fromGit.length > 0 ? fromGit : state.changedFiles).filter(isSourceFile);
  if (candidates.length === 0) return ALLOW; // no source changed

  const coverage = await coverageFor(root, candidates);
  if (coverage.covered) {
    return ALLOW; // a passing record vouches for these exact bytes
  }
  const records = await (await import("../verify/index.js")).readRecords(root);
  const lastFailed = records.find((r) => r.verdict === "fail");
  const checks = config.verifyCommands.length > 0
    ? config.verifyCommands
    : await detectCheckCommands(root);

  const reason: string[] = [
    "GraphWard: these source changes have no passing verification record.",
    "Validation must be a fact this tool produced, not a command that looked test-shaped.",
    "Unverified files:",
    ...coverage.uncovered.slice(0, 8).map((f) => `  - ${f}`),
  ];
  if (coverage.uncovered.length > 8) reason.push(`  …and ${coverage.uncovered.length - 8} more`);

  if (lastFailed && records[0] === lastFailed) {
    const failing = lastFailed.commands.find((c) => c.exitCode !== 0);
    if (failing) {
      reason.push(`The last run FAILED: \`${failing.command}\` exited ${failing.exitCode}.`);
      if (failing.outputTail) reason.push(failing.outputTail.trim().split("\n").slice(-6).join("\n"));
    }
  }
  reason.push(
    checks.length > 0
      ? `Run \`${runtimeCommand()} verify .\` (will run: ${checks.join(", ")}).`
      : "No check command could be detected. Configure `verify.commands` in .graphward/gw.config.json, or state explicitly that validation is unavailable and stop again.",
  );
  return block(reason.join("\n"));
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export function parseHookInput(raw: string): HookInput {
  try {
    const parsed = JSON.parse(raw) as HookInput;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Normalize a host's raw hook stdin JSON into the neutral HookInput shape.
 * Claude Code already matches. Cursor uses different field names and *granular*
 * events (afterFileEdit / afterShellExecution), which we translate into the
 * generic tool_name/tool_input the handlers expect. Field mappings unknown to us
 * fail safe (absent → the relevant enforcement no-ops, never a false block).
 */
export function normalizeInput(host: HookHost, raw: string): HookInput {
  const obj = parseHookInput(raw) as Record<string, unknown>;
  if (host === 'antigravity' || host === 'antigravity-cli') {
    const tool = obj.toolCall as { name?: string; args?: Record<string, unknown> } | undefined;
    const roots = obj.workspacePaths;
    const args = tool?.args ?? {};
    const wrapped = tool?.name === 'call_mcp_tool';
    const server = args.ServerName ?? args.serverName ?? args.server_name;
    const name = args.ToolName ?? args.toolName ?? args.tool_name;
    const nested = args.Arguments ?? args.arguments ?? args.args;
    const input = wrapped && nested && typeof nested === 'object' && !Array.isArray(nested) ? nested as Record<string, unknown> : args;
    const toolName = wrapped && typeof server === 'string' && typeof name === 'string' ? `mcp__${server}__${name}` : tool?.name;
    return { session_id: obj.conversationId as string | undefined, cwd: Array.isArray(roots) ? roots[0] : undefined, tool_name: toolName, tool_input: { ...input, file_path: (input.TargetFile ?? input.file_path) as string | undefined, command: (input.CommandLine ?? input.command) as string | undefined }, transcript_path: obj.transcriptPath as string | undefined };
  }
  if (host !== "cursor") return obj as HookInput;

  const eventName = typeof obj.hook_event_name === "string" ? obj.hook_event_name : undefined;
  const roots = obj.workspace_roots;
  const cwd = Array.isArray(roots) && typeof roots[0] === "string" ? (roots[0] as string) : (obj.cwd as string | undefined);
  const base: HookInput = {
    session_id: (obj.conversation_id ?? obj.generation_id ?? obj.session_id) as string | undefined,
    cwd,
    hook_event_name: eventName,
    transcript_path: typeof obj.transcript_path === "string" ? obj.transcript_path : undefined,
    stop_hook_active: obj.stop_hook_active === true,
  };
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  if (eventName === "afterFileEdit" || eventName === "afterTabFileEdit") {
    base.tool_name = "Edit";
    base.tool_input = { file_path: str(obj.file_path) ?? str(obj.path) };
  } else if (eventName === "afterShellExecution") {
    base.tool_name = "Bash";
    base.tool_input = { command: str(obj.command) };
    base.tool_response = { success: typeof obj.exit_code === "number" ? obj.exit_code === 0 : true };
  } else if (eventName === "preToolUse" || eventName === "postToolUse" || obj.tool_input || obj.tool_name) {
    const tool = obj.tool as Record<string, unknown> | undefined;
    const args = (obj.tool_input ?? obj.args) as Record<string, unknown> | undefined;
    base.tool_name = str(obj.tool_name) ?? str(tool?.name);
    base.tool_input = { ...args, file_path: str(obj.file_path) ?? str(obj.path) ?? str(args?.file_path) ?? str(args?.path), command: str(obj.command) ?? str(args?.command) };
  }
  return base;
}

/**
 * Run a hook event. Managed mutation failures deny; advisory event failures
 * remain unavailable rather than certifying readiness.
 */
export async function runHook(event: HookEvent, root: string, input: HookInput, host: HookHost = "claude-code"): Promise<HookResult> {
  try {
    const config = await loadHookConfig(root);
    let decision: HookDecision;
    switch (event) {
      case "session-start": decision = await onSessionStart(root, input, config); break;
      case "user-prompt-submit": {
        const observed = await observeUserPrompt(root, host, input.session_id ?? '', typeof input.prompt === 'string' ? input.prompt : '');
        decision = observed.confirmed ? context(`GraphWard scope confirmed for task ${"taskId" in observed ? observed.taskId : ""}. Prepare current context before implementation.`) : ALLOW; break;
      }
      case "pre-tool-use":  decision = await onPreToolUse(root, input, config, host); break;
      case "post-tool-use": {
        const confirmation = input.tool_name === 'AskUserQuestion' ? await observeNativeQuestionResponse(root, host, input.session_id ?? '', input.tool_input?.questions, input.tool_response) : { confirmed: false };
        decision = confirmation.confirmed ? context('GraphWard requirements confirmed by native user response. Prepare current implementation context.') : await onPostToolUse(root, input); break;
      }
      case "stop":          decision = await onStop(root, input, config); break;
      default:              decision = ALLOW;
    }
    if (event === 'session-start' && decision.kind === 'context') decision.message += `\nGraphWard native host: ${host}; parent session ID: ${input.session_id ?? 'unavailable'}. Bind propose_task_contract to this host/session. Task APIs are documented in .graphward/providers/tool-contracts.json.`;
    if (existsSync(path.join(root, '.graphward/install-manifest.json'))) {
      await mkdir(path.join(root, '.graphward/.hooks-state'), { recursive: true });
      await appendFile(path.join(root, '.graphward/.hooks-state/events.jsonl'), JSON.stringify({ recordedAt: new Date().toISOString(), host, sessionId: input.session_id, event, tool: input.tool_name, decision: decision.kind, processId: process.pid, parentProcessId: process.ppid }) + "\n");
    }
    return formatDecision(host, event, decision);
  } catch (error) {
    if (event === 'pre-tool-use' && existsSync(path.join(root, '.graphward/install-manifest.json'))) return formatDecision(host, event, deny(`GraphWard readiness failed: ${String(error)}`));
    return { exitCode: 0 };
  }
}
