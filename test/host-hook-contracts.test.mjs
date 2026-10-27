/**
 * Per-host hook contract tests. Tool names, payload shapes and output schemas follow each
 * host's published hook documentation:
 *   Claude Code  https://code.claude.com/docs/en/hooks, /tools-reference
 *   Codex        https://developers.openai.com/codex/hooks
 *   Cursor       https://cursor.com/docs/hooks
 *   Antigravity  https://antigravity.google/docs/hooks/
 * The gate must only stop unconfirmed changes to project files: with no task bound, every
 * non-mutating host tool passes and only in-project edits / mutating shell are denied.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runHook, normalizeInput, claudeCodeHookSettings, antigravityHookSettings } from "../dist/hooks/index.js";
import { mergeHookConfig } from "../dist/installer/json-merge.js";

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "gw-host-hooks-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".graphward"), { recursive: true });
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "backend"));
  await writeFile(path.join(root, "src/index.ts"), "export const a = 1;\n");
  await writeFile(path.join(root, ".graphward/gw.config.json"), JSON.stringify({ providers: { policy: "native" } }));
  await writeFile(path.join(root, ".graphward/install-manifest.json"), "{}");
  return root;
}

/** Claude Code and Codex share the hookSpecificOutput contract; silence means no objection. */
async function sharedDecision(root, host, tool_name, tool_input = {}) {
  const result = await runHook("pre-tool-use", root, { session_id: "s", cwd: root, tool_name, tool_input }, host);
  return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput?.permissionDecision ?? "allow" : "allow";
}

test("Claude Code: built-in, agent, browser, search and GraphWard tools pass without a task; edits and mutating shell do not", async (t) => {
  const root = await fixture(t);
  const allowed = [
    ["Read", { file_path: path.join(root, "src/index.ts") }], ["Glob", { pattern: "**/*.ts" }], ["Grep", { pattern: "a" }],
    ["TodoWrite", { todos: [] }], ["TaskCreate", { subject: "x" }], ["TaskUpdate", { taskId: "1" }], ["Agent", { prompt: "x" }],
    ["Skill", { skill: "x" }], ["WebFetch", { url: "https://example.com" }], ["WebSearch", { query: "x" }], ["ToolSearch", { query: "x" }],
    ["AskUserQuestion", { questions: [] }], ["EnterWorktree", { path: "wt" }], ["Artifact", { file_path: path.join(root, "page.html") }],
    ["mcp__context-engine__context_search", { query: "x", top_k: 12 }], ["mcp__context-engine__session_recall", { topic: "x" }],
    ["mcp__claude-in-chrome__javascript_tool", { action: "javascript_exec", text: "fetch('/x')" }], ["mcp__Claude_Browser__navigate", { url: "https://x" }],
    ["mcp__ccd_session__spawn_task", { title: "x" }], ["mcp__graphward__get_engineering_context", { task: "x" }],
    ["mcp__graphward__validate_change", { files: ["src/index.ts"] }], ["mcp__graphward__sync_engineering_knowledge", {}],
    ["mcp__graphward__update_aidlc_state", { phase: "construction" }], ["mcp__graphward__propose_task_contract", {}],
    ["Bash", { command: "git -C backend status -sb | head -1" }],
    ["Bash", { command: "curl -s -m 10 https://api.example.com/version" }], ["Bash", { command: "node --version && npm ls" }],
    ["PowerShell", { command: "git branch --show-current" }],
  ];
  for (const [tool, input] of allowed) assert.equal(await sharedDecision(root, "claude-code", tool, input), "allow", tool);
  const denied = [
    ["Edit", { file_path: path.join(root, "src/index.ts"), old_string: "1", new_string: "2" }], ["Write", { file_path: path.join(root, "src/new.ts"), content: "" }],
    ["Bash", { command: "touch src/index.ts" }], ["Bash", { command: "GIT_PAGER='sh -c id' git log" }], ["Bash", { command: "curl -so out.json https://x" }],
    ["mcp__graphward__evaluate_experiment_step", {}], ["mcp__filesystem__write_file", { path: "src/index.ts", content: "" }],
    ["mcp__engineering-intelligence__get_engineering_context", { task: "x" }], ["mcp__plugin_tools_gw__propose_task_contract", {}],
    ["Bash", { command: "git fetch -q origin" }],
  ];
  for (const [tool, input] of denied) assert.equal(await sharedDecision(root, "claude-code", tool, input), "deny", tool);
});

test("Claude Code: the PreToolUse matcher is anchored so TodoWrite/BashOutput never reach the gate", () => {
  const settings = JSON.parse(claudeCodeHookSettings());
  const matcher = new RegExp(settings.hooks.PreToolUse[0].matcher);
  for (const tool of ["Edit", "Write", "NotebookEdit", "Bash", "PowerShell", "Task", "Agent", "mcp__graphward__validate_change"]) assert.ok(matcher.test(tool), tool);
  for (const tool of ["TodoWrite", "BashOutput", "Read", "TaskCreate"]) assert.ok(!matcher.test(tool), tool);
});

test("Codex: Bash, apply_patch, MCP and namespaced local tools follow Codex's names", async (t) => {
  const root = await fixture(t);
  for (const [tool, input] of [["update_plan", { plan: [] }], ["collaborationspawn_agent", { agent_type: "x" }], ["collaboration.wait_agent", {}], ["clocksleep", {}],
    ["Bash", { command: "git log --oneline -3" }], ["mcp__graphward__get_engineering_context", { task: "x" }], ["view_image", { path: "a.png" }]]) {
    assert.equal(await sharedDecision(root, "codex", tool, input), "allow", tool);
  }
  assert.equal(await sharedDecision(root, "codex", "apply_patch", { command: "*** Begin Patch\n*** Update File: src/index.ts\n*** End Patch" }), "deny");
  assert.equal(await sharedDecision(root, "codex", "Bash", { command: "rm -rf src" }), "deny");
  // Context on other events carries the matching event name.
  const session = JSON.parse((await runHook("session-start", root, { session_id: "s" }, "codex")).stdout);
  assert.equal(session.hookSpecificOutput.hookEventName, "SessionStart");
});

test("Cursor: Shell/Read/Grep/Task and MCP:<tool> follow Cursor's names; GraphWard MCP tools are reachable before a task", async (t) => {
  const root = await fixture(t);
  const decide = async (tool_name, tool_input) => {
    const input = normalizeInput("cursor", JSON.stringify({ conversation_id: "c", hook_event_name: "preToolUse", workspace_roots: [root], tool_name, tool_input }));
    return JSON.parse((await runHook("pre-tool-use", root, input, "cursor")).stdout).permission;
  };
  for (const [tool, input] of [["mcp__graphward__propose_task_contract", {}], ["mcp__graphward__get_task_readiness", {}], ["Read", { file_path: "src/index.ts" }], ["Grep", { pattern: "a" }],
    ["Task", { description: "x" }], ["Shell", { command: "git status" }], ["MCP:search_docs", { query: "x" }]]) {
    assert.equal(await decide(tool, input), "allow", tool);
  }
  for (const [tool, input] of [["Write", { file_path: path.join(root, "src/index.ts") }], ["Delete", { path: "src/index.ts" }], ["Shell", { command: "rm -rf src" }], ["MCP:propose_task_contract", {}], ["MCP:get_task_readiness", {}]]) {
    assert.equal(await decide(tool, input), "deny", tool);
  }
});

test("Antigravity: every PreToolUse answer carries a decision; subdirectory Cwd is this project; SessionStart replaces PreInvocation", async (t) => {
  const root = await fixture(t);
  const call = (name, args) => normalizeInput("antigravity", JSON.stringify({ conversationId: "c", workspacePaths: [root], toolCall: { name, args } }));
  const decide = async (name, args) => JSON.parse((await runHook("pre-tool-use", root, call(name, args), "antigravity")).stdout).decision;
  for (const [name, args] of [["view_file", { AbsolutePath: path.join(root, "src/index.ts") }], ["list_dir", { DirectoryPath: root }], ["grep_search", { Query: "a" }],
    ["send_message", { Message: "x" }], ["manage_subagents", {}], ["define_subagent", {}], ["manage_task", {}], ["ask_permission", { Action: "x" }], ["generate_image", { Prompt: "x" }],
    ["run_command", { CommandLine: "git status", Cwd: path.join(root, "backend") }], ["run_command", { CommandLine: "ls", Cwd: "/somewhere/else" }]]) {
    assert.equal(await decide(name, args), "allow", name);
  }
  const blocked = await runHook("pre-tool-use", root, call("run_command", { CommandLine: "touch app.py", Cwd: path.join(root, "backend") }), "antigravity");
  const out = JSON.parse(blocked.stdout);
  assert.equal(out.decision, "deny");
  assert.doesNotMatch(out.reason, /another project/, "a subdirectory of the project is the project");
  assert.equal(await decide("write_to_file", { TargetFile: path.join(root, "src/index.ts"), CodeContent: "" }), "deny");
  assert.equal(await decide("mcp_graphward_validate_change", {}), "allow", "flattened MCP naming");
  assert.deepEqual(JSON.parse((await runHook("post-tool-use", root, call("view_file", {}), "antigravity")).stdout), {});

  const settings = JSON.parse(antigravityHookSettings("antigravity"));
  assert.ok(settings.graphward.SessionStart && !settings.graphward.PreInvocation);
  // Reinstalling over a previous install drops our retired PreInvocation entry and keeps the user's.
  const previous = JSON.stringify({ graphward: { enabled: true, PreInvocation: [{ type: "command", command: "gw hook session-start --host antigravity" }] }, mine: { PreInvocation: [{ command: "./lint.sh" }] } });
  const merged = JSON.parse(mergeHookConfig(previous, antigravityHookSettings("antigravity")));
  assert.equal(merged.graphward.PreInvocation, undefined);
  assert.deepEqual(merged.mine.PreInvocation, [{ command: "./lint.sh" }]);
});
