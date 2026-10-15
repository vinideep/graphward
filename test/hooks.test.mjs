/**
 * Hook engine unit tests — drive `runHook` at the library level (deterministic,
 * no CLI spawn). They prove the enforcement contract:
 *  - source vs non-source classification
 *  - validation-command detection
 *  - PostToolUse records changed files and successful validation commands
 *  - Stop blocks unvalidated code changes only when opted in, and never loops
 *  - every path is fail-safe (missing intelligence → allow)
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { execFileSync } from "node:child_process";
import {
  runHook,
  parseHookInput,
  normalizeInput,
  isSourceFile,
  looksLikeValidationCommand,
  isHookHost,
  loadHookConfig,
  DEFAULT_HOOK_CONFIG,
  claudeCodeHookSettings,
  cursorHookSettings,
  defaultConfigFile,
  isReadOnlyShellCommand,
} from "../dist/hooks/index.js";
import { runVerification } from "../dist/verify/index.js";

async function tmpRoot(config) {
  const root = await mkdtemp(path.join(tmpdir(), "ei-hooks-"));
  await mkdir(path.join(root, ".graphward"), { recursive: true });
  if (config) {
    await writeFile(
      path.join(root, ".graphward", "gw.config.json"),
      JSON.stringify({ hooks: config }),
      "utf8",
    );
  }
  return root;
}

/** A real git repo with a committed baseline and a passing `npm test`, so the
 *  record-based Stop gate has genuine change detection to work against. */
async function gitRoot(config) {
  const root = await tmpRoot(config);
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init");
  git("config", "user.email", "t@t.co");
  git("config", "user.name", "t");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"0\"" } }), "utf8");
  await mkdir(path.join(root, "src"), { recursive: true });
  git("add", "-A");
  git("commit", "-m", "base");
  return root;
}

async function readState(root, sid) {
  const raw = await readFile(
    path.join(root, ".graphward", ".hooks-state", `${sid}.json`),
    "utf8",
  );
  return JSON.parse(raw);
}

test("isSourceFile classifies product code but excludes intelligence/config/vendored", () => {
  assert.equal(isSourceFile("src/app.ts"), true);
  assert.equal(isSourceFile("lib/handler.py"), true);
  assert.equal(isSourceFile("README.md"), false);
  assert.equal(isSourceFile(".graphward/knowledge-base/00.md"), false);
  assert.equal(isSourceFile(".claude/settings.json"), false);
  assert.equal(isSourceFile("node_modules/x/index.js"), false);
  assert.equal(isSourceFile("dist/app.js"), false);
});

test("looksLikeValidationCommand is a UX hint only, and no longer gates anything", () => {
  assert.equal(looksLikeValidationCommand("npm test"), true);
  assert.equal(looksLikeValidationCommand("npx tsc --noEmit"), true);
  assert.equal(looksLikeValidationCommand("pytest -q"), true);
  assert.equal(looksLikeValidationCommand("cargo test"), true);
  assert.equal(looksLikeValidationCommand("ls -la"), false);
  assert.equal(looksLikeValidationCommand("git status"), false);
  // These defeated the OLD gate. They may still look test-shaped to a human, but
  // nothing about this function can satisfy the Stop gate any more — only a record can.
  assert.equal(looksLikeValidationCommand("rm -rf build"), false);
  assert.equal(looksLikeValidationCommand("echo check"), false);
  assert.equal(looksLikeValidationCommand("git commit -m 'add tests'"), false);
});

test("loadHookConfig merges overrides onto defaults and falls back safely", async () => {
  const root = await tmpRoot({ requireValidationOnStop: true });
  const config = await loadHookConfig(root);
  assert.equal(config.requireValidationOnStop, true);
  assert.equal(config.blockStaleEdits, DEFAULT_HOOK_CONFIG.blockStaleEdits);
  assert.equal(config.freshnessThreshold, DEFAULT_HOOK_CONFIG.freshnessThreshold);

  const bare = await mkdtemp(path.join(tmpdir(), "ei-hooks-noconf-"));
  assert.deepEqual(await loadHookConfig(bare), DEFAULT_HOOK_CONFIG);
});

test("PostToolUse records changed source files and check-shaped commands", async () => {
  const root = await tmpRoot();
  const sid = "sess";
  const base = { session_id: sid };

  await runHook("post-tool-use", root, { ...base, tool_name: "Write", tool_input: { file_path: path.join(root, "src/a.ts") } });
  await runHook("post-tool-use", root, { ...base, tool_name: "Edit", tool_input: { file_path: path.join(root, "README.md") } });
  await runHook("post-tool-use", root, { ...base, tool_name: "Bash", tool_input: { command: "ls" } });
  await runHook("post-tool-use", root, { ...base, tool_name: "Bash", tool_input: { command: "npm test" } });

  const state = await readState(root, sid);
  assert.deepEqual(state.changedFiles, ["src/a.ts"], "only source files are tracked");
  assert.deepEqual(state.validationCommands, ["npm test"], "check-shaped commands recorded as a hint");
});

test("Stop can be explicitly disabled even though validation is enabled by default", async () => {
  const root = await gitRoot({ requireValidationOnStop: false });
  await writeFile(path.join(root, "src/a.ts"), "export const a = 1;\n", "utf8");
  const result = await runHook("stop", root, { session_id: "off" });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, undefined, "gate off → never blocks");
});

test("Stop requires a passing record covering the current bytes", async () => {
  const root = await gitRoot({ requireValidationOnStop: true });
  const sid = "gate";
  const stop = async (extra = {}) => runHook("stop", root, { session_id: sid, ...extra });

  // Clean tree → allow.
  assert.equal((await stop()).stdout, undefined, "no source change → allow");

  // Source changed, nothing verified → block.
  await writeFile(path.join(root, "src/a.ts"), "export const a = 1;\n", "utf8");
  const blocked = await stop();
  assert.ok(blocked.stdout, "unverified change must block");
  const decision = JSON.parse(blocked.stdout);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /src\/a\.ts/, "names the unverified file");
  assert.match(decision.reason, /npm test/, "surfaces the real project check command");

  // THE OLD BYPASS: a test-shaped shell command must no longer satisfy the gate.
  await runHook("post-tool-use", root, { session_id: sid, tool_name: "Bash", tool_input: { command: "rm -rf build" } });
  await runHook("post-tool-use", root, { session_id: sid, tool_name: "Bash", tool_input: { command: "npm test" } });
  assert.ok((await stop()).stdout, "claiming to have run tests must not satisfy the gate");

  // A repeated stop attempt is not evidence and must remain blocked.
  assert.ok((await stop({ stop_hook_active: true })).stdout);

  // A real verification run produces a record → allow.
  const { record } = await runVerification(root, { provenance: "human" });
  assert.equal(record.verdict, "pass");
  assert.equal((await stop()).stdout, undefined, "passing record → allow");

  // Editing after verification invalidates the record → block again.
  await writeFile(path.join(root, "src/a.ts"), "export const a = 2;\n", "utf8");
  assert.ok((await stop()).stdout, "record must not vouch for bytes it never saw");
});

test("Stop stays blocked when verification actually fails", async () => {
  const root = await gitRoot({ requireValidationOnStop: true });
  // A check command that always fails.
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(1)\"" } }), "utf8");
  await writeFile(path.join(root, "src/a.ts"), "export const a = 1;\n", "utf8");

  const { record } = await runVerification(root, { provenance: "human" });
  assert.equal(record.verdict, "fail", "a failing command must never produce a passing record");

  const blocked = await runHook("stop", root, { session_id: "failing" });
  assert.ok(blocked.stdout, "failed verification must still block");
  assert.match(JSON.parse(blocked.stdout).reason, /FAILED/, "surfaces the failure");
});

test("SessionStart resets session state and injects context", async () => {
  const root = await tmpRoot();
  const sid = "start";
  // Seed stale state from a previous session with the same id.
  await runHook("post-tool-use", root, { session_id: sid, tool_name: "Write", tool_input: { file_path: path.join(root, "src/a.ts") } });
  assert.deepEqual((await readState(root, sid)).changedFiles, ["src/a.ts"]);

  const result = await runHook("session-start", root, { session_id: sid });
  assert.equal(result.exitCode, 0);
  const out = JSON.parse(result.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(out.hookSpecificOutput.additionalContext, /GraphWard/);
  assert.deepEqual((await readState(root, sid)).changedFiles, [], "session state reset on start");
});

test("PreToolUse allows non-source edits and is fail-safe without intelligence", async () => {
  const root = await tmpRoot();
  const allowDoc = await runHook("pre-tool-use", root, { session_id: "p", tool_name: "Write", tool_input: { file_path: path.join(root, "README.md") } });
  assert.equal(allowDoc.stdout, undefined, "editing docs is always allowed");

  const allowSrc = await runHook("pre-tool-use", root, { session_id: "p", tool_name: "Write", tool_input: { file_path: path.join(root, "src/a.ts") } });
  assert.equal(allowSrc.stdout, undefined, "no intelligence → Proceed → allow");
});

test("runHook never throws on malformed input", async () => {
  const root = await tmpRoot();
  const result = await runHook("post-tool-use", root, parseHookInput("not json"));
  assert.equal(result.exitCode, 0);
});

test("rendered Claude settings and default config are valid JSON with hook wiring", () => {
  const settings = JSON.parse(claudeCodeHookSettings());
  assert.ok(settings.hooks.SessionStart, "SessionStart wired");
  assert.ok(settings.hooks.Stop, "Stop wired");
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /index\.js['" ]+hook pre-tool-use/);

  const config = JSON.parse(defaultConfigFile());
  assert.equal(config.hooks.blockStaleEdits, false);
  assert.equal(config.hooks.requireValidationOnStop, true);
});

// --- Cross-IDE: Cursor host --------------------------------------------------

test("isHookHost recognizes claude-code and cursor only", () => {
  assert.equal(isHookHost("claude-code"), true);
  assert.equal(isHookHost("cursor"), true);
  assert.equal(isHookHost("copilot"), false);
});

test("cursorHookSettings renders Cursor's schema with --host cursor commands", () => {
  const s = JSON.parse(cursorHookSettings());
  assert.equal(s.version, 1);
  // Cursor's granular edit/shell events both route to our post-tool-use handler.
  for (const e of ["sessionStart", "preToolUse", "afterFileEdit", "afterShellExecution", "stop"]) {
    assert.ok(Array.isArray(s.hooks[e]), `missing cursor event ${e}`);
  }
  assert.match(s.hooks.sessionStart[0].command, /hook session-start --host cursor/);
  assert.match(s.hooks.afterShellExecution[0].command, /hook post-tool-use --host cursor/);
});

test("normalizeInput maps Cursor field names and granular events to the neutral shape", () => {
  const edit = normalizeInput("cursor", JSON.stringify({
    conversation_id: "c1", workspace_roots: ["/repo"], hook_event_name: "afterFileEdit", file_path: "/repo/src/a.ts",
  }));
  assert.equal(edit.session_id, "c1");
  assert.equal(edit.cwd, "/repo");
  assert.equal(edit.tool_name, "Edit");
  assert.equal(edit.tool_input.file_path, "/repo/src/a.ts");

  const shellOk = normalizeInput("cursor", JSON.stringify({ conversation_id: "c1", hook_event_name: "afterShellExecution", command: "npm test", exit_code: 0 }));
  assert.equal(shellOk.tool_name, "Bash");
  assert.equal(shellOk.tool_response.success, true);
  const shellFail = normalizeInput("cursor", JSON.stringify({ hook_event_name: "afterShellExecution", command: "npm test", exit_code: 1 }));
  assert.equal(shellFail.tool_response.success, false);

  // Claude passthrough is unchanged.
  const claude = normalizeInput("claude-code", JSON.stringify({ session_id: "s", tool_name: "Write" }));
  assert.equal(claude.session_id, "s");
  assert.equal(claude.tool_name, "Write");
});

test("runHook formats output in Cursor's contract (additional_context / followup_message / permission)", async () => {
  const root = await tmpRoot({ requireValidationOnStop: true, blockStaleEdits: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }), "utf8");
  const sid = "cur";

  // session-start → Cursor's documented sessionStart output is additional_context.
  const start = await runHook("session-start", root, { session_id: sid }, "cursor");
  const startOut = JSON.parse(start.stdout);
  assert.ok("additional_context" in startOut, "cursor session-start should use additional_context");
  assert.ok(!("hookSpecificOutput" in startOut));

  // Record a source change (Cursor afterFileEdit → Edit), then stop must block via followup_message.
  // The file must really exist: the gate binds records to bytes on disk, so it
  // cannot (and must not) block on a path that was only mentioned.
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src/a.ts"), "export const a = 1;\n", "utf8");
  const edit = normalizeInput("cursor", JSON.stringify({ session_id: sid, hook_event_name: "afterFileEdit", file_path: path.join(root, "src/a.ts") }));
  await runHook("post-tool-use", root, edit, "cursor");
  const stop = await runHook("stop", root, { session_id: sid }, "cursor");
  const stopOut = JSON.parse(stop.stdout);
  assert.ok(typeof stopOut.followup_message === "string", "cursor stop-block uses followup_message");
  assert.match(stopOut.followup_message, /npm test/);
});

test("Cursor edits with no discoverable file path fail safe (no false block)", async () => {
  const root = await tmpRoot();
  // preToolUse without a resolvable file path → allow, never a spurious deny.
  const input = normalizeInput("cursor", JSON.stringify({ session_id: "x", hook_event_name: "preToolUse" }));
  const res = await runHook("pre-tool-use", root, input, "cursor");
  assert.deepEqual(JSON.parse(res.stdout), { permission: "allow" });
});

test("discovery classifier allows read-only pipelines and quoted metacharacters, rejects writes and execution", () => {
  const allowed = [
    "ls -la",
    "rg -n \"foo|bar\" src",
    "git -C /repo log -5 --format=%h·%s",
    "git status --short && git diff --stat",
    "grep -rn 'a;b' src | head -20",
    "find src -name '*.ts' | wc -l",
    "sed -n '1,80p' src/web.ts",
    "cat package.json 2>/dev/null",
    "cd src && ls",
    "sort -u list.txt | uniq -c",
  ];
  for (const command of allowed) assert.equal(isReadOnlyShellCommand(command), true, command);
  const rejected = [
    "touch src/index.ts",
    "ls > out.txt",
    "cat a | tee b",
    "echo $(rm -rf x)",
    "echo `id`",
    "find . -name x -delete",
    "find . -exec rm {} \;",
    "sed -i 's/a/b/' f",
    "sed -n '1p;w out' f",
    "sort -o out.txt in.txt",
    "uniq in.txt out.txt",
    "git -c core.pager=sh log",
    "git branch new-branch",
    "rg --pre ./script x",
    "sleep 1 &",
    "FOO=1 ls",
    "ls\nrm x",
    "cat 'unterminated",
    "ls &&",
  ];
  for (const command of rejected) assert.equal(isReadOnlyShellCommand(command), false, command);
});

test("hook event log rotates instead of growing without bound", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ei-hooks-rotate-"));
  const state = path.join(root, ".graphward", ".hooks-state");
  await mkdir(state, { recursive: true });
  await writeFile(path.join(root, ".graphward", "install-manifest.json"), "{}");
  await writeFile(path.join(state, "events.jsonl"), "x".repeat(1024 * 1024 + 1));
  await runHook("post-tool-use", root, { session_id: "s", tool_name: "Read", tool_input: {} });
  const rotated = await readFile(path.join(state, "events.jsonl.1"), "utf8");
  const current = await readFile(path.join(state, "events.jsonl"), "utf8");
  assert.equal(rotated.length, 1024 * 1024 + 1);
  assert.equal(current.trim().split("\n").length, 1);
});

test("Stop allows a clean Git tree even when the session tracked edits that were since committed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ei-hooks-committed-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q"); git("config", "user.email", "t@t.co"); git("config", "user.name", "t");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "app.ts"), "export const a = 1;\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e 0" } }));
  await runHook("post-tool-use", root, { session_id: "s", tool_name: "Edit", tool_input: { file_path: path.join(root, "src", "app.ts") } });
  const dirty = await runHook("stop", root, { session_id: "s" });
  assert.match(dirty.stdout ?? "", /no passing verification record/, "uncommitted, unverified source still blocks");
  git("add", "-A"); git("commit", "-qm", "work");
  const clean = await runHook("stop", root, { session_id: "s" });
  assert.equal(clean.stdout, undefined, "nothing uncommitted remains to verify");
});
