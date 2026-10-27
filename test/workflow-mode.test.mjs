import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { defaultGwConfig, loadGwConfig, migrateGwConfig } from "../dist/config/index.js";
import { routeRequest } from "../dist/routing/catalog.js";
import { getEngineeringContext } from "../dist/context/orchestrator.js";
import { runHook, isReadOnlyShellCommand } from "../dist/hooks/index.js";
import { proposeTask, observeUserPrompt, checkTaskReadiness } from "../dist/aidlc/task-contract.js";
import { runVerification } from "../dist/verify/index.js";
import { resolveRuntimeInvocation } from "../dist/runtime/invocation.js";

async function fixture(t, mode = "concise") {
  const root = await mkdtemp(path.join(tmpdir(), "gw-workflow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".graphward"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, ".graphward/gw.config.json"), JSON.stringify({ workflow: { mode }, providers: { policy: "native" } }));
  await writeFile(path.join(root, "src/index.ts"), "export const value = 1;\n");
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init"); git("config", "user.email", "t@t.co"); git("config", "user.name", "t"); git("add", "."); git("commit", "-m", "base");
  await writeFile(path.join(root, "src/index.ts"), "export const value = 2;\n");
  return { root, git };
}
const hook = (event, root, input = {}, host = "codex") => runHook(event, root, { session_id: "conversation", cwd: root, ...input }, host);
const blocked = result => result.stdout ? JSON.parse(result.stdout).decision === "block" : false;
const denied = result => result.stdout ? JSON.parse(result.stdout).hookSpecificOutput?.permissionDecision === "deny" : false;

test("workflow mode is explicit opt-in and normalization preserves user configuration", async t => {
  assert.equal(defaultGwConfig().workflow.mode, "strict");
  assert.equal(defaultGwConfig({ workflow: { mode: "unknown" } }).workflow.mode, "strict");
  const { root } = await fixture(t);
  const config = { workflow: { mode: "concise", custom: "keep" }, hooks: { requireTaskReadiness: true, requireValidationOnStop: false }, custom: { instructions: "keep" } };
  await writeFile(path.join(root, ".graphward/gw.config.json"), JSON.stringify(config));
  await migrateGwConfig(root);
  const loaded = await loadGwConfig(root);
  assert.equal(loaded.workflow.mode, "concise"); assert.equal(loaded.workflow.custom, "keep");
  assert.deepEqual(loaded.hooks, {...config.hooks,unavailableValidationPolicy:"block"}); assert.deepEqual(loaded.custom, config.custom);
});

test("intent routing keeps discussion, source lookup and planning non-mutating", async t => {
  const { root } = await fixture(t);
  for (const [task, intent] of [["Explain token savings", "discuss"], ["Review API design", "read"], ["Locate index.ts", "read"], ["Plan the fix", "plan"]]) {
    assert.notEqual(routeRequest(task), "graphward", task);
    const pack = await getEngineeringContext(root, { task, files: ["src/index.ts"] });
    assert.equal(pack.classification.intent, intent, task);
    assert.equal(pack.classification.risk, "low", task);
    assert.ok(!pack.classification.route.some(item => /gates/.test(item)), task);
  }
  for (const task of ["Rotate credentials", "Migrate database schema", "Change public API response", "Implement credential rotation; do not change the public API", "Rotate credentials; no changes outside src/auth", "Implement a read-only API endpoint", "Fix the read-only database connection bug"]) {
    const pack = await getEngineeringContext(root, { task });
    assert.equal(pack.classification.intent, "mutate", task);
    assert.ok(["high", "critical"].includes(pack.classification.risk), task);
  }
  assert.equal(routeRequest("Review the fix and implement it"), "graphward");
  for (const task of ["Explain how TDD works", "How do I create a project?", "Plan a new project"]) assert.ok(!["graphward", "tdd", "create-project"].includes(routeRequest(task)), task);
  for (const task of ["I want to fix the parser", "We need to implement pagination"]) assert.equal(routeRequest(task), "graphward", task);
  assert.equal(routeRequest("Fix bug; no changes to docs"), "graphward");
});

test("native authorization cannot be reused by another host/session or through a symlink", async t => {
  const { root } = await fixture(t);
  const spec = { kind: "fix", request: "Fix value", intendedUsers: [], behavior: ["Correct value"], nonGoals: [], acceptanceCriteria: ["Value corrected"], scope: ["src"], constraints: [], questions: [] };
  const proposal = await proposeTask(root, spec, { taskId: "fix", host: "codex", sessionId: "conversation" });
  await observeUserPrompt(root, "codex", "conversation", proposal.challenge);
  assert.equal((await checkTaskReadiness(root, { taskId: "fix", host: "codex", sessionId: "other", stage: "requirements" })).ready, false);
  await proposeTask(root, spec, { taskId: "fix", host: "codex", sessionId: "other" });
  assert.equal((await checkTaskReadiness(root, { host: "codex", sessionId: "other", stage: "requirements" })).ready, false);
  assert.equal((await checkTaskReadiness(root, { taskId: "fix", host: "cursor", sessionId: "conversation", stage: "requirements" })).ready, false);
  assert.equal((await checkTaskReadiness(root, { taskId: "fix", host: "codex", stage: "requirements" })).ready, false);
  assert.equal((await checkTaskReadiness(root, { taskId: "fix", sessionId: "conversation", stage: "requirements" })).ready, false);
  await writeFile(path.join(root, "outside.ts"), "outside");
  await symlink(path.join(root, "outside.ts"), path.join(root, "src/alias.ts"));
  assert.equal((await checkTaskReadiness(root, { taskId: "fix", files: ["src/alias.ts"], stage: "requirements" })).ready, false);
  const external = await mkdtemp(path.join(tmpdir(), "gw-scope-external-")); t.after(() => rm(external, { recursive: true, force: true }));
  await symlink(path.join(external, "not-created"), path.join(root, "src/dangling"));
  assert.equal((await checkTaskReadiness(root, { taskId: "fix", files: ["src/dangling/new.ts"], stage: "requirements" })).ready, false);
  await writeFile(path.join(root, ".graphward/install-manifest.json"), "{}");
  assert.equal(denied(await hook("pre-tool-use", root, { cwd: external, tool_name: "Write", tool_input: { file_path: path.join(root, "src/dangling/new.ts") } })), true);
});

test("tool names cannot hide filesystem or local code effects", async t => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, ".graphward/install-manifest.json"), "{}");
  for (const [tool_name, tool_input] of [["mcp__untrusted__get_engineering_context", { code: "write()" }], ["mcp__browser__write_file", { path: "src/index.ts" }], ["mcp__chrome_devtools__run", { code: "require('fs').writeFileSync('src/index.ts','')" }]]) {
    assert.equal(denied(await hook("pre-tool-use", root, { tool_name, tool_input })), true, tool_name);
  }
  assert.equal(denied(await hook("pre-tool-use", root, { tool_name: "mcp__graphward__get_engineering_context", tool_input: { task: "Read" } })), false);
  for (const tool of ["take_screenshot", "take_snapshot", "evaluate_script", "performance_start_trace", "performance_stop_trace", "take_heapsnapshot", "get_network_request"]) {
    for (const key of tool === "get_network_request" ? ["requestFilePath", "responseFilePath"] : ["filePath"]) assert.equal(denied(await hook("pre-tool-use", root, { tool_name: `mcp__chrome_devtools__${tool}`, tool_input: { [key]: "src/index.ts" } })), true, `${tool}/${key}`);
  }
  assert.equal(denied(await hook("pre-tool-use", root, { tool_name: "mcp__chrome_devtools__take_screenshot", tool_input: {} })), false);
});

test("safe source reads stay allowed while dynamic, output and network mutations stay gated", () => {
  assert.equal(isReadOnlyShellCommand("nl -ba src/index.ts | sed -n '1,80p'"), true);
  for (const command of ["sort $FLAGS src/index.ts", "git diff $OPTIONS", "file -C", "git diff -o out.txt", "git fetch", "curl -X DELETE https://example.test", "curl --data x https://example.test", "curl --config local", "curl --quote 'DELE remote.txt' ftp://example.test", "git grep --open-files-in-pager=sh pattern", "git config --list --edit", "less -o output.txt input.txt", "sed -n '1p;w out' src/index.ts"]) assert.equal(isReadOnlyShellCommand(command), false, command);
});

test("concise read-only Stop exempts unchanged pre-existing dirt; strict retains verification", async t => {
  for (const mode of ["strict", "concise"]) {
    const { root } = await fixture(t, mode);
    await hook("session-start", root);
    await hook("pre-tool-use", root, { tool_name: "exec_command", tool_input: { cmd: "nl -ba src/index.ts | sed -n '1,8p'" } });
    assert.equal(blocked(await hook("stop", root)), mode === "strict");
  }
});

test("concise Stop requires verification after changed source, mode, HEAD or config", async t => {
  const actions = [
    async ({ root }) => writeFile(path.join(root, "src/index.ts"), "changed"),
    async ({ root }) => writeFile(path.join(root, "src/new.ts"), "new"),
    async ({ root }) => rm(path.join(root, "src/index.ts")),
    async ({ root }) => chmod(path.join(root, "src/index.ts"), 0o755),
    async ({ root, git }) => { git("add", "src"); git("commit", "-m", "changed"); await writeFile(path.join(root, "src/index.ts"), "later"); },
    async ({ root }) => writeFile(path.join(root, ".graphward/gw.config.json"), JSON.stringify({ workflow: { mode: "concise" }, hooks: { freshnessThreshold: 61 } })),
    async ({ root }) => { await mkdir(path.join(root, "scripts")); await writeFile(path.join(root, "scripts/hidden.mjs"), "new"); },
    async ({ root }) => writeFile(path.join(root, ".eiignore"), "src/\n"),
    async ({ root }) => writeFile(path.join(root, "pyproject.toml"), "[tool.pytest.ini_options]\naddopts='--strict-markers'\n"),
  ];
  for (const action of actions) {
    const f = await fixture(t); await hook("session-start", f.root); await action(f);
    assert.equal(blocked(await hook("stop", f.root)), true, action.toString());
  }
});

test("concise exemption is sticky and unavailable after mutation, child delegation or resume", async t => {
  for (const input of [{ tool_name: "apply_patch", tool_input: { patch: "*** Update File: src/index.ts" } }, { tool_name: "collaboration.spawn_agent", tool_input: { message: "inspect" } }, { tool_name: "collaboration.followup_task", tool_input: { message: "inspect" } }, { tool_name: "Task", tool_input: { prompt: "inspect" } }]) {
    const { root } = await fixture(t); await hook("session-start", root);
    await hook("pre-tool-use", root, input);
    assert.equal(blocked(await hook("stop", root)), true);
  }
  const { root } = await fixture(t); await hook("session-start", root); await hook("session-start", root);
  assert.equal(blocked(await hook("stop", root)), true);
  const missing = await fixture(t); assert.equal(blocked(await hook("stop", missing.root)), true);
  const wrong = await fixture(t); await hook("session-start", wrong.root);
  assert.equal(blocked(await hook("stop", wrong.root, { session_id: "other" })), true);
});

test("concise identity is bound to full session, host and root; corrupt or unavailable snapshots never exempt", async t => {
  const { root } = await fixture(t);
  await hook("session-start", root, { session_id: "a/b" });
  assert.equal(blocked(await hook("stop", root, { session_id: "a_b" })), true);
  const cursor = await hook("stop", root, { session_id: "a/b" }, "cursor");
  assert.equal(JSON.parse(cursor.stdout).followup_message.includes("no passing verification"), true);
  const directory = path.join(root, ".graphward/.hooks-state");
  const baseline = (await readdir(directory)).find(file => file.startsWith("readonly-"));
  const saved = await readFile(path.join(directory, baseline), "utf8");
  await writeFile(path.join(directory, baseline), "{broken");
  assert.equal(blocked(await hook("stop", root, { session_id: "a/b" })), true);
  const other = await fixture(t);
  await mkdir(path.join(other.root, ".graphward/.hooks-state"), { recursive: true });
  await writeFile(path.join(other.root, ".graphward/.hooks-state", baseline), saved);
  assert.equal(blocked(await hook("stop", other.root, { session_id: "a/b" })), true);
  const huge = await fixture(t); await writeFile(path.join(huge.root, "src/huge.ts"), "x".repeat(4 * 1024 * 1024 + 1));
  await hook("session-start", huge.root); assert.equal(blocked(await hook("stop", huge.root)), true);
});

test("restored writes invalidate concise provenance and actual verification still permits completion", async t => {
  const { root } = await fixture(t); const target = path.join(root, "src/index.ts"); const original = await readFile(target);
  await hook("session-start", root);
  await writeFile(target, "temporary"); await writeFile(target, original);
  assert.equal(blocked(await hook("stop", root)), true);
  await writeFile(path.join(root,".graphward/gw.config.json"),JSON.stringify({workflow:{mode:"concise"},providers:{policy:"native"},hooks:{verifyCommands:["node -e \"0\""]}}));
  const result = await runVerification(root);
  assert.equal(result.record.verdict, "pass");
  assert.equal(blocked(await hook("stop", root)), false);
});

test("verification recovery remains reachable but cannot assert a read-only session", async t => {
  for (const input of [...["gw verify .", "\"gw\" verify .", "'gw' verify .", "gw \\v\\e\\r\\i\\f\\y ."].map(cmd => ({ tool_name: "exec_command", tool_input: { cmd } })), { tool_name: "mcp__graphward__run_gate", tool_input: { gate: "conventions" } }, { tool_name: "mcp__graphward__validate_change", tool_input: {} }]) {
    const { root } = await fixture(t); await hook("session-start", root);
    assert.equal(denied(await hook("pre-tool-use", root, input)), false);
    assert.equal(blocked(await hook("stop", root)), true, input.tool_name);
  }
});

test("identified CLI preparation and interactive confirmation remain reachable before a task", async t => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, ".graphward/install-manifest.json"), "{}");
  const runtime = resolveRuntimeInvocation();
  const command = [runtime.command, ...runtime.args].map(value => `'${value.replaceAll("'", "'\\''")}'`).join(" ");
  for (const sub of ["prepare-task", "confirm-task", "accept-reduced-context"]) assert.equal(denied(await hook("pre-tool-use", root, { tool_name: "exec_command", tool_input: { cmd: `${command} aidlc ${sub} . --id task --host cursor --unit conversation` } })), false, sub);
});

test("unverifiable source targets cannot turn a Stop verification error into completion", async t => {
  const { root } = await fixture(t);
  const external = await mkdtemp(path.join(tmpdir(), "gw-stop-external-")); t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(path.join(external, "external.ts"), "outside");
  await symlink(path.join(external, "external.ts"), path.join(root, "src/alias.ts"));
  await hook("session-start", root);
  assert.equal(blocked(await hook("stop", root)), true);
  await writeFile(path.join(root, ".graphward/gw.config.json"), JSON.stringify({ workflow: { mode: "concise" }, hooks: { requireValidationOnStop: false } }));
  assert.equal(blocked(await hook("stop", root)), false);
});
