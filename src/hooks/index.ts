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

import { mkdir, readFile, writeFile, appendFile, rename, stat, lstat, rm } from "node:fs/promises";
import path from "node:path";
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolveRuntimeInvocation, quoteShellArgument } from "../runtime/invocation.js";
import { checkTaskReadiness, observeUserPrompt, observeNativeQuestionResponse } from "../aidlc/task-contract.js";
import { computeFreshness } from "../freshness/index.js";
import { defaultGwConfig, loadGwConfig } from "../config/index.js";
import { toCanonicalPath } from "../providers/workspace.js";
import { execFile } from "node:child_process";
import { withLock } from "../manifest/lock.js";
import type ts from "typescript";
import { createRequire } from "node:module";

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
  /** Per-command timeout for `verify`, in ms; unset uses the built-in 15 minutes. */
  verifyTimeoutMs?: number;
  unavailableValidationPolicy?: "block" | "allow-explicit";
}

export const DEFAULT_HOOK_CONFIG: HookConfig = {
  requireTaskReadiness: true,
  freshnessThreshold: 60,
  blockStaleEdits: false,
  requireValidationOnStop: true,
  verifyCommands: [],
  unavailableValidationPolicy: "block",
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
  return [invocation.command, ...invocation.args].map(value => quoteShellArgument(value)).join(' ');
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
          // Anchored: an unanchored regex matcher also fires on TodoWrite, BashOutput, etc.
          { matcher: "^(Edit|Write|NotebookEdit|MultiEdit|Bash|PowerShell|Task|Agent|mcp__.*)$", hooks: [{ type: "command", command: hookCommand("pre-tool-use"), onFailure: "block" }] },
        ],
        PostToolUse: [
          { matcher: "^(Edit|Write|NotebookEdit|MultiEdit|Bash|PowerShell|Task|Agent|AskUserQuestion|ExitPlanMode|mcp__.*)$", hooks: [{ type: "command", command: hookCommand("post-tool-use") }] },
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
  // SessionStart, not PreInvocation: PreInvocation fires on every turn and would reset session state.
  return JSON.stringify({ graphward: { enabled: true, SessionStart: [handler("session-start")], PreToolUse: [{ matcher: ".*", hooks: [handler("pre-tool-use")] }], PostToolUse: [{ matcher: ".*", hooks: [handler("post-tool-use")] }], Stop: [handler("stop")] } }, null, 2) + "\n";
}

function editPaths(input: HookInput): string[] {
  const args = input.tool_input ?? {};
  const paths = [args.file_path, args.path, args.TargetFile, args.filePath, args.target_file].filter((value): value is string => typeof value === "string");
  if (Array.isArray(args.edits)) for (const edit of args.edits) if (edit && typeof edit === "object" && typeof (edit as any).file_path === "string") paths.push((edit as any).file_path);
  const patch = typeof args.command === "string" && baseToolName(input.tool_name ?? "") === "apply_patch" ? args.command : typeof args.patch === "string" ? args.patch : "";
  for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) paths.push(match[1]);
  return [...new Set(paths)];
}
/** Resolve symlinks through the nearest existing ancestor, so a new file written via an
 *  aliased path (e.g. macOS /var -> /private/var) cannot look like it is outside the project. */
function canonicalTarget(file: string, depth = 0): string {
  if (depth > 40) throw new Error("Symlink resolution exceeded its safe limit.");
  let current = path.resolve(file);
  const missing: string[] = [];
  for (;;) {
    try {
      if (lstatSync(current).isSymbolicLink()) return canonicalTarget(path.join(path.resolve(path.dirname(current), readlinkSync(current)), ...missing), depth + 1);
      return path.join(realpathSync(current), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.unshift(path.basename(current)); current = parent;
    }
  }
}

function isInsideProject(root: string, file: string): boolean {
  const relative = path.relative(toCanonicalPath(root), canonicalTarget(path.resolve(root, file)));
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Codex groups built-in tools into namespaces and reports them to hooks as namespace+name
 * (`collaborationspawn_agent`, `clocksleep`), with or without a separator. Strip the
 * namespace so the tool classifies by its own name.
 */
function baseToolName(tool: string): string {
  return tool.replace(/^(?:collaboration|clock)(?:[._:/]|__)?(?=[a-z])/, "");
}

// ---------------------------------------------------------------------------
// Tool effects
//
// The task gate exists to stop unconfirmed changes to THIS project's files. Hosts name
// their tools differently and add new ones often, so the gate classifies a call by what it
// can do rather than by a list of names it happens to know: anything that cannot change
// project files passes, whatever the host or tool.
//
//   Claude Code  Edit/Write/NotebookEdit, Bash/PowerShell, mcp__<server>__<tool>
//   Codex        apply_patch, Bash (shell and exec_command), mcp__<server>__<tool>,
//                namespaced locals (collaborationspawn_agent)
//   Cursor       Write/Delete, Shell, MCP:<tool>
//   Antigravity  write_to_file/replace_file_content/multi_replace_file_content, run_command,
//                call_mcp_tool (normalized to mcp__<server>__<tool>) or mcp_<server>_<tool>
// ---------------------------------------------------------------------------

/** What a tool call can do to the project. */
type ToolEffect =
  | { kind: "none" }                   // cannot change project files: never gated
  | { kind: "edit"; paths: string[] }  // writes these files (empty: target not exposed)
  | { kind: "shell"; command?: string } // runs a local command; read-only commands pass
  | { kind: "execute" };               // runs local code that cannot be inspected

const FILE_EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit|Delete|apply_patch|write_to_file|replace_file_content|multi_replace_file_content)$/;
const SHELL_TOOLS = /^(Bash|PowerShell|Shell|Monitor|run_command|exec_command|shell|local_shell|container\.exec)$/;

/** GraphWard's own MCP tools. They write only `.graphward/` state and enforce their own
 *  preconditions, so the gate must never stand between an agent and validation or sync. */
const GRAPHWARD_TOOLS = new Set([
  "analyze_change_impact", "analyze_impact", "assess_prompt_clarity", "assess_risk", "capture_api_snapshot", "check_aidlc_gate",
  "create_session_handoff", "derive_claims", "evaluate_counterfactual", "evaluate_experiment_step", "find_symbol",
  "freeze_clarified_requirements", "generate_experiment_candidates", "get_aidlc_state", "get_brief", "get_context",
  "get_engineering_context", "get_experiment_history", "get_graph", "get_session_handoff", "get_task_readiness", "graphward",
  "host_support_status", "list_active_flights", "map_dependencies", "migrate_legacy_regression_patterns", "postflight",
  "preflight", "prepare_task_context", "promote_learned_pattern", "propose_task_contract", "provider_cce_retrieval",
  "provider_graphify_evidence", "provider_status", "query_project_memory", "read_knowledge", "record_learned_pattern",
  "record_task_change_mapping", "replay_api_snapshot", "run_gate", "simulate_change_intent", "slice_graph",
  "sync_engineering_knowledge", "update_aidlc_state", "validate_change", "verify_claims", "who_calls",
]);
/** The one GraphWard tool that applies a patch to product code. */
const GRAPHWARD_CODE_TOOLS = new Set(["evaluate_experiment_step"]);

const MUTATING_VERB = /(^|[_-])(write|edit|create|delete|remove|rm|move|rename|copy|patch|apply|replace|insert|update|append|save|mkdir|upload|put|modify|overwrite|truncate)(?=[_-]|$)/i;
const EXECUTOR_NAME = /(^|[_-])(exec|execute|run|shell|terminal|bash|command|cmd|process|eval|repl|python|js|javascript|script)(?=[_-]|$)/i;
/** Browser automation runs JavaScript in a page, not on the project. */
const PATH_KEY = /^(path|paths|file|files|file_?path|filepath|target_?file|targetfile|source|destination|dest|directory|dir|absolute_?path|relative_?path|uri)$/i;

function mcpTool(name: string): { server?: string; tool: string } | undefined {
  const qualified = /^mcp__(.+?)__(.+)$/.exec(name);
  if (qualified) return { server: qualified[1], tool: qualified[2] };
  const cursor = /^MCP:(.+)$/.exec(name);
  if (cursor) return { tool: cursor[1] };
  // Antigravity may flatten to mcp_<server>_<tool>; server names can contain underscores,
  // so only a known GraphWard suffix can be split reliably.
  const flat = /^mcp_(.+)$/.exec(name);
  if (flat) {
    const known = [...GRAPHWARD_TOOLS].find(tool => flat[1].endsWith(`_${tool}`));
    return known ? { server: flat[1].slice(0, -known.length - 1), tool: known } : { tool: flat[1] };
  }
  return undefined;
}

/** String paths in an argument object (one level, plus arrays and array elements' path keys). */
function argumentPaths(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const add = (value: unknown) => { if (typeof value === "string" && value) paths.push(value.replace(/^file:\/\//, "")); };
  for (const [key, value] of Object.entries(args)) {
    if (!PATH_KEY.test(key)) continue;
    if (Array.isArray(value)) for (const item of value) {
      if (item && typeof item === "object") for (const [inner, nested] of Object.entries(item)) { if (PATH_KEY.test(inner)) add(nested); }
      else add(item);
    }
    else add(value);
  }
  return [...new Set(paths)];
}

function toolEffect(input: HookInput): ToolEffect {
  const raw = input.tool_name ?? "";
  // No tool name is a malformed payload: treat it as an edit whose target is unknown.
  if (!raw) return { kind: "edit", paths: [] };
  const tool = baseToolName(raw);
  const args = (input.tool_input ?? {}) as Record<string, unknown>;
  const command = typeof args.command === "string" ? args.command : typeof args.cmd === "string" ? args.cmd : undefined;
  if (FILE_EDIT_TOOLS.test(tool)) return { kind: "edit", paths: editPaths(input) };
  if (SHELL_TOOLS.test(tool)) return { kind: "shell", command };
  const mcp = mcpTool(raw);
  // These page tools expose explicit *output* paths. A screenshot without one is
  // remote observation; a supplied local destination is a filesystem effect.
  if (mcp && /^(?:take_screenshot|take_snapshot|evaluate_script|performance_start_trace|performance_stop_trace|take_heapsnapshot|get_network_request)$/.test(mcp.tool)) {
    const outputs = [args.filePath, args.requestFilePath, args.responseFilePath].filter((value): value is string => typeof value === "string" && value.length > 0);
    if (outputs.length) return { kind: "edit", paths: outputs };
  }
  // Namespaces are provenance, not effects. A browser-like name or a copied GraphWard
  // tool name cannot exempt filesystem writes or arbitrary local code payloads.
  if (command !== undefined) return { kind: "shell", command };
  if (["code", "script"].some(key => typeof args[key] === "string")) return { kind: "execute" };
  if (mcp?.server === "graphward" && GRAPHWARD_TOOLS.has(mcp.tool)) return GRAPHWARD_CODE_TOOLS.has(mcp.tool) ? { kind: "execute" } : { kind: "none" };
  if (mcp && GRAPHWARD_TOOLS.has(mcp.tool)) return { kind: "execute" };
  // Any other tool — third-party MCP or a host tool this version has never seen — is gated
  // only when it demonstrably runs local commands/code or writes a path.
  const name = mcp?.tool ?? tool;
  if (EXECUTOR_NAME.test(name) || /repl/i.test(mcp?.server ?? "")) {
    if (command !== undefined) return { kind: "shell", command };
    if (["code", "script", "source"].some(key => typeof args[key] === "string")) return { kind: "execute" };
  }
  if (MUTATING_VERB.test(name)) {
    const paths = argumentPaths(args);
    if (paths.length) return { kind: "edit", paths };
  }
  return { kind: "none" };
}

/**
 * Split a shell command into pipeline/list segments of unquoted words. Returns null for
 * anything this conservative parser cannot prove harmless: command/process substitution,
 * backgrounding, multi-line scripts, or redirects other than to /dev/null or fd duplication.
 */
function splitShellSegments(command: string): string[][] | null {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let hasWord = false;
  let quote: "'" | '"' | null = null;
  const pushWord = () => { if (hasWord) words.push(word); word = ""; hasWord = false; };
  const endSegment = (): boolean => { pushWord(); if (!words.length) return false; segments.push(words); words = []; return true; };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    const next = command[index + 1] ?? "";
    if (quote === "'") { if (char === "'") quote = null; else word += char; continue; }
    if (quote === '"') {
      if (char === '"') { quote = null; continue; }
      if (char === "`" || char === "$") return null;
      if (char === "\\" && next) { word += next; index++; continue; }
      word += char; continue;
    }
    if (char === "'" || char === '"') { quote = char; hasWord = true; continue; }
    if (char === "\\") { if (!next || next === "\n") return null; word += next; hasWord = true; index++; continue; }
    if (char === "\n" || char === "\r" || char === "`" || char === "(" || char === ")") return null;
    if (char === "$") return null;
    if (char === " " || char === "\t") { pushWord(); continue; }
    if (char === "<") return null;
    if (char === ">") {
      const redirect = /^>(?:&\d|\s*\/dev\/null)(?=\s|$|[;|&])/.exec(command.slice(index));
      if (!redirect) return null;
      if (hasWord && /^\d$/.test(word)) { word = ""; hasWord = false; } // fd prefix such as 2>
      index += redirect[0].length - 1; continue;
    }
    if (char === "&") {
      if (next === "&") { if (!endSegment()) return null; index++; continue; }
      const redirect = /^&>\s*\/dev\/null(?=\s|$|[;|&])/.exec(command.slice(index));
      if (!redirect) return null; // background job
      index += redirect[0].length - 1; continue;
    }
    if (char === "|") { if (next === "|") index++; if (!endSegment()) return null; continue; }
    if (char === ";") { if (!endSegment()) return null; continue; }
    word += char; hasWord = true;
  }
  if (quote || !endSegment()) return null;
  return segments;
}

const READ_ONLY_COMMANDS = new Set([
  "pwd", "ls", "cat", "head", "tail", "wc", "stat", "file", "du", "tree", "basename", "dirname", "realpath", "which", "echo", "printf", "true", "cut", "tr", "nl", "column", "grep", "egrep", "fgrep", "jq", "diff", "cd",
  "whoami", "id", "uname", "uptime", "df", "free", "ps", "pgrep", "lsof", "printenv", "sleep", "seq",
  "sha256sum", "sha1sum", "shasum", "md5", "md5sum", "cksum", "hexdump", "od", "strings",
]);
const READ_ONLY_GIT = new Set(["status", "diff", "log", "show", "ls-files", "rev-parse", "blame", "grep", "cat-file", "ls-tree", "shortlog", "describe", "merge-base", "rev-list", "for-each-ref", "name-rev", "count-objects"]);
/** Environment prefixes that only change formatting; anything else (PAGER, GIT_EXTERNAL_DIFF,
 *  LD_PRELOAD, BASH_ENV...) can make a "read" command execute arbitrary code. */
const SAFE_ENV = /^(TZ|LANG|LANGUAGE|LC_[A-Z]+|NO_COLOR|FORCE_COLOR|TERM|COLUMNS|LINES|CLICOLOR)=/;
/** Toolchains whose version probe is a read. */
const VERSION_PROBES = new Set(["node", "npm", "npx", "pnpm", "yarn", "bun", "deno", "python", "python3", "pip", "pip3", "uv", "go", "cargo", "rustc", "java", "ruby", "gem", "dotnet", "docker", "kubectl", "terraform", "tsc", "git", "gh", "gw", "graphward"]);
const VERSION_FLAGS = new Set(["--version", "-v", "-V", "version"]);
/** curl flags that write local files or send local files. */
const CURL_WRITES = /^--(?:output|output-dir|remote-name|remote-name-all|dump-header|cookie-jar|upload-file|config|create-dirs|libcurl|trace|trace-ascii|stderr|form|form-string)(?:=|$)/;

function readOnlyGitSubcommand(sub: string, args: string[]): boolean {
  switch (sub) {
    case "branch": return args.every(arg => /^(-a|-r|-v|-vv|--all|--remotes|--verbose|--show-current|--list|-l|--no-color|--color)$/.test(arg)) || args[0] === "--list" || args[0] === "-l";
    case "remote": return args.length === 0 || args.every(arg => arg === "-v" || arg === "--verbose") || args[0] === "show" || args[0] === "get-url";
    case "tag": return args.length === 0 || args[0] === "-l" || args[0] === "--list";
    case "stash": return args[0] === "list" || args[0] === "show";
    case "config": return args.some(arg => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(arg));
    case "worktree": return args[0] === "list";
    case "reflog": return args.length === 0 || args[0] === "show";
    default: return READ_ONLY_GIT.has(sub);
  }
}
const FIND_WRITES = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);

// Deliberately small expression language. Node evaluation is not generally a read:
// ambient globals, constructors, computed properties and user callbacks execute code.
function isPureJavaScript(source: string): boolean {
  if (source.length > 16_384) return false;
  let ts: typeof import("typescript");
  try { ts = createRequire(import.meta.url)("typescript"); } catch { return false; }
  const file = ts.createSourceFile("inspection.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const calls = new Set(["console.log", "console.info", "console.dir", "JSON.stringify", "JSON.parse", "Number", "String", "Boolean", "Math.abs", "Math.floor", "Math.ceil", "Math.round", "Math.min", "Math.max"]);
  const expression = (node: ts.Node): boolean => {
    if (ts.isNumericLiteral(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)) return true;
    if (ts.isParenthesizedExpression(node)) return expression(node.expression);
    if (ts.isArrayLiteralExpression(node)) return node.elements.every(expression);
    if (ts.isObjectLiteralExpression(node)) return node.properties.every(item => ts.isPropertyAssignment(item) && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name) || ts.isNumericLiteral(item.name)) && expression(item.initializer));
    if (ts.isPrefixUnaryExpression(node)) return [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.ExclamationToken, ts.SyntaxKind.TildeToken].includes(node.operator) && expression(node.operand);
    if (ts.isBinaryExpression(node)) return node.operatorToken.kind >= ts.SyntaxKind.FirstBinaryOperator && node.operatorToken.kind <= ts.SyntaxKind.LastBinaryOperator && !(node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) && expression(node.left) && expression(node.right);
    if (ts.isConditionalExpression(node)) return expression(node.condition) && expression(node.whenTrue) && expression(node.whenFalse);
    return ts.isCallExpression(node) && calls.has(node.expression.getText(file)) && node.arguments.every(expression);
  };
  return !(file as ts.SourceFile & {parseDiagnostics?: unknown[]}).parseDiagnostics?.length && file.statements.length > 0 && file.statements.every(statement => ts.isExpressionStatement(statement) && expression(statement.expression));
}

function graphwardArgs(words: string[]): string[] | undefined {
  let start = 0;
  while (SAFE_ENV.test(words[start] ?? "")) start++;
  words = words.slice(start);
  if (words[0] === "gw" || words[0] === "graphward") return words.slice(1);
  if (words[0] !== process.execPath && words[0] !== realpathSync(process.execPath)) return undefined;
  const invocation = resolveRuntimeInvocation();
  const runtime = [invocation.command, ...invocation.args];
  return runtime.every((part, index) => words[index] === part) ? words.slice(runtime.length) : undefined;
}

function isReadOnlySegment(words: string[]): boolean {
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) {
    if (!SAFE_ENV.test(words[index])) return false;
    index++;
  }
  if (index === words.length) return true; // a formatting variable assignment alone
  words = words.slice(index);
  const cliArgs = graphwardArgs(words);
  if (cliArgs) return /^(?:verify|context|providers status|aidlc (?:prepare-task|assess|gate|confirm-task|accept-reduced-context))(?:\s|$)/.test(cliArgs.join(" "));
  const [name, ...args] = words;
  if (READ_ONLY_COMMANDS.has(name)) return !args.some(arg => arg === "--output" || /^--output=/.test(arg) || name === "file" && (/^--compile(?:=|$)/.test(arg) || /^-[^-]*C/.test(arg)));
  if (VERSION_PROBES.has(name) && args.length === 1 && VERSION_FLAGS.has(args[0])) return true;
  switch (name) {
    case "command": return args.length === 2 && (args[0] === "-v" || args[0] === "-V") && /^[\w.-]+$/.test(args[1]);
    case "node": {
      const rest = args[0] === "--input-type=module" ? args.slice(1) : args;
      return rest.length === 2 && ["-e", "--eval", "-p", "--print"].includes(rest[0]) && isPureJavaScript(rest[1]);
    }
    case "date": return args.every(arg => arg.startsWith("+") || /^(?:-u|-R|--utc|--universal|--iso-8601(?:=\w+)?|--rfc-3339=\w+)$/.test(arg));
    case "hostname": return args.every(arg => /^(?:-s|-f|-i|-I|--short|--fqdn|--ip-address|--all-ip-addresses)$/.test(arg));
    case "sort": return !args.some(arg => arg === "-o" || /^--output/.test(arg) || /^-[A-Za-z]*o/.test(arg));
    case "uniq": return args.filter(arg => !arg.startsWith("-")).length <= 1; // a second operand is an output file
    case "find": return !args.some(arg => FIND_WRITES.has(arg));
    case "rg": return !args.some(arg => /^--(?:pre|pre-glob|hostname-bin)(?:=|$)/.test(arg));
    case "sed": {
      // Only `sed -n '<line-range>p' [files]`; the first operand is the script and must be a pure print.
      const operands = args.filter(arg => arg !== "-n");
      return args.includes("-n") && operands.every(arg => !arg.startsWith("-")) && /^(?:\s*(?:\d+|\$)(?:,(?:\d+|\$))?p\s*;?)+$/.test(operands[0] ?? "");
    }
    case "git": {
      let rest = args;
      while (rest[0] === "-C" || rest[0] === "--no-pager") rest = rest[0] === "-C" ? rest.slice(2) : rest.slice(1);
      return readOnlyGitSubcommand(rest[0] ?? "", rest.slice(1)) && !rest.some(arg => arg === "-c" || /^-o/.test(arg) || /^--(?:output|ext-diff|textconv|exec|upload-pack|open-files-in-pager|edit|unset|add|replace-all|delete|move|copy|create-reflog|force|prune|expire)/.test(arg) || /^-[^-]*[edmMCDf]/.test(arg) && ["config", "branch", "tag"].includes(rest[0]));
    }
    case "env": return args.length === 0 || args.every(arg => arg === "-0" || arg === "--null");
    case "npm": case "pnpm": case "yarn": return ["ls", "list", "view", "info", "outdated", "why", "explain"].includes(args[0] ?? "") && !args.includes("--fix");
    case "docker": return ["ps", "images", "logs", "inspect", "version", "info", "stats"].includes(args[0] ?? "") && !args.includes("--follow-unsafe");
    case "kubectl": return ["get", "describe", "logs", "version", "top", "explain"].includes(args[0] ?? "") || args[0] === "config" && args[1] === "view";
    case "curl":
      // Network reads print to stdout; anything that writes or uploads a local file is gated.
      return !args.some(arg => CURL_WRITES.test(arg) || /^--(?:request|data(?:-[a-z]+)?|json|next|url-query|quote|prequote|postquote|mail-from|mail-rcpt)(?:=|$)/.test(arg) || /^-[A-Za-z]*[oODcTKFXdGQ]/.test(arg) && !arg.startsWith("--") || arg.startsWith("@") || /=@/.test(arg));
    default: return false;
  }
}

/** True when every segment of a shell command (pipelines and && / ; lists included) is read-only. */
export function isReadOnlyShellCommand(command: string): boolean {
  const segments = splitShellSegments(command.trim());
  return !!segments && segments.every(isReadOnlySegment);
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
  unavailableValidation?: { identity: string; quote: string; host: HookHost; recordedAt: string };
}

const STATE_DIR = ".graphward/.hooks-state";
const EVENT_LOG_MAX_BYTES = 1024 * 1024;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

interface ReadOnlySession {
  schemaVersion: 1;
  root: string;
  host: HookHost;
  session: string;
  fingerprint: string;
  eligible: boolean;
}

function readOnlyIdentity(input: HookInput, host: HookHost): string | undefined {
  return typeof input.session_id === "string" && input.session_id.trim() && input.session_id.length <= 4096
    ? digest(JSON.stringify([host, input.session_id])) : undefined;
}

function readOnlyPath(root: string, identity: string): string {
  return path.join(root, STATE_DIR, `readonly-${identity}.json`);
}

async function readOnlyState(root: string, input: HookInput, host: HookHost): Promise<ReadOnlySession | undefined> {
  const identity = readOnlyIdentity(input, host); if (!identity) return undefined;
  try {
    const { checksum, ...state } = JSON.parse(await readFile(readOnlyPath(root, identity), "utf8"));
    if (checksum !== digest(JSON.stringify(state)) || state.schemaVersion !== 1 || state.root !== toCanonicalPath(root) || state.host !== host || state.session !== input.session_id || typeof state.eligible !== "boolean" || !/^[a-f0-9]{64}$/.test(state.fingerprint)) return undefined;
    return state;
  } catch { return undefined; }
}

async function saveReadOnlyState(root: string, identity: string, state: ReadOnlySession): Promise<void> {
  await mkdir(path.join(root, STATE_DIR), { recursive: true });
  await ensureStateGitignored(root);
  const location = readOnlyPath(root, identity); const temporary = `${location}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify({ ...state, checksum: digest(JSON.stringify(state)) })); await rename(temporary, location); }
  finally { await rm(temporary, { force: true }); }
}

/** Unlike provider indexes, this uses Git's full Stop candidate universe. Errors,
 * unsupported entries, excessive data or races mean no exemption. Local checksums
 * detect corruption; they are not tamper-proof native-host attestations. */
async function stopFingerprint(root: string): Promise<string | undefined> {
  const git = (args: string[]) => new Promise<string>((resolve, reject) => {
    execFile("git", args, { cwd: root, encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
  try {
    const canonicalRoot = toCanonicalPath(root);
    if (toCanonicalPath((await git(["rev-parse", "--show-toplevel"])).trim()) !== canonicalRoot) return undefined;
    const head = (await git(["rev-parse", "HEAD"])).trim();
    const gitDir = canonicalTarget(path.resolve(root, (await git(["rev-parse", "--git-dir"])).trim()));
    const inventory = async () => {
      const files = [...new Set((await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).split("\0").filter(file => file && !file.startsWith(".graphward/")))].sort();
      const index = (await git(["ls-files", "--stage", "-z"])).split("\0").filter(record => record && !record.split("\t").slice(1).join("\t").startsWith(".graphward/"));
      if (index.some(record => record.startsWith("160000 "))) throw new Error("Nested repository source coverage is unknown.");
      return { files, index };
    };
    const before = await inventory();
    if (before.files.length > 20_000) return undefined;
    const configFile = (file: string) => /(?:^|\/)(?:package(?:-lock)?\.json|(?:tsconfig|jsconfig)[^/]*\.json|\.gitignore|\.gwignore|\.eiignore|\.gitmodules|[^/]*lock[^/]*|[^/]*\.config\.[cm]?[jt]s)$/.test(file);
    const files = [...new Set([...before.files, ".graphward/gw.config.json", ".graphward/config.json"])].sort();
    let totalBytes = 0;
    const hashes: Array<Array<string | number>> = [];
    for (const file of files) {
      const absolute = path.resolve(root, file);
      const relative = path.relative(canonicalRoot, canonicalTarget(absolute));
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
      try {
        const first = await lstat(absolute);
        if (!first.isFile()) return undefined;
        // Bind other configuration formats and inventory changes by metadata without
        // reading arbitrary private config/assets. Source and known gate config bind bytes.
        if (!isSourceFile(file) && !configFile(file) && !file.startsWith(".graphward/")) {
          hashes.push([file, "metadata", first.mode, first.mtimeMs, first.ctimeMs, first.size, first.ino, first.dev]);
          continue;
        }
        if (first.size > 4 * 1024 * 1024) return undefined;
        totalBytes += first.size; if (totalBytes > 64 * 1024 * 1024) return undefined;
        const bytes = await readFile(absolute); const last = await lstat(absolute);
        if (first.ino !== last.ino || first.dev !== last.dev || first.size !== last.size || first.mtimeMs !== last.mtimeMs || first.ctimeMs !== last.ctimeMs || first.mode !== last.mode || bytes.length !== last.size) return undefined;
        hashes.push([file, digest(bytes), last.mode, last.mtimeMs, last.ctimeMs]);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
        hashes.push([file, "missing", 0, 0, 0]);
      }
    }
    if (JSON.stringify(before) !== JSON.stringify(await inventory()) || head !== (await git(["rev-parse", "HEAD"])).trim()) return undefined;
    return digest(JSON.stringify({ root: canonicalRoot, gitDir, head, index: before.index, hashes }));
  } catch { return undefined; }
}

async function startReadOnlySession(root: string, input: HookInput, host: HookHost): Promise<void> {
  if ((await loadGwConfig(root)).workflow.mode !== "concise") return;
  const identity = readOnlyIdentity(input, host); if (!identity) return;
  await withLock(root, async () => {
    let exists = false;
    try { await lstat(readOnlyPath(root, identity)); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    // Repeated SessionStart is a resume/collision, never a new baseline.
    const fingerprint = !exists ? await stopFingerprint(root) : undefined;
    await saveReadOnlyState(root, identity, { schemaVersion: 1, root: toCanonicalPath(root), host, session: input.session_id!, fingerprint: fingerprint ?? "0".repeat(64), eligible: !exists && !!fingerprint });
  }, { name: `.readonly-${identity}.lock` });
}

async function notePotentialMutation(root: string, input: HookInput, host: HookHost, effect: ToolEffect): Promise<void> {
  const tool = baseToolName(input.tool_name ?? "");
  const delegated = /(?:spawn_agent|followup_task|send_message|send_input|create_thread|fork_thread|handoff_thread)/.test(tool) || /^(?:Task|Agent|delegate_to_agent)$/i.test(tool);
  const mcp = mcpTool(input.tool_name ?? "");
  const runsChecks = mcp?.server === "graphward" && ["run_gate", "validate_change", "replay_api_snapshot", "capture_api_snapshot", "evaluate_experiment_step"].includes(mcp.tool)
    || effect.kind === "shell" && splitShellSegments(effect.command ?? "")?.some(segment => ["verify", "gate"].includes(graphwardArgs(segment)?.[0] ?? ""));
  const read = effect.kind === "none" || effect.kind === "shell" && effect.command !== undefined && isReadOnlyShellCommand(effect.command);
  if (read && !delegated && !runsChecks) return;
  const identity = readOnlyIdentity(input, host); if (!identity) return;
  await withLock(root, async () => {
    const state = await readOnlyState(root, input, host);
    if (state?.eligible) await saveReadOnlyState(root, identity, { ...state, eligible: false });
  }, { name: `.readonly-${identity}.lock` });
}

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
      unavailableValidation: parsed.unavailableValidation,
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

async function unavailableIdentity(root: string, input: HookInput, config: HookConfig, host: HookHost): Promise<string | undefined> {
  if (config.unavailableValidationPolicy !== "allow-explicit" || !input.session_id || config.verifyCommands.length) return undefined;
  const verification = await import("../verify/index.js");
  if ((await verification.detectCheckCommands(root)).length) return undefined;
  const state = await readState(root, input);
  const files = (await verification.isGitWorkTree(root) ? await verification.changedFiles(root) : await verification.withinNonGitScope(root, state.changedFiles)).filter(isSourceFile);
  return digest(JSON.stringify([host, input.session_id, await verification.verificationScopeIdentity(root, files)]));
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
  if (host === 'antigravity' || host === 'antigravity-cli') {
    // Antigravity requires `decision` on every PreToolUse answer and treats a failed hook as a
    // block, so even "allow" is spelled out. PostToolUse answers `{}`; Stop continues only on
    // `decision: "continue"`; SessionStart injects steps.
    if (event === 'pre-tool-use') return { exitCode: 0, stdout: JSON.stringify(decision.kind === 'deny' ? { decision: 'deny', reason: decision.message } : { decision: 'allow' }) };
    if (decision.kind === 'block') return { exitCode: 0, stdout: JSON.stringify({ decision: 'continue', reason: decision.message }) };
    if (decision.kind === 'context' && event === 'session-start') return { exitCode: 0, stdout: JSON.stringify({ injectSteps: [{ ephemeralMessage: decision.message }] }) };
    return { exitCode: 0, stdout: '{}' };
  }
  if (decision.kind === "allow") return host === 'cursor' && event === 'pre-tool-use' ? { exitCode: 0, stdout: JSON.stringify({ permission: 'allow' }) } : { exitCode: 0 };
  const message = decision.message ?? "";

  if (host === "cursor") {
    // Cursor: permission hooks use { permission, agent_message }; stop uses followup_message.
    switch (decision.kind) {
      case "context":
        return {
          exitCode: 0,
          // preToolUse has no context field, so the note rides on agent_message; sessionStart
          // and postToolUse take `additional_context`.
          stdout: JSON.stringify(
            event === "pre-tool-use" ? { permission: "allow", agent_message: message } : { additional_context: message },
          ),
        };
      case "deny":
        return { exitCode: 0, stdout: JSON.stringify({ permission: "deny", agent_message: message }) };
      case "block":
        return { exitCode: 0, stdout: JSON.stringify({ followup_message: message }) };
    }
  }

  // Claude Code and Codex share this contract.
  const hookEventName = { "session-start": "SessionStart", "user-prompt-submit": "UserPromptSubmit", "pre-tool-use": "PreToolUse", "post-tool-use": "PostToolUse", stop: "Stop" }[event];
  switch (decision.kind) {
    case "context":
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName,
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

async function onSessionStart(root: string, input: HookInput, config: HookConfig, host: HookHost): Promise<HookDecision> {
  await startReadOnlySession(root, input, host).catch(() => {});
  // Fresh session: clear any stale evidence from a previous session id collision.
  await writeState(root, input, { changedFiles: [], validationCommands: [] }).catch(() => {});

  const report = await computeFreshness(root, config.freshnessThreshold);
  if (report.scores.length === 0) {
    // No intelligence initialized — nudge, but never block.
    return context(
      "GraphWard: no persisted intelligence found. Run `initialize-graphward` to document this codebase so future work reuses it instead of re-exploring.",
    );
  }

  // Uncited documents are missing evidence, not proven drift; list them separately so the
  // agent sees which artifacts actually disagree with current source.
  const stale = report.scores.filter((s) => s.action !== "none" && s.status !== "unverifiable").sort((a, b) => a.score - b.score);
  const uncited = report.scores.filter((s) => s.status === "unverifiable");
  const lines = [
    `GraphWard — freshness: ${report.driftDecision} (threshold ${report.threshold}).`,
    `${report.scores.length} intelligence docs; ${stale.length} stale against current source${uncited.length ? `, ${uncited.length} without checkable citations` : ""}.`,
  ];
  if (stale.length > 0) {
    const top = stale.slice(0, 5).map((s) => `  - ${s.docPath} (score ${s.score}, ${s.action})`);
    lines.push("Stale artifacts:", ...top);
    lines.push("Verify these against source before relying on them; run `sync-graphward` to refresh.");
  } else {
    lines.push("All checkable intelligence is fresh — prefer it over re-reading source.");
  }
  return context(lines.join("\n"));
}

async function onPreToolUse(root: string, input: HookInput, config: HookConfig, host: HookHost): Promise<HookDecision> {
  const effect = toolEffect(input);
  // Persist before any allow/deny/foreign-workspace branch: a failed or restored edit
  // still makes session provenance uncertain. The host remains the permission owner.
  await notePotentialMutation(root, input, host, effect);
  if (effect.kind === "none") return ALLOW;
  if (effect.kind === "shell" && effect.command !== undefined && isReadOnlyShellCommand(effect.command)) return ALLOW;

  if (config.requireTaskReadiness && existsSync(path.join(root, '.graphward/install-manifest.json'))) {
    // GraphWard governs this project only. A session or command working directory outside
    // it (another workspace root, another repo) is left to the host's own permissions; one
    // inside it (Antigravity run_command with Cwd=backend/) is this project.
    const allPaths = effect.kind === "edit" ? effect.paths : [];
    for (const file of allPaths) {
      const lexical = path.relative(path.resolve(root), path.resolve(root, file));
      if (lexical !== ".." && !lexical.startsWith(`..${path.sep}`) && !path.isAbsolute(lexical) && !isInsideProject(root, file)) return deny(`Mutation target resolves outside this project through a symlink: ${file}`);
    }
    const toolCwd = input.tool_input?.Cwd ?? input.tool_input?.cwd ?? input.tool_input?.workdir;
    const hasProjectTarget = allPaths.some(file => isInsideProject(root, file));
    if (!hasProjectTarget && (input.cwd && !isInsideProject(root, input.cwd) || typeof toolCwd === "string" && !isInsideProject(root, toolCwd))) return ALLOW;
    // File edits that target nothing inside the project root (agent memory, scratch files,
    // other repos) are left to the host instead of being denied as "outside confirmed scope".
    const paths = allPaths.filter(file => isInsideProject(root, file));
    if (allPaths.length > 0 && paths.length === 0) return context(`GraphWard: ${allPaths.join(", ")} is outside this project; not governed by the task gate.`);
    const reportingOnly = effect.kind === "edit" && paths.length > 0 && paths.every(file => {
      const isReport = (relative: string) => /^\.graphward\/(?:reports|handoffs)\//.test(relative.replace(/\\/g, "/"));
      return isReport(path.relative(path.resolve(root),path.resolve(root,file))) && isReport(path.relative(toCanonicalPath(root),canonicalTarget(path.resolve(root,file))));
    });
    const readiness = await checkTaskReadiness(root, { host, sessionId: input.session_id, files: paths, ...(reportingOnly ? { stage: "requirements" as const } : {}) });
    if (!readiness.ready) return deny(`GraphWard task readiness blocked this mutation: ${readiness.blockers.join(' ')}. Discover → clarify → confirm scope → prepare_task_context → implement → validate.`);
    if (effect.kind === "edit" && !paths.length) return deny('Mutation payload does not expose a supported target.');
  }

  if (effect.kind !== "edit") return ALLOW;
  const targetPath = input.tool_input?.file_path ?? effect.paths[0];
  if (!targetPath || !isInsideProject(root, targetPath)) return ALLOW;
  const rel = path.relative(toCanonicalPath(root), canonicalTarget(path.resolve(root, targetPath))).replace(/\\/g, "/");
  if (!isSourceFile(rel)) return ALLOW; // editing docs/config/intelligence is always fine

  // Non-strict mode only reports documents describing this file, so only score those;
  // the full scan (one git lookup per cited source per document) cost ~2s per edit.
  const report = await computeFreshness(root, config.freshnessThreshold, config.blockStaleEdits ? {} : { citing: rel });
  if (report.scores.length === 0 || report.driftDecision === "Proceed") return ALLOW;

  const stale = report.scores.filter((s) => s.action !== "none" && s.status !== "unverifiable").sort((a, b) => a.score - b.score);
  // Only interrupt with documents that actually describe the file being edited;
  // repeating the global stale list on every edit is noise the agent learns to ignore.
  const relevant = stale.filter((s) => s.staleSources.some((source) => source.file === rel) || s.deletedSources.includes(rel));
  const strict = config.blockStaleEdits && report.driftDecision === "Block implementation";
  const listed = strict && relevant.length === 0 ? stale : relevant;
  if (listed.length === 0) return ALLOW;
  const detail = [
    strict ? `GraphWard flags stale documentation (${report.driftDecision}).` : `GraphWard: documentation describing ${rel} is stale; verify it against source before relying on it.`,
    "Affected artifacts:",
    ...listed.slice(0, 5).map((s) => `  - ${s.docPath} (score ${s.score})`),
    `Sync with \`sync-graphward\` (or \`${runtimeCommand()} freshness .\`) after this change.`,
  ].join("\n");

  if (strict) return deny(detail);
  return context(detail);
}

async function onPostToolUse(root: string, input: HookInput, host: HookHost): Promise<HookDecision> {
  await notePotentialMutation(root, input, host, toolEffect(input));
  const tool = input.tool_name ?? "";
  const state = await readState(root, input);
  let dirty = false;

  // Edits are still recorded, but only as a hint for messaging. The Stop gate
  // derives the real change set from git, so edits this matcher never sees
  // (sed -i, patch, a subagent) are still covered.
  if (/^(Edit|Write|NotebookEdit|MultiEdit)$/.test(tool)) {
    const targetPath = input.tool_input?.file_path;
    if (targetPath) {
      const rel = path.relative(toCanonicalPath(root), canonicalTarget(path.resolve(root, targetPath))).replace(/\\/g, "/");
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

async function onStop(root: string, input: HookInput, config: HookConfig, host: HookHost): Promise<HookDecision> {
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

  const { changedFiles, coverageFor, detectCheckCommands, isGitWorkTree, withinNonGitScope } = await import("../verify/index.js");

  // Derive the change set from git, not from what the tool matcher happened to see.
  // Fall back to hook-tracked edits only when git is unavailable (e.g. no repo); a clean
  // Git tree means everything was committed, not that the change set is unknown.
  // Outside Git, only files a receipt can bind count (nested repos' .gitignore applies).
  const state = await readState(root, input);
  const candidates = (await isGitWorkTree(root) ? await changedFiles(root) : await withinNonGitScope(root, state.changedFiles)).filter(isSourceFile);
  if (candidates.length === 0) return ALLOW; // no source changed

  if ((await loadGwConfig(root)).workflow.mode === "concise") {
    const baseline = await readOnlyState(root, input, host);
    if (baseline?.eligible) {
      const fingerprint = await stopFingerprint(root);
      if (fingerprint && fingerprint === baseline.fingerprint) return ALLOW;
    }
  }

  const coverage = await coverageFor(root, candidates);
  if (coverage.covered) {
    return ALLOW; // a passing record vouches for these exact bytes
  }
  const records = await (await import("../verify/index.js")).readRecords(root);
  const lastFailed = records.find((r) => r.verdict === "fail");
  const checks = config.verifyCommands.length > 0
    ? config.verifyCommands
    : await detectCheckCommands(root);
  if (!checks.length && state.unavailableValidation?.host === host && state.unavailableValidation.identity === await unavailableIdentity(root, input, config, host)) return ALLOW;

  const reason: string[] = [
    "GraphWard: these source changes have no passing verification record.",
    "Validation must be a fact this tool produced, not a command that looked test-shaped.",
    "Unverified files:",
    ...coverage.uncovered.slice(0, 8).map((f) => `  - ${f}`),
  ];
  if (coverage.uncovered.length > 8) reason.push(`  …and ${coverage.uncovered.length - 8} more`);
  if (coverage.uncovered.length === 0) reason.push("  (none by content — every file matches the last passing record, but that record was made at a different commit or project root; records are bound to HEAD, so re-run verification after committing or switching branches.)");

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
      : `No check command could be detected. Configure \`hooks.verifyCommands\` in .graphward/gw.config.json.${config.unavailableValidationPolicy === "allow-explicit" ? " If checks are genuinely unavailable, state 'Validation is unavailable; no check commands are configured.' This records an unavailable outcome for this session and exact source; it never establishes a pass." : " Validation remains unavailable under the current blocking policy; an explicit hooks.unavailableValidationPolicy=allow-explicit policy permits a scoped honest unavailable outcome."}`,
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
      case "session-start": decision = await onSessionStart(root, input, config, host); break;
      case "user-prompt-submit": {
        const observed = await observeUserPrompt(root, host, input.session_id ?? '', typeof input.prompt === 'string' ? input.prompt : '');
        if (typeof input.prompt === "string" && /^Validation is unavailable; no check commands are configured\.?$/i.test(input.prompt.trim())) {
          const identity = await unavailableIdentity(root, input, config, host);
          if (identity) { const state = await readState(root, input); state.unavailableValidation = {identity, quote:input.prompt,host,recordedAt:new Date().toISOString()}; await writeState(root, input, state); }
        }
        decision = observed.confirmed ? context(`GraphWard scope confirmed for task ${"taskId" in observed ? observed.taskId : ""}. Prepare current context before implementation.`) : ALLOW; break;
      }
      case "pre-tool-use":  decision = await onPreToolUse(root, input, config, host); break;
      case "post-tool-use": {
        const confirmation = input.tool_name === 'AskUserQuestion' ? await observeNativeQuestionResponse(root, host, input.session_id ?? '', input.tool_input?.questions, input.tool_response) : { confirmed: false };
        decision = confirmation.confirmed ? context('GraphWard requirements confirmed by native user response. Prepare current implementation context.') : await onPostToolUse(root, input, host); break;
      }
      case "stop":          decision = await onStop(root, input, config, host); break;
      default:              decision = ALLOW;
    }
    if (event === 'session-start' && decision.kind === 'context') decision.message += `\nGraphWard native host: ${host}; parent session ID: ${input.session_id ?? 'unavailable'}. Bind propose_task_contract to this host/session. Task APIs are documented in .graphward/providers/tool-contracts.json.`;
    if (existsSync(path.join(root, '.graphward/install-manifest.json'))) {
      await mkdir(path.join(root, '.graphward/.hooks-state'), { recursive: true });
      const eventLog = path.join(root, '.graphward/.hooks-state/events.jsonl');
      // One line per tool call adds up; keep the current log plus one rotated generation.
      try { if ((await stat(eventLog)).size > EVENT_LOG_MAX_BYTES) await rename(eventLog, `${eventLog}.1`); } catch { /* absent or raced */ }
      await appendFile(eventLog, JSON.stringify({ recordedAt: new Date().toISOString(), host, sessionId: input.session_id, event, tool: input.tool_name, decision: decision.kind, processId: process.pid, parentProcessId: process.ppid }) + "\n");
    }
    return formatDecision(host, event, decision);
  } catch (error) {
    if (event === 'pre-tool-use' && existsSync(path.join(root, '.graphward/install-manifest.json'))) return formatDecision(host, event, deny(`GraphWard readiness failed: ${String(error)}`));
    if (event === "stop" && (await loadHookConfig(root)).requireValidationOnStop) return formatDecision(host, event, block(`GraphWard verification is unavailable: ${String(error)}. Resolve the unsupported source target or verification error, then run \`${runtimeCommand()} verify .\`.`));
    return { exitCode: 0 };
  }
}
