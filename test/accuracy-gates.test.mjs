import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { captureApiSnapshot, replayApiSnapshot, normalizeApiExchange } from "../dist/gates/api-snapshot.js";
import { runGate } from "../dist/gates/index.js";

async function root() { return mkdtemp(path.join(tmpdir(), "gw-accuracy-gates-")); }
async function write(root, rel, value) { const target = path.join(root, rel); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`); }
const exchange = { request: { method: "GET", path: "/users", headers: { Authorization: "Bearer secret", Cookie: "sid=x" } }, response: { status: 200, headers: { ETag: "v1", "Set-Cookie": "token=x" }, body: { id: "abc", token: "secret", amount: 10, items: [1, 2], nullable: null } } };

test("API snapshots redact secrets, mask explicit volatility, and detect semantic differences", async () => {
  const dir = await root();
  const normalized = normalizeApiExchange(exchange, { volatilePaths: ["response.body.id"] });
  assert.equal(normalized.request.headers.authorization, "[REDACTED]");
  assert.equal(normalized.response.body.token, "[REDACTED]");
  assert.equal(normalized.response.body.id, "[VOLATILE]");
  await captureApiSnapshot(dir, "users-list", exchange, { volatilePaths: ["response.body.id"], sourceFiles: ["src/routes/users.ts"] });
  assert.equal((await replayApiSnapshot(dir, "users-list", { ...exchange, response: { ...exchange.response, body: { ...exchange.response.body, id: "changed" } } })).status, "pass");
  const failed = await replayApiSnapshot(dir, "users-list", { ...exchange, response: { ...exchange.response, status: 403, body: { ...exchange.response.body, amount: -10, items: [2, 1], nullable: 0 } } });
  assert.equal(failed.status, "fail");
  assert.ok(failed.differences.some((item) => item.includes("response.status")));
  assert.ok(failed.differences.some((item) => item.includes("amount")));
  assert.doesNotMatch(await readFile(path.join(dir, ".graphward/snapshots/users-list/manifest.json"), "utf8"), /Bearer secret|sid=x|token=x/);
  assert.equal((await runGate("api-snapshot", dir, { changedFiles: ["src/routes/users.ts"] })).status, "fail");
  assert.equal((await runGate("api-snapshot", dir, { changedFiles: ["src/routes/accounts.ts"] })).status, "unavailable");
  assert.equal((await runGate("api-snapshot", dir, { changedFiles: ["src/gates/api-snapshot.ts"] })).status, "skipped");
});

test("required security and rollback gates are unavailable when evidence is missing", async () => {
  const dir = await root();
  assert.equal((await runGate("security-audit", dir, { changedFiles: ["src/auth/session.ts"], risk: "high" })).status, "unavailable");
  assert.equal((await runGate("rollback-readiness", dir, { risk: "medium" })).status, "unavailable");
});

test("rollback content and convention thresholds are enforced", async () => {
  const dir = await root();
  await write(dir, ".graphward/aidlc/operations/rollback-readiness.json", { schemaVersion: 1, codeRevert: "revert commit", stateCompensation: "none; read-only state", disablePath: "disable flag", externalEffects: "none", irreversibleSteps: "none", verification: "run tests" });
  assert.equal((await runGate("rollback-readiness", dir, { risk: "medium" })).status, "pass");
  await write(dir, ".graphward/reports/convention-findings.json", { schemaVersion: 1, findings: [
    { id: "one", message: "major architecture violation", severity: "major", category: "architecture", confidence: 0.8, adherence: 0.8 },
    { id: "ignored", message: "low confidence", severity: "critical", category: "security", confidence: 0.79, adherence: 1 }
  ] });
  assert.equal((await runGate("conventions", dir, { changedFiles: ["src/a.ts"], risk: "medium" })).status, "fail");
});
