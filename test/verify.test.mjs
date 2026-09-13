/**
 * Verification record tests — the evidence layer that replaced word-matching
 * the agent's shell history.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  runVerification,
  coverageFor,
  changedFiles,
  detectCheckCommands,
  readRecords,
  hashContent,
} from "../dist/verify/index.js";

async function repo(scripts = { test: 'node -e "0"' }) {
  const root = await mkdtemp(path.join(tmpdir(), "ei-verify-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init");
  git("config", "user.email", "t@t.co");
  git("config", "user.name", "t");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts }), "utf8");
  await mkdir(path.join(root, "src"), { recursive: true });
  git("add", "-A");
  git("commit", "-m", "base");
  return root;
}

test("changedFiles expands untracked directories and excludes our own state", async () => {
  const root = await repo();
  await writeFile(path.join(root, "src/new.ts"), "export const x = 1;\n", "utf8");
  await mkdir(path.join(root, ".graphward"), { recursive: true });
  await writeFile(path.join(root, ".graphward/gw.config.json"), "{}", "utf8");

  const files = await changedFiles(root);
  // Without -uall git reports the untracked dir as `src/`, hiding the new file
  // and letting an unverified change slip past the gate.
  assert.ok(files.includes("src/new.ts"), `expected src/new.ts in ${JSON.stringify(files)}`);
  assert.ok(!files.some((f) => f.startsWith(".graphward/")), "own state must never enter a record");
});

test("detectCheckCommands prefers an aggregate check, else typecheck/lint/test", async () => {
  assert.deepEqual(await detectCheckCommands(await repo({ check: "make ci", test: "jest" })), ["npm run check"]);
  assert.deepEqual(await detectCheckCommands(await repo({ test: "jest", lint: "eslint ." })), ["npm run lint", "npm test"]);
  // Non-node project falls back to an ecosystem default.
  const py = await mkdtemp(path.join(tmpdir(), "ei-verify-py-"));
  await writeFile(path.join(py, "pyproject.toml"), "[project]\n", "utf8");
  assert.deepEqual(await detectCheckCommands(py), ["pytest"]);
});

test("a passing run produces a pass record bound to the changed bytes", async () => {
  const root = await repo();
  await writeFile(path.join(root, "src/a.ts"), "export const a = 1;\n", "utf8");

  const { record } = await runVerification(root, { provenance: "human" });
  assert.equal(record.verdict, "pass");
  assert.equal(record.commands.length, 1);
  assert.equal(record.commands[0].exitCode, 0);
  assert.equal(record.files["src/a.ts"], hashContent("export const a = 1;\n"));
  assert.ok(record.head, "record records the git HEAD it was taken at");

  assert.equal((await coverageFor(root, ["src/a.ts"])).covered, true);
});

test("a failing command can never produce a passing record", async () => {
  const root = await repo({ test: 'node -e "process.exit(3)"' });
  await writeFile(path.join(root, "src/a.ts"), "export const a = 1;\n", "utf8");

  const { record } = await runVerification(root, { provenance: "human" });
  assert.equal(record.verdict, "fail");
  assert.equal(record.commands[0].exitCode, 3);
  assert.equal((await coverageFor(root, ["src/a.ts"])).covered, false);
});

test("a record stops covering a file the moment its bytes change", async () => {
  const root = await repo();
  const file = path.join(root, "src/a.ts");
  await writeFile(file, "export const a = 1;\n", "utf8");
  await runVerification(root, { provenance: "human" });
  assert.equal((await coverageFor(root, ["src/a.ts"])).covered, true);

  await writeFile(file, "export const a = 2;\n", "utf8");
  const after = await coverageFor(root, ["src/a.ts"]);
  assert.equal(after.covered, false, "a record must not vouch for bytes it never saw");
  assert.deepEqual(after.uncovered, ["src/a.ts"]);
});

test("no detectable check command yields a fail verdict, never a free pass", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ei-verify-bare-"));
  const { record, noCommands } = await runVerification(root, { provenance: "human" });
  assert.equal(noCommands, true);
  assert.equal(record.verdict, "fail", "nothing ran, so nothing is proven");
});

test("explicit commands override detection and all must pass", async () => {
  const root = await repo();
  const ok = await runVerification(root, { commands: ['node -e "0"', 'node -e "0"'] });
  assert.equal(ok.record.verdict, "pass");
  assert.equal(ok.record.commands.length, 2);

  const bad = await runVerification(root, { commands: ['node -e "0"', 'node -e "process.exit(1)"', 'node -e "0"'] });
  assert.equal(bad.record.verdict, "fail");
  assert.equal(bad.record.commands.length, 2, "stops at the first failure — the tree is not verified");
});

test("records accumulate newest-first and are capped", async () => {
  const root = await repo();
  await runVerification(root);
  await runVerification(root);
  const records = await readRecords(root);
  assert.ok(records.length >= 2);
  assert.ok(records[0].createdAt >= records[1].createdAt, "newest first");
  assert.ok(records.length <= 20, "history is capped");
});

test("outside a git repo, coverage degrades to mtime and still expires on edit", async () => {
  // Without git we cannot enumerate the change set, so a record cannot bind to
  // bytes. It must still be usable (or non-git projects would block forever) and
  // must still stop covering a file that is written afterwards.
  const root = await mkdtemp(path.join(tmpdir(), "ei-verify-nogit-"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: 'node -e "0"' } }), "utf8");
  await mkdir(path.join(root, "src"), { recursive: true });
  const file = path.join(root, "src/a.ts");
  await writeFile(file, "export const a = 1;\n", "utf8");

  const { record } = await runVerification(root);
  assert.equal(record.gitAvailable, false, "degraded mode must be recorded honestly, not hidden");
  assert.equal(record.verdict, "pass");
  assert.equal((await coverageFor(root, ["src/a.ts"])).covered, true);

  await new Promise((r) => setTimeout(r, 12));
  await writeFile(file, "export const a = 2;\n", "utf8");
  assert.equal((await coverageFor(root, ["src/a.ts"])).covered, false, "editing after verification must expire the record");

  await rm(root, { recursive: true, force: true });
});

test("coverage is vacuously true when nothing changed", async () => {
  const root = await repo();
  assert.equal((await coverageFor(root, [])).covered, true);
  // A file that does not exist cannot be uncovered.
  assert.equal((await coverageFor(root, ["src/ghost.ts"])).covered, true);
});
