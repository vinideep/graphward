/**
 * CLI argument safety: an omitted command implies `install`, so anything that is not
 * an install option must fail before touching the project.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli", "index.js");

for (const args of [["--json"], ["--threshold", "50"], ["--ide", "claude-code", "--json"]]) {
  test(`no command with non-install option ${args.join(" ")} fails without writing files`, async (t) => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gw-cli-args-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", timeout: 60_000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /not an install option/);
    assert.deepEqual(await readdir(cwd), []);
  });
}

test("unknown command fails without writing files", async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), "gw-cli-args-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [cli, "instal", "."], { cwd, encoding: "utf8", timeout: 60_000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /Unknown command "instal"/);
  assert.deepEqual(await readdir(cwd), []);
});
